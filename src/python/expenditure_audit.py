#!/usr/bin/env python3
"""
expenditure_audit.py — measures what the athlete ACTUALLY burns outside of
logged workouts, from their own intake + weight history, and compares it
with what the app's demand model assumes (BMR x NEAT factor + EPOC + fatigue
buffer). Python 3 stdlib only (same rule as server.py).

    python3 src/python/expenditure_audit.py --store secrets/app_store.json [--days 56] [--json]

Also imported by server.py (GET /api/expenditure/audit).

The idea (energy balance, no model of NEAT needed):

    observed TDEE   = mean logged intake - 7700 kcal/kg x (trend-weight change) / days
    non-exercise    = observed TDEE - device exercise kcal (exactly what the app counts)
                    = BMR + TEF + NEAT + EPOC + everything else (+ logging bias)

The weight change comes from a local-linear-trend Kalman smoother over the
weigh-ins (ironman_calibrate.weight_trend), so day-to-day water/glycogen
noise mostly cancels; windows are >= 14 days for the same reason.

Outputs:
- pooled: the recommendation window (last `days` days ending at the last
  weigh-in) — observed TDEE, exercise, non-exercise expenditure, the app's
  current equivalent, and the gap, each with a 1-SD uncertainty.
- breakdown: non-exercise split into BMR (Mifflin-St Jeor), TEF (~10% of
  intake), and the residual "NEAT + EPOC + other".
- recommendation: the neatFactor (or neatOffset) that makes the app's demand
  match observed expenditure, keeping the current EPOC / fatigue settings.
- windows: rolling 14-day (step 7) estimates, to see drift across a block.
- loadResponse: across non-overlapping 14-day windows, how non-exercise
  expenditure moves with training load (slope per 100 kcal/day of
  training). Positive = EPOC / recovery cost the app might be missing;
  negative = NEAT compensation (moving less on big weeks).
- split: the Kalman grid fit (ironman_calibrate.fit_energy_balance) with a
  WIDE prior, i.e. expenditure = a x BMR + b x exercise kcal, mostly data-
  driven. Only meaningful when training load varied enough (see `identified`).

Everything is an EFFECTIVE number: food the log misses, device calorie bias
and BMR double-counted inside workout calories all land in "non-exercise".
That is what the app needs anyway, since its targets are compared against
the same logged intake and the same device calories.
"""
import argparse
import datetime as dt
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ironman_calibrate as ic  # noqa: E402

KCAL_PER_KG = ic.KCAL_PER_KG
TEF_FRACTION = 0.10
MISSING_INTAKE_SD = 600.0  # kcal: assumed uncertainty of one unlogged day
# Water/glycogen swings are autocorrelated over days, so the smoother (which
# treats weigh-in noise as independent) is overconfident about the level on a
# given morning. A systematic +-0.25 kg at each end of a window covers that.
WATER_LEVEL_SD_KG = 0.25
WINDOW_DAYS = 14
WINDOW_STEP = 7
MIN_POOLED_DAYS = 14
MIN_WEIGH_INS = 6
MIN_INTAKE_COVERAGE = 0.8


# ------------------------------------------------- app-equivalent formulas
# Mirrors of app-source.jsx so "what the app assumed" is exact.

def epoc_factor_for(intensity):
    if intensity >= 0.85:
        return 0.12
    if intensity >= 0.7:
        return 0.08
    return 0.05


def strava_kcal(a):
    c = ic.fnum(a.get("calories"))
    if c and c > 0:
        return c
    kj = ic.fnum(a.get("kilojoules"))
    return kj / 4.184 / 0.24 if kj is not None else 0.0


def strava_intensity(a):
    ss, sec = ic.fnum(a.get("suffer_score")), ic.fnum(a.get("moving_time"), 0)
    if ss is not None and sec:
        return min(1.3, max(0.3, ss / (sec / 3600.0) / 60.0))
    return 0.7


def intervals_kcal(a):
    c = ic.fnum(a.get("calories"))
    if c and c > 0:
        return c
    j = ic.fnum(a.get("icu_joules"))
    return j / 4184.0 / 0.24 if j and j > 0 else 0.0


