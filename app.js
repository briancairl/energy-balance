(() => {
  const { useState, useEffect, useMemo, useCallback, useRef } = React;
  const {
    ComposedChart,
    Bar,
    Line,
    Cell,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ReferenceLine
  } = Recharts;
  const Papa = window.Papa;
  const ink = "var(--ink)";
  const panel = "var(--panel)";
  const panel2 = "var(--panel2)";
  const line = "var(--line)";
  const paper = "var(--paper)";
  const cyan = "var(--cyan)";
  const amber = "var(--amber)";
  const coral = "var(--coral)";
  const mint = "var(--mint)";
  const lavender = "var(--lavender)";
  const gold = "var(--gold)";
  const dim = "var(--dim)";
  const mono = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
  const grotesk = "'Space Grotesk', system-ui, sans-serif";
  const body = "'Inter', system-ui, sans-serif";
  function fmt(n, d = 0) {
    if (n === null || n === void 0 || Number.isNaN(n)) return "\u2014";
    return n.toLocaleString(void 0, { maximumFractionDigits: d, minimumFractionDigits: d });
  }
  function toISODate(d) {
    return d.toISOString().slice(0, 10);
  }
  function toLocalISODate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function parseFlexibleDate(raw) {
    if (raw === null || raw === void 0) return null;
    let s = String(raw).trim();
    if (!s) return null;
    s = s.replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\s*[AaPp][Mm])?$/, "");
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const [, y, mo, d] = m;
      const dt = new Date(Number(y), Number(mo) - 1, Number(d));
      return Number.isNaN(dt.getTime()) ? null : dt;
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      let [, mo, d, y] = m;
      if (y.length === 2) y = (Number(y) < 70 ? "20" : "19") + y;
      const dt = new Date(Number(y), Number(mo) - 1, Number(d));
      return Number.isNaN(dt.getTime()) ? null : dt;
    }
    const native = new Date(s);
    return Number.isNaN(native.getTime()) ? null : native;
  }
  function daysAgo(n) {
    const d = /* @__PURE__ */ new Date();
    d.setDate(d.getDate() - n);
    return d;
  }
  const KG_PER_LB = 0.45359237;
  const CM_PER_IN = 2.54;
  function kgToLb(kg) {
    return kg / KG_PER_LB;
  }
  function lbToKg(lb) {
    return lb * KG_PER_LB;
  }
  function cmToIn(cm) {
    return cm / CM_PER_IN;
  }
  function inToCm(inch) {
    return inch * CM_PER_IN;
  }
  function weightUnitLabel(units) {
    return units === "imperial" ? "lb" : "kg";
  }
  function heightUnitLabel(units) {
    return units === "imperial" ? "in" : "cm";
  }
  function kgToDisplay(kg, units) {
    return units === "imperial" ? kgToLb(kg) : kg;
  }
  function displayToKg(v, units) {
    return units === "imperial" ? lbToKg(v) : v;
  }
  function gPerKgToDisplay(g, units) {
    return units === "imperial" ? g * KG_PER_LB : g;
  }
  function displayToGPerKg(g, units) {
    return units === "imperial" ? g / KG_PER_LB : g;
  }
  function cmToDisplayLen(cm, units) {
    return units === "imperial" ? cmToIn(cm) : cm;
  }
  function displayToCm(v, units) {
    return units === "imperial" ? inToCm(v) : v;
  }
  function roundTo(n, decimals) {
    const f = 10 ** decimals;
    return Math.round(n * f) / f;
  }
  function useUnitInput(metricStr, units, toDisplay, toMetric, decimals = 1) {
    const [text, setText] = useState("");
    const lastSyncedRef = useRef({ metric: void 0, units: void 0 });
    useEffect(() => {
      if (metricStr === lastSyncedRef.current.metric && units === lastSyncedRef.current.units) return;
      lastSyncedRef.current = { metric: metricStr, units };
      const num = parseFloat(metricStr);
      setText(Number.isNaN(num) ? "" : String(roundTo(toDisplay(num, units), decimals)));
    }, [metricStr, units]);
    function onChange(e, onChangeMetric) {
      var _a;
      const raw = e.target.value;
      setText(raw);
      const num = parseFloat(raw);
      const metric = raw.trim() === "" ? "" : Number.isNaN(num) ? (_a = lastSyncedRef.current.metric) != null ? _a : "" : String(toMetric(num, units));
      lastSyncedRef.current = { metric, units };
      onChangeMetric(metric);
    }
    return [text, onChange];
  }
  async function fetchWithRetry(url, options, retries = 2, backoffMs = 300) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, options);
      } catch (e) {
        if (attempt >= retries) throw e;
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
      return res;
    }
  }
  async function storageGet(key, fallback) {
    try {
      const res = await fetchWithRetry(`/api/store?key=${encodeURIComponent(key)}`);
      if (!res.ok) return fallback;
      const data = await res.json();
      return data.value !== null && data.value !== void 0 ? data.value : fallback;
    } catch (e) {
      console.error("storage get failed", key, e);
      return fallback;
    }
  }
  async function storageSet(key, value) {
    try {
      await fetchWithRetry(`/api/store?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value)
      });
    } catch (e) {
      console.error("storage set failed", key, e);
    }
  }
  async function apiSaveNutritionDay(date, manual) {
    const res = await fetchWithRetry(`/api/nutrition/day?date=${date}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manual })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Save failed (${res.status}).`);
    return data.entry;
  }
  async function apiDeleteNutritionDay(date) {
    const res = await fetchWithRetry(`/api/nutrition/day/delete?date=${date}`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Delete failed (${res.status}).`);
    }
  }
  async function apiSaveNutritionBulk(days) {
    const res = await fetchWithRetry("/api/nutrition/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Import failed (${res.status}).`);
    return data.count;
  }
  async function apiImportScheduleFile(filename, data) {
    const res = await fetchWithRetry("/api/schedule/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, data })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || `Import failed (${res.status}).`);
    return result;
  }
  async function apiSetScheduleMatchOverride(date, plannedKey, actualKey) {
    const body2 = { plannedKey };
    if (actualKey !== void 0) body2.actualKey = actualKey;
    const res = await fetchWithRetry(`/api/schedule/match-override?date=${date}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body2)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Save failed (${res.status}).`);
    return data;
  }
  async function apiSaveWeightDay(date, kg) {
    const res = await fetchWithRetry(`/api/weight/day?date=${date}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kg })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Save failed (${res.status}).`);
    return data.kg;
  }
  async function apiDeleteWeightDay(date) {
    const res = await fetchWithRetry(`/api/weight/day/delete?date=${date}`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Delete failed (${res.status}).`);
    }
  }
  function normalizeNutritionEntry(raw) {
    var _a, _b;
    if (!raw) return { manual: null, macrosfirst: null };
    if (raw.manual !== void 0 || raw.macrosfirst !== void 0) {
      return { manual: (_a = raw.manual) != null ? _a : null, macrosfirst: (_b = raw.macrosfirst) != null ? _b : null };
    }
    return { manual: raw, macrosfirst: null };
  }
  function effectiveNutritionEntry(raw) {
    const n = normalizeNutritionEntry(raw);
    return n.macrosfirst || n.manual || null;
  }
  function calcBMR(sex, weightKg, heightCm, age) {
    if (!weightKg || !heightCm || !age) return null;
    const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
    return sex === "female" ? base - 161 : base + 5;
  }
  function activityKcal(act) {
    if (typeof act.calories === "number" && act.calories > 0) return act.calories;
    if (typeof act.icu_joules === "number" && act.icu_joules > 0) {
      const mechanicalKcal = act.icu_joules / 4184;
      return mechanicalKcal / 0.24;
    }
    return 0;
  }
  function stravaActivityKcal(act) {
    if (typeof act.calories === "number" && act.calories > 0) return act.calories;
    if (typeof act.kilojoules === "number") return act.kilojoules / 4.184 / 0.24;
    return 0;
  }
  function intensityFactor(act) {
    if (typeof act.icu_intensity === "number") return act.icu_intensity;
    if (typeof act.icu_training_load === "number" && act.moving_time) {
      const hrs = act.moving_time / 3600;
      if (hrs <= 0) return 0.7;
      const loadPerHr = act.icu_training_load / hrs;
      return Math.min(1.3, loadPerHr / 80);
    }
    return 0.7;
  }
  function epocFactorFor(IF) {
    if (IF >= 0.85) return 0.12;
    if (IF >= 0.7) return 0.08;
    return 0.05;
  }
  function stravaIntensityFactor(act) {
    if (typeof act.suffer_score === "number" && act.moving_time) {
      const hrs = act.moving_time / 3600;
      if (hrs <= 0) return 0.7;
      const perHr = act.suffer_score / hrs;
      return Math.min(1.3, Math.max(0.3, perHr / 60));
    }
    return 0.7;
  }
  const FUEL_TIERS = [
    { tier: "rest", label: "Rest / light", maxMin: 20, carbLo: 3, carbHi: 5, proLo: 1.2, proHi: 1.4 },
    { tier: "moderate", label: "Moderate (~1h)", maxMin: 60, carbLo: 5, carbHi: 7, proLo: 1.4, proHi: 1.6 },
    { tier: "endurance", label: "Endurance (1\u20133h)", maxMin: 180, carbLo: 6, carbHi: 10, proLo: 1.6, proHi: 1.8 },
    { tier: "extreme", label: "High-volume (3h+)", maxMin: Infinity, carbLo: 8, carbHi: 12, proLo: 1.8, proHi: 2 }
  ];
  function classifyTrainingTier(durationMin) {
    return FUEL_TIERS.find((t) => durationMin < t.maxMin) || FUEL_TIERS[FUEL_TIERS.length - 1];
  }
  function intensityBlend(avgIF) {
    return Math.min(1, Math.max(0, (avgIF - 0.5) / (1.3 - 0.5)));
  }
  const ZONES = [
    { n: 1, label: "Zone 1 \xB7 Recovery", hrPct: "<50% HRmax", met: 4, if: 0.55 },
    { n: 2, label: "Zone 2 \xB7 Aerobic", hrPct: "50\u201363% HRmax", met: 7, if: 0.65 },
    { n: 3, label: "Zone 3 \xB7 Tempo", hrPct: "64\u201376% HRmax", met: 9, if: 0.75 },
    { n: 4, label: "Zone 4 \xB7 Threshold", hrPct: "77\u201393% HRmax", met: 11.5, if: 0.85 },
    { n: 5, label: "Zone 5 \xB7 VO2max", hrPct: "93%+ HRmax", met: 14, if: 0.95 }
  ];
  const ACTIVITY_TYPES = ["Run", "Ride", "Swim", "Row", "Strength", "Other"];
  const FORWARD_DAYS = 4;
  const CHART_DAY_WIDTH = 70;
  function estimatePlannedKcal(session, durationMin, weightKg) {
    const src = session.sourceActivity;
    if (src && src.durationMin > 0 && src.kcal > 0) {
      return src.kcal / src.durationMin * durationMin;
    }
    const z = ZONES[session.zone - 1];
    if (!z || !weightKg) return 0;
    return z.met * weightKg * (durationMin / 60);
  }
  function mapToActivityType(rawType) {
    const t = (rawType || "").toLowerCase();
    if (t.includes("run") || t.includes("hike") || t.includes("walk")) return "Run";
    if (t.includes("ride") || t.includes("bike") || t.includes("cycl")) return "Ride";
    if (t.includes("swim")) return "Swim";
    if (t.includes("row")) return "Row";
    if (t.includes("weight") || t.includes("strength") || t.includes("workout")) return "Strength";
    return "Other";
  }
  function nearestZone(IF) {
    let best = ZONES[0], bestDiff = Infinity;
    for (const z of ZONES) {
      const diff = Math.abs(z.if - IF);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = z;
      }
    }
    return best.n;
  }
  const ACTIVITY_LIBRARY_DAYS = 180;
  function getActivityLibrary(stravaData, intervalsData) {
    const byDateStrava = {};
    for (const a of stravaData.activities) {
      const d = (a.start_date_local || "").slice(0, 10);
      if (!d) continue;
      (byDateStrava[d] || (byDateStrava[d] = [])).push(a);
    }
    const byDateIntervals = {};
    for (const a of intervalsData.activities) {
      const d = (a.start_date_local || a.start_date || "").slice(0, 10);
      if (!d) continue;
      (byDateIntervals[d] || (byDateIntervals[d] = [])).push(a);
    }
    const cutoff = toISODate(daysAgo(ACTIVITY_LIBRARY_DAYS));
    const dates = new Set([...Object.keys(byDateStrava), ...Object.keys(byDateIntervals)].filter((d) => d >= cutoff));
    const out = [];
    for (const d of dates) {
      const stravaActs = byDateStrava[d] || [];
      const acts = stravaActs.length ? stravaActs.map((a) => ({ provider: "strava", raw: a })) : (byDateIntervals[d] || []).map((a) => ({ provider: "intervals", raw: a }));
      for (const { provider, raw: a } of acts) {
        const kcal = provider === "strava" ? stravaActivityKcal(a) : activityKcal(a);
        const durationMin = Math.round((a.moving_time || 0) / 60);
        if (!kcal || !durationMin) continue;
        const IF = provider === "strava" ? stravaIntensityFactor(a) : intensityFactor(a);
        out.push({
          key: `${provider}-${a.id}`,
          provider,
          date: d,
          name: a.name || a.type || "Activity",
          rawType: a.type,
          activityType: mapToActivityType(a.type),
          durationMin,
          kcal: Math.round(kcal),
          intensityFactor: IF,
          zone: nearestZone(IF)
        });
      }
    }
    out.sort((a, b) => a.date < b.date ? 1 : -1);
    return out;
  }
  function isPreloadWorthy(session) {
    return session.durationMin >= 90 || session.zone >= 4;
  }
  function getScheduledSessionsForDate(schedule, dateStr) {
    const weekday = (/* @__PURE__ */ new Date(dateStr + "T00:00:00")).getDay();
    return schedule.filter((s) => {
      if (s.kind === "race") return false;
      if (s.kind === "single") return s.date === dateStr;
      if (!s.daysOfWeek.includes(weekday)) return false;
      if (dateStr < s.startDate) return false;
      if (s.endDate && dateStr > s.endDate) return false;
      return true;
    });
  }
  function getRaces(schedule) {
    return schedule.filter((s) => s.kind === "race");
  }
  function getUpcomingRace(schedule, dateStr) {
    const races = getRaces(schedule).filter((s) => s.raceDate >= dateStr);
    races.sort((a, b) => a.raceDate < b.raceDate ? -1 : 1);
    return races[0] || null;
  }
  function daysBetween(fromStr, toStr) {
    return Math.round((/* @__PURE__ */ new Date(toStr + "T00:00:00") - /* @__PURE__ */ new Date(fromStr + "T00:00:00")) / 864e5);
  }
  const TAPER_VOLUME_FLOOR = 0.4;
  const TAPER_INTENSITY_FLOOR = 0.9;
  function getTaperState(schedule, dateStr) {
    const race = getUpcomingRace(schedule, dateStr);
    if (!race || !race.taperDays) return null;
    const daysToRace = daysBetween(dateStr, race.raceDate);
    if (daysToRace <= 0 || daysToRace > race.taperDays) return null;
    const progress = race.taperDays > 1 ? (daysToRace - 1) / (race.taperDays - 1) : 0;
    const volumeFactor = TAPER_VOLUME_FLOOR + (1 - TAPER_VOLUME_FLOOR) * progress;
    const intensityFactor2 = TAPER_INTENSITY_FLOOR + (1 - TAPER_INTENSITY_FLOOR) * progress;
    return { race, daysToRace, volumeFactor, intensityFactor: intensityFactor2 };
  }
  function getEffectiveSessionsForDate(schedule, dateStr) {
    const sessions = getScheduledSessionsForDate(schedule, dateStr);
    const taper = getTaperState(schedule, dateStr);
    if (!taper) return { sessions, taper: null };
    const tapered = sessions.map((s) => ({
      ...s,
      durationMin: Math.max(0, Math.round(s.durationMin * taper.volumeFactor)),
      taperIntensityFactor: taper.intensityFactor
    }));
    return { sessions: tapered, taper };
  }
  const CARB_LOAD_DAYS = 3;
  const CARB_LOAD_MIN_DURATION = 90;
  function getCarbLoadState(schedule, dateStr) {
    const race = getUpcomingRace(schedule, dateStr);
    if (!race || race.durationMin < CARB_LOAD_MIN_DURATION) return null;
    const daysToRace = daysBetween(dateStr, race.raceDate);
    if (daysToRace <= 0 || daysToRace > CARB_LOAD_DAYS) return null;
    return { race, daysToRace };
  }
  function plannedMatchKey(planned) {
    return planned.isRace ? `race:${planned.id}` : `session:${planned.id}`;
  }
  function matchDayActivities(plannedItems, actuals, overrides) {
    overrides = overrides || {};
    const byKey = {};
    for (const a of actuals) byKey[a.key] = a;
    const claimed = /* @__PURE__ */ new Set();
    for (const planned of plannedItems) {
      const forced = overrides[plannedMatchKey(planned)];
      if (forced) claimed.add(forced);
    }
    const remaining = actuals.filter((a) => !claimed.has(a.key));
    const pairs = [];
    for (const planned of plannedItems) {
      const pk = plannedMatchKey(planned);
      if (Object.prototype.hasOwnProperty.call(overrides, pk)) {
        const forced = overrides[pk];
        pairs.push({ planned, actual: forced ? byKey[forced] || null : null, manual: true });
        continue;
      }
      const candidates = remaining.filter((a) => a.activityType === planned.activityType);
      let match = null;
      if (candidates.length) {
        candidates.sort((a, b) => Math.abs(a.durationMin - planned.durationMin) - Math.abs(b.durationMin - planned.durationMin));
        match = candidates[0];
        remaining.splice(remaining.indexOf(match), 1);
      }
      pairs.push({ planned, actual: match, manual: false });
    }
    return { pairs, extras: remaining };
  }
  const KCAL_PER_KG_TISSUE = 7700;
  const GOAL_DEFAULTS = {
    build: { ratePct: 0.25, min: 0.1, max: 0.75 },
    lose: { ratePct: 0.5, min: 0.25, max: 1.5 }
  };
  function getGoalParams(profile) {
    if (profile.goal === "build") return { sign: 1, ratePct: parseFloat(profile.buildRatePct) || GOAL_DEFAULTS.build.ratePct, label: "Building" };
    if (profile.goal === "lose") return { sign: -1, ratePct: parseFloat(profile.loseRatePct) || GOAL_DEFAULTS.lose.ratePct, label: "Losing" };
    return { sign: 0, ratePct: 0, label: "Maintaining" };
  }
  function computeTrendCorrection(weightLog, goalSign, ratePct) {
    const entries = Object.entries(weightLog).filter(([d]) => (/* @__PURE__ */ new Date() - new Date(d)) / 864e5 <= 21).sort(([a], [b]) => a < b ? -1 : 1);
    if (entries.length < 8) return { insufficient: true, n: entries.length };
    const t0 = new Date(entries[0][0]).getTime();
    const spanDays = (new Date(entries[entries.length - 1][0]).getTime() - t0) / 864e5;
    if (spanDays < 10) return { insufficient: true, n: entries.length, spanDays };
    const xs = entries.map(([d]) => (new Date(d).getTime() - t0) / 864e5);
    const ys = entries.map(([, kg]) => kg);
    const n = xs.length;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - meanX) * (ys[i] - meanY);
      den += (xs[i] - meanX) ** 2;
    }
    if (den === 0) return { insufficient: true, n };
    const actualWeeklyRateKg = num / den * 7;
    const targetWeeklyRateKg = goalSign * (ratePct / 100) * meanY;
    const rawCorrection = (targetWeeklyRateKg - actualWeeklyRateKg) * KCAL_PER_KG_TISSUE / 7;
    const correctionKcal = Math.max(-400, Math.min(400, rawCorrection));
    return { insufficient: false, n, spanDays, actualWeeklyRateKg, targetWeeklyRateKg, correctionKcal };
  }
  function computeRollingAvgWeight(weightLog, windowDays = 7) {
    const entries = Object.entries(weightLog);
    if (!entries.length) return null;
    const mostRecent = entries.map(([d]) => d).sort().pop();
    const cutoff = new Date(mostRecent);
    cutoff.setDate(cutoff.getDate() - (windowDays - 1));
    const inWindow = entries.filter(([d]) => new Date(d) >= cutoff).map(([, kg]) => kg);
    return inWindow.length ? inWindow.reduce((s, kg) => s + kg, 0) / inWindow.length : null;
  }
  function computeGoalWeightStatus(profile, weightTrendAvg) {
    const target = parseFloat(profile.targetWeightKg);
    if (!target || weightTrendAvg === null) return null;
    const diffKg = weightTrendAvg - target;
    const pct = Math.abs(diffKg) / target * 100;
    const direction = diffKg > 0 ? "above" : "below";
    if (profile.goal === "build") {
      if (diffKg <= 0) return null;
      return { severity: "high", pct, diffKg, direction, weightTrendAvg, target, suggestMaintain: true };
    }
    if (profile.goal === "lose") {
      if (diffKg >= 0) return null;
      return { severity: "high", pct, diffKg, direction, weightTrendAvg, target, suggestMaintain: true };
    }
    let severity = null;
    if (pct >= 10) severity = "high";
    else if (pct >= 5) severity = "medium";
    else if (pct >= 2) severity = "low";
    if (!severity) return null;
    return { severity, pct, diffKg, direction, weightTrendAvg, target, suggestMaintain: false };
  }
  function formatWeightGoalMessage(status, units) {
    const u = weightUnitLabel(units);
    const avg = fmt(kgToDisplay(status.weightTrendAvg, units), 1);
    const target = fmt(kgToDisplay(status.target, units), 1);
    const pct = fmt(status.pct, 1);
    return status.suggestMaintain ? `Averaging ${avg} ${u} (7-day) \u2014 ${pct}% ${status.direction} your ${target} ${u} target. Consider switching to Maintain.` : `Averaging ${avg} ${u} (7-day) \u2014 ${pct}% ${status.direction} your ${target} ${u} target weight.`;
  }
  function Icon({ path, size = 14, color = "currentColor" }) {
    return /* @__PURE__ */ React.createElement(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: color,
        strokeWidth: "2",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        style: { flexShrink: 0 }
      },
      /* @__PURE__ */ React.createElement("path", { d: path })
    );
  }
  const ICONS = {
    settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z",
    upload: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12",
    activity: "M22 12h-4l-3 9L9 3l-3 9H2",
    info: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01",
    refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15",
    flame: "M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 001.5 2.5z",
    gauge: "M12 15l3.5-3.5M20.5 12a8.5 8.5 0 10-17 0",
    warn: "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01",
    check: "M20 6L9 17l-5-5",
    link: "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71",
    pencil: "M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4z",
    trash: "M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z",
    plus: "M12 5v14M5 12h14",
    calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z",
    trophy: "M8 21h8M12 17v4M7 4h10v4a5 5 0 01-10 0V4zM7 4H3v2a4 4 0 004 4M17 4h4v2a4 4 0 01-4 4",
    sun: "M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42",
    moon: "M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"
  };
  const SEVERITY_COLOR = { low: cyan, medium: amber, high: coral };
  const SEVERITY_BG = { low: "rgba(79,209,217,0.08)", medium: "rgba(232,163,61,0.1)", high: "rgba(225,96,77,0.12)" };
  const BANNER_STYLE = {
    info: { color: cyan, bg: "rgba(79,209,217,0.08)" },
    success: { color: mint, bg: "rgba(127,200,169,0.12)" },
    warning: { color: amber, bg: "rgba(232,163,61,0.1)" },
    error: { color: coral, bg: "rgba(225,96,77,0.12)" }
  };
  function Banner({ kind = "info", children }) {
    const s = BANNER_STYLE[kind] || BANNER_STYLE.info;
    const iconPath = kind === "success" ? ICONS.check : ICONS.warn;
    return /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, background: s.bg, border: `1px solid ${s.color}`, borderRadius: 4, padding: "10px 12px", fontSize: 12.5, display: "flex", gap: 8, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement(Icon, { path: iconPath, size: 14, color: s.color }), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }, children));
  }
  function App() {
    const [tab, setTab] = useState("setup");
    const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === "light" ? "light" : "dark");
    const toggleTheme = useCallback(() => {
      setTheme((prev) => {
        const next = prev === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        localStorage.setItem("theme", next);
        return next;
      });
    }, []);
    const [profile, setProfile] = useState({
      sex: "male",
      weightKg: "",
      heightCm: "",
      age: "",
      neatMode: "multiplier",
      neatFactor: 1.15,
      neatOffset: 400,
      epocSensitivity: 1,
      fatigueBuffer: true,
      goal: "maintain",
      buildRatePct: GOAL_DEFAULTS.build.ratePct,
      loseRatePct: GOAL_DEFAULTS.lose.ratePct,
      targetWeightKg: "",
      trendCalibration: true,
      proteinGPerKg: 1,
      minFatG: 100,
      maxPreloadCarbGPerKg: 12,
      preloadBorrowRatio: 1,
      units: "metric"
    });
    const units = profile.units || "metric";
    const toggleUnits = useCallback(() => {
      setProfile((p) => ({ ...p, units: (p.units || "metric") === "imperial" ? "metric" : "imperial" }));
    }, []);
    const [loaded, setLoaded] = useState(false);
    const [nutrition, setNutrition] = useState({});
    const [weightLog, setWeightLog] = useState({});
    const [schedule, setSchedule] = useState([]);
    const [matchOverrides, setMatchOverrides] = useState({});
    const [csvPreview, setCsvPreview] = useState(null);
    const [csvPreviewSource, setCsvPreviewSource] = useState(null);
    const [colMap, setColMap] = useState({ date: "", calories: "", protein: "", carbs: "", fat: "" });
    const [intervalsData, setIntervalsData] = useState({ activities: [], wellness: [], syncedDates: [] });
    const [intervalsStatus, setIntervalsStatus] = useState({ configured: false, checked: false });
    const [rangeDays, setRangeDays] = useState(21);
    const [fetching, setFetching] = useState(false);
    const [fetchError, setFetchError] = useState(null);
    const [lastFetched, setLastFetched] = useState(null);
    const [stravaStatus, setStravaStatus] = useState({ connected: false, checked: false });
    const [stravaData, setStravaData] = useState({ activities: [], syncedDates: [] });
    const [stravaFetching, setStravaFetching] = useState(false);
    const [stravaError, setStravaError] = useState(null);
    const [stravaLastFetched, setStravaLastFetched] = useState(null);
    const [googleStatus, setGoogleStatus] = useState({ connected: false, checked: false });
    const [googleLastAutoSync, setGoogleLastAutoSync] = useState(null);
    const [googleFetching, setGoogleFetching] = useState(false);
    const [googleError, setGoogleError] = useState(null);
    useEffect(() => {
      (async () => {
        const [p, n, w, sched, matchOv, cached, stravaCached, gLastSync] = await Promise.all([
          storageGet("profile", null),
          storageGet("nutrition-log", {}),
          storageGet("weight-log", {}),
          storageGet("training-schedule", []),
          storageGet("schedule-match-overrides", {}),
          storageGet("intervals-cache", null),
          storageGet("strava-cache", null),
          storageGet("google-last-auto-sync", null)
        ]);
        setNutrition(n);
        setWeightLog(w);
        setSchedule(sched);
        setMatchOverrides(matchOv);
        setGoogleLastAutoSync(gLastSync);
        const latestWeightDate = Object.keys(w).sort().pop();
        const merged = { ...p || {} };
        if (latestWeightDate) merged.weightKg = String(w[latestWeightDate]);
        if (p || latestWeightDate) setProfile((prev) => ({ ...prev, ...merged }));
        if (cached) {
          setIntervalsData({
            activities: cached.activities || [],
            wellness: cached.wellness || [],
            syncedDates: cached.syncedDates || []
          });
          setLastFetched(cached.fetchedAt || null);
        }
        if (stravaCached) {
          setStravaData({ activities: stravaCached.activities || [], syncedDates: stravaCached.syncedDates || [] });
          setStravaLastFetched(stravaCached.fetchedAt || null);
        }
        setLoaded(true);
      })();
      fetch("/api/strava/status").then((r) => r.json()).then((s) => {
        setStravaStatus({ ...s, checked: true });
      }).catch(() => setStravaStatus({ connected: false, checked: true, unreachable: true }));
      fetch("/api/intervals/status").then((r) => r.json()).then((s) => {
        setIntervalsStatus({ ...s, checked: true });
      }).catch(() => setIntervalsStatus({ configured: false, checked: true, unreachable: true }));
      fetch("/api/google/status").then((r) => r.json()).then((s) => {
        setGoogleStatus({ ...s, checked: true });
      }).catch(() => setGoogleStatus({ connected: false, checked: true, unreachable: true }));
    }, []);
    useEffect(() => {
      if (loaded) storageSet("profile", profile);
    }, [profile, loaded]);
    const [importError, setImportError] = useState(null);
    const [importNotice, setImportNotice] = useState(null);
    const saveSchedule = useCallback((next) => {
      setSchedule(next);
      storageSet("training-schedule", next);
    }, []);
    function addScheduleEntry(entry) {
      saveSchedule([...schedule, { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }]);
    }
    function updateScheduleEntry(id, entry) {
      saveSchedule(schedule.map((s) => s.id === id ? { ...entry, id } : s));
    }
    function deleteScheduleEntry(id) {
      saveSchedule(schedule.filter((s) => s.id !== id));
    }
    async function setScheduleMatchOverride(date, plannedKey, actualKey) {
      const data = await apiSetScheduleMatchOverride(date, plannedKey, actualKey);
      setMatchOverrides((prev) => {
        const next = { ...prev };
        if (data.overrides && Object.keys(data.overrides).length) next[date] = data.overrides;
        else delete next[date];
        return next;
      });
    }
    const bmr = useMemo(
      () => calcBMR(profile.sex, parseFloat(profile.weightKg), parseFloat(profile.heightCm), parseFloat(profile.age)),
      [profile.sex, profile.weightKg, profile.heightCm, profile.age]
    );
    const goalParams = useMemo(() => getGoalParams(profile), [profile.goal, profile.buildRatePct, profile.loseRatePct]);
    const trendCorrection = useMemo(
      () => computeTrendCorrection(weightLog, goalParams.sign, goalParams.ratePct),
      [weightLog, goalParams]
    );
    const weightTrendAvg = useMemo(() => computeRollingAvgWeight(weightLog), [weightLog]);
    const weightGoalStatus = useMemo(
      () => computeGoalWeightStatus(profile, weightTrendAvg),
      [profile.goal, profile.targetWeightKg, weightTrendAvg]
    );
    function guessColumnMapping(fields) {
      const guess = (patterns) => fields.find((f) => patterns.some((p) => f.toLowerCase().includes(p))) || "";
      return {
        date: guess(["date"]),
        calories: guess(["calorie", "kcal", "energy"]),
        protein: guess(["protein"]),
        carbs: guess(["carb"]),
        fat: guess(["fat"])
      };
    }
    function handleCSVFile(file) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => {
          const fields = res.meta.fields || [];
          setColMap(guessColumnMapping(fields));
          setCsvPreview({ fields, rows: res.data });
          setCsvPreviewSource("csv");
          setImportError(null);
        },
        error: (err) => setImportError("Could not parse CSV: " + err.message)
      });
    }
    const [scheduleImportError, setScheduleImportError] = useState(null);
    const [scheduleImportNotice, setScheduleImportNotice] = useState(null);
    async function handleScheduleFile(file) {
      setScheduleImportError(null);
      setScheduleImportNotice(null);
      try {
        let parsed;
        try {
          parsed = JSON.parse(await file.text());
        } catch (e) {
          throw new Error(`"${file.name}" isn't valid JSON.`);
        }
        const result = await apiImportScheduleFile(file.name, parsed);
        setSchedule(result.schedule);
        setScheduleImportNotice(
          `Imported "${result.filename}" as source "${result.source}" \u2014 it'll auto-reimport from now on whenever that file's contents change.`
        );
      } catch (e) {
        setScheduleImportError(e.message || "Import failed.");
      }
    }
    async function syncGoogleSheet() {
      if (!googleStatus.connected) return;
      setGoogleFetching(true);
      setGoogleError(null);
      try {
        const res = await fetch("/api/google/sheet");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Google Sheets request failed (${res.status}).`);
        if (!data.fields.length) throw new Error("Sheet appears empty \u2014 check google_sheet_id and google_sheet_range in config.json.");
        const cachedMap = await storageGet("google-sheet-colmap", null);
        const cachedMapUsable = cachedMap && cachedMap.date && cachedMap.calories && [cachedMap.date, cachedMap.calories, cachedMap.protein, cachedMap.carbs, cachedMap.fat].every((f) => !f || data.fields.includes(f));
        if (cachedMapUsable) {
          setColMap(cachedMap);
          importMappedCSV({ fields: data.fields, rows: data.rows }, cachedMap, "sheet");
        } else {
          setColMap(guessColumnMapping(data.fields));
          setCsvPreview({ fields: data.fields, rows: data.rows });
          setCsvPreviewSource("sheet");
        }
      } catch (e) {
        setGoogleError(e.message || "Could not reach the local server's Google Sheets proxy.");
      } finally {
        setGoogleFetching(false);
      }
    }
    async function importMappedCSV(preview = csvPreview, map = colMap, source = csvPreviewSource) {
      var _a, _b, _c, _d, _e, _f;
      if (!preview || !map.date || !map.calories) {
        setImportError("Map at least the date and calories columns first.");
        return;
      }
      setImportError(null);
      const days = {};
      const skippedExamples = [];
      for (const row of preview.rows) {
        const rawDate = row[map.date];
        const d = parseFlexibleDate(rawDate);
        if (!d) {
          if (skippedExamples.length < 3) skippedExamples.push(JSON.stringify(rawDate));
          continue;
        }
        const key = toISODate(d);
        const existing = normalizeNutritionEntry(nutrition[key]);
        days[key] = {
          calories: parseFloat(row[map.calories]) || 0,
          protein: map.protein ? parseFloat(row[map.protein]) || 0 : (_b = (_a = existing.macrosfirst) == null ? void 0 : _a.protein) != null ? _b : 0,
          carbs: map.carbs ? parseFloat(row[map.carbs]) || 0 : (_d = (_c = existing.macrosfirst) == null ? void 0 : _c.carbs) != null ? _d : 0,
          fat: map.fat ? parseFloat(row[map.fat]) || 0 : (_f = (_e = existing.macrosfirst) == null ? void 0 : _e.fat) != null ? _f : 0
        };
      }
      const importedDates = Object.keys(days);
      if (importedDates.length) {
        try {
          await apiSaveNutritionBulk(days);
        } catch (e) {
          setImportError(e.message || "Could not import \u2014 the local server's /api/nutrition/bulk request failed.");
          return;
        }
        setNutrition((prev) => {
          const next = { ...prev };
          for (const key of importedDates) {
            next[key] = { ...normalizeNutritionEntry(next[key]), macrosfirst: days[key] };
          }
          return next;
        });
      }
      setCsvPreview(null);
      setCsvPreviewSource(null);
      if (source === "sheet") {
        storageSet("google-sheet-colmap", map);
      }
      if (importedDates.length === 0) {
        setImportNotice(null);
        setImportError(`0 rows imported \u2014 the date column's values couldn't be parsed. Example raw value(s): ${skippedExamples.join(", ")}. Double-check the date column is mapped correctly, or tell me what format that is and I'll add support for it.`);
      } else {
        setImportNotice(`Imported ${importedDates.length} day(s) of nutrition data from MacrosFirst${skippedExamples.length ? ` (${skippedExamples.length} row(s) skipped \u2014 unparseable date)` : ""}. These take priority over any manual entries for the same days.`);
      }
      if (stravaStatus.connected) {
        const missing = importedDates.filter((d) => !stravaData.syncedDates.includes(d));
        if (missing.length) fetchStrava(missing);
      }
      if (intervalsStatus.configured) {
        const missing = importedDates.filter((d) => !intervalsData.syncedDates.includes(d));
        if (missing.length) fetchIntervals(missing);
      }
    }
    async function saveManualDay(date, entry) {
      const merged = await apiSaveNutritionDay(date, entry);
      setNutrition((prev) => ({ ...prev, [date]: merged }));
      if (stravaStatus.connected && !stravaData.syncedDates.includes(date)) fetchStrava([date]);
      if (intervalsStatus.configured && !intervalsData.syncedDates.includes(date)) fetchIntervals([date]);
    }
    async function deleteNutritionDay(date) {
      await apiDeleteNutritionDay(date);
      setNutrition((prev) => {
        const next = { ...prev };
        delete next[date];
        return next;
      });
    }
    async function saveManualWeight(date, kg) {
      const savedKg = await apiSaveWeightDay(date, kg);
      setWeightLog((prev) => ({ ...prev, [date]: savedKg }));
    }
    async function deleteWeightDay(date) {
      await apiDeleteWeightDay(date);
      setWeightLog((prev) => {
        const next = { ...prev };
        delete next[date];
        return next;
      });
    }
    async function fetchIntervals(dates) {
      if (!intervalsStatus.configured) return [];
      if (dates && dates.length === 0) return [];
      setFetching(true);
      setFetchError(null);
      try {
        const url = dates && dates.length ? `/api/intervals/activities?dates=${dates.join(",")}` : `/api/intervals/activities?days=${rangeDays}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `intervals.icu request failed (${res.status}).`);
        const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
        let newDates = [];
        setIntervalsData((prev) => {
          const resynced = new Set(data.syncedDates || []);
          const keptActs = prev.activities.filter((a) => !resynced.has((a.start_date_local || a.start_date || "").slice(0, 10)));
          const keptWell = prev.wellness.filter((w) => !resynced.has(w.id || w.date));
          const merged = {
            activities: [...keptActs, ...data.activities],
            wellness: [...keptWell, ...data.wellness],
            syncedDates: Array.from(/* @__PURE__ */ new Set([...prev.syncedDates, ...data.syncedDates || []])).sort()
          };
          storageSet("intervals-cache", { ...merged, fetchedAt });
          return merged;
        });
        newDates = Array.from(new Set(
          data.activities.map((a) => (a.start_date_local || a.start_date || "").slice(0, 10)).filter(Boolean)
        ));
        setLastFetched(fetchedAt);
        return newDates;
      } catch (e) {
        setFetchError(e.message || "Could not reach the local server's intervals.icu proxy.");
        return [];
      } finally {
        setFetching(false);
      }
    }
    async function fetchStrava(dates) {
      if (!stravaStatus.connected) return;
      if (dates && dates.length === 0) return;
      setStravaFetching(true);
      setStravaError(null);
      try {
        const url = dates && dates.length ? `/api/strava/activities?dates=${dates.join(",")}` : `/api/strava/activities?days=${rangeDays}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Strava request failed (${res.status}).`);
        const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
        setStravaData((prev) => {
          const resynced = new Set(data.syncedDates || []);
          const keptOld = prev.activities.filter((a) => !resynced.has((a.start_date_local || "").slice(0, 10)));
          const merged = [...keptOld, ...data.activities];
          const syncedSet = /* @__PURE__ */ new Set([...prev.syncedDates, ...data.syncedDates || []]);
          const next = { activities: merged, syncedDates: Array.from(syncedSet).sort() };
          storageSet("strava-cache", { ...next, fetchedAt });
          return next;
        });
        setStravaLastFetched(fetchedAt);
      } catch (e) {
        setStravaError(e.message || "Could not reach the local server's Strava proxy.");
      } finally {
        setStravaFetching(false);
      }
    }
    async function pullAll() {
      await Promise.all([fetchIntervals(), fetchStrava()]);
      setTab("dashboard");
    }
    const dailyRows = useMemo(() => {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      if (!bmr) return [];
      const wellByDate = {};
      for (const w of intervalsData.wellness) {
        const d = w.id || w.date;
        if (d) wellByDate[d] = w;
      }
      const actByDate = {};
      for (const a of intervalsData.activities) {
        const d = (a.start_date_local || a.start_date || "").slice(0, 10);
        if (!d) continue;
        if (!actByDate[d]) actByDate[d] = [];
        actByDate[d].push(a);
      }
      const stravaByDate = {};
      for (const a of stravaData.activities) {
        const d = (a.start_date_local || "").slice(0, 10);
        if (!d) continue;
        if (!stravaByDate[d]) stravaByDate[d] = [];
        stravaByDate[d].push(a);
      }
      const stravaSyncedSet = new Set(stravaData.syncedDates);
      const days = [];
      let carryRepaymentKcal = 0;
      for (let i = rangeDays - 1; i >= -FORWARD_DAYS; i--) {
        const d = daysAgo(i);
        const key = toISODate(d);
        const stravaActs = stravaByDate[key] || [];
        const intervalsActs = actByDate[key] || [];
        const stravaSynced = stravaSyncedSet.has(key);
        const { sessions: scheduledSessions, taper } = getEffectiveSessionsForDate(schedule, key);
        const carbLoad = getCarbLoadState(schedule, key);
        const upcomingRace = getUpcomingRace(schedule, key);
        const raceToday = upcomingRace && upcomingRace.raceDate === key ? upcomingRace : null;
        const weightForDay = (_a = weightLog[key]) != null ? _a : parseFloat(profile.weightKg) || null;
        let exerciseKcal = 0, epocKcal = 0, source = null;
        let durationSec = 0, ifWeightedSum = 0;
        if (stravaActs.length) {
          source = "strava";
          for (const a of stravaActs) {
            const kcal = typeof a.calories === "number" && a.calories > 0 ? a.calories : typeof a.kilojoules === "number" ? a.kilojoules / 4.184 / 0.24 : 0;
            exerciseKcal += kcal;
            const IF = stravaIntensityFactor(a);
            epocKcal += kcal * epocFactorFor(IF) * profile.epocSensitivity;
            durationSec += a.moving_time || 0;
            ifWeightedSum += IF * (a.moving_time || 0);
          }
        } else if (intervalsActs.length) {
          source = "intervals";
          for (const a of intervalsActs) {
            const kcal = activityKcal(a);
            exerciseKcal += kcal;
            const IF = intensityFactor(a);
            epocKcal += kcal * epocFactorFor(IF) * profile.epocSensitivity;
            durationSec += a.moving_time || 0;
            ifWeightedSum += IF * (a.moving_time || 0);
          }
        } else if (scheduledSessions.length) {
          source = "planned";
          for (const s of scheduledSessions) {
            const baseIF = s.sourceActivity ? s.sourceActivity.intensityFactor : ZONES[s.zone - 1].if;
            const effIF = s.taperIntensityFactor ? baseIF * s.taperIntensityFactor : baseIF;
            const kcal = estimatePlannedKcal(s, s.durationMin, weightForDay);
            exerciseKcal += kcal;
            epocKcal += kcal * epocFactorFor(effIF) * profile.epocSensitivity;
            durationSec += s.durationMin * 60;
            ifWeightedSum += effIF * (s.durationMin * 60);
          }
        } else if (raceToday) {
          source = "planned";
          const raceIF = raceToday.sourceActivity ? raceToday.sourceActivity.intensityFactor : ZONES[raceToday.zone - 1].if;
          const kcal = estimatePlannedKcal(raceToday, raceToday.durationMin, weightForDay);
          exerciseKcal += kcal;
          epocKcal += kcal * epocFactorFor(raceIF) * profile.epocSensitivity;
          durationSec += raceToday.durationMin * 60;
          ifWeightedSum += raceIF * (raceToday.durationMin * 60);
        } else if (stravaSynced) {
          source = "strava";
        }
        const durationMin = durationSec / 60;
        const avgIF = durationSec > 0 ? ifWeightedSum / durationSec : 0.5;
        const bmrWeight = profile.goal === "maintain" ? parseFloat(profile.weightKg) || null : weightForDay;
        const dayBmr = bmrWeight ? calcBMR(profile.sex, bmrWeight, parseFloat(profile.heightCm), parseFloat(profile.age)) : bmr;
        const w = wellByDate[key];
        const ctl = (_b = w == null ? void 0 : w.ctl) != null ? _b : null;
        const atl = (_c = w == null ? void 0 : w.atl) != null ? _c : null;
        const tsb = ctl !== null && atl !== null ? ctl - atl : null;
        const fatigueBuffer = profile.fatigueBuffer && tsb !== null && tsb < -10 ? dayBmr * 0.05 : 0;
        const baseline = profile.neatMode === "offset" ? dayBmr + (parseFloat(profile.neatOffset) || 0) : dayBmr * (parseFloat(profile.neatFactor) || 1.15);
        const demand = baseline + exerciseKcal + epocKcal + fatigueBuffer;
        const nutritionEntry = effectiveNutritionEntry(nutrition[key]);
        const nutritionSource = nutritionEntry ? normalizeNutritionEntry(nutrition[key]).macrosfirst ? "macrosfirst" : "manual" : null;
        const intake = (_d = nutritionEntry == null ? void 0 : nutritionEntry.calories) != null ? _d : null;
        const goalAdjustmentKcal = weightForDay ? goalParams.sign * (goalParams.ratePct / 100) * weightForDay * KCAL_PER_KG_TISSUE / 7 : 0;
        const calibrationKcal = profile.trendCalibration && trendCorrection && !trendCorrection.insufficient ? trendCorrection.correctionKcal : 0;
        const baseTarget = demand + goalAdjustmentKcal + calibrationKcal;
        const fuelTier = classifyTrainingTier(durationMin);
        const tomorrowKey = toISODate(daysAgo(i - 1));
        const tomorrowSessions = getScheduledSessionsForDate(schedule, tomorrowKey);
        const preloadSession = tomorrowSessions.filter(isPreloadWorthy).sort((a, b) => b.durationMin - a.durationMin)[0];
        const preloadTier = preloadSession ? classifyTrainingTier(preloadSession.durationMin) : null;
        const preloading = !!(preloadTier && FUEL_TIERS.indexOf(preloadTier) > FUEL_TIERS.indexOf(fuelTier));
        const raceLoading = !!carbLoad;
        const effectiveTier = raceLoading ? FUEL_TIERS[FUEL_TIERS.length - 1] : preloading ? preloadTier : fuelTier;
        const blend = intensityBlend(avgIF);
        const effectiveBlend = raceLoading ? 1 : blend;
        const normalCarbTargetG = weightForDay ? weightForDay * (fuelTier.carbLo + (fuelTier.carbHi - fuelTier.carbLo) * blend) : null;
        const preloadCapGPerKg = parseFloat(profile.maxPreloadCarbGPerKg) || 12;
        let effectiveCarbGPerKg = effectiveTier.carbLo + (effectiveTier.carbHi - effectiveTier.carbLo) * effectiveBlend;
        if (preloading || raceLoading) effectiveCarbGPerKg = Math.min(effectiveCarbGPerKg, preloadCapGPerKg);
        const carbTargetG = weightForDay ? weightForDay * effectiveCarbGPerKg : null;
        const extraCarbKcal = (preloading || raceLoading) && carbTargetG !== null && normalCarbTargetG !== null && carbTargetG > normalCarbTargetG ? (carbTargetG - normalCarbTargetG) * 4 : 0;
        const borrowRatio = Math.min(1, Math.max(0, parseFloat(profile.preloadBorrowRatio)));
        const borrowedKcal = raceLoading ? extraCarbKcal : extraCarbKcal * (isNaN(borrowRatio) ? 1 : borrowRatio);
        const repaidKcal = carryRepaymentKcal;
        const carbDrivenTarget = baseTarget - repaidKcal + borrowedKcal;
        carryRepaymentKcal = raceLoading ? 0 : borrowedKcal;
        const proteinWeightKg = parseFloat(profile.targetWeightKg) || weightForDay;
        const proteinTargetG = proteinWeightKg ? proteinWeightKg * (parseFloat(profile.proteinGPerKg) || 1) : null;
        const fatFloorG = preloading || raceLoading ? Math.max(carbDrivenTarget * 0.2 / 9, parseFloat(profile.minFatG) || 100) : carbDrivenTarget * 0.2 / 9;
        const fatRemainderG = (carbDrivenTarget - (carbTargetG || 0) * 4 - (proteinTargetG || 0) * 4) / 9;
        const fatTargetG = weightForDay ? Math.max(fatFloorG, fatRemainderG) : null;
        const macroFloorKcal = (carbTargetG || 0) * 4 + (proteinTargetG || 0) * 4 + (fatTargetG || 0) * 9;
        const target = weightForDay ? Math.max(carbDrivenTarget, macroFloorKcal) : carbDrivenTarget;
        const gap = intake !== null ? intake - target : null;
        const trainingMissing = !stravaSynced && intervalsActs.length === 0 && source !== "planned";
        const nutritionMissing = intake === null;
        const weightMissing = weightLog[key] === void 0;
        const isFutureOrToday = key >= toISODate(/* @__PURE__ */ new Date());
        days.push({
          date: key,
          label: d.toLocaleDateString(void 0, { month: "short", day: "numeric" }),
          bmr: dayBmr,
          baseline,
          exerciseKcal,
          epocKcal,
          fatigueBuffer,
          demand,
          target,
          intake,
          gap,
          tsb,
          source,
          weight: (_e = weightLog[key]) != null ? _e : null,
          protein: (_f = nutritionEntry == null ? void 0 : nutritionEntry.protein) != null ? _f : null,
          carbs: (_g = nutritionEntry == null ? void 0 : nutritionEntry.carbs) != null ? _g : null,
          fat: (_h = nutritionEntry == null ? void 0 : nutritionEntry.fat) != null ? _h : null,
          nutritionSource,
          activityCount: stravaActs.length || intervalsActs.length || scheduledSessions.length,
          trainingMissing: trainingMissing && !isFutureOrToday,
          nutritionMissing: nutritionMissing && !isFutureOrToday,
          weightMissing: weightMissing && !isFutureOrToday,
          durationMin,
          fuelTier,
          carbTargetG,
          proteinTargetG,
          fatTargetG,
          isFutureOrToday,
          scheduledSessions,
          preloading,
          preloadSession,
          borrowedKcal,
          repaidKcal,
          taper,
          raceLoading,
          race: (taper == null ? void 0 : taper.race) || (carbLoad == null ? void 0 : carbLoad.race) || raceToday || null
        });
      }
      return days;
    }, [intervalsData, stravaData, nutrition, weightLog, schedule, bmr, profile, rangeDays, goalParams, trendCorrection]);
    const summary = useMemo(() => {
      const withIntake = dailyRows.filter((d) => d.intake !== null);
      const trainingMissingDays = dailyRows.filter((d) => d.trainingMissing).length;
      const nutritionMissingDays = dailyRows.filter((d) => d.nutritionMissing).length;
      if (!withIntake.length) return { trainingMissingDays, nutritionMissingDays, noIntake: true };
      const avgGap = withIntake.reduce((s, d) => s + d.gap, 0) / withIntake.length;
      const avgDemand = dailyRows.reduce((s, d) => s + d.demand, 0) / dailyRows.length;
      const avgTarget = dailyRows.reduce((s, d) => s + d.target, 0) / dailyRows.length;
      const avgIntake = withIntake.reduce((s, d) => s + d.intake, 0) / withIntake.length;
      const deficitDays = withIntake.filter((d) => d.gap < -300).length;
      return { avgGap, avgDemand, avgTarget, avgIntake, deficitDays, trackedDays: withIntake.length, trainingMissingDays, nutritionMissingDays };
    }, [dailyRows]);
    const fuelingByTier = useMemo(() => {
      const groups = {};
      for (const d of dailyRows) {
        if (d.carbTargetG === null || d.isFutureOrToday) continue;
        if (d.carbs === null && d.protein === null) continue;
        const key = d.fuelTier.tier;
        if (!groups[key]) groups[key] = { tier: key, label: d.fuelTier.label, days: [] };
        groups[key].days.push(d);
      }
      return FUEL_TIERS.map((t) => groups[t.tier]).filter(Boolean).map((g) => {
        const n = g.days.length;
        const avgCarb = g.days.reduce((s, d) => {
          var _a;
          return s + ((_a = d.carbs) != null ? _a : 0);
        }, 0) / n;
        const avgCarbTarget = g.days.reduce((s, d) => s + d.carbTargetG, 0) / n;
        const avgProtein = g.days.reduce((s, d) => {
          var _a;
          return s + ((_a = d.protein) != null ? _a : 0);
        }, 0) / n;
        const avgProteinTarget = g.days.reduce((s, d) => s + d.proteinTargetG, 0) / n;
        const avgFat = g.days.reduce((s, d) => {
          var _a;
          return s + ((_a = d.fat) != null ? _a : 0);
        }, 0) / n;
        const avgFatTarget = g.days.reduce((s, d) => {
          var _a;
          return s + ((_a = d.fatTargetG) != null ? _a : 0);
        }, 0) / n;
        return { ...g, n, avgCarb, avgCarbTarget, avgProtein, avgProteinTarget, avgFat, avgFatTarget };
      });
    }, [dailyRows]);
    return /* @__PURE__ */ React.createElement("div", { style: { background: ink, minHeight: "100vh", color: paper, fontFamily: body } }, /* @__PURE__ */ React.createElement("style", null, `
        * { box-sizing: border-box; }
        input, select, button { font-family: ${body}; }
        input:focus, select:focus { outline: 2px solid ${cyan}; outline-offset: 1px; }
        .card { background: ${panel}; border: 1px solid ${line}; border-radius: 6px; }
        .fieldlabel { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: ${dim}; margin-bottom: 6px; display:block; font-weight:600; }
        .inp { width: 100%; background: ${panel2}; border: 1px solid ${line}; color: ${paper}; border-radius: 4px; padding: 9px 10px; font-size: 14px; font-family: ${mono}; }
        .navbtn { display:flex; align-items:center; gap:8px; padding: 10px 14px; border-radius: 5px; cursor:pointer; font-size:13px; font-weight:600; border:1px solid transparent; }
        .navbtn.active { background: ${panel2}; border-color: ${line}; color: ${cyan}; }
        .navbtn:not(.active) { color: ${dim}; }
        .navbtn:not(.active):hover { color: ${paper}; }
        .btn-primary { background: ${cyan}; color: ${ink}; border:none; padding: 10px 18px; border-radius: 4px; font-weight:700; font-size: 13px; cursor:pointer; letter-spacing:0.02em; display:inline-flex; align-items:center; gap:7px; }
        .btn-primary:disabled { opacity: 0.5; cursor: default; }
        .btn-ghost { background: transparent; color: ${paper}; border: 1px solid ${line}; padding: 9px 16px; border-radius: 4px; font-weight:600; font-size: 13px; cursor:pointer; }
        table.data { width:100%; border-collapse: collapse; font-family: ${mono}; font-size: 12.5px; }
        table.data th { text-align:right; padding: 8px 10px; color: ${dim}; font-weight:600; border-bottom: 1px solid ${line}; text-transform:uppercase; font-size:10.5px; letter-spacing:0.05em; position: sticky; top: 0; background: ${panel}; z-index: 1; }
        table.data td { text-align:right; padding: 7px 10px; border-bottom: 1px solid ${line}; }
        table.data th:first-child, table.data td:first-child { text-align:left; font-family: ${body}; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
        * { scrollbar-color: ${line} transparent; scrollbar-width: thin; }
        *::-webkit-scrollbar { width: 10px; height: 10px; background: transparent; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb { background: ${line}; border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
        *::-webkit-scrollbar-thumb:hover { background: ${dim}; background-clip: padding-box; }
        *::-webkit-scrollbar-corner { background: transparent; }
      `), /* @__PURE__ */ React.createElement("div", { style: { borderBottom: `1px solid ${line}` } }, /* @__PURE__ */ React.createElement("div", { style: { padding: "14px clamp(12px, 4vw, 28px)", maxWidth: 1080, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", rowGap: 10 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } }, /* @__PURE__ */ React.createElement("img", { src: "/logo-header.png", alt: "", width: 28, height: 28, style: { borderRadius: 6, display: "block" } }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 700, fontSize: 17, letterSpacing: "-0.01em" } }, "Energy Balance"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, fontFamily: mono, marginTop: 1 } }, "training demand vs. fuel intake \u2014 local build"))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" } }, [
      { id: "setup", label: "Setup", icon: ICONS.settings },
      { id: "import", label: "Log", icon: ICONS.upload },
      { id: "schedule", label: "Schedule", icon: ICONS.calendar },
      { id: "dashboard", label: "Dashboard", icon: ICONS.activity }
    ].map(({ id, label, icon }) => /* @__PURE__ */ React.createElement("div", { key: id, className: `navbtn ${tab === id ? "active" : ""}`, onClick: () => setTab(id) }, /* @__PURE__ */ React.createElement(Icon, { path: icon, size: 14 }), " ", label)), /* @__PURE__ */ React.createElement(
      "div",
      {
        className: "navbtn",
        onClick: toggleUnits,
        title: units === "imperial" ? "Switch to metric (kg/cm)" : "Switch to imperial (lb/in)",
        "aria-label": "Toggle unit system",
        style: { marginLeft: 6 }
      },
      units === "imperial" ? "LB" : "KG"
    ), /* @__PURE__ */ React.createElement(
      "div",
      {
        className: "navbtn",
        onClick: toggleTheme,
        title: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
        "aria-label": "Toggle color theme",
        style: { marginLeft: 6 }
      },
      /* @__PURE__ */ React.createElement(Icon, { path: theme === "dark" ? ICONS.sun : ICONS.moon, size: 14 })
    )))), /* @__PURE__ */ React.createElement("div", { style: { padding: "20px clamp(12px, 4vw, 28px)", maxWidth: 1080, margin: "0 auto" } }, tab === "setup" && /* @__PURE__ */ React.createElement(
      SetupTab,
      {
        profile,
        setProfile,
        bmr,
        onFetch: pullAll,
        fetching: fetching || stravaFetching,
        fetchError,
        rangeDays,
        setRangeDays,
        lastFetched,
        stravaStatus,
        stravaError,
        stravaLastFetched,
        stravaSyncedCount: stravaData.syncedDates.length,
        intervalsStatus,
        intervalsSyncedCount: intervalsData.syncedDates.length,
        goalParams,
        trendCorrection,
        weightTrendAvg,
        weightGoalStatus
      }
    ), tab === "import" && /* @__PURE__ */ React.createElement(
      ImportTab,
      {
        onFile: handleCSVFile,
        csvPreview,
        colMap,
        setColMap,
        onImport: importMappedCSV,
        nutrition,
        onSaveManualDay: saveManualDay,
        onDeleteDay: deleteNutritionDay,
        weightLog,
        onSaveWeight: saveManualWeight,
        onDeleteWeight: deleteWeightDay,
        googleStatus,
        googleFetching,
        googleError,
        onSyncGoogleSheet: syncGoogleSheet,
        googleLastAutoSync,
        importError,
        importNotice,
        units
      }
    ), tab === "schedule" && /* @__PURE__ */ React.createElement(
      ScheduleTab,
      {
        schedule,
        onAdd: addScheduleEntry,
        onUpdate: updateScheduleEntry,
        onDelete: deleteScheduleEntry,
        stravaData,
        intervalsData,
        onImportFile: handleScheduleFile,
        importFileError: scheduleImportError,
        importFileNotice: scheduleImportNotice,
        matchOverrides,
        onSetMatchOverride: setScheduleMatchOverride
      }
    ), tab === "dashboard" && /* @__PURE__ */ React.createElement(
      DashboardTab,
      {
        rows: dailyRows,
        summary,
        bmr,
        fuelingByTier,
        goalParams,
        trendCorrection,
        trendCalibration: profile.trendCalibration,
        proteinGPerKg: profile.proteinGPerKg,
        weightGoalStatus,
        targetWeightKg: parseFloat(profile.targetWeightKg) || null,
        units
      }
    )));
  }
  function Field({ label, children }) {
    return /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "fieldlabel" }, label), children);
  }
  function SetupTab({ profile, setProfile, bmr, onFetch, fetching, fetchError, rangeDays, setRangeDays, lastFetched, stravaStatus, stravaError, stravaLastFetched, stravaSyncedCount, intervalsStatus, intervalsSyncedCount, goalParams, trendCorrection, weightTrendAvg, weightGoalStatus }) {
    var _a;
    const set = (k) => (e) => setProfile((p) => ({ ...p, [k]: e.target.value }));
    const units = profile.units || "metric";
    const [weightText, onWeightChange] = useUnitInput(profile.weightKg, units, kgToDisplay, displayToKg, 1);
    const [heightText, onHeightChange] = useUnitInput(profile.heightCm, units, cmToDisplayLen, displayToCm, 1);
    return /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 20, gridTemplateColumns: "minmax(0, 1fr)" } }, /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 16 } }, "Athlete profile"), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 14 } }, /* @__PURE__ */ React.createElement(Field, { label: "Sex" }, /* @__PURE__ */ React.createElement("select", { className: "inp", value: profile.sex, onChange: set("sex") }, /* @__PURE__ */ React.createElement("option", { value: "male" }, "Male"), /* @__PURE__ */ React.createElement("option", { value: "female" }, "Female"))), /* @__PURE__ */ React.createElement(Field, { label: `Weight (${weightUnitLabel(units)})` }, /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "inp",
        value: weightText,
        onChange: (e) => onWeightChange(e, (v) => setProfile((p) => ({ ...p, weightKg: v }))),
        placeholder: units === "imperial" ? "154" : "70"
      }
    )), /* @__PURE__ */ React.createElement(Field, { label: `Height (${heightUnitLabel(units)})` }, /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "inp",
        value: heightText,
        onChange: (e) => onHeightChange(e, (v) => setProfile((p) => ({ ...p, heightCm: v }))),
        placeholder: units === "imperial" ? "70" : "178"
      }
    )), /* @__PURE__ */ React.createElement(Field, { label: "Age" }, /* @__PURE__ */ React.createElement("input", { className: "inp", value: profile.age, onChange: set("age"), placeholder: "34" }))), bmr && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 16, fontFamily: mono, fontSize: 13, color: cyan } }, "Mifflin-St Jeor BMR: ", /* @__PURE__ */ React.createElement("b", null, fmt(bmr), " kcal/day"))), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.flame, size: 16, color: amber }), " Training calories \u2014 Strava"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 } }, "Strava only exposes accurate per-activity ", /* @__PURE__ */ React.createElement("code", null, "calories"), " through an authenticated, server-side call \u2014 this runs through ", /* @__PURE__ */ React.createElement("code", null, "server.py"), " next to this page, which keeps your client secret out of the browser. See ", /* @__PURE__ */ React.createElement("code", null, "config.example.json"), " for setup. Every pull is cached to disk by date server-side, so repeat pulls only ever hit Strava for today \u2014 a fresh nutrition entry also triggers a background sync for just that date."), !stravaStatus.checked ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim } }, "Checking connection\u2026") : stravaStatus.unreachable ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: coral } }, "Can't reach the local server. Make sure you're running this page via ", /* @__PURE__ */ React.createElement("code", null, "python3 server.py"), ", not a plain file server.") : stravaStatus.configError ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: coral } }, "Server is missing ", /* @__PURE__ */ React.createElement("code", null, "config.json"), " \u2014 copy ", /* @__PURE__ */ React.createElement("code", null, "config.example.json"), ", fill in your Strava client_id/secret, and restart ", /* @__PURE__ */ React.createElement("code", null, "server.py"), ".") : stravaStatus.connected ? /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.check, size: 15, color: mint }), /* @__PURE__ */ React.createElement("span", null, "Connected", ((_a = stravaStatus.athlete) == null ? void 0 : _a.firstname) ? ` as ${stravaStatus.athlete.firstname} ${stravaStatus.athlete.lastname || ""}` : "")) : ["localhost", "127.0.0.1"].includes(window.location.hostname) ? /* @__PURE__ */ React.createElement("a", { className: "btn-primary", href: "/login", style: { textDecoration: "none", width: "fit-content" } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.link, size: 13, color: ink }), " Connect to Strava") : /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, lineHeight: 1.5 } }, "Connect from ", /* @__PURE__ */ React.createElement("code", null, "http://localhost:", window.location.port, "/"), " on the computer running ", /* @__PURE__ */ React.createElement("code", null, "server.py"), " \u2014 Strava's OAuth callback only works there. Every device on this network shares that connection automatically once it's made."), stravaLastFetched && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 10, fontSize: 11.5, color: dim, fontFamily: mono } }, "last synced ", new Date(stravaLastFetched).toLocaleString(), " \xB7 ", stravaSyncedCount, " day", stravaSyncedCount === 1 ? "" : "s", " covered"), stravaError && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, background: "rgba(225,96,77,0.12)", border: `1px solid ${coral}`, borderRadius: 4, padding: "10px 12px", fontSize: 12.5, display: "flex", gap: 8 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.warn, size: 15, color: coral }), /* @__PURE__ */ React.createElement("span", null, stravaError))), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4 } }, "intervals.icu connection ", /* @__PURE__ */ React.createElement("span", { style: { color: dim, fontWeight: 400 } }, "(optional \u2014 wellness / TSB only)")), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 } }, "Used only for CTL/ATL/TSB (recovery buffer below) and as a calorie fallback on days Strava has no data. Fetched and cached server-side too, the same way as Strava \u2014 add ", /* @__PURE__ */ React.createElement("code", null, "intervals_api_key"), "(and optionally ", /* @__PURE__ */ React.createElement("code", null, "intervals_athlete_id"), ", default ", /* @__PURE__ */ React.createElement("code", null, "0"), ") to ", /* @__PURE__ */ React.createElement("code", null, "config.json"), "and restart ", /* @__PURE__ */ React.createElement("code", null, "server.py"), ". Get the key from intervals.icu \u2192 Settings \u2192 Developer Settings."), !intervalsStatus.checked ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim } }, "Checking connection\u2026") : intervalsStatus.unreachable ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: coral } }, "Can't reach the local server. Make sure you're running this page via ", /* @__PURE__ */ React.createElement("code", null, "python3 server.py"), ", not a plain file server.") : intervalsStatus.configured ? /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.check, size: 15, color: mint }), /* @__PURE__ */ React.createElement("span", null, "Configured \u2014 athlete ", intervalsStatus.athleteId)) : /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim } }, "Not configured \u2014 add ", /* @__PURE__ */ React.createElement("code", null, "intervals_api_key"), " to ", /* @__PURE__ */ React.createElement("code", null, "config.json"), " and restart the server to enable this."), lastFetched && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 10, fontSize: 11.5, color: dim, fontFamily: mono } }, "last synced ", new Date(lastFetched).toLocaleString(), " \xB7 ", intervalsSyncedCount, " day", intervalsSyncedCount === 1 ? "" : "s", " covered")), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement(Field, { label: "Days of history" }, /* @__PURE__ */ React.createElement("select", { className: "inp", style: { width: 120 }, value: rangeDays, onChange: (e) => setRangeDays(parseInt(e.target.value)) }, /* @__PURE__ */ React.createElement("option", { value: 14 }, "14 days"), /* @__PURE__ */ React.createElement("option", { value: 21 }, "21 days"), /* @__PURE__ */ React.createElement("option", { value: 30 }, "30 days"), /* @__PURE__ */ React.createElement("option", { value: 60 }, "60 days"))), /* @__PURE__ */ React.createElement("button", { className: "btn-primary", style: { marginTop: 18 }, onClick: onFetch, disabled: fetching }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.refresh, size: 13, color: ink }), fetching ? "Fetching\u2026" : "Pull training data"), lastFetched && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 18, fontSize: 11.5, color: dim, fontFamily: mono } }, "intervals last synced ", new Date(lastFetched).toLocaleString())), fetchError && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, background: "rgba(225,96,77,0.12)", border: `1px solid ${coral}`, borderRadius: 4, padding: "10px 12px", fontSize: 12.5, display: "flex", gap: 8 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.warn, size: 15, color: coral }), /* @__PURE__ */ React.createElement("span", null, fetchError))), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 16, display: "flex", alignItems: "center", gap: 7 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.gauge, size: 16, color: amber }), " Model tuning"), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 20 } }, /* @__PURE__ */ React.createElement(Field, { label: "Non-training activity (NEAT)" }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, marginBottom: 10 } }, [["multiplier", "Multiplier"], ["offset", "Fixed offset"]].map(([id, label]) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: id,
        onClick: () => setProfile((p) => ({ ...p, neatMode: id })),
        className: id === (profile.neatMode || "multiplier") ? "" : "btn-ghost",
        style: id === (profile.neatMode || "multiplier") ? { flex: 1, padding: "7px 10px", borderRadius: 4, fontWeight: 700, fontSize: 12, cursor: "pointer", border: "none", background: cyan, color: ink } : { flex: 1, padding: "7px 10px", fontSize: 12 }
      },
      label
    ))), (profile.neatMode || "multiplier") === "offset" ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "inp",
        type: "number",
        step: "25",
        value: profile.neatOffset,
        onChange: (e) => setProfile((p) => ({ ...p, neatOffset: e.target.value })),
        style: { width: "100%" }
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "A flat kcal/day added to BMR to cover daily NEAT/light activity, before training is added on top.")) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min: "1.0",
        max: "1.4",
        step: "0.01",
        value: profile.neatFactor,
        onChange: (e) => setProfile((p) => ({ ...p, neatFactor: e.target.value })),
        style: { width: "100%" }
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "BMR \xD7 ", profile.neatFactor, "\xD7 covers daily NEAT/light activity, before training is added on top."))), /* @__PURE__ */ React.createElement(Field, { label: `EPOC / recovery sensitivity \u2014 ${profile.epocSensitivity}\xD7` }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min: "0.5",
        max: "1.5",
        step: "0.05",
        value: profile.epocSensitivity,
        onChange: (e) => setProfile((p) => ({ ...p, epocSensitivity: e.target.value })),
        style: { width: "100%" }
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "Scales the post-exercise afterburn estimate (5\u201312% of session kcal by intensity).")), /* @__PURE__ */ React.createElement(Field, { label: `Protein target \u2014 ${fmt(gPerKgToDisplay(parseFloat(profile.proteinGPerKg) || 0, units), 2)} g/${weightUnitLabel(units)}/day` }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min: units === "imperial" ? 0.3 : 0.6,
        max: units === "imperial" ? 1.2 : 2.5,
        step: units === "imperial" ? 0.02 : 0.05,
        value: gPerKgToDisplay(parseFloat(profile.proteinGPerKg) || 0, units),
        onChange: (e) => setProfile((p) => ({ ...p, proteinGPerKg: String(displayToGPerKg(parseFloat(e.target.value), units)) })),
        style: { width: "100%" }
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "Flat daily rate, not tier-scaled like carbs. Default ", fmt(gPerKgToDisplay(1, units), 2), " g/", weightUnitLabel(units), "; athlete guidelines typically range ", fmt(gPerKgToDisplay(1.2, units), 2), "\u2013", fmt(gPerKgToDisplay(2, units), 2), "+ g/", weightUnitLabel(units), ".")), /* @__PURE__ */ React.createElement(Field, { label: `Max carb pre-load \u2014 ${profile.maxPreloadCarbGPerKg} g/kg/day` }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min: "6",
        max: "14",
        step: "0.5",
        value: profile.maxPreloadCarbGPerKg,
        onChange: (e) => setProfile((p) => ({ ...p, maxPreloadCarbGPerKg: e.target.value })),
        style: { width: "100%" }
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "Ceiling on the tomorrow's-session/race pre-load bump only \u2014 a day's own carbs for training actually done that day are never capped by this. Classic carb-loading protocols top out around 10\u201312 g/kg/day; more shows no extra glycogen benefit and raises GI-distress risk.")), /* @__PURE__ */ React.createElement(Field, { label: `Pre-load funding \u2014 ${Math.round(profile.preloadBorrowRatio * 100)}% borrowed` }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min: "0",
        max: "1",
        step: "0.05",
        value: profile.preloadBorrowRatio,
        onChange: (e) => setProfile((p) => ({ ...p, preloadBorrowRatio: e.target.value })),
        style: { width: "100%" }
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "How pre-loaded carbs get funded: 0% shrinks that day's fat target to make room; 100% raises that day's calorie Target instead, and debits the same amount from the next day's Target to balance it out.")), /* @__PURE__ */ React.createElement(Field, { label: `Minimum fat target \u2014 ${profile.minFatG}g/day` }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min: "40",
        max: "150",
        step: "5",
        value: profile.minFatG,
        onChange: (e) => setProfile((p) => ({ ...p, minFatG: e.target.value })),
        style: { width: "100%" }
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "Fat is normally floored at 20% of Target (ISSN's usual minimum), but a big carb pre-load/race-load day can still price it down near nothing \u2014 this flat gram floor backstops that for essential-fatty-acid and fat-soluble-vitamin intake. 100g defaults comfortably inside the ~100\u2013150g/day typical range for an athlete's calorie load."))), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 18, fontSize: 12.5, cursor: "pointer" } }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: profile.fatigueBuffer, onChange: (e) => setProfile((p) => ({ ...p, fatigueBuffer: e.target.checked })) }), "Add a +5% BMR recovery buffer on days with a strongly negative training stress balance (TSB < \u221210)")), /* @__PURE__ */ React.createElement(
      GoalCard,
      {
        profile,
        setProfile,
        goalParams,
        trendCorrection,
        weightTrendAvg,
        weightGoalStatus
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, fontSize: 12, color: dim, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.info, size: 14, color: dim }), /* @__PURE__ */ React.createElement("div", null, "BMR uses the Mifflin-St Jeor equation. The training and recovery adjustments beyond that are heuristics commonly used in endurance-coaching practice, not a single peer-reviewed formula \u2014 tune the sliders above to match how your coach or experience calibrates it.")));
  }
  function GoalCard({ profile, setProfile, goalParams, trendCorrection, weightTrendAvg, weightGoalStatus }) {
    const setGoal = (goal) => setProfile((p) => ({ ...p, goal }));
    const range = profile.goal === "build" ? GOAL_DEFAULTS.build : profile.goal === "lose" ? GOAL_DEFAULTS.lose : null;
    const rateKey = profile.goal === "build" ? "buildRatePct" : "loseRatePct";
    const units = profile.units || "metric";
    const wUnit = weightUnitLabel(units);
    const [targetWeightText, onTargetWeightChange] = useUnitInput(profile.targetWeightKg, units, kgToDisplay, displayToKg, 1);
    return /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.flame, size: 16, color: amber }), " Goal"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.6 } }, "Shifts your daily Target (shown alongside modeled TDEE on the dashboard) by a steady surplus or deficit for 2\u20133x/week lifting. Defaults: ~0.25%/week gain (a common lean-bulk ceiling for experienced lifters) and ~0.5%/week loss (the conservative end of a sustainable-deficit range) \u2014 both adjustable below."), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, marginBottom: profile.goal === "maintain" ? 0 : 18 } }, [["maintain", "Maintain"], ["build", "Build"], ["lose", "Lose"]].map(([id, label]) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: id,
        onClick: () => setGoal(id),
        className: id === profile.goal ? "" : "btn-ghost",
        style: id === profile.goal ? { flex: 1, padding: "10px 14px", borderRadius: 4, fontWeight: 700, fontSize: 13, cursor: "pointer", border: "none", background: cyan, color: ink } : { flex: 1, padding: "10px 14px" }
      },
      label
    ))), /* @__PURE__ */ React.createElement(Field, { label: `Target weight (${wUnit})` }, /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "inp",
        value: targetWeightText,
        onChange: (e) => onTargetWeightChange(e, (v) => setProfile((p) => ({ ...p, targetWeightKg: v }))),
        placeholder: units === "imperial" ? "154" : "70"
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "What ", goalParams.label.toLowerCase(), " is aiming for \u2014 kept separate from the current weight above so the goal doesn't shift just because you logged a new weigh-in.", weightTrendAvg !== null && ` Currently averaging ${fmt(kgToDisplay(weightTrendAvg, units), 1)} ${wUnit} (7-day).`)), weightGoalStatus && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, display: "flex", gap: 8, background: SEVERITY_BG[weightGoalStatus.severity], border: `1px solid ${SEVERITY_COLOR[weightGoalStatus.severity]}`, borderRadius: 4, padding: "10px 12px", fontSize: 12.5, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.warn, size: 15, color: SEVERITY_COLOR[weightGoalStatus.severity] }), /* @__PURE__ */ React.createElement("span", null, formatWeightGoalMessage(weightGoalStatus, units))), range && /* @__PURE__ */ React.createElement(Field, { label: `${profile.goal === "build" ? "Weight gain" : "Weight loss"} rate \u2014 ${profile[rateKey]}%/week` }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "range",
        min: range.min,
        max: range.max,
        step: "0.05",
        value: profile[rateKey],
        onChange: (e) => setProfile((p) => ({ ...p, [rateKey]: e.target.value })),
        style: { width: "100%" }
      }
    ), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "Safe range ", range.min, "\u2013", range.max, "%/week. Faster ", profile.goal === "build" ? "gains skew toward fat" : "loss risks muscle and performance", ".")), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 18, fontSize: 12.5, cursor: "pointer" } }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: profile.trendCalibration, onChange: (e) => setProfile((p) => ({ ...p, trendCalibration: e.target.checked })) }), "Auto-calibrate the target from your logged weight trend"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 6, marginLeft: 24, lineHeight: 1.5 } }, "Compares your actual weight trend (needs ~10+ days logged) against the ", goalParams.label.toLowerCase(), " rate above, and nudges the daily target toward what your real data says you need \u2014 rather than trusting the formula alone."), trendCorrection && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 12, fontFamily: mono, fontSize: 12, color: dim } }, trendCorrection.insufficient ? `Gathering data \u2014 ${trendCorrection.n} weight entries logged so far, need ~8+ spanning 10+ days.` : `Trend: ${trendCorrection.actualWeeklyRateKg >= 0 ? "+" : ""}${fmt(kgToDisplay(trendCorrection.actualWeeklyRateKg, units), 2)} ${wUnit}/wk actual vs ${trendCorrection.targetWeeklyRateKg >= 0 ? "+" : ""}${fmt(kgToDisplay(trendCorrection.targetWeeklyRateKg, units), 2)} ${wUnit}/wk target \u2192 correction ${trendCorrection.correctionKcal >= 0 ? "+" : ""}${fmt(trendCorrection.correctionKcal)} kcal/day`));
  }
  function ImportTab({ onFile, csvPreview, colMap, setColMap, onImport, nutrition, onSaveManualDay, onDeleteDay, weightLog, onSaveWeight, onDeleteWeight, googleStatus, googleFetching, googleError, onSyncGoogleSheet, googleLastAutoSync, importError, importNotice, units }) {
    const [dragOver, setDragOver] = useState(false);
    const dayCount = Object.keys(nutrition).length;
    const weightCount = Object.keys(weightLog).length;
    return /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 20, gridTemplateColumns: "minmax(0, 1fr)" } }, /* @__PURE__ */ React.createElement(ManualEntryCard, { nutrition, onSave: onSaveManualDay }), /* @__PURE__ */ React.createElement(WeightEntryCard, { weightLog, onSave: onSaveWeight, units }), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.upload, size: 16, color: cyan }), " MacrosFirst via Google Sheets"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 } }, "MacrosFirst's own API is partner-gated, but its Premium Google Sheets Importer already writes your daily log to a Sheet you own \u2014 this connects to that Sheet directly, through", /* @__PURE__ */ React.createElement("code", null, " server.py"), ", the same pattern as Strava. See ", /* @__PURE__ */ React.createElement("code", null, "config.example.json"), " for setup."), !googleStatus.checked ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim } }, "Checking connection\u2026") : googleStatus.unreachable ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: coral } }, "Can't reach the local server. Make sure you're running this page via ", /* @__PURE__ */ React.createElement("code", null, "python3 server.py"), ", not a plain file server.") : googleStatus.configError ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: coral } }, "Not configured \u2014 add ", /* @__PURE__ */ React.createElement("code", null, "google_client_id"), ", ", /* @__PURE__ */ React.createElement("code", null, "google_client_secret"), ", and ", /* @__PURE__ */ React.createElement("code", null, "google_sheet_id"), " to ", /* @__PURE__ */ React.createElement("code", null, "config.json"), " and restart the server.") : googleStatus.connected ? /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.check, size: 15, color: mint }), /* @__PURE__ */ React.createElement("span", null, "Connected")), /* @__PURE__ */ React.createElement("button", { className: "btn-primary", onClick: onSyncGoogleSheet, disabled: googleFetching }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.refresh, size: 13, color: ink }), " ", googleFetching ? "Syncing\u2026" : "Sync from Google Sheet")), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 10, fontSize: 11.5, color: dim, fontFamily: mono } }, googleLastAutoSync ? `Last automatic sync: ${new Date(googleLastAutoSync).toLocaleString()}` : "No automatic sync yet \u2014 runs daily once you've imported at least once (set google_sync_time in config.json, default 04:00).")) : ["localhost", "127.0.0.1"].includes(window.location.hostname) ? /* @__PURE__ */ React.createElement("a", { className: "btn-primary", href: "/google/login", style: { textDecoration: "none", width: "fit-content", display: "inline-flex" } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.link, size: 13, color: ink }), " Connect Google Sheets") : /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, lineHeight: 1.5 } }, "Connect from ", /* @__PURE__ */ React.createElement("code", null, "http://localhost:", window.location.port, "/"), " on the computer running ", /* @__PURE__ */ React.createElement("code", null, "server.py"), " \u2014 Google's OAuth callback only works there. Every device on this network shares that connection automatically once it's made."), googleError && /* @__PURE__ */ React.createElement(Banner, { kind: "error" }, googleError)), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4 } }, "Or import a CSV manually"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 } }, "MacrosFirst Premium \u2192 Download Food Log (Excel), or export any spreadsheet as CSV. Drop the file here and map its columns below."), /* @__PURE__ */ React.createElement(
      "div",
      {
        onDragOver: (e) => {
          e.preventDefault();
          setDragOver(true);
        },
        onDragLeave: () => setDragOver(false),
        onDrop: (e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
        },
        style: {
          border: `1.5px dashed ${dragOver ? cyan : line}`,
          borderRadius: 6,
          padding: "36px 20px",
          textAlign: "center",
          background: dragOver ? "rgba(79,209,217,0.05)" : "transparent",
          transition: "all 0.15s"
        }
      },
      /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "center", marginBottom: 10 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.upload, size: 22, color: dim })),
      /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, marginBottom: 12 } }, "Drop your CSV export here, or"),
      /* @__PURE__ */ React.createElement("label", { className: "btn-ghost", style: { display: "inline-block" } }, "Choose file", /* @__PURE__ */ React.createElement("input", { type: "file", accept: ".csv", style: { display: "none" }, onChange: (e) => e.target.files[0] && onFile(e.target.files[0]) }))
    ), importError && /* @__PURE__ */ React.createElement(Banner, { kind: "error" }, importError), !importError && importNotice && /* @__PURE__ */ React.createElement(Banner, { kind: "success" }, importNotice)), csvPreview && /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4 } }, "Map columns"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16 } }, csvPreview.rows.length, " rows found. Match the columns to the fields below."), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 12 } }, ["date", "calories", "protein", "carbs", "fat"].map((k) => /* @__PURE__ */ React.createElement(Field, { key: k, label: k }, /* @__PURE__ */ React.createElement("select", { className: "inp", value: colMap[k], onChange: (e) => setColMap((m) => ({ ...m, [k]: e.target.value })) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "\u2014 none \u2014"), csvPreview.fields.map((f) => /* @__PURE__ */ React.createElement("option", { key: f, value: f }, f)))))), /* @__PURE__ */ React.createElement("button", { className: "btn-primary", style: { marginTop: 18 }, onClick: () => onImport() }, "Import ", csvPreview.rows.length, " rows")), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4 } }, "Stored nutrition log"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: dayCount ? 16 : 0 } }, dayCount, " day", dayCount === 1 ? "" : "s", " of intake saved. Click a row to edit it."), dayCount > 0 && /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto" } }, /* @__PURE__ */ React.createElement(NutritionLogTable, { nutrition, onSave: onSaveManualDay, onDelete: onDeleteDay }))), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4 } }, "Stored weight log"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: weightCount ? 16 : 0 } }, weightCount, " day", weightCount === 1 ? "" : "s", " of weight saved. Click a row to edit it."), weightCount > 0 && /* @__PURE__ */ React.createElement("div", { style: { overflowX: "auto" } }, /* @__PURE__ */ React.createElement(WeightLogTable, { weightLog, onSave: onSaveWeight, onDelete: onDeleteWeight, units }))));
  }
  function macroCalories(protein, carbs, fat) {
    return protein * 4 + carbs * 4 + fat * 9;
  }
  function ManualEntryCard({ nutrition, onSave }) {
    const [date, setDate] = useState(() => toISODate(/* @__PURE__ */ new Date()));
    const [protein, setProtein] = useState("");
    const [carbs, setCarbs] = useState("");
    const [fat, setFat] = useState("");
    const [status, setStatus] = useState("idle");
    const [errorMsg, setErrorMsg] = useState(null);
    const dateRef = useRef(date);
    const normalized = normalizeNutritionEntry(nutrition[date]);
    const hasMacrosFirst = !!normalized.macrosfirst;
    useEffect(() => {
      dateRef.current = date;
      const applyPrefill = (source) => {
        var _a, _b, _c;
        const existing = normalizeNutritionEntry(source[date]);
        const prefill = existing.macrosfirst || existing.manual;
        setProtein(prefill ? String((_a = prefill.protein) != null ? _a : "") : "");
        setCarbs(prefill ? String((_b = prefill.carbs) != null ? _b : "") : "");
        setFat(prefill ? String((_c = prefill.fat) != null ? _c : "") : "");
      };
      applyPrefill(nutrition);
      setStatus("idle");
      setErrorMsg(null);
      storageGet("nutrition-log", null).then((fresh) => {
        if (dateRef.current === date && fresh) applyPrefill(fresh);
      });
    }, [date]);
    const p = parseFloat(protein) || 0;
    const c = parseFloat(carbs) || 0;
    const f = parseFloat(fat) || 0;
    const calories = macroCalories(p, c, f);
    const hasAny = protein !== "" || carbs !== "" || fat !== "";
    async function handleSave() {
      setStatus("saving");
      setErrorMsg(null);
      try {
        await onSave(date, { calories, protein: p, carbs: c, fat: f });
        setStatus("saved");
        setTimeout(() => setStatus((s) => s === "saved" ? "idle" : s), 1500);
      } catch (e) {
        setStatus("error");
        setErrorMsg(e.message || "Save failed \u2014 check the local server connection and retry.");
      }
    }
    return /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.plus, size: 16, color: cyan }), " Enter a day's macros directly"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 } }, "Skip the CSV for a single day \u2014 type in totals from MacrosFirst (or anywhere) and calories are computed automatically (4 kcal/g protein & carbs, 9 kcal/g fat). Pick a date that's already logged to edit it. A MacrosFirst import always takes priority over a manual entry for the same day."), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 14 } }, /* @__PURE__ */ React.createElement(Field, { label: "Date" }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "date", value: date, max: toISODate(/* @__PURE__ */ new Date()), onChange: (e) => setDate(e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: "Protein (g)" }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "number", min: "0", step: "1", value: protein, onChange: (e) => setProtein(e.target.value), placeholder: "0" })), /* @__PURE__ */ React.createElement(Field, { label: "Carbs (g)" }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "number", min: "0", step: "1", value: carbs, onChange: (e) => setCarbs(e.target.value), placeholder: "0" })), /* @__PURE__ */ React.createElement(Field, { label: "Fat (g)" }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "number", min: "0", step: "1", value: fat, onChange: (e) => setFat(e.target.value), placeholder: "0" }))), hasMacrosFirst && /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, background: "rgba(232,163,61,0.1)", border: `1px solid ${amber}`, borderRadius: 4, padding: "9px 12px", fontSize: 12, color: paper, display: "flex", gap: 8, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.warn, size: 14, color: amber }), /* @__PURE__ */ React.createElement("span", null, "MacrosFirst data already exists for this day and will be used everywhere in the app instead of what you save here \u2014 unless that import is later removed.")), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, marginTop: 16 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: mono, fontSize: 13, color: amber } }, "\u2248 ", fmt(calories), " kcal"), /* @__PURE__ */ React.createElement("button", { className: "btn-primary", onClick: handleSave, disabled: !hasAny || status === "saving" }, status === "saving" ? "Saving\u2026" : normalized.manual ? "Update manual entry" : "Save this day"), status === "saved" && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: mint } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.check, size: 13, color: mint }), " Saved")), status === "error" && /* @__PURE__ */ React.createElement(Banner, { kind: "error" }, errorMsg, " ", /* @__PURE__ */ React.createElement("button", { className: "btn-ghost", style: { padding: "2px 8px", marginLeft: 8 }, onClick: handleSave }, "Retry")));
  }
  function SourceBadge({ source }) {
    const isMF = source === "macrosfirst";
    return /* @__PURE__ */ React.createElement("span", { style: {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: "0.04em",
      textTransform: "uppercase",
      padding: "2px 6px",
      borderRadius: 3,
      marginLeft: 8,
      background: isMF ? "rgba(232,163,61,0.15)" : "rgba(124,139,143,0.15)",
      color: isMF ? amber : dim
    } }, isMF ? "MacrosFirst" : "Manual");
  }
  function NutritionLogTable({ nutrition, onSave, onDelete }) {
    const [editingDate, setEditingDate] = useState(null);
    const editingDateRef = useRef(null);
    const [draft, setDraft] = useState({ protein: "", carbs: "", fat: "" });
    const [status, setStatus] = useState("idle");
    const [errorMsg, setErrorMsg] = useState(null);
    const dates = Object.keys(nutrition).sort().reverse();
    function startEdit(date) {
      var _a, _b, _c;
      editingDateRef.current = date;
      setEditingDate(date);
      setStatus("idle");
      setErrorMsg(null);
      const eff = effectiveNutritionEntry(nutrition[date]);
      setDraft({ protein: String((_a = eff == null ? void 0 : eff.protein) != null ? _a : ""), carbs: String((_b = eff == null ? void 0 : eff.carbs) != null ? _b : ""), fat: String((_c = eff == null ? void 0 : eff.fat) != null ? _c : "") });
      storageGet("nutrition-log", null).then((fresh) => {
        var _a2, _b2, _c2;
        if (editingDateRef.current !== date || !fresh) return;
        const freshEff = effectiveNutritionEntry(fresh[date]);
        setDraft({ protein: String((_a2 = freshEff == null ? void 0 : freshEff.protein) != null ? _a2 : ""), carbs: String((_b2 = freshEff == null ? void 0 : freshEff.carbs) != null ? _b2 : ""), fat: String((_c2 = freshEff == null ? void 0 : freshEff.fat) != null ? _c2 : "") });
      });
    }
    function cancelEdit() {
      editingDateRef.current = null;
      setEditingDate(null);
    }
    async function commitEdit(date) {
      const p = parseFloat(draft.protein) || 0;
      const c = parseFloat(draft.carbs) || 0;
      const f = parseFloat(draft.fat) || 0;
      setStatus("saving");
      setErrorMsg(null);
      try {
        await onSave(date, { calories: macroCalories(p, c, f), protein: p, carbs: c, fat: f });
        editingDateRef.current = null;
        setEditingDate(null);
        setStatus("idle");
      } catch (e) {
        setStatus("error");
        setErrorMsg(e.message || "Save failed \u2014 check the local server connection and retry.");
      }
    }
    return /* @__PURE__ */ React.createElement("table", { className: "data" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Date"), /* @__PURE__ */ React.createElement("th", null, "Protein (g)"), /* @__PURE__ */ React.createElement("th", null, "Carbs (g)"), /* @__PURE__ */ React.createElement("th", null, "Fat (g)"), /* @__PURE__ */ React.createElement("th", null, "Calories"), /* @__PURE__ */ React.createElement("th", null))), /* @__PURE__ */ React.createElement("tbody", null, dates.map((date) => {
      const normalized = normalizeNutritionEntry(nutrition[date]);
      const e = normalized.macrosfirst || normalized.manual;
      const source = normalized.macrosfirst ? "macrosfirst" : "manual";
      const editing = editingDate === date;
      return /* @__PURE__ */ React.createElement(React.Fragment, { key: date }, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, date, /* @__PURE__ */ React.createElement(SourceBadge, { source })), editing ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("input", { className: "inp", style: { padding: "4px 6px", textAlign: "right" }, type: "number", value: draft.protein, onChange: (ev) => setDraft((d) => ({ ...d, protein: ev.target.value })) })), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("input", { className: "inp", style: { padding: "4px 6px", textAlign: "right" }, type: "number", value: draft.carbs, onChange: (ev) => setDraft((d) => ({ ...d, carbs: ev.target.value })) })), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("input", { className: "inp", style: { padding: "4px 6px", textAlign: "right" }, type: "number", value: draft.fat, onChange: (ev) => setDraft((d) => ({ ...d, fat: ev.target.value })) })), /* @__PURE__ */ React.createElement("td", { style: { color: dim } }, "\u2248 ", fmt(macroCalories(parseFloat(draft.protein) || 0, parseFloat(draft.carbs) || 0, parseFloat(draft.fat) || 0))), /* @__PURE__ */ React.createElement("td", { style: { textAlign: "left", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement(
        "button",
        {
          className: "btn-ghost",
          style: { padding: "4px 10px", marginRight: 6 },
          onClick: () => commitEdit(date),
          disabled: status === "saving",
          title: source === "macrosfirst" ? "Saves as a manual fallback \u2014 MacrosFirst data still takes priority for this day" : void 0
        },
        status === "saving" ? "Saving\u2026" : "Save"
      ), /* @__PURE__ */ React.createElement("button", { className: "btn-ghost", style: { padding: "4px 10px" }, onClick: cancelEdit, disabled: status === "saving" }, "Cancel"))) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("td", null, fmt(e.protein)), /* @__PURE__ */ React.createElement("td", null, fmt(e.carbs)), /* @__PURE__ */ React.createElement("td", null, fmt(e.fat)), /* @__PURE__ */ React.createElement("td", { style: { color: amber } }, fmt(e.calories)), /* @__PURE__ */ React.createElement("td", { style: { textAlign: "left", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("button", { title: "Edit", onClick: () => startEdit(date), style: { background: "none", border: "none", cursor: "pointer", padding: 4, color: dim } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.pencil, size: 13, color: dim })), /* @__PURE__ */ React.createElement("button", { title: "Delete", onClick: () => {
        if (confirm(`Delete ${source === "macrosfirst" ? "the MacrosFirst import and any manual entry" : "the manual entry"} for ${date}?`)) onDelete(date);
      }, style: { background: "none", border: "none", cursor: "pointer", padding: 4, color: dim } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.trash, size: 13, color: coral }))))), editing && status === "error" && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { colSpan: 6, style: { padding: 0 } }, /* @__PURE__ */ React.createElement(Banner, { kind: "error" }, errorMsg, " ", /* @__PURE__ */ React.createElement("button", { className: "btn-ghost", style: { padding: "2px 8px", marginLeft: 8 }, onClick: () => commitEdit(date) }, "Retry")))));
    })));
  }
  function WeightEntryCard({ weightLog, onSave, units }) {
    const [date, setDate] = useState(() => toISODate(/* @__PURE__ */ new Date()));
    const [metricKg, setMetricKg] = useState("");
    const [status, setStatus] = useState("idle");
    const [errorMsg, setErrorMsg] = useState(null);
    const dateRef = useRef(date);
    useEffect(() => {
      dateRef.current = date;
      const existingKg = weightLog[date];
      setMetricKg(existingKg === void 0 ? "" : String(existingKg));
      setStatus("idle");
      setErrorMsg(null);
      storageGet("weight-log", null).then((fresh) => {
        if (dateRef.current !== date || !fresh) return;
        const freshKg = fresh[date];
        setMetricKg(freshKg === void 0 ? "" : String(freshKg));
      });
    }, [date]);
    const [text, onChange] = useUnitInput(metricKg, units, kgToDisplay, displayToKg, 1);
    const wUnit = weightUnitLabel(units);
    async function handleSave() {
      const kg = parseFloat(metricKg);
      if (Number.isNaN(kg) || kg <= 0) return;
      setStatus("saving");
      setErrorMsg(null);
      try {
        await onSave(date, Math.round(kg * 100) / 100);
        setStatus("saved");
        setTimeout(() => setStatus((s) => s === "saved" ? "idle" : s), 1500);
      } catch (e) {
        setStatus("error");
        setErrorMsg(e.message || "Save failed \u2014 check the local server connection and retry.");
      }
    }
    return /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.plus, size: 16, color: cyan }), " Log today's weight"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 } }, "Feeds directly into BMR and fueling targets for that day \u2014 body weight shifts across a training block, so this keeps demand and g/kg targets tracking you rather than a fixed Setup value."), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 14, alignItems: "end" } }, /* @__PURE__ */ React.createElement(Field, { label: "Date" }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "date", value: date, max: toISODate(/* @__PURE__ */ new Date()), onChange: (e) => setDate(e.target.value) })), /* @__PURE__ */ React.createElement(Field, { label: `Weight (${wUnit})` }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "number", min: "0", step: "0.1", value: text, onChange: (e) => onChange(e, setMetricKg), placeholder: units === "imperial" ? "154.0" : "70.0" }))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 14, marginTop: 16 } }, /* @__PURE__ */ React.createElement("button", { className: "btn-primary", onClick: handleSave, disabled: !text || status === "saving" }, status === "saving" ? "Saving\u2026" : weightLog[date] !== void 0 ? "Update this day" : "Save this day"), status === "saved" && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: mint } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.check, size: 13, color: mint }), " Saved")), status === "error" && /* @__PURE__ */ React.createElement(Banner, { kind: "error" }, errorMsg, " ", /* @__PURE__ */ React.createElement("button", { className: "btn-ghost", style: { padding: "2px 8px", marginLeft: 8 }, onClick: handleSave }, "Retry")));
  }
  function WeightLogTable({ weightLog, onSave, onDelete, units }) {
    const [editingDate, setEditingDate] = useState(null);
    const editingDateRef = useRef(null);
    const [draft, setDraft] = useState("");
    const [status, setStatus] = useState("idle");
    const [errorMsg, setErrorMsg] = useState(null);
    const dates = Object.keys(weightLog).sort().reverse();
    function startEdit(date) {
      editingDateRef.current = date;
      setEditingDate(date);
      setStatus("idle");
      setErrorMsg(null);
      setDraft(String(roundTo(kgToDisplay(weightLog[date], units), 1)));
      storageGet("weight-log", null).then((fresh) => {
        if (editingDateRef.current !== date || !fresh || fresh[date] === void 0) return;
        setDraft(String(roundTo(kgToDisplay(fresh[date], units), 1)));
      });
    }
    function cancelEdit() {
      editingDateRef.current = null;
      setEditingDate(null);
    }
    async function commitEdit(date) {
      const v = parseFloat(draft);
      if (Number.isNaN(v) || v <= 0) return;
      setStatus("saving");
      setErrorMsg(null);
      try {
        await onSave(date, Math.round(displayToKg(v, units) * 100) / 100);
        editingDateRef.current = null;
        setEditingDate(null);
        setStatus("idle");
      } catch (e) {
        setStatus("error");
        setErrorMsg(e.message || "Save failed \u2014 check the local server connection and retry.");
      }
    }
    return /* @__PURE__ */ React.createElement("table", { className: "data" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Date"), /* @__PURE__ */ React.createElement("th", null, "Weight (", weightUnitLabel(units), ")"), /* @__PURE__ */ React.createElement("th", null))), /* @__PURE__ */ React.createElement("tbody", null, dates.map((date) => {
      const kg = weightLog[date];
      const editing = editingDate === date;
      return /* @__PURE__ */ React.createElement(React.Fragment, { key: date }, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", null, date), editing ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("input", { className: "inp", style: { padding: "4px 6px", textAlign: "right" }, type: "number", step: "0.1", value: draft, onChange: (ev) => setDraft(ev.target.value) })), /* @__PURE__ */ React.createElement("td", { style: { textAlign: "left", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("button", { className: "btn-ghost", style: { padding: "4px 10px", marginRight: 6 }, onClick: () => commitEdit(date), disabled: status === "saving" }, status === "saving" ? "Saving\u2026" : "Save"), /* @__PURE__ */ React.createElement("button", { className: "btn-ghost", style: { padding: "4px 10px" }, onClick: cancelEdit, disabled: status === "saving" }, "Cancel"))) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("td", null, fmt(kgToDisplay(kg, units), 1)), /* @__PURE__ */ React.createElement("td", { style: { textAlign: "left", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("button", { title: "Edit", onClick: () => startEdit(date), style: { background: "none", border: "none", cursor: "pointer", padding: 4, color: dim } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.pencil, size: 13, color: dim })), /* @__PURE__ */ React.createElement("button", { title: "Delete", onClick: () => {
        if (confirm(`Delete weight entry for ${date}?`)) onDelete(date);
      }, style: { background: "none", border: "none", cursor: "pointer", padding: 4, color: dim } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.trash, size: 13, color: coral }))))), editing && status === "error" && /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("td", { colSpan: 3, style: { padding: 0 } }, /* @__PURE__ */ React.createElement(Banner, { kind: "error" }, errorMsg, " ", /* @__PURE__ */ React.createElement("button", { className: "btn-ghost", style: { padding: "2px 8px", marginLeft: 8 }, onClick: () => commitEdit(date) }, "Retry")))));
    })));
  }
  const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const ACTIVITY_COLORS = { Run: coral, Ride: cyan, Swim: mint, Row: lavender, Strength: gold, Other: amber };
  const DEFAULT_TAPER_DAYS = 10;
  function emptyScheduleForm() {
    return {
      kind: "recurring",
      activityType: "Run",
      zone: 2,
      durationMin: "45",
      daysOfWeek: [],
      startDate: toLocalISODate(/* @__PURE__ */ new Date()),
      endDate: "",
      ongoing: true,
      notes: "",
      date: toLocalISODate(/* @__PURE__ */ new Date()),
      raceDate: toLocalISODate(/* @__PURE__ */ new Date()),
      taperDays: String(DEFAULT_TAPER_DAYS),
      sourceActivity: null
    };
  }
  function sourceActivityLabel(src) {
    return `${src.date} \xB7 ${src.name} \xB7 ${src.durationMin}min \xB7 ${src.kcal}kcal`;
  }
  function scheduleRowStyle(highlighted) {
    return {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "10px 12px",
      background: highlighted ? "rgba(79,209,217,0.15)" : panel2,
      border: `1px solid ${highlighted ? cyan : line}`,
      borderRadius: 5,
      fontSize: 12.5,
      transition: "background 0.3s, border-color 0.3s"
    };
  }
  function ScheduleTab({
    schedule,
    onAdd,
    onUpdate,
    onDelete,
    stravaData,
    intervalsData,
    onImportFile,
    importFileError,
    importFileNotice,
    matchOverrides,
    onSetMatchOverride
  }) {
    var _a;
    const [form, setForm] = useState(emptyScheduleForm());
    const [editingId, setEditingId] = useState(null);
    const [highlightIds, setHighlightIds] = useState([]);
    const [scheduleDragOver, setScheduleDragOver] = useState(false);
    const [editingMatchDay, setEditingMatchDay] = useState(null);
    const itemRefs = useRef({});
    const activityLibrary = useMemo(
      () => getActivityLibrary(stravaData, intervalsData),
      [stravaData, intervalsData]
    );
    const actualsByDate = useMemo(() => {
      const map = {};
      for (const a of activityLibrary) (map[a.date] || (map[a.date] = [])).push(a);
      return map;
    }, [activityLibrary]);
    function applySourceActivity(key) {
      const src = activityLibrary.find((a) => a.key === key);
      if (!src) {
        setForm((f) => ({ ...f, sourceActivity: null }));
        return;
      }
      setForm((f) => ({
        ...f,
        activityType: src.activityType,
        zone: src.zone,
        durationMin: String(src.durationMin),
        sourceActivity: { key: src.key, date: src.date, name: src.name, durationMin: src.durationMin, kcal: src.kcal, intensityFactor: src.intensityFactor }
      }));
    }
    function jumpToDay(day) {
      const ids = day.sessions.map((s) => s.id).concat(day.race ? [day.race.id] : []);
      if (!ids.length) return;
      setHighlightIds(ids);
      const firstEl = itemRefs.current[ids[0]];
      if (firstEl) firstEl.scrollIntoView({ behavior: "smooth", block: "center" });
      window.clearTimeout(jumpToDay._t);
      jumpToDay._t = window.setTimeout(() => setHighlightIds([]), 2e3);
    }
    const recurring = schedule.filter((s) => s.kind !== "race" && s.kind !== "single");
    const singles = schedule.filter((s) => s.kind === "single").slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const races = getRaces(schedule).slice().sort((a, b) => a.raceDate < b.raceDate ? -1 : 1);
    function toggleDay(n) {
      setForm((f) => ({
        ...f,
        daysOfWeek: f.daysOfWeek.includes(n) ? f.daysOfWeek.filter((d) => d !== n) : [...f.daysOfWeek, n].sort()
      }));
    }
    function startEdit(s) {
      var _a2;
      setEditingId(s.id);
      if (s.kind === "race") {
        setForm({
          ...emptyScheduleForm(),
          kind: "race",
          activityType: s.activityType,
          zone: s.zone,
          durationMin: String(s.durationMin),
          raceDate: s.raceDate,
          taperDays: String((_a2 = s.taperDays) != null ? _a2 : DEFAULT_TAPER_DAYS),
          notes: s.notes || "",
          sourceActivity: s.sourceActivity || null
        });
      } else if (s.kind === "single") {
        setForm({
          ...emptyScheduleForm(),
          kind: "single",
          activityType: s.activityType,
          zone: s.zone,
          durationMin: String(s.durationMin),
          date: s.date,
          notes: s.notes || "",
          sourceActivity: s.sourceActivity || null
        });
      } else {
        setForm({
          ...emptyScheduleForm(),
          kind: "recurring",
          activityType: s.activityType,
          zone: s.zone,
          durationMin: String(s.durationMin),
          daysOfWeek: s.daysOfWeek,
          startDate: s.startDate,
          endDate: s.endDate || "",
          ongoing: !s.endDate,
          notes: s.notes || "",
          sourceActivity: s.sourceActivity || null
        });
      }
    }
    function cancelEdit() {
      setEditingId(null);
      setForm(emptyScheduleForm());
    }
    function handleSubmit() {
      if (form.kind === "race") {
        const entry2 = {
          kind: "race",
          activityType: form.activityType,
          zone: form.zone,
          durationMin: parseInt(form.durationMin) || 0,
          raceDate: form.raceDate,
          taperDays: Math.max(0, parseInt(form.taperDays) || 0),
          notes: form.notes,
          sourceActivity: form.sourceActivity
        };
        if (editingId) onUpdate(editingId, entry2);
        else onAdd(entry2);
        cancelEdit();
        return;
      }
      if (form.kind === "single") {
        const entry2 = {
          kind: "single",
          activityType: form.activityType,
          zone: form.zone,
          durationMin: parseInt(form.durationMin) || 0,
          date: form.date,
          notes: form.notes,
          sourceActivity: form.sourceActivity
        };
        if (editingId) onUpdate(editingId, entry2);
        else onAdd(entry2);
        cancelEdit();
        return;
      }
      if (form.daysOfWeek.length === 0) {
        alert("Pick at least one day of the week.");
        return;
      }
      const entry = {
        kind: "recurring",
        activityType: form.activityType,
        zone: form.zone,
        durationMin: parseInt(form.durationMin) || 0,
        daysOfWeek: form.daysOfWeek,
        startDate: form.startDate,
        endDate: form.ongoing ? null : form.endDate || null,
        notes: form.notes,
        sourceActivity: form.sourceActivity
      };
      if (editingId) onUpdate(editingId, entry);
      else onAdd(entry);
      cancelEdit();
    }
    const calendarStart = daysAgo((/* @__PURE__ */ new Date()).getDay());
    const calendarDays = [];
    for (let i = 0; i < 21; i++) {
      const d = new Date(calendarStart);
      d.setDate(d.getDate() + i);
      const key = toLocalISODate(d);
      const { sessions, taper } = getEffectiveSessionsForDate(schedule, key);
      const raceToday = races.find((r) => r.raceDate === key);
      const carbLoad = getCarbLoadState(schedule, key);
      const plannedItems = raceToday ? [{ ...raceToday, isRace: true }, ...sessions] : sessions;
      const dayActuals = actualsByDate[key] || [];
      const { pairs, extras } = matchDayActivities(plannedItems, dayActuals, matchOverrides[key]);
      calendarDays.push({ key, date: d, sessions, taper, race: raceToday, carbLoad, pairs, extras, dayActuals });
    }
    const todayKey = toLocalISODate(/* @__PURE__ */ new Date());
    return /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 20, gridTemplateColumns: "minmax(0, 1fr)" } }, /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.calendar, size: 16, color: cyan }), " Upcoming"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } }, /* @__PURE__ */ React.createElement("span", null, "Next 3 weeks"), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 4 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.flame, size: 10, color: amber }), " pre-loads the day before"), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 4 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.gauge, size: 10, color: lavender }), " tapering"), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 4 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.flame, size: 10, color: gold }), " carb-loading"), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 4 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.trophy, size: 10, color: gold }), " race day"), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 4 } }, "solid = planned, outline = actual ", /* @__PURE__ */ React.createElement(Icon, { path: ICONS.check, size: 10, color: mint }), " matched"), /* @__PURE__ */ React.createElement("span", { style: { display: "flex", alignItems: "center", gap: 4 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.pencil, size: 10, color: dim }), " click to correct a match")), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 } }, WEEKDAY_LABELS.map((label) => /* @__PURE__ */ React.createElement("div", { key: label, style: { fontSize: 11, color: dim, textAlign: "center", paddingBottom: 2 } }, label)), calendarDays.map((day) => {
      const isToday = day.key === todayKey;
      const isPast = day.key < todayKey;
      const isFirstOfMonth = day.date.getDate() === 1;
      const clickable = day.sessions.length > 0 || !!day.race;
      function plannedChip(planned, i) {
        if (planned.isRace) {
          return /* @__PURE__ */ React.createElement(
            "div",
            {
              key: `p${i}`,
              title: `Race: ${planned.notes || planned.activityType} \xB7 ${planned.durationMin}min`,
              style: {
                background: gold,
                color: ink,
                borderRadius: 3,
                padding: "2px 5px",
                fontSize: 10.5,
                lineHeight: 1.3,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                gap: 3
              }
            },
            /* @__PURE__ */ React.createElement(Icon, { path: ICONS.trophy, size: 9, color: ink }),
            " ",
            planned.notes || planned.activityType
          );
        }
        return /* @__PURE__ */ React.createElement(
          "div",
          {
            key: `p${i}`,
            title: `${planned.activityType} \xB7 ${ZONES[planned.zone - 1].label.split(" \xB7 ")[1]} \xB7 ${planned.durationMin}min${planned.notes ? ` \xB7 ${planned.notes}` : ""}${day.taper ? " \xB7 tapered" : ""}`,
            style: {
              background: ACTIVITY_COLORS[planned.activityType] || dim,
              color: ink,
              borderRadius: 3,
              padding: "2px 5px",
              fontSize: 10.5,
              lineHeight: 1.3,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 3,
              opacity: day.taper ? 0.65 : 1
            }
          },
          planned.activityType,
          " Z",
          planned.zone,
          " \xB7 ",
          planned.durationMin,
          "m",
          isPreloadWorthy(planned) && /* @__PURE__ */ React.createElement(Icon, { path: ICONS.flame, size: 9, color: ink })
        );
      }
      function actualChip(actual, matched, i, manual) {
        const color = ACTIVITY_COLORS[actual.activityType] || dim;
        return /* @__PURE__ */ React.createElement(
          "div",
          {
            key: `a${i}`,
            title: `${actual.name} \xB7 ${actual.activityType} \xB7 ${actual.durationMin}min${matched ? " \xB7 matched to the plan" : " \xB7 not on the schedule"}${manual ? " \xB7 manually corrected" : ""}`,
            style: {
              border: `1px solid ${color}`,
              color,
              borderRadius: 3,
              padding: "2px 5px",
              fontSize: 10.5,
              lineHeight: 1.3,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 3
            }
          },
          matched && /* @__PURE__ */ React.createElement(Icon, { path: ICONS.check, size: 9, color }),
          actual.activityType,
          " \xB7 ",
          actual.durationMin,
          "m",
          manual && /* @__PURE__ */ React.createElement(Icon, { path: ICONS.pencil, size: 8, color })
        );
      }
      return /* @__PURE__ */ React.createElement(
        "div",
        {
          key: day.key,
          onClick: clickable ? () => jumpToDay(day) : void 0,
          title: clickable ? "Jump to this session in the listings below" : void 0,
          style: {
            background: panel2,
            border: isToday ? `2px solid ${cyan}` : day.race ? `1px solid ${gold}` : `1px solid ${line}`,
            borderRadius: 5,
            padding: 6,
            minHeight: 76,
            display: "flex",
            flexDirection: "column",
            gap: 3,
            cursor: clickable ? "pointer" : "default",
            opacity: isPast ? 0.5 : 1
          }
        },
        /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: isToday ? cyan : dim, fontWeight: isToday ? 700 : 600, display: "flex", alignItems: "center", gap: 4 } }, isFirstOfMonth ? day.date.toLocaleDateString(void 0, { month: "short", day: "numeric" }) : day.date.getDate(), day.taper && /* @__PURE__ */ React.createElement("span", { title: `Tapering for ${day.taper.race.notes || day.taper.race.activityType} in ${day.taper.daysToRace}d \u2014 ~${Math.round(day.taper.volumeFactor * 100)}% volume` }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.gauge, size: 9, color: lavender })), day.carbLoad && /* @__PURE__ */ React.createElement("span", { title: `Carb-loading ahead of ${day.carbLoad.race.notes || day.carbLoad.race.activityType} in ${day.carbLoad.daysToRace}d` }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.flame, size: 9, color: gold })), (day.pairs.length > 0 || day.dayActuals.length > 0) && /* @__PURE__ */ React.createElement(
          "button",
          {
            type: "button",
            title: "Correct planned/actual matches for this day",
            onClick: (e) => {
              e.stopPropagation();
              setEditingMatchDay(day.key);
            },
            style: { marginLeft: "auto", background: "none", border: "none", color: dim, cursor: "pointer", padding: 0, display: "flex" }
          },
          /* @__PURE__ */ React.createElement(Icon, { path: ICONS.pencil, size: 10, color: dim })
        )),
        day.pairs.map(({ planned, actual, manual }, i) => /* @__PURE__ */ React.createElement("div", { key: `pair${i}`, style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3 } }, plannedChip(planned, i), actual ? actualChip(actual, true, i, manual) : day.key <= todayKey ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 10, color: dim, display: "flex", alignItems: "center" } }, "not logged") : null)),
        day.extras.map((actual, i) => /* @__PURE__ */ React.createElement("div", { key: `extra${i}`, style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3 } }, /* @__PURE__ */ React.createElement("div", null), actualChip(actual, false, i)))
      );
    }))), editingMatchDay && (() => {
      const day = calendarDays.find((d) => d.key === editingMatchDay);
      if (!day) return null;
      const dayOverrides = matchOverrides[day.key] || {};
      return /* @__PURE__ */ React.createElement("div", { style: {
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20
      }, onClick: () => setEditingMatchDay(null) }, /* @__PURE__ */ React.createElement("div", { onClick: (e) => e.stopPropagation(), style: {
        background: panel2,
        border: `1px solid ${line}`,
        borderRadius: 8,
        padding: 20,
        width: 420,
        maxWidth: "100%",
        maxHeight: "80vh",
        overflowY: "auto"
      } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 700, fontSize: 14 } }, day.date.toLocaleDateString(void 0, { weekday: "long", month: "short", day: "numeric" })), /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: () => setEditingMatchDay(null),
          style: { background: "none", border: "none", color: dim, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0 }
        },
        "\xD7"
      )), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12, color: dim, marginBottom: 16, lineHeight: 1.5 } }, "Correct which logged activity matches each planned session, if the automatic guess got it wrong."), day.pairs.length === 0 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16 } }, "Nothing scheduled this day."), day.pairs.map(({ planned, actual }, i) => {
        const pk = plannedMatchKey(planned);
        const label = planned.isRace ? `Race: ${planned.notes || planned.activityType}` : `${planned.activityType} Z${planned.zone} \xB7 ${planned.durationMin}m${planned.notes ? ` \xB7 ${planned.notes}` : ""}`;
        const hasOverride = Object.prototype.hasOwnProperty.call(dayOverrides, pk);
        const overrideValue = dayOverrides[pk];
        const selectValue = !hasOverride ? "__auto__" : overrideValue === null ? "__none__" : overrideValue;
        return /* @__PURE__ */ React.createElement("div", { key: i, style: { marginBottom: 14 } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 } }, /* @__PURE__ */ React.createElement("span", { style: {
          width: 8,
          height: 8,
          borderRadius: 2,
          background: planned.isRace ? gold : ACTIVITY_COLORS[planned.activityType] || dim,
          display: "inline-block"
        } }), label), /* @__PURE__ */ React.createElement(
          "select",
          {
            value: selectValue,
            onChange: (e) => {
              const v = e.target.value;
              if (v === "__auto__") onSetMatchOverride(day.key, pk, void 0);
              else if (v === "__none__") onSetMatchOverride(day.key, pk, null);
              else onSetMatchOverride(day.key, pk, v);
            },
            style: { width: "100%", padding: "6px 8px", borderRadius: 4, background: panel, border: `1px solid ${line}`, color: paper, fontSize: 12.5 }
          },
          /* @__PURE__ */ React.createElement("option", { value: "__auto__" }, "Auto (let the app guess)"),
          /* @__PURE__ */ React.createElement("option", { value: "__none__" }, "No match"),
          day.dayActuals.map((a) => /* @__PURE__ */ React.createElement("option", { key: a.key, value: a.key }, a.activityType, " \xB7 ", a.durationMin, "m \xB7 ", a.name))
        ), !hasOverride && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 10.5, color: dim, marginTop: 2 } }, "Auto-detected", actual ? ` \u2014 matched to "${actual.name}"` : " \u2014 no match found"));
      }), day.dayActuals.length === 0 && day.pairs.length > 0 && /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim } }, "No Strava/intervals.icu activities synced for this day.")));
    })(), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.upload, size: 16, color: cyan }), " Import schedule from file"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 } }, "Drop a periodized training-plan export, or a plain list of schedule entries, as a .json file. It's saved under ", /* @__PURE__ */ React.createElement("code", null, "schedule_sources/"), " and re-imported automatically from then on whenever that file's contents change \u2014 no need to come back here and re-upload it."), /* @__PURE__ */ React.createElement(
      "div",
      {
        onDragOver: (e) => {
          e.preventDefault();
          setScheduleDragOver(true);
        },
        onDragLeave: () => setScheduleDragOver(false),
        onDrop: (e) => {
          e.preventDefault();
          setScheduleDragOver(false);
          if (e.dataTransfer.files[0]) onImportFile(e.dataTransfer.files[0]);
        },
        style: {
          border: `1.5px dashed ${scheduleDragOver ? cyan : line}`,
          borderRadius: 6,
          padding: "28px 20px",
          textAlign: "center",
          background: scheduleDragOver ? "rgba(79,209,217,0.05)" : "transparent",
          transition: "all 0.15s"
        }
      },
      /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "center", marginBottom: 10 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.upload, size: 22, color: dim })),
      /* @__PURE__ */ React.createElement("div", { style: { fontSize: 13, marginBottom: 12 } }, "Drop a .json schedule file here, or"),
      /* @__PURE__ */ React.createElement("label", { className: "btn-ghost", style: { display: "inline-block" } }, "Choose file", /* @__PURE__ */ React.createElement(
        "input",
        {
          type: "file",
          accept: ".json,application/json",
          style: { display: "none" },
          onChange: (e) => {
            if (e.target.files[0]) onImportFile(e.target.files[0]);
            e.target.value = "";
          }
        }
      ))
    ), importFileError && /* @__PURE__ */ React.createElement(Banner, { kind: "error" }, importFileError), !importFileError && importFileNotice && /* @__PURE__ */ React.createElement(Banner, { kind: "success" }, importFileNotice)), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 } }, /* @__PURE__ */ React.createElement(Icon, { path: form.kind === "race" ? ICONS.trophy : ICONS.calendar, size: 16, color: cyan }), " ", editingId ? "Edit scheduled session" : "Add to schedule"), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 } }, form.kind === "race" ? "A one-off event on a specific date. Training in the taper window before it is automatically scaled down, and carbs load up in the final days." : form.kind === "single" ? "A single session on one specific date \u2014 doesn't repeat, and won't affect any other day." : /* @__PURE__ */ React.createElement(React.Fragment, null, "Repeats on the days you pick, within the date range. Projects up to ", FORWARD_DAYS, " days ahead on the dashboard as an estimate \u2014 once a real activity syncs in for that day, it takes over automatically.")), !editingId && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 4, marginBottom: 16 } }, /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        onClick: () => setForm((f) => ({ ...f, kind: "recurring" })),
        style: form.kind === "recurring" ? { flex: 1, padding: "9px 6px", borderRadius: 4, fontWeight: 700, fontSize: 12.5, cursor: "pointer", border: "none", background: cyan, color: ink, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 } : { flex: 1, padding: "9px 6px", borderRadius: 4, fontWeight: 600, fontSize: 12.5, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }
      },
      /* @__PURE__ */ React.createElement(Icon, { path: ICONS.calendar, size: 13, color: form.kind === "recurring" ? ink : dim }),
      " Recurring session"
    ), /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        onClick: () => setForm((f) => ({ ...f, kind: "single" })),
        style: form.kind === "single" ? { flex: 1, padding: "9px 6px", borderRadius: 4, fontWeight: 700, fontSize: 12.5, cursor: "pointer", border: "none", background: cyan, color: ink, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 } : { flex: 1, padding: "9px 6px", borderRadius: 4, fontWeight: 600, fontSize: 12.5, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }
      },
      /* @__PURE__ */ React.createElement(Icon, { path: ICONS.calendar, size: 13, color: form.kind === "single" ? ink : dim }),
      " Single session"
    ), /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        onClick: () => setForm((f) => ({ ...f, kind: "race" })),
        style: form.kind === "race" ? { flex: 1, padding: "9px 6px", borderRadius: 4, fontWeight: 700, fontSize: 12.5, cursor: "pointer", border: "none", background: cyan, color: ink, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 } : { flex: 1, padding: "9px 6px", borderRadius: 4, fontWeight: 600, fontSize: 12.5, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }
      },
      /* @__PURE__ */ React.createElement(Icon, { path: ICONS.trophy, size: 13, color: form.kind === "race" ? ink : dim }),
      " Race"
    )), /* @__PURE__ */ React.createElement("div", { style: { marginBottom: 14 } }, /* @__PURE__ */ React.createElement(Field, { label: "Model demand on" }, /* @__PURE__ */ React.createElement("select", { className: "inp", value: ((_a = form.sourceActivity) == null ? void 0 : _a.key) || "", onChange: (e) => applySourceActivity(e.target.value) }, /* @__PURE__ */ React.createElement("option", { value: "" }, "Manual (MET estimate from activity type / zone / duration below)"), activityLibrary.map((a) => /* @__PURE__ */ React.createElement("option", { key: a.key, value: a.key }, sourceActivityLabel(a)))), form.sourceActivity ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "Demand estimate will scale from this session's actual ", fmt(form.sourceActivity.kcal / form.sourceActivity.durationMin, 1), " kcal/min \u2014 activity type/zone below were pre-filled from it, and duration can still be adjusted.") : activityLibrary.length === 0 ? /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, "No synced Strava/intervals.icu activities in the last ", ACTIVITY_LIBRARY_DAYS, " days yet.") : null)), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginBottom: 14 } }, /* @__PURE__ */ React.createElement(Field, { label: "Activity type" }, /* @__PURE__ */ React.createElement("select", { className: "inp", value: form.activityType, onChange: (e) => setForm((f) => ({ ...f, activityType: e.target.value })) }, ACTIVITY_TYPES.map((t) => /* @__PURE__ */ React.createElement("option", { key: t, value: t }, t)))), /* @__PURE__ */ React.createElement(Field, { label: form.kind === "race" ? "Expected finish time (min)" : "Duration (min)" }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "number", min: "1", value: form.durationMin, onChange: (e) => setForm((f) => ({ ...f, durationMin: e.target.value })) }))), /* @__PURE__ */ React.createElement(Field, { label: "Intensity zone" }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 4 } }, ZONES.map((z) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: z.n,
        type: "button",
        onClick: () => setForm((f) => ({ ...f, zone: z.n })),
        title: z.hrPct,
        style: form.zone === z.n ? { flex: 1, padding: "9px 6px", borderRadius: 4, fontWeight: 700, fontSize: 12, cursor: "pointer", border: "none", background: cyan, color: ink } : { flex: 1, padding: "9px 6px", borderRadius: 4, fontWeight: 600, fontSize: 12, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim }
      },
      "Z",
      z.n
    ))), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginTop: 4 } }, ZONES[form.zone - 1].label, " \xB7 ", ZONES[form.zone - 1].hrPct)), form.kind === "race" ? /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginTop: 14 } }, /* @__PURE__ */ React.createElement(Field, { label: "Race date" }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "date", value: form.raceDate, onChange: (e) => setForm((f) => ({ ...f, raceDate: e.target.value })) })), /* @__PURE__ */ React.createElement(Field, { label: "Taper starts (days before race)" }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "number", min: "0", value: form.taperDays, onChange: (e) => setForm((f) => ({ ...f, taperDays: e.target.value })) }))) : form.kind === "single" ? /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14 } }, /* @__PURE__ */ React.createElement(Field, { label: "Date" }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "date", value: form.date, onChange: (e) => setForm((f) => ({ ...f, date: e.target.value })) }))) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14 } }, /* @__PURE__ */ React.createElement("span", { className: "fieldlabel" }, "Days of week"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 4 } }, WEEKDAY_LABELS.map((label, n) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: n,
        type: "button",
        onClick: () => toggleDay(n),
        style: form.daysOfWeek.includes(n) ? { flex: 1, padding: "8px 4px", borderRadius: 4, fontWeight: 700, fontSize: 11.5, cursor: "pointer", border: "none", background: amber, color: ink } : { flex: 1, padding: "8px 4px", borderRadius: 4, fontWeight: 600, fontSize: 11.5, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim }
      },
      label
    )))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 14, marginTop: 14, alignItems: "end" } }, /* @__PURE__ */ React.createElement("div", { style: { flex: "1 1 140px" } }, /* @__PURE__ */ React.createElement(Field, { label: "Start date" }, /* @__PURE__ */ React.createElement("input", { className: "inp", type: "date", value: form.startDate, onChange: (e) => setForm((f) => ({ ...f, startDate: e.target.value })) }))), /* @__PURE__ */ React.createElement("div", { style: { flex: "1 1 140px" } }, /* @__PURE__ */ React.createElement(Field, { label: "End date" }, /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "inp",
        type: "date",
        value: form.endDate,
        disabled: form.ongoing,
        onChange: (e) => setForm((f) => ({ ...f, endDate: e.target.value })),
        style: { opacity: form.ongoing ? 0.5 : 1 }
      }
    ))), /* @__PURE__ */ React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 10, cursor: "pointer", whiteSpace: "nowrap" } }, /* @__PURE__ */ React.createElement("input", { type: "checkbox", checked: form.ongoing, onChange: (e) => setForm((f) => ({ ...f, ongoing: e.target.checked })) }), "Ongoing"))), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14 } }, /* @__PURE__ */ React.createElement(Field, { label: "Notes (optional)" }, /* @__PURE__ */ React.createElement("input", { className: "inp", value: form.notes, onChange: (e) => setForm((f) => ({ ...f, notes: e.target.value })), placeholder: form.kind === "race" ? "e.g. Boston Marathon" : "e.g. track intervals" }))), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 10, marginTop: 18 } }, /* @__PURE__ */ React.createElement("button", { className: "btn-primary", onClick: handleSubmit }, editingId ? "Save changes" : form.kind === "race" ? "Add race" : "Add to schedule"), editingId && /* @__PURE__ */ React.createElement("button", { className: "btn-ghost", onClick: cancelEdit }, "Cancel"))), races.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 14, display: "flex", alignItems: "center", gap: 7 } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.trophy, size: 16, color: gold }), " Races"), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 8, maxHeight: 260, overflowY: "auto", paddingRight: 4 } }, races.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.id, ref: (el) => {
      itemRefs.current[s.id] = el;
    }, style: scheduleRowStyle(highlightIds.includes(s.id)) }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("b", null, s.notes || s.activityType), " \xB7 ", s.activityType, " \xB7 ", ZONES[s.zone - 1].label.split(" \xB7 ")[1], " \xB7 ", s.durationMin, "min", /* @__PURE__ */ React.createElement("div", { style: { color: dim, fontSize: 11, marginTop: 2 } }, s.raceDate, " \xB7 taper starts ", s.taperDays, "d out", s.sourceActivity && ` \xB7 modeled on ${s.sourceActivity.date} (${s.sourceActivity.name})`)), /* @__PURE__ */ React.createElement("button", { title: "Edit", onClick: () => startEdit(s), style: { background: "none", border: "none", cursor: "pointer", padding: 4, color: dim } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.pencil, size: 13, color: dim })), /* @__PURE__ */ React.createElement("button", { title: "Delete", onClick: () => {
      if (confirm("Delete this race?")) onDelete(s.id);
    }, style: { background: "none", border: "none", cursor: "pointer", padding: 4, color: dim } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.trash, size: 13, color: coral })))))), singles.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 14 } }, "Single sessions"), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 8, maxHeight: 260, overflowY: "auto", paddingRight: 4 } }, singles.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.id, ref: (el) => {
      itemRefs.current[s.id] = el;
    }, style: scheduleRowStyle(highlightIds.includes(s.id)) }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("b", null, s.activityType), " \xB7 ", ZONES[s.zone - 1].label.split(" \xB7 ")[1], " \xB7 ", s.durationMin, "min", /* @__PURE__ */ React.createElement("div", { style: { color: dim, fontSize: 11, marginTop: 2 } }, s.date, s.notes ? ` \xB7 ${s.notes}` : "", s.sourceActivity && ` \xB7 modeled on ${s.sourceActivity.date} (${s.sourceActivity.name})`)), /* @__PURE__ */ React.createElement("button", { title: "Edit", onClick: () => startEdit(s), style: { background: "none", border: "none", cursor: "pointer", padding: 4, color: dim } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.pencil, size: 13, color: dim })), /* @__PURE__ */ React.createElement("button", { title: "Delete", onClick: () => {
      if (confirm("Delete this scheduled session?")) onDelete(s.id);
    }, style: { background: "none", border: "none", cursor: "pointer", padding: 4, color: dim } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.trash, size: 13, color: coral })))))), recurring.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 22 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 14 } }, "Recurring sessions"), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 8, maxHeight: 260, overflowY: "auto", paddingRight: 4 } }, recurring.map((s) => /* @__PURE__ */ React.createElement("div", { key: s.id, ref: (el) => {
      itemRefs.current[s.id] = el;
    }, style: scheduleRowStyle(highlightIds.includes(s.id)) }, /* @__PURE__ */ React.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ React.createElement("b", null, s.activityType), " \xB7 ", ZONES[s.zone - 1].label.split(" \xB7 ")[1], " \xB7 ", s.durationMin, "min", /* @__PURE__ */ React.createElement("div", { style: { color: dim, fontSize: 11, marginTop: 2 } }, s.daysOfWeek.map((n) => WEEKDAY_LABELS[n]).join(", "), " \xB7 from ", s.startDate, s.endDate ? ` to ${s.endDate}` : " (ongoing)", s.notes ? ` \xB7 ${s.notes}` : "", s.sourceActivity && ` \xB7 modeled on ${s.sourceActivity.date} (${s.sourceActivity.name})`)), /* @__PURE__ */ React.createElement("button", { title: "Edit", onClick: () => startEdit(s), style: { background: "none", border: "none", cursor: "pointer", padding: 4, color: dim } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.pencil, size: 13, color: dim })), /* @__PURE__ */ React.createElement("button", { title: "Delete", onClick: () => {
      if (confirm("Delete this scheduled session?")) onDelete(s.id);
    }, style: { background: "none", border: "none", cursor: "pointer", padding: 4, color: dim } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.trash, size: 13, color: coral })))))));
  }
  function DashboardTab({ rows, summary, bmr, fuelingByTier, goalParams, trendCorrection, trendCalibration, proteinGPerKg, weightGoalStatus, targetWeightKg, units }) {
    const wUnit = weightUnitLabel(units);
    const [visibleMacros, setVisibleMacros] = useState({ carbs: false, protein: false, fat: false });
    const [visibleWeightSeries, setVisibleWeightSeries] = useState({ actual: true, rollingAvg: true, target: true });
    const [showFuelingRef, setShowFuelingRef] = useState(false);
    const [showInfoPopout, setShowInfoPopout] = useState(false);
    const chartScrollRefs = useRef([]);
    const registerChartScroll = useCallback((el) => {
      if (el && !chartScrollRefs.current.includes(el)) chartScrollRefs.current.push(el);
    }, []);
    function syncChartScroll(e) {
      const scrollLeft = e.currentTarget.scrollLeft;
      chartScrollRefs.current.forEach((el) => {
        if (el && el !== e.currentTarget && el.scrollLeft !== scrollLeft) el.scrollLeft = scrollLeft;
      });
    }
    useEffect(() => {
      const id = requestAnimationFrame(() => {
        chartScrollRefs.current.forEach((el) => {
          if (el) el.scrollLeft = el.scrollWidth - el.clientWidth;
        });
      });
      return () => cancelAnimationFrame(id);
    }, [rows.length]);
    if (!bmr) return /* @__PURE__ */ React.createElement(EmptyState, { icon: ICONS.settings, text: "Enter your weight, height, age and sex in Setup to calculate a baseline." });
    if (!rows.length || rows.every((r) => r.activityCount === 0 && r.intake === null)) {
      return /* @__PURE__ */ React.createElement(EmptyState, { icon: ICONS.activity, text: "Pull training data from intervals.icu and import a nutrition CSV to see your energy balance." });
    }
    const hasWeight = rows.some((r) => r.weight !== null);
    const chartWidth = Math.max(rows.length * CHART_DAY_WIDTH, CHART_DAY_WIDTH * 7);
    const rowsWithTrend = rows.map((r, i) => {
      const window2 = rows.slice(Math.max(0, i - 6), i + 1).filter((x) => x.weight !== null);
      const trend = window2.length ? window2.reduce((s, x) => s + x.weight, 0) / window2.length : null;
      return {
        ...r,
        weight: r.weight !== null ? kgToDisplay(r.weight, units) : null,
        weightTrend: trend !== null ? kgToDisplay(trend, units) : null,
        targetWeight: targetWeightKg !== null ? kgToDisplay(targetWeightKg, units) : null
      };
    });
    return (
      // gridTemplateColumns is pinned to minmax(0, 1fr) rather than left as the
      // default "auto" — a card containing a chart pinned to a fixed pixel
      // width (days × 70px, easily 1000px+) would otherwise make its grid
      // track (and this whole column, and the page) blow out past the
      // viewport, since "auto" tracks size to their content's min-content
      // width. That silently broke the page's centering only while Dashboard
      // was open, since it's the only tab with fixed-width content this wide.
      /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 20, gridTemplateColumns: "minmax(0, 1fr)" } }, (summary.trainingMissingDays > 0 || summary.nutritionMissingDays > 0) && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, background: "rgba(232,163,61,0.1)", border: `1px solid ${amber}`, borderRadius: 6, padding: "12px 16px", fontSize: 12.5, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.warn, size: 16, color: amber }), /* @__PURE__ */ React.createElement("div", null, summary.trainingMissingDays > 0 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, summary.trainingMissingDays), " day", summary.trainingMissingDays === 1 ? "" : "s", " with no training data synced yet (demand is a floor, not the full picture)."), summary.nutritionMissingDays > 0 && /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, summary.nutritionMissingDays), " day", summary.nutritionMissingDays === 1 ? "" : "s", " with no nutrition logged."))), goalParams.sign !== 0 && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, background: "rgba(79,209,217,0.08)", border: `1px solid ${cyan}`, borderRadius: 6, padding: "12px 16px", fontSize: 12.5, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.gauge, size: 16, color: cyan }), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("b", null, goalParams.label), " at ", goalParams.ratePct, "%/week.", trendCalibration && trendCorrection && !trendCorrection.insufficient && /* @__PURE__ */ React.createElement(React.Fragment, null, " Trend calibration is live: ", trendCorrection.correctionKcal >= 0 ? "+" : "", fmt(trendCorrection.correctionKcal), " kcal/day applied based on your actual ", fmt(kgToDisplay(trendCorrection.actualWeeklyRateKg, units), 2), " ", wUnit, "/wk trend."), trendCalibration && trendCorrection && trendCorrection.insufficient && /* @__PURE__ */ React.createElement(React.Fragment, null, " Log weight for ~10+ days to enable trend-based calibration (", trendCorrection.n, " logged so far)."))), weightGoalStatus && /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 8, background: SEVERITY_BG[weightGoalStatus.severity], border: `1px solid ${SEVERITY_COLOR[weightGoalStatus.severity]}`, borderRadius: 6, padding: "12px 16px", fontSize: 12.5, alignItems: "flex-start" } }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.warn, size: 16, color: SEVERITY_COLOR[weightGoalStatus.severity] }), /* @__PURE__ */ React.createElement("div", null, formatWeightGoalMessage(weightGoalStatus, units))), !summary.noIntake && /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 } }, /* @__PURE__ */ React.createElement(StatCard, { label: "Avg. daily target", value: `${fmt(summary.avgTarget)} kcal`, color: cyan }), /* @__PURE__ */ React.createElement(StatCard, { label: "Avg. daily intake", value: `${fmt(summary.avgIntake)} kcal`, color: paper }), /* @__PURE__ */ React.createElement(StatCard, { label: "Avg. gap", value: `${summary.avgGap >= 0 ? "+" : ""}${fmt(summary.avgGap)} kcal`, color: summary.avgGap < -200 ? coral : summary.avgGap > 200 ? amber : mint }), /* @__PURE__ */ React.createElement(StatCard, { label: "Off-target days", value: `${summary.deficitDays} / ${summary.trackedDays}`, color: summary.deficitDays > summary.trackedDays / 3 ? coral : dim })), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: "20px 20px 16px" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12, padding: "0 4px" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, position: "relative" } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 14 } }, "Target vs. intake"), /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: () => setShowInfoPopout((v) => !v),
          title: "About these targets",
          style: { width: 17, height: 17, borderRadius: "50%", border: `1px solid ${dim}`, background: "transparent", color: dim, fontSize: 10.5, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, lineHeight: 1, fontStyle: "italic", fontFamily: "serif" }
        },
        "i"
      ), showInfoPopout && /* @__PURE__ */ React.createElement(FuelingInfoPopout, { proteinGPerKg, onClose: () => setShowInfoPopout(false) })), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } }, [["carbs", "Carbs", mint], ["protein", "Protein", lavender], ["fat", "Fat", gold]].map(([key, label, color]) => /* @__PURE__ */ React.createElement(
        "button",
        {
          key,
          onClick: () => setVisibleMacros((v) => ({ ...v, [key]: !v[key] })),
          style: visibleMacros[key] ? { padding: "5px 11px", borderRadius: 20, fontWeight: 700, fontSize: 11.5, cursor: "pointer", border: "none", background: color, color: ink } : { padding: "5px 11px", borderRadius: 20, fontWeight: 600, fontSize: 11.5, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim }
        },
        label
      )), /* @__PURE__ */ React.createElement(
        "button",
        {
          onClick: () => setShowFuelingRef((v) => !v),
          style: showFuelingRef ? { padding: "5px 11px", borderRadius: 20, fontWeight: 700, fontSize: 11.5, cursor: "pointer", border: "none", background: amber, color: ink } : { padding: "5px 11px", borderRadius: 20, fontWeight: 600, fontSize: 11.5, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim }
        },
        "Fueling ref"
      ))), /* @__PURE__ */ React.createElement("div", { ref: registerChartScroll, onScroll: syncChartScroll, style: { overflowX: "auto", overflowY: "hidden", maxWidth: "100%" } }, /* @__PURE__ */ React.createElement("div", { style: { width: chartWidth, margin: "0 auto" } }, /* @__PURE__ */ React.createElement(ComposedChart, { width: chartWidth, height: 280, data: rows, margin: { top: 4, right: 12, left: -14, bottom: 0 } }, /* @__PURE__ */ React.createElement(CartesianGrid, { stroke: line, vertical: false }), /* @__PURE__ */ React.createElement(XAxis, { dataKey: "label", tick: { fill: dim, fontSize: 11, fontFamily: mono }, axisLine: { stroke: line }, tickLine: false }), /* @__PURE__ */ React.createElement(YAxis, { yAxisId: "kcal", tick: { fill: dim, fontSize: 11, fontFamily: mono }, axisLine: false, tickLine: false }), (visibleMacros.carbs || visibleMacros.protein || visibleMacros.fat) && /* @__PURE__ */ React.createElement(YAxis, { yAxisId: "grams", orientation: "right", tick: { fill: dim, fontSize: 11, fontFamily: mono }, axisLine: false, tickLine: false, label: { value: "grams", angle: 90, position: "insideRight", fill: dim, fontSize: 10 } }), /* @__PURE__ */ React.createElement(Tooltip, { content: /* @__PURE__ */ React.createElement(CustomTooltip, null) }), /* @__PURE__ */ React.createElement(Bar, { yAxisId: "kcal", dataKey: "demand", name: "Modeled TDEE (kcal)", fill: panel2, stroke: line, strokeWidth: 1, radius: [2, 2, 0, 0] }), /* @__PURE__ */ React.createElement(Line, { yAxisId: "kcal", type: "monotone", dataKey: "target", name: "Target (kcal)", stroke: cyan, strokeWidth: 2, dot: false, strokeDasharray: goalParams.sign !== 0 ? "5 3" : void 0, connectNulls: true }), /* @__PURE__ */ React.createElement(Line, { yAxisId: "kcal", type: "monotone", dataKey: "intake", name: "Intake (kcal)", stroke: amber, strokeWidth: 2.2, dot: { r: 2.5, fill: amber }, connectNulls: true }), visibleMacros.carbs && /* @__PURE__ */ React.createElement(Line, { yAxisId: "grams", type: "monotone", dataKey: "carbs", name: "Carbs actual (g)", stroke: mint, strokeWidth: 2, dot: { r: 2, fill: mint }, connectNulls: true }), visibleMacros.carbs && /* @__PURE__ */ React.createElement(Line, { yAxisId: "grams", type: "monotone", dataKey: "carbTargetG", name: "Carbs target (g)", stroke: mint, strokeWidth: 1.5, strokeDasharray: "4 3", dot: false, connectNulls: true }), visibleMacros.protein && /* @__PURE__ */ React.createElement(Line, { yAxisId: "grams", type: "monotone", dataKey: "protein", name: "Protein actual (g)", stroke: lavender, strokeWidth: 2, dot: { r: 2, fill: lavender }, connectNulls: true }), visibleMacros.protein && /* @__PURE__ */ React.createElement(Line, { yAxisId: "grams", type: "monotone", dataKey: "proteinTargetG", name: "Protein target (g)", stroke: lavender, strokeWidth: 1.5, strokeDasharray: "4 3", dot: false, connectNulls: true }), visibleMacros.fat && /* @__PURE__ */ React.createElement(Line, { yAxisId: "grams", type: "monotone", dataKey: "fat", name: "Fat actual (g)", stroke: gold, strokeWidth: 2, dot: { r: 2, fill: gold }, connectNulls: true }), visibleMacros.fat && /* @__PURE__ */ React.createElement(Line, { yAxisId: "grams", type: "monotone", dataKey: "fatTargetG", name: "Fat target (g)", stroke: gold, strokeWidth: 1.5, strokeDasharray: "4 3", dot: false, connectNulls: true })))), showFuelingRef && /* @__PURE__ */ React.createElement(FuelingReferencePanel, { fuelingByTier })), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: "20px 20px 8px" } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 14, marginBottom: 12, padding: "0 4px" } }, "Daily gap (intake \u2212 target)"), /* @__PURE__ */ React.createElement("div", { ref: registerChartScroll, onScroll: syncChartScroll, style: { overflowX: "auto", overflowY: "hidden", maxWidth: "100%" } }, /* @__PURE__ */ React.createElement("div", { style: { width: chartWidth, margin: "0 auto" } }, /* @__PURE__ */ React.createElement(ComposedChart, { width: chartWidth, height: 200, data: rows, margin: { top: 4, right: 12, left: -14, bottom: 0 } }, /* @__PURE__ */ React.createElement(CartesianGrid, { stroke: line, vertical: false }), /* @__PURE__ */ React.createElement(XAxis, { dataKey: "label", tick: { fill: dim, fontSize: 11, fontFamily: mono }, axisLine: { stroke: line }, tickLine: false }), /* @__PURE__ */ React.createElement(YAxis, { tick: { fill: dim, fontSize: 11, fontFamily: mono }, axisLine: false, tickLine: false }), /* @__PURE__ */ React.createElement(ReferenceLine, { y: 0, stroke: dim }), /* @__PURE__ */ React.createElement(Tooltip, { content: /* @__PURE__ */ React.createElement(CustomTooltip, null) }), /* @__PURE__ */ React.createElement(Bar, { dataKey: "gap", name: "Gap (kcal)", radius: [2, 2, 2, 2] }, rows.map((r, i) => /* @__PURE__ */ React.createElement(Cell, { key: i, fill: r.gap === null ? line : r.gap < -200 ? coral : r.gap > 200 ? amber : mint }))))))), hasWeight && /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: "20px 20px 8px" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12, padding: "0 4px" } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 14 } }, "Body weight"), /* @__PURE__ */ React.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } }, [["actual", "Actual", dim], ["rollingAvg", "7-day avg", cyan], ...targetWeightKg !== null ? [["target", "Target", gold]] : []].map(([key, label, color]) => /* @__PURE__ */ React.createElement(
        "button",
        {
          key,
          onClick: () => setVisibleWeightSeries((v) => ({ ...v, [key]: !v[key] })),
          style: visibleWeightSeries[key] ? { padding: "5px 11px", borderRadius: 20, fontWeight: 700, fontSize: 11.5, cursor: "pointer", border: "none", background: color, color: ink } : { padding: "5px 11px", borderRadius: 20, fontWeight: 600, fontSize: 11.5, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim }
        },
        label
      )))), /* @__PURE__ */ React.createElement("div", { ref: registerChartScroll, onScroll: syncChartScroll, style: { overflowX: "auto", overflowY: "hidden", maxWidth: "100%" } }, /* @__PURE__ */ React.createElement("div", { style: { width: chartWidth, margin: "0 auto" } }, /* @__PURE__ */ React.createElement(ComposedChart, { width: chartWidth, height: 200, data: rowsWithTrend, margin: { top: 4, right: 12, left: -14, bottom: 0 } }, /* @__PURE__ */ React.createElement(CartesianGrid, { stroke: line, vertical: false }), /* @__PURE__ */ React.createElement(XAxis, { dataKey: "label", tick: { fill: dim, fontSize: 11, fontFamily: mono }, axisLine: { stroke: line }, tickLine: false }), /* @__PURE__ */ React.createElement(YAxis, { tick: { fill: dim, fontSize: 11, fontFamily: mono }, axisLine: false, tickLine: false, domain: ["dataMin - 1", "dataMax + 1"] }), /* @__PURE__ */ React.createElement(Tooltip, { content: /* @__PURE__ */ React.createElement(CustomTooltip, null) }), visibleWeightSeries.actual && /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "weight", name: `Weight (${wUnit})`, stroke: dim, strokeWidth: 1, dot: { r: 2.5, fill: dim }, connectNulls: false }), visibleWeightSeries.rollingAvg && /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "weightTrend", name: `7-day avg (${wUnit})`, stroke: cyan, strokeWidth: 2.2, dot: false, connectNulls: true }), visibleWeightSeries.target && targetWeightKg !== null && /* @__PURE__ */ React.createElement(Line, { type: "monotone", dataKey: "targetWeight", name: `Target (${wUnit})`, stroke: gold, strokeWidth: 2, strokeDasharray: "6 3", dot: false, connectNulls: true }))))), /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: 20 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 600, fontSize: 14, marginBottom: 12 } }, "Daily breakdown"), /* @__PURE__ */ React.createElement("div", { style: { maxHeight: 480, overflow: "auto" } }, /* @__PURE__ */ React.createElement("table", { className: "data" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", null, "Date"), /* @__PURE__ */ React.createElement("th", null, "Data"), /* @__PURE__ */ React.createElement("th", null, "Weight"), /* @__PURE__ */ React.createElement("th", null, "BMR"), /* @__PURE__ */ React.createElement("th", null, "Baseline"), /* @__PURE__ */ React.createElement("th", null, "Training"), /* @__PURE__ */ React.createElement("th", null, "EPOC"), /* @__PURE__ */ React.createElement("th", null, "Fatigue+"), /* @__PURE__ */ React.createElement("th", null, "Demand"), /* @__PURE__ */ React.createElement("th", null, "Target"), /* @__PURE__ */ React.createElement("th", null, "Intake"), /* @__PURE__ */ React.createElement("th", null, "Gap"), /* @__PURE__ */ React.createElement("th", null, "TSB"), /* @__PURE__ */ React.createElement("th", null, "Carbs (g)"), /* @__PURE__ */ React.createElement("th", null, "Protein (g)"), /* @__PURE__ */ React.createElement("th", null, "Fat (g)"))), /* @__PURE__ */ React.createElement("tbody", null, rows.slice().reverse().map((r) => {
        var _a, _b, _c;
        return /* @__PURE__ */ React.createElement("tr", { key: r.date }, /* @__PURE__ */ React.createElement("td", null, r.label), /* @__PURE__ */ React.createElement("td", { style: { textAlign: "left" } }, /* @__PURE__ */ React.createElement("span", { style: { display: "inline-flex", gap: 5 } }, /* @__PURE__ */ React.createElement(
          "span",
          {
            title: r.trainingMissing ? "No training data synced for this day" : r.source === "strava" ? "Training data from Strava" : r.source === "intervals" ? "Training data from intervals.icu (fallback)" : r.source === "planned" ? "Estimated from your training schedule \u2014 replaced automatically once synced" : "No training expected",
            style: { width: 7, height: 7, borderRadius: "50%", background: r.trainingMissing ? coral : r.source === "planned" ? cyan : r.source ? mint : line, display: "inline-block" }
          }
        ), /* @__PURE__ */ React.createElement(
          "span",
          {
            title: r.nutritionMissing ? "No nutrition logged for this day" : r.nutritionSource === "macrosfirst" ? "Nutrition from MacrosFirst" : "Nutrition entered manually",
            style: { width: 7, height: 7, borderRadius: "50%", background: r.nutritionMissing ? coral : r.intake !== null ? r.nutritionSource === "macrosfirst" ? amber : mint : line, display: "inline-block" }
          }
        ), /* @__PURE__ */ React.createElement(
          "span",
          {
            title: r.weightMissing ? "No weight logged for this day (using Setup default)" : "Weight logged",
            style: { width: 7, height: 7, borderRadius: "50%", background: r.weightMissing ? line : mint, display: "inline-block" }
          }
        ), r.preloading && !r.raceLoading && /* @__PURE__ */ React.createElement("span", { title: `Pre-loading carbs for tomorrow's ${((_a = r.preloadSession) == null ? void 0 : _a.activityType) || "session"}${r.borrowedKcal > 5 ? ` \u2014 borrowing ${fmt(r.borrowedKcal)} kcal from tomorrow's target` : ""}` }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.flame, size: 10, color: amber })), r.repaidKcal > 5 && /* @__PURE__ */ React.createElement("span", { title: `Repaying ${fmt(r.repaidKcal)} kcal borrowed by yesterday's pre-load` }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.gauge, size: 10, color: dim })), r.taper && /* @__PURE__ */ React.createElement("span", { title: `Tapering for ${r.taper.race.notes || r.taper.race.activityType + " race"} in ${r.taper.daysToRace}d \u2014 training scaled to ~${Math.round(r.taper.volumeFactor * 100)}% volume` }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.gauge, size: 10, color: lavender })), r.raceLoading && /* @__PURE__ */ React.createElement("span", { title: `Carb-loading ahead of ${((_b = r.race) == null ? void 0 : _b.notes) || ((_c = r.race) == null ? void 0 : _c.activityType) + " race"} in ${r.race ? daysBetween(r.date, r.race.raceDate) : "?"}d` }, /* @__PURE__ */ React.createElement(Icon, { path: ICONS.flame, size: 10, color: gold })))), /* @__PURE__ */ React.createElement("td", { style: { color: dim } }, r.weight !== null ? `${fmt(kgToDisplay(r.weight, units), 1)}${wUnit}` : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { color: dim } }, fmt(r.bmr)), /* @__PURE__ */ React.createElement("td", { style: { color: dim } }, fmt(r.baseline)), /* @__PURE__ */ React.createElement("td", null, r.exerciseKcal ? fmt(r.exerciseKcal) : r.trainingMissing ? /* @__PURE__ */ React.createElement("span", { style: { color: coral } }, "?") : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { color: dim } }, r.epocKcal ? fmt(r.epocKcal) : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { color: dim } }, r.fatigueBuffer ? fmt(r.fatigueBuffer) : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { color: dim } }, fmt(r.demand)), /* @__PURE__ */ React.createElement("td", { style: { color: cyan, fontWeight: 600 } }, fmt(r.target)), /* @__PURE__ */ React.createElement("td", { style: { color: amber } }, r.intake !== null ? fmt(r.intake) : r.nutritionMissing ? /* @__PURE__ */ React.createElement("span", { style: { color: coral } }, "?") : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { color: r.gap === null ? dim : r.gap < -200 ? coral : r.gap > 200 ? amber : mint, fontWeight: 600 } }, r.gap !== null ? `${r.gap >= 0 ? "+" : ""}${fmt(r.gap)}` : "\u2014"), /* @__PURE__ */ React.createElement("td", { style: { color: dim } }, r.tsb !== null ? fmt(r.tsb, 1) : "\u2014"), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement(MacroCell, { actual: r.carbs, target: r.carbTargetG })), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement(MacroCell, { actual: r.protein, target: r.proteinTargetG })), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement(MacroCell, { actual: r.fat, target: r.fatTargetG })));
      }))))))
    );
  }
  function MacroCell({ actual, target }) {
    if (target === null) return /* @__PURE__ */ React.createElement("span", { style: { color: dim } }, "\u2014");
    const pct = actual !== null ? actual / target : null;
    const color = pct === null ? dim : pct < 0.7 ? coral : pct > 1.3 ? amber : mint;
    return /* @__PURE__ */ React.createElement("span", { style: { color, fontWeight: 600 } }, actual !== null ? fmt(actual) : "?", /* @__PURE__ */ React.createElement("span", { style: { color: dim, fontWeight: 400 } }, " / ", fmt(target)));
  }
  function FuelingInfoPopout({ proteinGPerKg, onClose }) {
    return /* @__PURE__ */ React.createElement("div", { style: { position: "absolute", top: 26, left: 0, zIndex: 20, width: 340, maxWidth: "80vw", background: panel2, border: `1px solid ${line}`, borderRadius: 6, padding: 16, boxShadow: "0 10px 28px rgba(0,0,0,0.45)" } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 } }, /* @__PURE__ */ React.createElement("div", { style: { fontFamily: grotesk, fontWeight: 700, fontSize: 12.5 } }, "About these targets"), /* @__PURE__ */ React.createElement("button", { onClick: onClose, style: { background: "none", border: "none", color: dim, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 } }, "\xD7")), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11.5, color: dim, lineHeight: 1.6 } }, "Carbs follow the IOC/Burke carbohydrate-periodization framework (3\u20135 g/kg on light days up to 8\u201312 g/kg on 3h+ high-volume days), blending toward the top of the range the harder the day's training was \u2014 and if tomorrow has a demanding session scheduled (90min+ or Zone 4+), today's target pre-loads toward that higher tier too, per GSSI guidance to scale carbs to the demands of the ", /* @__PURE__ */ React.createElement("i", null, "upcoming"), " session. Protein is a flat ", /* @__PURE__ */ React.createElement("b", { style: { color: paper } }, proteinGPerKg, " g/kg/day"), " (adjustable in Setup \u2014 Model tuning). Fat fills whatever's left of the day's calorie Target after carbs and protein, with a floor of 20% of Target \u2014 sports-nutrition consensus treats fat below ~20% of total energy as a performance/health risk. These are general guidelines, not individualized advice."), /* @__PURE__ */ React.createElement("div", { style: { marginTop: 14, paddingTop: 12, borderTop: `1px solid ${line}`, fontSize: 11.5, color: dim, lineHeight: 1.6 } }, /* @__PURE__ */ React.createElement("b", { style: { color: paper } }, "In-session (\u226560 min):"), " 30\u201360 g carb/hour, up to ~90 g/hour beyond ~2.5h using multiple carb sources \u2014 practice this in training, don't debut it on race day.", /* @__PURE__ */ React.createElement("br", null), /* @__PURE__ */ React.createElement("b", { style: { color: paper } }, "Recovery window:"), " if under ~8h until your next session, aim for ~1.0\u20131.2 g/kg carb plus 20\u201340 g protein within the first couple hours post-workout."));
  }
  function FuelingReferencePanel({ fuelingByTier }) {
    return /* @__PURE__ */ React.createElement("div", { style: { marginTop: 16, paddingTop: 16, borderTop: `1px solid ${line}` } }, /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: fuelingByTier.length ? 18 : 0 } }, FUEL_TIERS.map((t) => /* @__PURE__ */ React.createElement("div", { key: t.tier, style: { background: panel2, border: `1px solid ${line}`, borderRadius: 5, padding: "10px 12px" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 11, color: dim, marginBottom: 4 } }, t.label), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: mono, fontSize: 12.5 } }, t.carbLo, "\u2013", t.carbHi, " g/kg carb")))), fuelingByTier.length > 0 && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 10 } }, "Your averages by tier, this window"), /* @__PURE__ */ React.createElement("div", { style: { display: "grid", gap: 8 } }, fuelingByTier.map((g) => /* @__PURE__ */ React.createElement("div", { key: g.tier, style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, fontSize: 12.5 } }, /* @__PURE__ */ React.createElement("div", { style: { width: 130, color: dim, flexShrink: 0 } }, g.label, " ", /* @__PURE__ */ React.createElement("span", { style: { fontFamily: mono } }, "(", g.n, "d)")), /* @__PURE__ */ React.createElement("div", { style: { flex: "1 1 100px" } }, "Carb: ", /* @__PURE__ */ React.createElement(MacroCell, { actual: g.avgCarb, target: g.avgCarbTarget }), " g"), /* @__PURE__ */ React.createElement("div", { style: { flex: "1 1 100px" } }, "Protein: ", /* @__PURE__ */ React.createElement(MacroCell, { actual: g.avgProtein, target: g.avgProteinTarget }), " g"), /* @__PURE__ */ React.createElement("div", { style: { flex: "1 1 100px" } }, "Fat: ", /* @__PURE__ */ React.createElement(MacroCell, { actual: g.avgFat, target: g.avgFatTarget }), " g"))))));
  }
  function CustomTooltip({ active, payload, label }) {
    if (!active || !payload || !payload.length) return null;
    return /* @__PURE__ */ React.createElement("div", { style: { background: panel2, border: `1px solid ${line}`, borderRadius: 4, padding: "10px 12px", fontFamily: mono, fontSize: 12 } }, /* @__PURE__ */ React.createElement("div", { style: { color: dim, marginBottom: 6 } }, label), payload.map((p, i) => /* @__PURE__ */ React.createElement("div", { key: i, style: { color: p.color, display: "flex", justifyContent: "space-between", gap: 16 } }, /* @__PURE__ */ React.createElement("span", null, p.name), /* @__PURE__ */ React.createElement("span", null, fmt(p.value)))));
  }
  function StatCard({ label, value, color }) {
    return /* @__PURE__ */ React.createElement("div", { className: "card", style: { padding: "16px 18px" } }, /* @__PURE__ */ React.createElement("div", { style: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: dim, fontWeight: 600, marginBottom: 8 } }, label), /* @__PURE__ */ React.createElement("div", { style: { fontFamily: mono, fontSize: 22, fontWeight: 600, color } }, value));
  }
  function EmptyState({ icon, text }) {
    return /* @__PURE__ */ React.createElement("div", { style: { padding: "80px 20px", textAlign: "center", color: dim } }, /* @__PURE__ */ React.createElement("div", { style: { display: "flex", justifyContent: "center", marginBottom: 14, opacity: 0.6 } }, /* @__PURE__ */ React.createElement(Icon, { path: icon, size: 28, color: dim })), /* @__PURE__ */ React.createElement("div", { style: { fontSize: 14, maxWidth: 380, margin: "0 auto", lineHeight: 1.6 } }, text));
  }
  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(/* @__PURE__ */ React.createElement(App, null));
})();
