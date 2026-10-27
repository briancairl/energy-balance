#!/usr/bin/env python3
"""
ironman_calibrate.py — fits "IronMan mode" parameters from the athlete's own
logged history. Python 3 stdlib only (same rule as server.py).

    python3 src/python/ironman_calibrate.py --store secrets/app_store.json \
        [--plan configs/schedule_sources/plan.json ...] [--out calibration.json]

Also imported by server.py (POST /api/ironman/calibrate re-runs it and writes
the result to the `ironman-calibration` store key via update_store; GET
/api/ironman/projection runs project_plan() over the schedule_sources/ plans).

What it fits (all pure functions, unit-tested in test_ironman_calibrate.py
against synthetic fixtures):

1. Session-cost model (fit_session_costs): kcal/hour per discipline (Swim,
   Run, Ride incl. VirtualRide, Strength) as a function of intensity, from
   strava-cache activities that carry `calories` (activity-kcal-overrides win).
   Intensity proxy: average power / FTP for rides (kilojoules / moving_time;
   FTP from intervals.icu eFTP, else plan meta, else 285 W), Strava
   suffer_score per hour for runs and swims (the cache stores no distance, so
   pace isn't available). Ride calories are sanity-checked against kJ; a
   ride whose calories/kJ ratio is far off the athlete's own median is
   replaced by kJ x median ratio. Each discipline gets a weighted linear fit
   kcal/h = a + b*x, evaluated at a per-zone reference intensity and shrunk
   toward the empirical per-zone mean where there's data. The result is
   compared with the app's generic MET table at the athlete's weight.

2. Energy-balance fit (fit_energy_balance): a 1-D Kalman filter over tissue
   weight, w[t+1] = w[t] + (intake[t] - E[t]) / 7700, with
   E[t] = neat * BMR(w[t]) + k * sessionKcal[t], weigh-ins as noisy
   measurements (measurement variance inflated the morning after a big day
   or a big carb swing, to absorb glycogen/water). neat and k are found by a
   grid search over the Kalman innovation log-likelihood plus a Gaussian
   prior centred on the app's current equivalent values; posterior mean, SD
   and correlation come straight off the grid. `neat` here is an EFFECTIVE
   multiplier that absorbs the +5% fatigue buffer, and `k` absorbs EPOC —
   IronMan mode uses them as demand = neat*BMR + k*sessionKcal with no
   separate EPOC/fatigue terms.

3. Empirical relation (fit_empirical_relation): weekly mean intake,
   corrected by the smoothed weight slope (x 7700) where weigh-ins exist, vs
   weekly training hours / activity kcal / CTL. Plain OLS, reported with R^2.

4. Projection (project_plan): per plan week, mean daily calibrated demand
   (and demand + goal surplus), carb g/day and g/kg, using the plan sessions'
   own zone when present.
"""
import argparse
import datetime as dt
import json
import math
import os
import sys

KCAL_PER_KG = 7700.0
DEFAULT_FTP = 285.0

# App's generic MET table (src/js/app-source.jsx ZONES) — kept here only to
# report the bias of the calibrated model against it.
APP_ZONE_MET = {1: 4.0, 2: 7.0, 3: 9.0, 4: 11.5, 5: 14.0}
APP_ZONE_IF = {1: 0.55, 2: 0.65, 3: 0.75, 4: 0.85, 5: 0.95}

DISCIPLINES = ("Swim", "Run", "Ride", "Strength")
STRAVA_TYPE_TO_DISC = {
    "Swim": "Swim", "Run": "Run", "TrailRun": "Run", "VirtualRun": "Run",
    "Ride": "Ride", "VirtualRide": "Ride", "GravelRide": "Ride", "MountainBikeRide": "Ride",
    "WeightTraining": "Strength", "Workout": "Strength", "Crossfit": "Strength",
}
PLAN_DISC_TO_DISC = {"swim": "Swim", "bike": "Ride", "run": "Run", "strength": "Strength"}

# Intensity proxy -> zone bands (upper bounds), and the reference proxy value
# a plan session LABELLED with that zone averages over its whole duration
# (a "Z4" threshold session still has a warm-up/cool-down, so its session
# average sits well below threshold).
ZONE_BANDS = {
    "Ride": [0.55, 0.72, 0.80, 0.90],   # avg power / FTP
    "Run": [50, 85, 110, 135],          # suffer_score / hour
    "Swim": [20, 40, 60, 90],
    "Strength": [1e9, 1e9, 1e9, 1e9],   # always zone 1
}
ZONE_REF = {
    "Ride": {1: 0.50, 2: 0.65, 3: 0.73, 4: 0.79, 5: 0.83},
    "Run": {1: 40, 2: 75, 3: 100, 4: 120, 5: 140},
    "Swim": {1: 12, 2: 25, 3: 45, 4: 60, 5: 75},
    "Strength": {1: 0, 2: 0, 3: 0, 4: 0, 5: 0},
}
MIN_ACTIVITY_SEC = 600

# Carb periodization by day load (session kcal, calibrated). Piecewise-linear
# so there's no cliff between bands: ~5-7 g/kg easy, 8-10 moderate-long,
# 10-12 big days. Mirrored in app-source.jsx (IM_CARB_LOAD_ANCHORS).
CARB_LOAD_ANCHORS = [(0, 5.0), (600, 6.0), (1200, 7.5), (2000, 9.0), (2800, 10.5), (4000, 12.0)]
# IOC/Burke tiers, same as the app's FUEL_TIERS.
FUEL_TIERS = [(20, 3, 5), (60, 5, 7), (180, 6, 10), (float("inf"), 8, 12)]


# ---------------------------------------------------------------- helpers

def normalize_nutrition_entry(raw):
    """Mirror of server.normalize_nutrition_entry / the JS helper."""
    if not raw:
        return {"manual": None, "macrosfirst": None}
    if isinstance(raw, dict) and ("manual" in raw or "macrosfirst" in raw):
        return {"manual": raw.get("manual"), "macrosfirst": raw.get("macrosfirst")}
    return {"manual": raw, "macrosfirst": None}