def intervals_intensity(a):
    i = ic.fnum(a.get("icu_intensity"))
    if i is not None:
        return i
    load, sec = ic.fnum(a.get("icu_training_load")), ic.fnum(a.get("moving_time"), 0)
    if load is not None and sec:
        return min(1.3, load / (sec / 3600.0) / 80.0)
    return 0.7


def _act_date(a):
    return (a.get("start_date_local") or a.get("start_date") or "")[:10]


# ------------------------------------------------------------ daily table

def build_days(store, start, end, trend_by_date):
    """One row per day: logged intake, exercise kcal exactly as the app's
    non-IronMan path counts it (Strava > intervals.icu fallback), the app's
    EPOC and fatigue-buffer kcal, BMR at the smoothed weight, and whether
    the day's training data is actually known (synced) or a gap."""
    p = store.get("profile") or {}
    sex = p.get("sex") or "male"
    height = ic.fnum(p.get("heightCm"), 180.0)
    age = ic.fnum(p.get("age"), 35.0)
    epoc_sens = ic.fnum(p.get("epocSensitivity"), 1.0)
    fatigue_on = bool(p.get("fatigueBuffer", True))
    nut = store.get("nutrition-log") or {}
    sc = store.get("strava-cache") or {}
    icc = store.get("intervals-cache") or {}
    strava_by, icu_by = {}, {}
    for a in sc.get("activities") or []:
        strava_by.setdefault(_act_date(a), []).append(a)
    for a in icc.get("activities") or []:
        icu_by.setdefault(_act_date(a), []).append(a)
    synced = set(sc.get("syncedDates") or []) | set(icc.get("syncedDates") or [])
    well = {}
    for w in icc.get("wellness") or []:
        k = w.get("id") or w.get("date")
        if k:
            well[k] = w
    weights = {k: ic.fnum(v) for k, v in (store.get("weight-log") or {}).items() if ic.fnum(v)}
    wkeys = sorted(weights)

    days = []
    d = start
    while d <= end:
        k = ic.d2s(d)
        e = ic.effective_nutrition_entry(nut.get(k))
        intake = ic.fnum(e.get("calories")) if e else None
        if intake is not None and intake <= 0:
            intake = None
        ex = epoc = hours = 0.0
        src = None
        if strava_by.get(k):
            src = "strava"
            for a in strava_by[k]:
                kc = strava_kcal(a)
                ex += kc
                epoc += kc * epoc_factor_for(strava_intensity(a)) * epoc_sens
                hours += (ic.fnum(a.get("moving_time"), 0) or 0) / 3600.0
        elif icu_by.get(k):
            src = "intervals"
            for a in icu_by[k]:
                kc = intervals_kcal(a)
                ex += kc
                epoc += kc * epoc_factor_for(intervals_intensity(a)) * epoc_sens
                hours += (ic.fnum(a.get("moving_time"), 0) or 0) / 3600.0
        elif k in synced:
            src = "rest"
        t = trend_by_date.get(k)
        if t:
            wkg = t["levelKg"]
        else:
            prior = [x for x in wkeys if x <= k]
            wkg = weights[prior[-1]] if prior else (weights[wkeys[0]] if wkeys else ic.fnum(p.get("weightKg"), 75.0))
        bmr = ic.calc_bmr(sex, wkg, height, age)
        w = well.get(k) or {}
        ctl, atl = ic.fnum(w.get("ctl")), ic.fnum(w.get("atl"))
        tsb = ctl - atl if ctl is not None and atl is not None else None
        fatigue = 0.05 * bmr if fatigue_on and tsb is not None and tsb < -10 else 0.0
        days.append({"date": k, "intake": intake, "exKcal": ex, "epocKcal": epoc, "fatigueKcal": fatigue,
                     "bmr": bmr, "weightKg": wkg, "tsb": tsb, "hours": hours, "exSource": src,
                     "exKnown": src is not None, "carbs": ic.fnum(e.get("carbs")) if e else None})
        d += dt.timedelta(days=1)
    return days


def app_baseline(profile, bmr):
    if (profile.get("neatMode") or "multiplier") == "offset":
        return bmr + (ic.fnum(profile.get("neatOffset"), 400.0) or 0.0)
    return bmr * (ic.fnum(profile.get("neatFactor"), 1.15) or 1.15)


# ------------------------------------------------------- window estimates

def window_estimate(days_by_date, trend_by_date, start, end, profile):
    """Energy balance over [start, end): weigh-in-morning `start` to
    weigh-in-morning `end`, intake/exercise from days start .. end-1.
    Returns None when the trend doesn't cover both ends."""
    ts, te = trend_by_date.get(ic.d2s(start)), trend_by_date.get(ic.d2s(end))
    n = (end - start).days
    if not ts or not te or n <= 0:
        return None
    rows = [days_by_date[ic.d2s(start + dt.timedelta(days=i))] for i in range(n)
            if ic.d2s(start + dt.timedelta(days=i)) in days_by_date]
    if len(rows) < n:
        return None
    logged = [r for r in rows if r["intake"] is not None]
    if not logged:
        return None
    mean_intake = sum(r["intake"] for r in logged) / len(logged)
    dw = te["levelKg"] - ts["levelKg"]
    storage = KCAL_PER_KG * dw / n
    tdee = mean_intake - storage
    mean = lambda key: sum(r[key] for r in rows) / n  # noqa: E731
    ex, epoc, fat, bmr = mean("exKcal"), mean("epocKcal"), mean("fatigueKcal"), mean("bmr")
    baseline = sum(app_baseline(profile, r["bmr"]) for r in rows) / n
    n_missing = n - len(logged)
    # 1-SD: smoothed level uncertainty at both ends (treated as independent —
    # conservative) plus the water/glycogen floor, plus the unlogged days.
    sd_storage = KCAL_PER_KG * math.sqrt(ts["levelSd"] ** 2 + te["levelSd"] ** 2 + 2 * WATER_LEVEL_SD_KG ** 2) / n
    sd_intake = MISSING_INTAKE_SD * math.sqrt(n_missing) / n
    sd = math.sqrt(sd_storage ** 2 + sd_intake ** 2)
    nex = tdee - ex
    app_nex = baseline + epoc + fat
    return {
        "start": ic.d2s(start), "end": ic.d2s(end), "days": n,
        "intakeCoverage": round(len(logged) / n, 3),
        "exerciseCoverage": round(sum(1 for r in rows if r["exKnown"]) / n, 3),
        "meanIntake": round(mean_intake), "weightChangeKg": round(dw, 2),
        "rateKgPerWeek": round(7 * dw / n, 2), "storageKcal": round(storage),
        "observedTdee": round(tdee), "exerciseKcal": round(ex), "trainingHoursPerDay": round(mean("hours"), 2),
        "nonExercise": round(nex), "sd": round(sd),
        "bmr": round(bmr), "tef": round(TEF_FRACTION * mean_intake),
        "neatEpocOther": round(nex - bmr - TEF_FRACTION * mean_intake),
        "nonExerciseFactor": round(nex / bmr, 2),
        "app": {"baseline": round(baseline), "epoc": round(epoc), "fatigue": round(fat),
                "nonExercise": round(app_nex), "demand": round(app_nex + ex),
                "nonExerciseFactor": round(app_nex / bmr, 2)},
        "gap": round(nex - app_nex),
        "_raw": {"nex": nex, "epoc": epoc, "fat": fat, "bmr": bmr, "ex": ex, "sd": sd},
    }


def _strip(w):
    if w is None:
        return None
    return {k: v for k, v in w.items() if not k.startswith("_")}


def ols(xs, ys, ws=None):
    ws = ws or [1.0] * len(xs)
    r = ic.wls(xs, ys, ws)
    if not r:
        return None
    a, b, se_a, se_b, r2 = r
    return {"intercept": a, "slope": b, "slopeSe": se_b, "r2": r2}


# ------------------------------------------------------------------ audit