def effective_nutrition_entry(raw):
    n = normalize_nutrition_entry(raw)
    return n["macrosfirst"] or n["manual"] or None


def fnum(v, default=None):
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def calc_bmr(sex, kg, cm, age):
    base = 10 * kg + 6.25 * cm - 5 * age
    return base - 161 if sex == "female" else base + 5


def d2s(d):
    return d.isoformat()


def s2d(s):
    return dt.date.fromisoformat(s[:10])


def week_start(d):
    return d - dt.timedelta(days=d.weekday())


def wls(xs, ys, ws):
    """Weighted least squares y = a + b x. Returns (a, b, se_a, se_b, r2)."""
    sw = sum(ws)
    if sw <= 0 or len(xs) < 2:
        return None
    mx = sum(w * x for x, w in zip(xs, ws)) / sw
    my = sum(w * y for y, w in zip(ys, ws)) / sw
    sxx = sum(w * (x - mx) ** 2 for x, w in zip(xs, ws))
    sxy = sum(w * (x - mx) * (y - my) for x, y, w in zip(xs, ys, ws))
    if sxx <= 1e-12:
        return (my, 0.0, None, None, 0.0)
    b = sxy / sxx
    a = my - b * mx
    resid = [y - (a + b * x) for x, y in zip(xs, ys)]
    sse = sum(w * r * r for r, w in zip(resid, ws))
    sst = sum(w * (y - my) ** 2 for y, w in zip(ys, ws))
    n = len(xs)
    sigma2 = sse / sw * n / max(1, n - 2)  # residual variance per unit weight (approx)
    se_b = math.sqrt(sigma2 / sxx * (sw / n)) if n > 2 else None
    se_a = math.sqrt(sigma2 * (1 / n + mx * mx / sxx * (sw / n))) if n > 2 else None
    r2 = 1 - sse / sst if sst > 0 else 0.0
    return (a, b, se_a, se_b, r2)


def interp(anchors, x):
    if x <= anchors[0][0]:
        return anchors[0][1]
    for (x0, y0), (x1, y1) in zip(anchors, anchors[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return anchors[-1][1]


def carb_g_per_kg_for_load(session_kcal):
    return interp(CARB_LOAD_ANCHORS, max(0.0, session_kcal))


def ioc_carb_g_per_kg(duration_min, avg_if):
    blend = min(1.0, max(0.0, (avg_if - 0.5) / 0.8))
    for max_min, lo, hi in FUEL_TIERS:
        if duration_min < max_min:
            return lo + (hi - lo) * blend
    return FUEL_TIERS[-1][1]


# ------------------------------------------------------- athlete inputs

def athlete_inputs(store, plans=None):
    p = store.get("profile") or {}
    weights = {k: fnum(v) for k, v in (store.get("weight-log") or {}).items() if fnum(v)}
    latest_w = weights[max(weights)] if weights else fnum(p.get("weightKg"), 75.0)
    ftp, ftp_src = None, None
    for w in sorted(((store.get("intervals-cache") or {}).get("wellness") or []),
                    key=lambda x: x.get("id") or "", reverse=True):
        for si in (w.get("sportInfo") or []):
            if si.get("type") == "Ride" and fnum(si.get("eftp")):
                ftp, ftp_src = fnum(si["eftp"]), f"intervals.icu eFTP ({w.get('id')})"
                break
        if ftp:
            break
    if not ftp:
        for plan in plans or []:
            f = fnum(((plan.get("meta") or {}).get("athlete") or {}).get("estFTP"))
            if f:
                ftp, ftp_src = f, "plan meta.athlete.estFTP"
                break
    if not ftp:
        ftp, ftp_src = DEFAULT_FTP, "default"
    return {
        "sex": p.get("sex") or "male",
        "heightCm": fnum(p.get("heightCm"), 180.0),
        "age": fnum(p.get("age"), 35.0),
        "weightKg": latest_w,
        "neatMode": p.get("neatMode") or "multiplier",
        "neatFactor": fnum(p.get("neatFactor"), 1.15),
        "neatOffset": fnum(p.get("neatOffset"), 400.0),
        "epocSensitivity": fnum(p.get("epocSensitivity"), 1.0),
        "fatigueBuffer": bool(p.get("fatigueBuffer", True)),
        "goal": p.get("goal") or "maintain",
        "buildRatePct": fnum(p.get("buildRatePct"), 0.25),
        "loseRatePct": fnum(p.get("loseRatePct"), 0.5),
        "proteinGPerKg": fnum(p.get("proteinGPerKg"), 1.0),
        "targetWeightKg": fnum(p.get("targetWeightKg")),
        "ftp": ftp, "ftpSource": ftp_src,
    }


# ------------------------------------------------- 1. session-cost model

def extract_activities(store, ftp):
    """Flattens strava-cache activities into per-activity records with a
    discipline, hours, kcal (override > calories), and an intensity proxy."""
    overrides = store.get("activity-kcal-overrides") or {}
    acts = ((store.get("strava-cache") or {}).get("activities")) or []
    out = []
    for a in acts:
        disc = STRAVA_TYPE_TO_DISC.get(a.get("type"))
        sec = fnum(a.get("moving_time"), 0) or 0
        date = (a.get("start_date_local") or "")[:10]
        if not date:
            continue
        key = f"strava-{a.get('id')}"
        kcal = fnum(a.get("calories"))
        overridden = key in overrides and fnum(overrides[key]) is not None
        if overridden:
            kcal = fnum(overrides[key])
        kj = fnum(a.get("kilojoules"))
        ss = fnum(a.get("suffer_score"))
        hours = sec / 3600.0
        rec = {"id": key, "date": date, "type": a.get("type"), "disc": disc, "hours": hours,
               "kcal": kcal if kcal and kcal > 0 else None, "kj": kj, "ss": ss,
               "overridden": overridden, "name": a.get("name")}
        if disc == "Ride" and kj and sec > 0:
            rec["x"] = (kj * 1000.0 / sec) / ftp
        elif disc in ("Run", "Swim") and ss is not None and hours > 0:
            rec["x"] = ss / hours
        elif disc == "Strength":
            rec["x"] = 0.0
        else:
            rec["x"] = None
        out.append(rec)
    return out


def zone_for(disc, x):
    if x is None:
        return None
    for i, ub in enumerate(ZONE_BANDS[disc]):
        if x < ub:
            return i + 1
    return 5


def _median(v):
    s = sorted(v)
    n = len(s)
    if not n:
        return None
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def fit_session_costs(activities, weight_kg, ftp):
    """Returns ({disc: {...}}, notes). Each disc entry has kcalPerHourByZone
    {1..5}, the linear fit, per-zone empirical stats, and MET comparison."""
    notes = []
    # Ride calories vs kJ sanity check: calories should track mechanical work
    # (kJ) closely for power-metered rides. Strava's own conversion lands ~1
    # kcal per kJ (≈24% gross efficiency). Replace wild outliers.
    by_type_ratio = {}
    for a in activities:
        if a["disc"] == "Ride" and a["kcal"] and a["kj"] and a["hours"] * 3600 >= MIN_ACTIVITY_SEC and not a["overridden"]:
            by_type_ratio.setdefault(a["type"], []).append(a["kcal"] / a["kj"])
    ratio_med = {t: _median(v) for t, v in by_type_ratio.items()}
    all_r = [r for v in by_type_ratio.values() for r in v]
    ratio_all = _median(all_r) if all_r else 1.0
    replaced = []
    for a in activities:
        if a["disc"] != "Ride" or not a["kj"] or a["overridden"]:
            continue
        r_ref = ratio_med.get(a["type"], ratio_all) or ratio_all
        if a["kcal"] is None:
            a["kcal"], a["kcalSource"] = a["kj"] * r_ref, "kJ"
        elif not (0.8 * r_ref <= a["kcal"] / a["kj"] <= 1.25 * r_ref):
            replaced.append((a["date"], a["name"], round(a["kcal"]), round(a["kj"] * r_ref)))
            a["kcal"], a["kcalSource"] = a["kj"] * r_ref, "kJ (calories outlier)"
    if replaced:
        notes.append(f"{len(replaced)} ride(s) had calories inconsistent with kJ and were re-derived from kJ: "
                     + "; ".join(f"{d} '{n}' {c}->{k} kcal" for d, n, c, k in replaced[:6]))

    result = {}
    for disc in DISCIPLINES:
        rows = [a for a in activities if a["disc"] == disc and a["kcal"] and a["hours"] * 3600 >= MIN_ACTIVITY_SEC]
        with_x = [a for a in rows if a["x"] is not None]
        rates = [a["kcal"] / a["hours"] for a in rows]
        # Robust: drop per-activity rates more than 3.5 MAD from the median
        # (e.g. a 9-minute swim logged at 1,800 kcal/h).
        med = _median(rates) if rates else None
        mad = _median([abs(r - med) for r in rates]) if rates else None
        def ok(a):
            if med is None or not mad:
                return True
            return abs(a["kcal"] / a["hours"] - med) <= 3.5 * 1.4826 * mad
        kept = [a for a in with_x if ok(a)]
        n_out = len(with_x) - len(kept)
        fit = None
        if disc != "Strength" and len(kept) >= 4:
            fit = wls([a["x"] for a in kept], [a["kcal"] / a["hours"] for a in kept], [a["hours"] for a in kept])
        by_zone = {}
        for a in kept:
            z = zone_for(disc, a["x"])
            bz = by_zone.setdefault(z, {"n": 0, "hours": 0.0, "kcal": 0.0})
            bz["n"] += 1
            bz["hours"] += a["hours"]
            bz["kcal"] += a["kcal"]
        kcal_by_zone, detail = {}, {}
        overall = (sum(a["kcal"] for a in kept) / sum(a["hours"] for a in kept)) if kept else None
        for z in range(1, 6):
            if fit:
                a0, b0 = fit[0], fit[1]
                model = a0 + b0 * ZONE_REF[disc][z]
            else:
                model = overall
            bz = by_zone.get(z)
            emp = bz["kcal"] / bz["hours"] if bz and bz["hours"] > 0 else None
            # The per-zone rate is the fitted line at the reference intensity
            # a plan session LABELLED with that zone averages (ZONE_REF) — not
            # the mean of activities whose actual average fell in that band
            # (ZONE_BANDS); those binned means are reported alongside as a
            # diagnostic only. Mixing the two would bias plan estimates up.
            if model is None:
                val, src = APP_ZONE_MET[z] * weight_kg, "MET (no data)"
            else:
                val, src = model, ("fit" if fit else "overall mean")
            if fit and fit[4] < 0.1 and overall:
                val, src = overall, "overall mean (intensity proxy uninformative)"
            if z > 1 and val < kcal_by_zone[z - 1]:
                val = kcal_by_zone[z - 1]  # never cheaper at a higher zone
            if disc == "Strength":
                val = overall if overall else APP_ZONE_MET[1] * weight_kg
                src = "empirical (single rate)" if overall else "MET (no data)"
            met = APP_ZONE_MET[z] * weight_kg
            kcal_by_zone[z] = round(val, 1)
            detail[z] = {"kcalPerHour": round(val, 1), "source": src,
                         "n": bz["n"] if bz else 0, "hours": round(bz["hours"], 2) if bz else 0.0,
                         "empiricalKcalPerHour": round(emp, 1) if emp else None,
                         "appMetKcalPerHour": round(met, 1), "biasVsMetPct": round(100 * (val / met - 1), 1)}
        total_h = sum(a["hours"] for a in kept)
        met_equiv = sum(APP_ZONE_MET[zone_for(disc, a["x"]) or 2] * weight_kg * a["hours"] for a in kept)
        result[disc] = {
            "kcalPerHourByZone": kcal_by_zone,
            "zones": detail,
            "n": len(kept), "hours": round(total_h, 1), "outliersDropped": n_out,
            "overallKcalPerHour": round(overall, 1) if overall else None,
            "intensityProxy": {"Ride": "avg power / FTP", "Run": "suffer_score per hour",
                               "Swim": "suffer_score per hour", "Strength": "none"}[disc],
            "fit": ({"intercept": round(fit[0], 1), "slope": round(fit[1], 2),
                     "slopeSE": round(fit[3], 2) if fit[3] is not None else None, "r2": round(fit[4], 3)}
                    if fit else None),
            # Hours-weighted bias of the device calories vs the app's MET table
            # over the same sessions (each binned into its intensity zone).
            "biasVsMetPct": round(100 * (sum(a["kcal"] for a in kept) / met_equiv - 1), 1) if met_equiv else None,
        }
    result["_rideCalPerKj"] = {"median": round(ratio_all, 3) if all_r else None,
                               "byType": {t: round(v, 3) for t, v in ratio_med.items()}}
    swim = result.get("Swim")
    if swim and swim["n"] >= 5:
        srates = [a["kcal"] / a["hours"] for a in activities if a["disc"] == "Swim" and a["kcal"] and a["hours"] * 3600 >= MIN_ACTIVITY_SEC]
        near = sum(1 for r in srates if abs(r - _median(srates)) < 25)
        if near / len(srates) > 0.4:
            notes.append(f"{near}/{len(srates)} swims sit within ±25 kcal/h of {round(_median(srates))} kcal/h — "
                         "the device appears to apply a near-fixed per-minute rate for pool swims, so swim "
                         "calories carry little intensity information.")
    return result, notes


def session_kcal(costs, disc, zone, minutes):
    d = costs.get(disc)
    if not d:
        return APP_ZONE_MET.get(zone or 2, 7.0) * 75 * minutes / 60.0
    z = int(zone) if zone else 2
    z = min(5, max(1, z))
    rate = d["kcalPerHourByZone"].get(z) or d["kcalPerHourByZone"].get(str(z))
    return rate * minutes / 60.0


# --------------------------------------------- weight trend (local-linear KF)

def weight_trend(weight_log, r_kg=0.45, q_level=0.02, q_slope=0.002):
    """Local-linear-trend Kalman filter + RTS smoother over daily steps.
    State [level kg, slope kg/day]. Returns list of dicts per day from first
    to last weigh-in. Mirrored in app-source.jsx (smoothWeightTrend) as a
    forward filter only — the app wants 'as of today', not hindsight."""
    items = sorted((k, fnum(v)) for k, v in (weight_log or {}).items() if fnum(v))
    if len(items) < 2:
        return []
    d0, d1 = s2d(items[0][0]), s2d(items[-1][0])
    obs = dict(items)
    n = (d1 - d0).days + 1
    x = [items[0][1], 0.0]
    P = [[1.0, 0.0], [0.0, 0.01]]
    R = r_kg ** 2
    Q = [[q_level ** 2, 0.0], [0.0, q_slope ** 2]]
    xs_f, Ps_f, xs_p, Ps_p = [], [], [], []
    for i in range(n):
        if i > 0:
            x = [x[0] + x[1], x[1]]
            P = [[P[0][0] + 2 * P[0][1] + P[1][1] + Q[0][0], P[0][1] + P[1][1]],
                 [P[0][1] + P[1][1], P[1][1] + Q[1][1]]]
        xs_p.append(list(x))
        Ps_p.append([row[:] for row in P])
        z = obs.get(d2s(d0 + dt.timedelta(days=i)))
        if z is not None:
            S = P[0][0] + R
            K0, K1 = P[0][0] / S, P[0][1] / S
            y = z - x[0]
            x = [x[0] + K0 * y, x[1] + K1 * y]
            P = [[(1 - K0) * P[0][0], (1 - K0) * P[0][1]],
                 [P[0][1] - K1 * P[0][0], P[1][1] - K1 * P[0][1]]]
        xs_f.append(list(x))
        Ps_f.append([row[:] for row in P])
    # RTS smoother, F = [[1,1],[0,1]]
    xs = [None] * n
    Ps = [None] * n
    xs[-1], Ps[-1] = xs_f[-1], Ps_f[-1]
    for i in range(n - 2, -1, -1):
        Pf = Ps_f[i]
        Pp = Ps_p[i + 1]
        # C = Pf F^T Pp^-1
        PfFt = [[Pf[0][0] + Pf[0][1], Pf[0][1]], [Pf[1][0] + Pf[1][1], Pf[1][1]]]
        det = Pp[0][0] * Pp[1][1] - Pp[0][1] * Pp[1][0]
        inv = [[Pp[1][1] / det, -Pp[0][1] / det], [-Pp[1][0] / det, Pp[0][0] / det]]
        C = [[PfFt[r][0] * inv[0][c] + PfFt[r][1] * inv[1][c] for c in range(2)] for r in range(2)]
        dx = [xs[i + 1][0] - xs_p[i + 1][0], xs[i + 1][1] - xs_p[i + 1][1]]
        xs[i] = [xs_f[i][0] + C[0][0] * dx[0] + C[0][1] * dx[1], xs_f[i][1] + C[1][0] * dx[0] + C[1][1] * dx[1]]
        dP = [[Ps[i + 1][r][c] - Pp[r][c] for c in range(2)] for r in range(2)]
        CdP = [[C[r][0] * dP[0][c] + C[r][1] * dP[1][c] for c in range(2)] for r in range(2)]
        Ps[i] = [[Pf[r][c] + CdP[r][0] * C[c][0] + CdP[r][1] * C[c][1] for c in range(2)] for r in range(2)]
    out = []
    for i in range(n):
        out.append({"date": d2s(d0 + dt.timedelta(days=i)),
                    "levelKg": xs[i][0], "levelSd": math.sqrt(max(0, Ps[i][0][0])),
                    "slopeKgPerDay": xs[i][1], "slopeSd": math.sqrt(max(0, Ps[i][1][1])),
                    "filteredLevelKg": xs_f[i][0], "filteredSlopeKgPerDay": xs_f[i][1],
                    "observedKg": obs.get(d2s(d0 + dt.timedelta(days=i)))})
    return out


# ------------------------------------------------ 2. energy-balance fit

def build_daily(store, costs, start, end, ftp):
    """Per-day intake, carbs and session kcal (device calories, override >
    calories > kJ-derived > modeled from the session-cost fit)."""
    nut = store.get("nutrition-log") or {}
    acts = extract_activities(store, ftp)
    # re-apply the ride kJ sanity correction exactly as the cost fit did
    _, _ = fit_session_costs(acts, 75.0, ftp)
    by_date = {}
    for a in acts:
        by_date.setdefault(a["date"], []).append(a)
    synced = set(((store.get("strava-cache") or {}).get("syncedDates")) or [])
    days = []
    d = start
    while d <= end:
        k = d2s(d)
        e = effective_nutrition_entry(nut.get(k))
        intake = fnum(e.get("calories")) if e else None
        carbs = fnum(e.get("carbs")) if e else None
        kcal, hours, imputed = 0.0, 0.0, 0
        for a in by_date.get(k, []):
            hours += a["hours"]
            if a["kcal"]:
                kcal += a["kcal"]
            elif a["disc"]:
                kcal += session_kcal(costs, a["disc"], zone_for(a["disc"], a["x"]) or 2, a["hours"] * 60)
                imputed += 1
        days.append({"date": k, "intake": intake, "carbs": carbs, "sessionKcal": kcal, "hours": hours,
                     "imputed": imputed, "synced": k in synced or bool(by_date.get(k))})
    # (loop advance)
        d += dt.timedelta(days=1)
    return days


def _kf_loglik(days, weights, neat, k, bmr_fn, w0, q_kg=0.05, r_kg=0.45, carb_mean=None):
    w, P = w0, 0.5 ** 2
    ll = 0.0
    prev = None
    for day in days:
        z = weights.get(day["date"])
        if z is not None:
            R = r_kg ** 2
            # glycogen/water: the morning after a big day or a big carb swing
            # carries extra, non-tissue weight noise.
            if prev is not None:
                if prev["sessionKcal"] > 2000:
                    R *= 2.0
                if carb_mean and prev["carbs"] is not None and abs(prev["carbs"] - carb_mean) > 200:
                    R *= 1.5
            S = P + R
            y = z - w
            ll += -0.5 * (math.log(2 * math.pi * S) + y * y / S)
            K = P / S
            w += K * y
            P *= (1 - K)
        if day["intake"] is not None:
            E = neat * bmr_fn(w) + k * day["sessionKcal"]
            w += (day["intake"] - E) / KCAL_PER_KG
            P += q_kg ** 2
        else:
            P += q_kg ** 2 + (600 / KCAL_PER_KG) ** 2  # unknown intake: ~±600 kcal
        prev = day
    return ll


def fit_energy_balance(days, weights, bmr_fn, prior_neat, prior_k, prior_sd_neat=0.10, prior_sd_k=0.15,
                       neat_grid=(0.9, 1.9, 0.01), k_grid=(0.5, 1.6, 0.01), q_kg=0.05, r_kg=0.45):
    """Grid posterior over (neat, k). `days` must start on/just before the
    first weigh-in. Returns posterior summary + data-only MLE."""
    wdays = [d for d in days if d["date"] in weights]
    if len(wdays) < 5:
        return {"insufficient": True, "nWeighIns": len(wdays)}
    w0 = weights[wdays[0]["date"]]
    carbs = [d["carbs"] for d in days if d["carbs"] is not None]
    carb_mean = sum(carbs) / len(carbs) if carbs else None

    def frange(lo, hi, st):
        n = int(round((hi - lo) / st)) + 1
        return [round(lo + i * st, 6) for i in range(n)]
    ng, kg = frange(*neat_grid), frange(*k_grid)
    grid = []
    best_ll, best = -1e18, None
    for nv in ng:
        row = []
        for kv in kg:
            ll = _kf_loglik(days, weights, nv, kv, bmr_fn, w0, q_kg, r_kg, carb_mean)
            lp = -0.5 * ((nv - prior_neat) / prior_sd_neat) ** 2 - 0.5 * ((kv - prior_k) / prior_sd_k) ** 2
            row.append((ll, ll + lp))
            if ll > best_ll:
                best_ll, best = ll, (nv, kv)
        grid.append(row)
    mx = max(c[1] for row in grid for c in row)
    tot = m_n = m_k = 0.0
    for i, nv in enumerate(ng):
        for j, kv in enumerate(kg):
            p = math.exp(grid[i][j][1] - mx)
            tot += p
            m_n += p * nv
            m_k += p * kv
    m_n /= tot
    m_k /= tot
    v_n = v_k = c_nk = 0.0
    for i, nv in enumerate(ng):
        for j, kv in enumerate(kg):
            p = math.exp(grid[i][j][1] - mx) / tot
            v_n += p * (nv - m_n) ** 2
            v_k += p * (kv - m_k) ** 2
            c_nk += p * (nv - m_n) * (kv - m_k)
    sd_n, sd_k = math.sqrt(v_n), math.sqrt(v_k)
    corr = c_nk / (sd_n * sd_k) if sd_n > 0 and sd_k > 0 else 0.0
    # How much the data moved us: posterior SD vs prior SD (1.0 = learned nothing)
    # Data-only (flat-prior) marginal SD of the total daily expenditure level
    # is the better-identified quantity; report it.
    mean_bmr = sum(bmr_fn(weights[d["date"]]) for d in wdays) / len(wdays)
    logged = [d for d in days if d["intake"] is not None]
    mean_sess = sum(d["sessionKcal"] for d in logged) / len(logged)
    mean_intake = sum(d["intake"] for d in logged) / len(logged)
    tot_e_mean = m_n * mean_bmr + m_k * mean_sess
    tot_e_var = (mean_bmr * sd_n) ** 2 + (mean_sess * sd_k) ** 2 + 2 * mean_bmr * mean_sess * c_nk
    return {
        "insufficient": False,
        "neat": round(m_n, 3), "neatSd": round(sd_n, 3),
        "activityScale": round(m_k, 3), "activityScaleSd": round(sd_k, 3),
        "corrNeatScale": round(corr, 3),
        "prior": {"neat": prior_neat, "neatSd": prior_sd_neat, "activityScale": prior_k, "activityScaleSd": prior_sd_k},
        "shrinkage": {"neatSdRatio": round(sd_n / prior_sd_neat, 2), "activityScaleSdRatio": round(sd_k / prior_sd_k, 2)},
        "dataOnlyMle": {"neat": best[0], "activityScale": best[1]},
        "meanDailyExpenditure": round(tot_e_mean), "meanDailyExpenditureSd": round(math.sqrt(max(0, tot_e_var))),
        "meanDailyIntake": round(mean_intake), "meanDailySessionKcal": round(mean_sess), "meanBmr": round(mean_bmr),
        "nDays": len(days), "nWeighIns": len(wdays),
        "noise": {"processKgPerDay": q_kg, "measurementKg": r_kg},
    }


# ------------------------------------------------ 3. empirical relation

def fit_empirical_relation(store, trend, today=None):
    today = today or dt.date.today()
    nut = store.get("nutrition-log") or {}
    acts = ((store.get("strava-cache") or {}).get("activities")) or []
    overrides = store.get("activity-kcal-overrides") or {}
    wk = {}
    for k, raw in nut.items():
        e = effective_nutrition_entry(raw)
        if not e or fnum(e.get("calories")) is None:
            continue
        ws = d2s(week_start(s2d(k)))
        w = wk.setdefault(ws, {"intake": [], "hours": 0.0, "actKcal": 0.0, "actKcalN": 0, "actN": 0, "ctl": []})
        w["intake"].append(fnum(e["calories"]))
    first_act = None
    for a in acts:
        k = (a.get("start_date_local") or "")[:10]
        if not k:
            continue
        first_act = k if first_act is None or k < first_act else first_act
        ws = d2s(week_start(s2d(k)))
        w = wk.setdefault(ws, {"intake": [], "hours": 0.0, "actKcal": 0.0, "actKcalN": 0, "actN": 0, "ctl": []})
        w["hours"] += (fnum(a.get("moving_time"), 0) or 0) / 3600
        w["actN"] += 1
        kc = fnum(overrides.get(f"strava-{a.get('id')}")) or fnum(a.get("calories"))
        if kc:
            w["actKcal"] += kc
            w["actKcalN"] += 1
    # intervals.icu seeds CTL at 0 on the first day it has history, so CTL
    # is an artifact of that start date (not fitness) for roughly one
    # 42-day time constant afterwards — skip that warm-up.
    wellness = [x for x in ((store.get("intervals-cache") or {}).get("wellness")) or []
                if fnum(x.get("ctl")) is not None and x.get("id")]
    ctl_valid_from = None
    if wellness:
        ctl_valid_from = d2s(s2d(min(x["id"] for x in wellness)) + dt.timedelta(days=42))
    for x in wellness:
        if x["id"] >= ctl_valid_from:
            ws = d2s(week_start(s2d(x["id"])))
            if ws in wk:
                wk[ws]["ctl"].append(fnum(x["ctl"]))
    slope_by_date = {t["date"]: t["slopeKgPerDay"] for t in trend}
    cur_ws = d2s(week_start(today))
    rows, excluded = [], []
    for ws in sorted(wk):
        w = wk[ws]
        if ws >= cur_ws or len(w["intake"]) < 5:
            excluded.append((ws, "partial/current week"))
            continue
        if first_act and ws < d2s(week_start(s2d(first_act))):
            excluded.append((ws, "before first Strava activity (training unknown)"))
            continue
        intake = sum(w["intake"]) / len(w["intake"])
        slopes = [slope_by_date[d2s(s2d(ws) + dt.timedelta(days=i))] for i in range(7)
                  if d2s(s2d(ws) + dt.timedelta(days=i)) in slope_by_date]
        slope = sum(slopes) / len(slopes) if slopes else None
        stable = intake - slope * KCAL_PER_KG if slope is not None else intake
        rows.append({"weekStart": ws, "intake": round(intake), "hours": round(w["hours"], 2),
                     "actKcalPerDay": round(w["actKcal"] / 7) if w["actN"] and w["actKcalN"] >= 0.8 * w["actN"] else None,
                     "ctl": round(sum(w["ctl"]) / len(w["ctl"]), 1) if w["ctl"] else None,
                     "trendKgPerWeek": round(slope * 7, 3) if slope is not None else None,
                     "weightStableIntake": round(stable), "weightKnown": slope is not None})

    def ols(key, rows_):
        pts = [(r[key], r["weightStableIntake"]) for r in rows_ if r[key] is not None]
        f = wls([p[0] for p in pts], [p[1] for p in pts], [1.0] * len(pts))
        if not f:
            return None
        resid = [y - (f[0] + f[1] * x) for x, y in pts]
        sd = math.sqrt(sum(r * r for r in resid) / max(1, len(pts) - 2))
        return {"intercept": round(f[0]), "slope": round(f[1], 2), "slopeSE": round(f[3], 2) if f[3] else None,
                "r2": round(f[4], 3), "residualSd": round(sd), "n": len(pts),
                "xRange": [min(p[0] for p in pts), max(p[0] for p in pts)]}
    return {
        "weeks": rows,
        "excludedWeeks": excluded,
        "vsHours": ols("hours", rows),
        "vsHoursWeighInWeeksOnly": ols("hours", [r for r in rows if r["weightKnown"]]),
        "vsActivityKcalPerDay": ols("actKcalPerDay", rows),
        "vsCtl": ols("ctl", rows),
        "ctlValidFrom": ctl_valid_from,
        "note": ("Weeks without weigh-ins are assumed weight-stable (intake taken as-is); weeks with "
                 "weigh-ins are corrected by the smoothed weight slope x 7700 kcal/kg."),
    }


# ---------------------------------------------------- 4. plan projection

def classify_zone(disc, title, detail):
    """Same heuristic as schedule_sync.classify_zone (duplicated to keep this
    module importable on its own)."""
    if disc == "strength":
        return 1
    text = f"{title} {detail}".lower()
    if "recovery" in text and "spin" in text:
        return 1
    if any(k in text for k in ["dress rehearsal", "marathon pace", "tempo", "threshold", "race power",
                                "race-pace", "race pace", "hills", "surges", "70.3 pace"]):
        return 3
    return 2


def day_carb_g_per_kg(sessions_for_day, costs, k_scale):
    """sessions_for_day: list of (disc, zone, mins). Returns (gPerKg, sessionKcal)."""
    mins = sum(m for _, _, m in sessions_for_day)
    kcal = sum(k_scale * session_kcal(costs, d, z, m) for d, z, m in sessions_for_day)
    avg_if = (sum(APP_ZONE_IF.get(z, 0.65) * m for _, z, m in sessions_for_day) / mins) if mins else 0.5
    return max(ioc_carb_g_per_kg(mins, avg_if), carb_g_per_kg_for_load(kcal)), kcal


def project_plan(plans, calibration, athlete, start=None, end=None):
    """Weekly projection from plan JSON(s). Returns list of week dicts.
    Uses the latest athlete weight throughout (no projected weight drift)."""
    costs = calibration["sessionCost"]
    eb = calibration["energyBalance"]
    neat = eb["neat"]
    k = eb["activityScale"]
    w = athlete["weightKg"]
    bmr = calc_bmr(athlete["sex"], w, athlete["heightCm"], athlete["age"])
    goal = athlete["goal"]
    goal_kcal = 0.0
    if goal == "build":
        goal_kcal = athlete["buildRatePct"] / 100 * w * KCAL_PER_KG / 7
    elif goal == "lose":
        goal_kcal = -athlete["loseRatePct"] / 100 * w * KCAL_PER_KG / 7
    protein_g = (athlete.get("targetWeightKg") or w) * athlete["proteinGPerKg"]
    # Several plan files can cover the same week (an old export left beside
    # a regenerated one). Callers pass plans oldest -> newest; for each week
    # the LAST plan that has it wins outright (never summed, which would
    # double-count).
    weeks = {}
    for plan in plans:
        for wk in plan.get("weeks", []):
            ws = wk.get("weekStart")
            if not ws:
                continue
            if start and ws < start:
                continue
            if end and ws > end:
                continue
            weeks[ws] = {"wk": wk, "sessions": list(wk.get("sessions", []))}
    out = []
    for ws in sorted(weeks):
        wk = weeks[ws]["wk"]
        days = {i: [] for i in range(7)}
        race_days = []
        planned_min = 0
        for s in weeks[ws]["sessions"]:
            disc = PLAN_DISC_TO_DISC.get(s.get("disc"))
            mins = fnum(s.get("mins"), 0) or 0
            if not disc or mins <= 0:
                continue
            try:
                di = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].index(s["day"])
            except (KeyError, ValueError):
                continue
            zone = s.get("zone") if isinstance(s.get("zone"), int) else classify_zone(s["disc"], s.get("title", ""), s.get("detail", ""))
            if (s.get("title") or "").upper().startswith("RACE"):
                # Race day itself is excluded from the weekly averages (the
                # app's race entry + carb-load logic handles it).
                race_days.append({"day": s["day"], "title": s["title"], "mins": mins})
                continue
            planned_min += mins
            days[di].append((disc, zone, mins))
        dem, carbs, gkg, sess, tgt, fats = [], [], [], [], [], []
        for i in range(7):
            if race_days and any(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].index(r["day"]) == i for r in race_days):
                continue  # race day itself is excluded from the weekly average
            g, skcal = day_carb_g_per_kg(days[i], costs, k)
            d = neat * bmr + skcal
            # Same macro bookkeeping as the app: fat fills the remainder,
            # floored at 20% of Target; Target never below the macro sum.
            t = d + goal_kcal
            fat = max(t * 0.20 / 9, (t - g * w * 4 - protein_g * 4) / 9)
            t = max(t, g * w * 4 + protein_g * 4 + fat * 9)
            dem.append(d)
            tgt.append(t)
            fats.append(fat)
            sess.append(skcal)
            gkg.append(g)
            carbs.append(g * w)
        n = len(dem) or 1
        avg_dem = sum(dem) / n
        avg_carb = sum(carbs) / n
        target = sum(tgt) / n
        carb_kcal_share = avg_carb * 4 / target if target else None
        out.append({
            "weekStart": ws, "phase": wk.get("phase"), "plannedHours": round(planned_min / 60, 1),
            "planTotalHours": wk.get("totalHours"),
            "sessionKcalPerDay": round(sum(sess) / n),
            "demandKcalPerDay": round(avg_dem), "targetKcalPerDay": round(target),
            "peakDayDemandKcal": round(max(dem)) if dem else None,
            "daysOver6500": sum(1 for x in tgt if x > 6500),
            "carbGPerDay": round(avg_carb), "carbGPerKg": round(avg_carb / w, 2),
            "peakDayCarbGPerKg": round(max(gkg), 1) if gkg else None,
            "proteinGPerDay": round(protein_g),
            "fatGPerDay": round(sum(fats) / n),
            "carbShareOfTarget": round(carb_kcal_share, 2) if carb_kcal_share else None,
            "raceDays": race_days,
        })
    return out