def run_audit(store, days=56, today=None):
    today = today or dt.date.today()
    profile = store.get("profile") or {}
    notes = []
    weights = {k: ic.fnum(v) for k, v in (store.get("weight-log") or {}).items()
               if ic.fnum(v) and ic.s2d(k) <= today}
    if len(weights) < MIN_WEIGH_INS:
        return {"ok": False, "reason": f"Need at least {MIN_WEIGH_INS} weigh-ins (have {len(weights)})."}
    trend = ic.weight_trend(weights)
    trend_by_date = {t["date"]: t for t in trend}
    t0, t1 = ic.s2d(trend[0]["date"]), ic.s2d(trend[-1]["date"])
    all_days = build_days(store, t0, t1, trend_by_date)
    by_date = {d["date"]: d for d in all_days}

    # ---- pooled recommendation window: last `days` days ending at the last weigh-in
    end = t1
    start = max(t0, end - dt.timedelta(days=days))
    # walk the start forward past an unlogged stretch at the front (e.g. the
    # weigh-ins began before food logging did)
    while (end - start).days > MIN_POOLED_DAYS and by_date[ic.d2s(start)]["intake"] is None:
        start += dt.timedelta(days=1)
    pooled = window_estimate(by_date, trend_by_date, start, end, profile)
    if not pooled or pooled["days"] < MIN_POOLED_DAYS:
        return {"ok": False, "reason": f"Need at least {MIN_POOLED_DAYS} days with both weigh-ins and food logs "
                                       f"(weigh-ins span {ic.d2s(t0)} .. {ic.d2s(t1)})."}
    n_wi = sum(1 for k in weights if pooled["start"] <= k <= pooled["end"])
    if pooled["intakeCoverage"] < MIN_INTAKE_COVERAGE:
        notes.append(f"Only {round(100 * pooled['intakeCoverage'])}% of days in the window have a food log; "
                     "unlogged days are assumed to match the logged average (and widen the uncertainty).")
    if pooled["exerciseCoverage"] < 0.9:
        notes.append(f"{round(100 * (1 - pooled['exerciseCoverage']))}% of days have no synced training data and "
                     "count as zero exercise — pull training data for the full window for a cleaner number.")
    if n_wi < 8:
        notes.append(f"Only {n_wi} weigh-ins in the window; more frequent weigh-ins (daily, same time) tighten this a lot.")

    raw = pooled["_raw"]
    # Recommended settings: make app demand == observed, keeping EPOC/fatigue as configured.
    rec_factor = (raw["nex"] - raw["epoc"] - raw["fat"]) / raw["bmr"]
    rec_offset = raw["nex"] - raw["epoc"] - raw["fat"] - raw["bmr"]
    sd = raw["sd"]
    confidence = "high" if sd <= 100 else "moderate" if sd <= 200 else "low"
    gap = pooled["gap"]
    meaningful = abs(gap) > max(75, 1.0 * sd)
    mode = profile.get("neatMode") or "multiplier"
    recommendation = {
        "neatMode": mode,
        "neatFactor": round(rec_factor, 2), "neatFactorSd": round(sd / raw["bmr"], 2),
        "neatOffset": int(round(rec_offset / 25.0) * 25), "neatOffsetSd": round(sd),
        "current": {"neatFactor": ic.fnum(profile.get("neatFactor"), 1.15),
                    "neatOffset": ic.fnum(profile.get("neatOffset"), 400.0),
                    "epocSensitivity": ic.fnum(profile.get("epocSensitivity"), 1.0),
                    "fatigueBuffer": bool(profile.get("fatigueBuffer", True))},
        "confidence": confidence,
        "changeSuggested": meaningful,
        "keepsEpocAndFatigue": True,
    }
    if rec_factor < 1.0:
        notes.append("Observed non-exercise expenditure is below BMR + the app's EPOC — usually a sign of food "
                     "going unlogged, device calories reading high, or a short window dominated by water shifts.")
    if rec_factor > 1.4 and mode != "offset":
        notes.append("The suggested NEAT factor is above the 1.4 the slider used to allow; the slider now goes to 1.8.")

    # ---- rolling windows
    windows = []
    s = t0
    while s + dt.timedelta(days=WINDOW_DAYS) <= t1:
        w = window_estimate(by_date, trend_by_date, s, s + dt.timedelta(days=WINDOW_DAYS), profile)
        if w and w["intakeCoverage"] >= MIN_INTAKE_COVERAGE:
            windows.append(w)
        s += dt.timedelta(days=WINDOW_STEP)

    # ---- load response across NON-overlapping windows (independent samples)
    load = None
    indep = windows[::max(1, WINDOW_DAYS // WINDOW_STEP)]
    if len(indep) >= 4:
        xs = [w["_raw"]["ex"] / 100.0 for w in indep]
        ys = [w["_raw"]["nex"] for w in indep]
        wts = [1.0 / max(50.0, w["_raw"]["sd"]) ** 2 for w in indep]
        fit = ols(xs, ys, wts)
        spread = (max(xs) - min(xs)) * 100
        if fit:
            load = {"nWindows": len(indep), "exerciseRangeKcal": round(spread),
                    "slopePer100Kcal": round(fit["slope"], 1),
                    "slopeSe": round(fit["slopeSe"], 1) if fit["slopeSe"] is not None else None,
                    "r2": round(fit["r2"], 3),
                    "appSlopePer100Kcal": round(100 * raw["epoc"] / raw["ex"], 1) if raw["ex"] > 0 else None}
            if spread < 300:
                load["note"] = "Training load barely varied between windows, so this slope is not informative."

    # ---- data-driven split (Kalman grid, wide prior)
    split = None
    # Uses up to the last 180 days: the split needs training-load variety, which
    # a single 8-week window often lacks, but very old data may predate a
    # change in lifestyle/job and drag the BMR multiplier.
    split_start = ic.d2s(max(t0, t1 - dt.timedelta(days=180)))
    span = [d for d in all_days if d["date"] >= split_start]
    kf_days = [{"date": d["date"], "intake": d["intake"], "carbs": d["carbs"], "sessionKcal": d["exKcal"]} for d in span]
    p = profile
    sex, height, age = p.get("sex") or "male", ic.fnum(p.get("heightCm"), 180.0), ic.fnum(p.get("age"), 35.0)
    eb = ic.fit_energy_balance(
        kf_days, weights, lambda w: ic.calc_bmr(sex, w, height, age),
        # Wide prior centred on the pooled observation, so the data decides.
        prior_neat=round(min(2.0, max(1.0, (raw["nex"] - raw["epoc"]) / raw["bmr"])), 2), prior_k=1.08,
        prior_sd_neat=0.4, prior_sd_k=0.4, neat_grid=(0.8, 2.4, 0.02), k_grid=(0.3, 2.0, 0.02))
    if not eb.get("insufficient"):
        identified = abs(eb["corrNeatScale"]) < 0.9 and eb["activityScaleSd"] < 0.2
        split = {"bmrMultiplier": eb["neat"], "bmrMultiplierSd": eb["neatSd"],
                 "exerciseMultiplier": eb["activityScale"], "exerciseMultiplierSd": eb["activityScaleSd"],
                 "correlation": eb["corrNeatScale"], "identified": identified,
                 "span": [kf_days[0]["date"], kf_days[-1]["date"]],
                 "meanDailyExpenditure": eb["meanDailyExpenditure"], "meanDailyExpenditureSd": eb["meanDailyExpenditureSd"]}

    return {
        "ok": True,
        "generatedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "pooled": _strip(pooled),
        "weighInsInWindow": n_wi,
        "recommendation": recommendation,
        "windows": [_strip(w) for w in windows],
        "loadResponse": load,
        "split": split,
        "assumptions": {"kcalPerKg": KCAL_PER_KG, "tefFraction": TEF_FRACTION, "windowDays": WINDOW_DAYS},
        "notes": notes,
        "ironmanMode": bool(profile.get("ironmanMode")),
    }


# -------------------------------------------------------------------- CLI

def format_report(r):
    if not r.get("ok"):
        return f"Not enough data: {r.get('reason')}"
    p, rec = r["pooled"], r["recommendation"]
    a = p["app"]
    L = []
    L.append(f"Window {p['start']} .. {p['end']} ({p['days']} days, {r['weighInsInWindow']} weigh-ins, "
             f"{round(100 * p['intakeCoverage'])}% food-logged, {round(100 * p['exerciseCoverage'])}% training synced)")
    L.append(f"  Mean intake            {p['meanIntake']:>6} kcal/d")
    L.append(f"  Trend weight change    {p['weightChangeKg']:+.2f} kg ({p['rateKgPerWeek']:+.2f} kg/wk) = {p['storageKcal']:+} kcal/d stored")
    L.append(f"  Observed TDEE          {p['observedTdee']:>6} ± {p['sd']} kcal/d")
    L.append(f"  - device exercise      {p['exerciseKcal']:>6} kcal/d ({p['trainingHoursPerDay']} h/d)")
    L.append(f"  = non-exercise         {p['nonExercise']:>6} ± {p['sd']} kcal/d  ({p['nonExerciseFactor']}x BMR)")
    L.append(f"      BMR (Mifflin)      {p['bmr']:>6}")
    L.append(f"      TEF (~10% intake)  {p['tef']:>6}")
    L.append(f"      NEAT+EPOC+other    {p['neatEpocOther']:>6}")
    L.append(f"  App currently assumes  {a['nonExercise']:>6} kcal/d non-exercise "
             f"(baseline {a['baseline']} + EPOC {a['epoc']} + fatigue {a['fatigue']}; {a['nonExerciseFactor']}x BMR)")
    L.append(f"  Gap (observed - app)   {p['gap']:+} kcal/d")
    L.append("")
    if rec["neatMode"] == "offset":
        L.append(f"Suggested NEAT offset: {rec['neatOffset']} kcal/d ± {rec['neatOffsetSd']} "
                 f"(now {rec['current']['neatOffset']}) — confidence {rec['confidence']}")
    else:
        L.append(f"Suggested NEAT factor: {rec['neatFactor']} ± {rec['neatFactorSd']} "
                 f"(now {rec['current']['neatFactor']}) — confidence {rec['confidence']}")
    L.append("  (keeps EPOC sensitivity and the fatigue buffer as they are)")
    if r["windows"]:
        L.append("")
        L.append("Rolling 14-day windows:")
        L.append("  start       intake  Δkg/wk  TDEE   exer  non-ex  xBMR   ±sd")
        for w in r["windows"]:
            L.append(f"  {w['start']}  {w['meanIntake']:>5}  {w['rateKgPerWeek']:+6.2f}  {w['observedTdee']:>5}  "
                     f"{w['exerciseKcal']:>5}  {w['nonExercise']:>6}  {w['nonExerciseFactor']:>4.2f}  {w['sd']:>4}")
    lr = r.get("loadResponse")
    if lr:
        L.append("")
        L.append(f"Load response ({lr['nWindows']} independent windows, exercise range {lr['exerciseRangeKcal']} kcal/d): "
                 f"non-exercise changes {lr['slopePer100Kcal']:+} ± {lr['slopeSe']} kcal per +100 kcal/d training "
                 f"(app's EPOC adds {lr['appSlopePer100Kcal']})" + (f" — {lr['note']}" if lr.get("note") else ""))
    sp = r.get("split")
    if sp:
        L.append(f"Kalman split {sp['span'][0]}..{sp['span'][1]}: expenditure = {sp['bmrMultiplier']}±{sp['bmrMultiplierSd']} x BMR "
                 f"+ {sp['exerciseMultiplier']}±{sp['exerciseMultiplierSd']} x exercise "
                 f"(corr {sp['correlation']}; {'identified' if sp['identified'] else 'NOT well identified — trust the total, not the split'})")
    for n in r["notes"]:
        L.append(f"Note: {n}")
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--store", default=os.path.join(os.path.dirname(__file__), "..", "..", "secrets", "app_store.json"))
    ap.add_argument("--days", type=int, default=56, help="recommendation window, ending at the last weigh-in")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    with open(args.store) as f:
        store = json.load(f)
    r = run_audit(store, days=args.days)
    print(json.dumps(r, indent=2) if args.json else format_report(r))


if __name__ == "__main__":
    main()