# ------------------------------------------------------------- driver

def run_calibration(store, plans=None, today=None):
    today = today or dt.date.today()
    ath = athlete_inputs(store, plans)
    acts = extract_activities(store, ath["ftp"])
    costs, cost_notes = fit_session_costs(acts, ath["weightKg"], ath["ftp"])
    weights = {k: fnum(v) for k, v in (store.get("weight-log") or {}).items() if fnum(v)}
    trend = weight_trend(weights)
    notes = list(cost_notes)
    eb = {"insufficient": True}
    window = None
    if len(weights) >= 5:
        w_start, w_end = s2d(min(weights)), s2d(max(weights))
        days = build_daily(store, costs, w_start, w_end, ath["ftp"])
        imputed = sum(d["imputed"] for d in days)
        if imputed:
            notes.append(f"{imputed} activity(ies) in the weigh-in window had no calories/kJ; modeled from the session-cost fit.")
        def bmr_fn(wkg):
            return calc_bmr(ath["sex"], wkg, ath["heightCm"], ath["age"])
        # Prior: the app's CURRENT model, expressed in IronMan-mode terms.
        # Effective NEAT absorbs the +5% fatigue buffer when it's enabled (TSB
        # was below -10 on most build days); the activity scale absorbs EPOC
        # (5-12% of session kcal x epocSensitivity; ~8% typical).
        if ath["neatMode"] == "offset":
            mean_bmr = sum(bmr_fn(v) for v in weights.values()) / len(weights)
            prior_neat = 1 + ath["neatOffset"] / mean_bmr
        else:
            prior_neat = ath["neatFactor"]
        if ath["fatigueBuffer"]:
            prior_neat += 0.05
        prior_k = 1 + 0.08 * ath["epocSensitivity"]
        eb = fit_energy_balance(days, weights, bmr_fn, round(prior_neat, 3), round(prior_k, 3))
        window = {"start": d2s(w_start), "end": d2s(w_end)}
        if not eb.get("insufficient"):
            if eb["shrinkage"]["neatSdRatio"] > 0.8 and eb["shrinkage"]["activityScaleSdRatio"] > 0.8:
                notes.append("Weigh-in data barely narrowed either parameter individually (posterior SD > 80% of "
                             "prior SD); the TOTAL expenditure level is what the data pins down — the NEAT vs "
                             "activity-scale split leans on the prior.")
    if eb.get("insufficient"):
        eb.update({"neat": ath["neatFactor"], "activityScale": 1.0, "neatSd": None, "activityScaleSd": None})
    empirical = fit_empirical_relation(store, trend, today)
    nut = store.get("nutrition-log") or {}
    act_dates = sorted(a["date"] for a in acts)
    data_window = {
        "nutrition": [min(nut), max(nut)] if nut else None,
        "weighIns": [min(weights), max(weights)] if weights else None,
        "nWeighIns": len(weights),
        "activities": [act_dates[0], act_dates[-1]] if act_dates else None,
        "activitiesWithCalories": sum(1 for a in acts if a["kcal"]),
        "nActivities": len(acts),
    }
    last_t = trend[-1] if trend else None
    cal = {
        "version": 1,
        "fittedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "fittedOn": d2s(today),
        "dataWindow": data_window,
        "energyBalanceWindow": window,
        "athlete": {k: ath[k] for k in ("weightKg", "heightCm", "age", "sex", "ftp", "ftpSource")},
        "sessionCost": {d: costs[d] for d in DISCIPLINES},
        "rideCalPerKj": costs["_rideCalPerKj"],
        "energyBalance": eb,
        "empirical": empirical,
        "weightTrend": ({"date": last_t["date"], "levelKg": round(last_t["filteredLevelKg"], 2),
                         "slopeKgPerWeek": round(last_t["filteredSlopeKgPerDay"] * 7, 3),
                         "smoothedSlopeKgPerWeek": round(last_t["slopeKgPerDay"] * 7, 3),
                         "slopeSdKgPerWeek": round(last_t["slopeSd"] * 7, 3)} if last_t else None),
        "carbLoadAnchors": CARB_LOAD_ANCHORS,
        "notes": notes,
    }
    return cal


def load_plans(paths):
    plans = []
    for p in paths or []:
        with open(p) as f:
            data = json.load(f)
        if isinstance(data, dict) and "weeks" in data:
            plans.append(data)
    return plans


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fit IronMan-mode calibration from an energy-balance store.")
    ap.add_argument("--store", required=True)
    ap.add_argument("--plan", action="append", default=[],
                    help="plan JSON (repeatable, oldest first — a later file wins for any week both cover)")
    ap.add_argument("--out", help="write calibration (+ projection) JSON here; default stdout")
    ap.add_argument("--from", dest="start", help="projection start week (YYYY-MM-DD)")
    ap.add_argument("--to", dest="end", help="projection end week (YYYY-MM-DD)")
    ap.add_argument("--today", help="override today's date (YYYY-MM-DD)")
    args = ap.parse_args(argv)
    with open(args.store) as f:
        store = json.load(f)
    plans = load_plans(args.plan)
    today = s2d(args.today) if args.today else None
    cal = run_calibration(store, plans, today)
    out = {"calibration": cal}
    if plans:
        out["projection"] = project_plan(plans, cal, athlete_inputs(store, plans), args.start, args.end)
    text = json.dumps(out, indent=2)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as f:
            f.write(text)
    else:
        sys.stdout.write(text + "\n")
    eb = cal["energyBalance"]
    print(f"[ironman-calibrate] NEAT(eff) {eb.get('neat')} ± {eb.get('neatSd')}, activity scale "
          f"{eb.get('activityScale')} ± {eb.get('activityScaleSd')}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
