
const { useState, useEffect, useMemo, useCallback, useRef } = React;
const {
  ComposedChart, Bar, Line, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine,
} = Recharts;
const Papa = window.Papa;

// ---------- design tokens ----------
const ink = "#0F1416";
const panel = "#161D20";
const panel2 = "#1D262A";
const line = "#2A363B";
const paper = "#EDE6D6";
const cyan = "#4FD1D9";
const amber = "#E8A33D";
const coral = "#E1604D";
const mint = "#7FC8A9";
const lavender = "#B98CE8";
const gold = "#E8C468";
const dim = "#7C8B8F";

const mono = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const grotesk = "'Space Grotesk', system-ui, sans-serif";
const body = "'Inter', system-ui, sans-serif";

function fmt(n, d = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
}
function toISODate(d) { return d.toISOString().slice(0, 10); }
// toISODate above converts through UTC, which silently rolls to the next day
// once local time is far enough ahead of UTC (e.g. after ~8pm EDT) — wrong for
// anything keying a calendar grid off the viewer's own local date. This stays
// in local time throughout.
function toLocalISODate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

// JS's native Date parser is notoriously inconsistent for anything but ISO
// or unambiguous US slash format — Google Sheets' FORMATTED_VALUE output
// varies by locale/cell format (e.g. with a trailing time, or DD/MM/YYYY),
// and a silent parse failure here is exactly what makes "3 rows found" turn
// into "0 imported" with no clue why. This tries the formats actually seen
// in CSV/Sheets exports before falling back to the native parser.
function parseFlexibleDate(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\s*[AaPp][Mm])?$/, ""); // strip a trailing time like " 0:00:00" or "T14:30", without mangling "Aug 21, 2026"

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); // ISO: YYYY-MM-DD
  if (m) {
    const [, y, mo, d] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // US: M/D/YYYY or M/D/YY
  if (m) {
    let [, mo, d, y] = m;
    if (y.length === 2) y = (Number(y) < 70 ? "20" : "19") + y;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const native = new Date(s); // handles "Aug 21, 2026" and similar
  return Number.isNaN(native.getTime()) ? null : native;
}

function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }

// ---------- persistence: server-side (/api/store), shared across every device
// pointed at this server instance, instead of per-browser localStorage ----------
async function storageGet(key, fallback) {
  try {
    const res = await fetch(`/api/store?key=${encodeURIComponent(key)}`);
    if (!res.ok) return fallback;
    const data = await res.json();
    return data.value !== null && data.value !== undefined ? data.value : fallback;
  } catch (e) {
    console.error("storage get failed", key, e);
    return fallback;
  }
}
async function storageSet(key, value) {
  try {
    await fetch(`/api/store?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  } catch (e) {
    console.error("storage set failed", key, e);
  }
}

// ---------- nutrition: MacrosFirst import always outranks a manual entry ----------
// Each day's stored value is { manual, macrosfirst } — both kept, nothing lost when
// they disagree — but the app displays/calculates from whichever is more authoritative.
// Legacy flat entries (from before this existed) are treated as "manual".
function normalizeNutritionEntry(raw) {
  if (!raw) return { manual: null, macrosfirst: null };
  if (raw.manual !== undefined || raw.macrosfirst !== undefined) {
    return { manual: raw.manual ?? null, macrosfirst: raw.macrosfirst ?? null };
  }
  return { manual: raw, macrosfirst: null }; // legacy flat shape
}
function effectiveNutritionEntry(raw) {
  const n = normalizeNutritionEntry(raw);
  return n.macrosfirst || n.manual || null;
}

// ---------- BMR / TDEE model ----------
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
// Same source-priority computation dailyRows uses per activity (Strava's own
// `calories`/`kilojoules`, or intervals.icu's `calories`/`icu_joules`), with
// no manual-override fallback — this is specifically "what would we compute
// with no help," used both to build exerciseKcal and to detect which
// activities have nothing usable and so need a manual entry.
function syncedActivityKcal(act, isStrava) {
  if (isStrava) {
    if (typeof act.calories === "number" && act.calories > 0) return act.calories;
    return typeof act.kilojoules === "number" ? act.kilojoules / 4.184 / 0.24 : 0;
  }
  return activityKcal(act);
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

// Strava's summary endpoint has no `calories`; only the per-activity detail
// endpoint does (fetched server-side by server.py). Intensity here is derived
// from Strava's own "suffer_score" (relative effort) rather than intervals.icu's
// training-load fields.
function stravaIntensityFactor(act) {
  if (typeof act.suffer_score === "number" && act.moving_time) {
    const hrs = act.moving_time / 3600;
    if (hrs <= 0) return 0.7;
    const perHr = act.suffer_score / hrs;
    return Math.min(1.3, Math.max(0.3, perHr / 60));
  }
  return 0.7;
}

// ---------- fueling targets: IOC/Burke carbohydrate periodization + ISSN protein ----------
// Carb tiers from Burke, Hawley, Wong & Jeukendrup (2011), "Carbohydrates for
// training and competition", J Sports Sci 29(S1) — the standard IOC-consensus
// framework for scaling daily carbohydrate to training volume. Protein ranges
// from the ISSN position stand on nutrient timing (Kerksick et al., 2017/2008),
// which centers endurance-athlete protein around 1.2–2.0 g/kg/day, rising with
// training demand. These are population-level sports-science guidelines, not
// individualized medical advice.
const FUEL_TIERS = [
  { tier: "rest", label: "Rest / light", maxMin: 20, carbLo: 3, carbHi: 5, proLo: 1.2, proHi: 1.4 },
  { tier: "moderate", label: "Moderate (~1h)", maxMin: 60, carbLo: 5, carbHi: 7, proLo: 1.4, proHi: 1.6 },
  { tier: "endurance", label: "Endurance (1–3h)", maxMin: 180, carbLo: 6, carbHi: 10, proLo: 1.6, proHi: 1.8 },
  { tier: "extreme", label: "High-volume (3h+)", maxMin: Infinity, carbLo: 8, carbHi: 12, proLo: 1.8, proHi: 2.0 },
];
function classifyTrainingTier(durationMin) {
  return FUEL_TIERS.find((t) => durationMin < t.maxMin) || FUEL_TIERS[FUEL_TIERS.length - 1];
}
// Blend within a tier's g/kg range by how intense the day's training was —
// easy days sit near the low end, hard days push toward the high end.
function intensityBlend(avgIF) {
  return Math.min(1, Math.max(0, (avgIF - 0.5) / (1.3 - 0.5)));
}

// ---------- training schedule: planned sessions + pre-load fueling ----------
// Zone bands follow the standard 5-zone %HRmax model; MET values are rough,
// activity-agnostic estimates for structured endurance training (i.e.
// noticeably harder than the general-population MET bands, since "Zone 1" for
// a trained athlete is already a jog, not a walk). 1 MET = 1 kcal/kg/hour
// (Compendium of Physical Activities), so estimated kcal = MET × kg × hours.
// This is only ever used before a session happens — once real Strava/intervals
// data syncs in for that date, the estimate is replaced automatically.
const ZONES = [
  { n: 1, label: "Zone 1 · Recovery", hrPct: "<50% HRmax", met: 4, if: 0.55 },
  { n: 2, label: "Zone 2 · Aerobic", hrPct: "50–63% HRmax", met: 7, if: 0.65 },
  { n: 3, label: "Zone 3 · Tempo", hrPct: "64–76% HRmax", met: 9, if: 0.75 },
  { n: 4, label: "Zone 4 · Threshold", hrPct: "77–93% HRmax", met: 11.5, if: 0.85 },
  { n: 5, label: "Zone 5 · VO2max", hrPct: "93%+ HRmax", met: 14, if: 0.95 },
];
const ACTIVITY_TYPES = ["Run", "Ride", "Swim", "Row", "Strength", "Other"];
const FORWARD_DAYS = 4; // how far ahead planned sessions project into the dashboard
const CHART_DAY_WIDTH = 70; // px per day — charts render at their full data width and scroll horizontally, showing 7 days (490px) at a time by default

function estimatePlannedKcal(zoneNum, durationMin, weightKg) {
  const z = ZONES[zoneNum - 1];
  if (!z || !weightKg) return 0;
  return z.met * weightKg * (durationMin / 60);
}
// Sessions demanding enough to warrant boosting the PRECEDING day's carb
// target — thresholds follow the >60–90min / higher-intensity language used
// throughout the sports-nutrition sources above (ISSN, GSSI).
function isPreloadWorthy(session) {
  return session.durationMin >= 90 || session.zone >= 4;
}
function getScheduledSessionsForDate(schedule, dateStr) {
  const weekday = new Date(dateStr + "T00:00:00").getDay(); // 0=Sun..6=Sat
  return schedule.filter((s) => {
    if (!s.daysOfWeek.includes(weekday)) return false;
    if (dateStr < s.startDate) return false;
    if (s.endDate && dateStr > s.endDate) return false;
    return true;
  });
}

// ---------- goal-based calorie targets + weight-trend calibration ----------
// ~7700 kcal ≈ 1 kg of body tissue is the standard practical approximation used
// by most sports-nutrition calculators to convert a target rate of weight
// change into a daily kcal surplus/deficit. It's a blended estimate (pure fat
// is ~9300 kcal/kg, muscle tissue considerably less) — a simplification, not
// a precise metabolic constant.
const KCAL_PER_KG_TISSUE = 7700;

// Defaults reflect commonly-cited practical guidelines for lifters training
// 2–3x/week: ~0.25% bodyweight/week for gaining (Helms' "no more than 0.25%/wk
// for advanced trainees" ceiling, widely used as a lean-bulk default) and
// ~0.5%/week for losing (the low end of the ~0.5–1%/week range generally
// considered sustainable without excess muscle loss). Both are adjustable.
const GOAL_DEFAULTS = {
  build: { ratePct: 0.25, min: 0.1, max: 0.75 },
  lose: { ratePct: 0.5, min: 0.25, max: 1.5 },
};
function getGoalParams(profile) {
  if (profile.goal === "build") return { sign: 1, ratePct: parseFloat(profile.buildRatePct) || GOAL_DEFAULTS.build.ratePct, label: "Building" };
  if (profile.goal === "lose") return { sign: -1, ratePct: parseFloat(profile.loseRatePct) || GOAL_DEFAULTS.lose.ratePct, label: "Losing" };
  return { sign: 0, ratePct: 0, label: "Maintaining" };
}

// Compares the ACTUAL weight trend from logged entries against the goal's
// target rate, and returns a daily kcal correction to bring future targets
// back toward that rate — the same feedback-loop idea trend-based trackers
// (e.g. MacroFactor-style adaptive TDEE) use instead of trusting a formula
// alone. Needs a reasonable spread of data before it will speak up.
function computeTrendCorrection(weightLog, goalSign, ratePct) {
  const entries = Object.entries(weightLog)
    .filter(([d]) => (new Date() - new Date(d)) / 86400000 <= 21)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length < 8) return { insufficient: true, n: entries.length };
  const t0 = new Date(entries[0][0]).getTime();
  const spanDays = (new Date(entries[entries.length - 1][0]).getTime() - t0) / 86400000;
  if (spanDays < 10) return { insufficient: true, n: entries.length, spanDays };

  // Linear regression (kg vs. day index) — more robust to daily water/glycogen
  // noise than just diffing the first and last data points.
  const xs = entries.map(([d]) => (new Date(d).getTime() - t0) / 86400000);
  const ys = entries.map(([, kg]) => kg);
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (ys[i] - meanY); den += (xs[i] - meanX) ** 2; }
  if (den === 0) return { insufficient: true, n };
  const actualWeeklyRateKg = (num / den) * 7;
  const targetWeeklyRateKg = goalSign * (ratePct / 100) * meanY;
  const rawCorrection = ((targetWeeklyRateKg - actualWeeklyRateKg) * KCAL_PER_KG_TISSUE) / 7;
  // Clamp so a noisy or short window can't swing the target wildly in one go.
  const correctionKcal = Math.max(-400, Math.min(400, rawCorrection));
  return { insufficient: false, n, spanDays, actualWeeklyRateKg, targetWeeklyRateKg, correctionKcal };
}

// ---------- tiny inline icon set (no icon library needed) ----------
function Icon({ path, size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d={path} />
    </svg>
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
};

function App() {
  const [tab, setTab] = useState("setup");
  const [profile, setProfile] = useState({
    sex: "male", weightKg: "", heightCm: "", age: "",
    neatFactor: 1.15, epocSensitivity: 1.0, fatigueBuffer: true,
    goal: "maintain", buildRatePct: GOAL_DEFAULTS.build.ratePct, loseRatePct: GOAL_DEFAULTS.lose.ratePct,
    trendCalibration: true,
    proteinGPerKg: 1.0,
    preloadBorrowRatio: 1.0,
  });
  const [loaded, setLoaded] = useState(false);
  const [nutrition, setNutrition] = useState({});
  const [weightLog, setWeightLog] = useState({}); // { 'YYYY-MM-DD': kg }
  const [schedule, setSchedule] = useState([]); // [{ id, activityType, zone, durationMin, daysOfWeek, startDate, endDate, notes }]
  const [calorieOverrides, setCalorieOverrides] = useState({}); // { activityId: kcal } — manual fallback, only used when Strava/intervals supply no calorie value at all
  const [csvPreview, setCsvPreview] = useState(null);
  const [csvPreviewSource, setCsvPreviewSource] = useState(null); // 'csv' | 'sheet'
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
      const [p, n, w, sched, cached, stravaCached, gLastSync, calOverrides] = await Promise.all([
        storageGet("profile", null),
        storageGet("nutrition-log", {}),
        storageGet("weight-log", {}),
        storageGet("training-schedule", []),
        storageGet("intervals-cache", null),
        storageGet("strava-cache", null),
        storageGet("google-last-auto-sync", null),
        storageGet("activity-calorie-overrides", {}),
      ]);
      setNutrition(n);
      setWeightLog(w);
      setSchedule(sched);
      setGoogleLastAutoSync(gLastSync);
      setCalorieOverrides(calOverrides);

      // Weight always reflects the most recent logged entry, so a fresh
      // session (new device, or a restart with no profile saved yet) starts
      // from real recent data instead of a stale or blank Setup value. Height
      // and age have no history to draw from — they just come from whatever
      // was saved in the profile originally.
      const latestWeightDate = Object.keys(w).sort().pop();
      const merged = { ...(p || {}) };
      if (latestWeightDate) merged.weightKg = String(w[latestWeightDate]);
      if (p || latestWeightDate) setProfile((prev) => ({ ...prev, ...merged }));

      if (cached) {
        setIntervalsData({
          activities: cached.activities || [],
          wellness: cached.wellness || [],
          syncedDates: cached.syncedDates || [],
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

  useEffect(() => { if (loaded) storageSet("profile", profile); }, [profile, loaded]);

  const saveNutrition = useCallback((next) => {
    setNutrition(next);
    storageSet("nutrition-log", next);
  }, []);

  const saveWeightLog = useCallback((next) => {
    setWeightLog(next);
    storageSet("weight-log", next);
  }, []);

  const saveSchedule = useCallback((next) => {
    setSchedule(next);
    storageSet("training-schedule", next);
  }, []);
  function addScheduleEntry(entry) {
    saveSchedule([...schedule, { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }]);
  }
  function updateScheduleEntry(id, entry) {
    saveSchedule(schedule.map((s) => (s.id === id ? { ...entry, id } : s)));
  }
  function deleteScheduleEntry(id) {
    saveSchedule(schedule.filter((s) => s.id !== id));
  }

  const saveCalorieOverrides = useCallback((next) => {
    setCalorieOverrides(next);
    storageSet("activity-calorie-overrides", next);
  }, []);
  function saveActivityCalories(activityId, kcal) {
    saveCalorieOverrides({ ...calorieOverrides, [activityId]: kcal });
  }
  function deleteActivityCalories(activityId) {
    const next = { ...calorieOverrides };
    delete next[activityId];
    saveCalorieOverrides(next);
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

  function guessColumnMapping(fields) {
    const guess = (patterns) => fields.find((f) => patterns.some((p) => f.toLowerCase().includes(p))) || "";
    return {
      date: guess(["date"]),
      calories: guess(["calorie", "kcal", "energy"]),
      protein: guess(["protein"]),
      carbs: guess(["carb"]),
      fat: guess(["fat"]),
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
      },
      error: (err) => alert("Could not parse CSV: " + err.message),
    });
  }

  async function syncGoogleSheet() {
    if (!googleStatus.connected) return;
    setGoogleFetching(true);
    setGoogleError(null);
    try {
      const res = await fetch("/api/google/sheet");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Google Sheets request failed (${res.status}).`);
      if (!data.fields.length) throw new Error("Sheet appears empty — check google_sheet_id and google_sheet_range in config.json.");
      setColMap(guessColumnMapping(data.fields));
      setCsvPreview({ fields: data.fields, rows: data.rows });
      setCsvPreviewSource("sheet");
    } catch (e) {
      setGoogleError(e.message || "Could not reach the local server's Google Sheets proxy.");
    } finally {
      setGoogleFetching(false);
    }
  }

  function importMappedCSV() {
    if (!csvPreview || !colMap.date || !colMap.calories) {
      alert("Map at least the date and calories columns first.");
      return;
    }
    const next = { ...nutrition };
    const importedDates = [];
    const skippedExamples = [];
    let count = 0;
    for (const row of csvPreview.rows) {
      const rawDate = row[colMap.date];
      const d = parseFlexibleDate(rawDate);
      if (!d) {
        if (skippedExamples.length < 3) skippedExamples.push(JSON.stringify(rawDate));
        continue;
      }
      const key = toISODate(d);
      const existing = normalizeNutritionEntry(next[key]);
      next[key] = {
        ...existing,
        macrosfirst: {
          calories: parseFloat(row[colMap.calories]) || 0,
          protein: colMap.protein ? parseFloat(row[colMap.protein]) || 0 : (existing.macrosfirst?.protein ?? 0),
          carbs: colMap.carbs ? parseFloat(row[colMap.carbs]) || 0 : (existing.macrosfirst?.carbs ?? 0),
          fat: colMap.fat ? parseFloat(row[colMap.fat]) || 0 : (existing.macrosfirst?.fat ?? 0),
        },
      };
      importedDates.push(key);
      count++;
    }
    saveNutrition(next);
    setCsvPreview(null);
    if (csvPreviewSource === "sheet") {
      storageSet("google-sheet-colmap", colMap); // lets the server's auto-sync reuse this mapping
    }
    setCsvPreviewSource(null);
    if (count === 0 && skippedExamples.length) {
      alert(`0 rows imported — the date column's values couldn't be parsed. Example raw value(s): ${skippedExamples.join(", ")}. Double-check the date column is mapped correctly, or tell me what format that is and I'll add support for it.`);
    } else {
      alert(`Imported ${count} day(s) of nutrition data from MacrosFirst${skippedExamples.length ? ` (${skippedExamples.length} row(s) skipped — unparseable date)` : ""}. These take priority over any manual entries for the same days.`);
    }

    // A newly-logged nutrition day is a signal this day matters — make sure we
    // also have training data for it (Strava + intervals.icu), without
    // re-syncing days we already have.
    const newDates = Array.from(new Set(importedDates));
    if (stravaStatus.connected) {
      const missing = newDates.filter((d) => !stravaData.syncedDates.includes(d));
      if (missing.length) fetchStrava(missing);
    }
    if (intervalsStatus.configured) {
      const missing = newDates.filter((d) => !intervalsData.syncedDates.includes(d));
      if (missing.length) fetchIntervals(missing);
    }
  }

  function saveManualDay(date, entry) {
    const existing = normalizeNutritionEntry(nutrition[date]);
    const next = { ...nutrition, [date]: { ...existing, manual: entry } };
    saveNutrition(next);
    if (stravaStatus.connected && !stravaData.syncedDates.includes(date)) fetchStrava([date]);
    if (intervalsStatus.configured && !intervalsData.syncedDates.includes(date)) fetchIntervals([date]);
  }

  function deleteNutritionDay(date) {
    const next = { ...nutrition };
    delete next[date];
    saveNutrition(next);
  }

  function saveManualWeight(date, kg) {
    saveWeightLog({ ...weightLog, [date]: kg });
  }

  function deleteWeightDay(date) {
    const next = { ...weightLog };
    delete next[date];
    saveWeightLog(next);
  }

  async function fetchIntervals(dates) {
    if (!intervalsStatus.configured) return [];
    if (dates && dates.length === 0) return [];
    setFetching(true);
    setFetchError(null);
    try {
      const url = dates && dates.length
        ? `/api/intervals/activities?dates=${dates.join(",")}`
        : `/api/intervals/activities?days=${rangeDays}`; // full pull; server dedupes internally
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `intervals.icu request failed (${res.status}).`);
      const fetchedAt = new Date().toISOString();
      let newDates = [];
      setIntervalsData((prev) => {
        const resynced = new Set(data.syncedDates || []);
        const keptActs = prev.activities.filter((a) => !resynced.has((a.start_date_local || a.start_date || "").slice(0, 10)));
        const keptWell = prev.wellness.filter((w) => !resynced.has(w.id || w.date));
        const merged = {
          activities: [...keptActs, ...data.activities],
          wellness: [...keptWell, ...data.wellness],
          syncedDates: Array.from(new Set([...prev.syncedDates, ...(data.syncedDates || [])])).sort(),
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
    if (dates && dates.length === 0) return; // nothing new — skip the call entirely
    setStravaFetching(true);
    setStravaError(null);
    try {
      const url = dates && dates.length
        ? `/api/strava/activities?dates=${dates.join(",")}`
        : `/api/strava/activities?days=${rangeDays}`; // full pull; server dedupes internally
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Strava request failed (${res.status}).`);
      const fetchedAt = new Date().toISOString();
      setStravaData((prev) => {
        const resynced = new Set(data.syncedDates || []);
        // Replace, don't just append, for any date we just re-synced (handles
        // deleted/edited activities on that day).
        const keptOld = prev.activities.filter((a) => !resynced.has((a.start_date_local || "").slice(0, 10)));
        const merged = [...keptOld, ...data.activities];
        const syncedSet = new Set([...prev.syncedDates, ...(data.syncedDates || [])]);
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
    // Both endpoints dedupe against their own disk cache server-side, so it's
    // safe (and simple) to always request the full window here — no repeat
    // network calls happen for days already cached, on either end.
    await Promise.all([fetchIntervals(), fetchStrava()]);
    setTab("dashboard");
  }

  const dailyRows = useMemo(() => {
    if (!bmr) return [];
    const wellByDate = {};
    for (const w of intervalsData.wellness) { const d = w.id || w.date; if (d) wellByDate[d] = w; }
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
    let carryRepaymentKcal = 0; // debt owed to the CURRENT day by the previous day's pre-load borrowing
    for (let i = rangeDays - 1; i >= -FORWARD_DAYS; i--) {
      const d = daysAgo(i);
      const key = toISODate(d);
      const stravaActs = stravaByDate[key] || [];
      const intervalsActs = actByDate[key] || [];
      const stravaSynced = stravaSyncedSet.has(key);
      const scheduledSessions = getScheduledSessionsForDate(schedule, key);

      // Use that day's logged weight for BMR/targets when available — body
      // weight shifts across a training block, and this keeps demand/fueling
      // numbers tracking the athlete rather than a single fixed profile value.
      // (Computed early since planned-session kcal estimates need it too.)
      const weightForDay = weightLog[key] ?? (parseFloat(profile.weightKg) || null);

      // Prefer Strava's own per-activity `calories` (accurate) when we have it
      // for this day; fall back to intervals.icu; fall back further to a
      // planned-session estimate (only relevant when nothing's actually
      // synced yet — today or a future day, or a past day not yet uploaded).
      let exerciseKcal = 0, epocKcal = 0, source = null;
      let durationSec = 0, ifWeightedSum = 0;
      if (stravaActs.length) {
        source = "strava";
        for (const a of stravaActs) {
          const synced = syncedActivityKcal(a, true);
          const kcal = synced > 0 ? synced : (calorieOverrides[String(a.id)] || 0);
          exerciseKcal += kcal;
          const IF = stravaIntensityFactor(a);
          epocKcal += kcal * epocFactorFor(IF) * profile.epocSensitivity;
          durationSec += a.moving_time || 0;
          ifWeightedSum += IF * (a.moving_time || 0);
        }
      } else if (intervalsActs.length) {
        source = "intervals";
        for (const a of intervalsActs) {
          const synced = syncedActivityKcal(a, false);
          const kcal = synced > 0 ? synced : (calorieOverrides[String(a.id)] || 0);
          exerciseKcal += kcal;
          const IF = intensityFactor(a);
          epocKcal += kcal * epocFactorFor(IF) * profile.epocSensitivity;
          durationSec += a.moving_time || 0;
          ifWeightedSum += IF * (a.moving_time || 0);
        }
      } else if (scheduledSessions.length) {
        source = "planned";
        for (const s of scheduledSessions) {
          const z = ZONES[s.zone - 1];
          const kcal = estimatePlannedKcal(s.zone, s.durationMin, weightForDay);
          exerciseKcal += kcal;
          epocKcal += kcal * epocFactorFor(z.if) * profile.epocSensitivity;
          durationSec += s.durationMin * 60;
          ifWeightedSum += z.if * (s.durationMin * 60);
        }
      } else if (stravaSynced) {
        source = "strava"; // confirmed rest day — zero is a real answer, not a gap
      }
      const durationMin = durationSec / 60;
      const avgIF = durationSec > 0 ? ifWeightedSum / durationSec : 0.5;

      const dayBmr = weightForDay
        ? calcBMR(profile.sex, weightForDay, parseFloat(profile.heightCm), parseFloat(profile.age))
        : bmr;

      const w = wellByDate[key];
      const ctl = w?.ctl ?? null;
      const atl = w?.atl ?? null;
      const tsb = ctl !== null && atl !== null ? ctl - atl : null;
      const fatigueBuffer = profile.fatigueBuffer && tsb !== null && tsb < -10 ? dayBmr * 0.05 : 0;
      const baseline = dayBmr * (parseFloat(profile.neatFactor) || 1.15);
      const demand = baseline + exerciseKcal + epocKcal + fatigueBuffer;
      const nutritionEntry = effectiveNutritionEntry(nutrition[key]);
      const nutritionSource = nutritionEntry ? (normalizeNutritionEntry(nutrition[key]).macrosfirst ? "macrosfirst" : "manual") : null;
      const intake = nutritionEntry?.calories ?? null;

      // Goal-adjusted target: demand plus the surplus/deficit needed for the
      // chosen weight-gain/loss rate, plus a trend-calibration correction if
      // the observed weight trend is drifting off that rate. For "maintain"
      // (sign 0, no correction data yet) this reduces to target === demand.
      const goalAdjustmentKcal = weightForDay ? goalParams.sign * (goalParams.ratePct / 100) * weightForDay * KCAL_PER_KG_TISSUE / 7 : 0;
      const calibrationKcal = (profile.trendCalibration && trendCorrection && !trendCorrection.insufficient) ? trendCorrection.correctionKcal : 0;
      const baseTarget = demand + goalAdjustmentKcal + calibrationKcal;

      // Fueling targets: carbs scale with the IOC/Burke tier as before. If
      // tomorrow needs pre-loading, the *extra* carbs above today's own tier
      // can be funded two ways, blended by preloadBorrowRatio (0–1):
      //   0   = absorbed by shrinking today's fat (same total Target)
      //   1   = today's Target actually increases by that amount, and
      //         tomorrow's Target is debited the same amount to repay it —
      //         a real day-before "overeat a bit, eat a bit less after" swap
      //         rather than just reallocating today's own macros.
      // Protein is a flat, adjustable g/kg rate. Fat fills whatever's left of
      // the (possibly borrow-adjusted) Target, floored at 20% of Target —
      // sports-nutrition consensus treats fat below ~20% of energy as a risk.
      const fuelTier = classifyTrainingTier(durationMin);
      const tomorrowKey = toISODate(daysAgo(i - 1));
      const tomorrowSessions = getScheduledSessionsForDate(schedule, tomorrowKey);
      const preloadSession = tomorrowSessions.filter(isPreloadWorthy).sort((a, b) => b.durationMin - a.durationMin)[0];
      const preloadTier = preloadSession ? classifyTrainingTier(preloadSession.durationMin) : null;
      const preloading = !!(preloadTier && FUEL_TIERS.indexOf(preloadTier) > FUEL_TIERS.indexOf(fuelTier));
      const effectiveTier = preloading ? preloadTier : fuelTier;
      const blend = intensityBlend(avgIF);
      const normalCarbTargetG = weightForDay ? weightForDay * (fuelTier.carbLo + (fuelTier.carbHi - fuelTier.carbLo) * blend) : null;
      const carbTargetG = weightForDay ? weightForDay * (effectiveTier.carbLo + (effectiveTier.carbHi - effectiveTier.carbLo) * blend) : null;
      const extraCarbKcal = (preloading && carbTargetG !== null && normalCarbTargetG !== null) ? (carbTargetG - normalCarbTargetG) * 4 : 0;
      const borrowRatio = Math.min(1, Math.max(0, parseFloat(profile.preloadBorrowRatio)));
      const borrowedKcal = extraCarbKcal * (isNaN(borrowRatio) ? 1 : borrowRatio);

      // Apply today: repay what yesterday borrowed from today, then borrow
      // today's own share from tomorrow.
      const repaidKcal = carryRepaymentKcal; // capture before we overwrite it below
      const target = baseTarget - repaidKcal + borrowedKcal;
      carryRepaymentKcal = borrowedKcal; // tomorrow's iteration will subtract this

      const gap = intake !== null ? intake - target : null;

      const proteinTargetG = weightForDay ? weightForDay * (parseFloat(profile.proteinGPerKg) || 1.0) : null;
      const fatFloorG = target * 0.20 / 9;
      const fatRemainderG = (target - (carbTargetG || 0) * 4 - (proteinTargetG || 0) * 4) / 9;
      const fatTargetG = weightForDay ? Math.max(fatFloorG, fatRemainderG) : null;

      // A day only counts as "missing training data" if we genuinely don't know
      // (no actual sync, and no plan either) — a confirmed rest day, or a
      // planned/estimated day, is NOT missing.
      const trainingMissing = !stravaSynced && intervalsActs.length === 0 && source !== "planned";
      const nutritionMissing = intake === null;
      const weightMissing = weightLog[key] === undefined;
      const isFutureOrToday = key >= toISODate(new Date());

      days.push({
        date: key,
        label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        bmr: dayBmr, baseline, exerciseKcal, epocKcal, fatigueBuffer, demand, target,
        intake, gap, tsb, source,
        weight: weightLog[key] ?? null,
        protein: nutritionEntry?.protein ?? null,
        carbs: nutritionEntry?.carbs ?? null,
        fat: nutritionEntry?.fat ?? null,
        nutritionSource,
        activityCount: stravaActs.length || intervalsActs.length || scheduledSessions.length,
        trainingMissing: trainingMissing && !isFutureOrToday,
        nutritionMissing: nutritionMissing && !isFutureOrToday,
        weightMissing: weightMissing && !isFutureOrToday,
        durationMin, fuelTier, carbTargetG, proteinTargetG, fatTargetG, isFutureOrToday,
        scheduledSessions, preloading, preloadSession, borrowedKcal, repaidKcal,
      });
    }
    return days;
  }, [intervalsData, stravaData, nutrition, weightLog, schedule, bmr, profile, rangeDays, goalParams, trendCorrection, calorieOverrides]);

  // Activities with no calorie value from either source, so `dailyRows`
  // above silently fell back to a manual override (or, if none is on file
  // yet, folded a 0 into that day's exerciseKcal). Uses the same per-day
  // source priority as dailyRows — Strava's activities for a date fully
  // supersede intervals.icu's for that date — so this list matches exactly
  // what dailyRows actually counted, never a stray intervals.icu activity
  // that Strava already covers for the same day.
  const activitiesNeedingCalories = useMemo(() => {
    const stravaByDate = {};
    for (const a of stravaData.activities) {
      const d = (a.start_date_local || "").slice(0, 10);
      if (!d) continue;
      if (!stravaByDate[d]) stravaByDate[d] = [];
      stravaByDate[d].push(a);
    }
    const intervalsByDate = {};
    for (const a of intervalsData.activities) {
      const d = (a.start_date_local || a.start_date || "").slice(0, 10);
      if (!d) continue;
      if (!intervalsByDate[d]) intervalsByDate[d] = [];
      intervalsByDate[d].push(a);
    }
    const dates = new Set([...Object.keys(stravaByDate), ...Object.keys(intervalsByDate)]);
    const out = [];
    for (const d of dates) {
      const acts = stravaByDate[d]
        ? stravaByDate[d].map((a) => ({ act: a, isStrava: true }))
        : (intervalsByDate[d] || []).map((a) => ({ act: a, isStrava: false }));
      for (const { act, isStrava } of acts) {
        if (act.id === undefined || act.id === null) continue;
        const id = String(act.id);
        if (syncedActivityKcal(act, isStrava) > 0) continue;
        if (calorieOverrides[id] !== undefined) continue;
        out.push({
          id, date: d, isStrava,
          source: isStrava ? "strava" : "intervals",
          name: act.name || "(unnamed activity)",
          type: act.type || act.icu_type || null,
          durationMin: act.moving_time ? act.moving_time / 60 : null,
        });
      }
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [stravaData, intervalsData, calorieOverrides]);

  // Same activity id -> {date, name, source} lookup, but unfiltered — used to
  // label existing overrides (including ones for an activity that's since
  // been re-synced with real data, so the override table can still show what
  // it applies to).
  const activityLabelsById = useMemo(() => {
    const map = {};
    for (const a of stravaData.activities) {
      if (a.id === undefined || a.id === null) continue;
      map[String(a.id)] = { date: (a.start_date_local || "").slice(0, 10), name: a.name || "(unnamed activity)", source: "strava" };
    }
    for (const a of intervalsData.activities) {
      if (a.id === undefined || a.id === null) continue;
      const id = String(a.id);
      if (map[id]) continue; // Strava takes priority, same as everywhere else
      map[id] = { date: (a.start_date_local || a.start_date || "").slice(0, 10), name: a.name || "(unnamed activity)", source: "intervals" };
    }
    return map;
  }, [stravaData, intervalsData]);

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

  // Groups days by training-load tier and compares actual vs. targeted carb/
  // protein intake within each — this is the "guide future similar workouts"
  // view: it shows, from your own history, how close you typically land to
  // the target the next time you do a workout in that same tier.
  const fuelingByTier = useMemo(() => {
    const groups = {};
    for (const d of dailyRows) {
      if (d.carbTargetG === null || d.isFutureOrToday) continue;
      if (d.carbs === null && d.protein === null) continue;
      const key = d.fuelTier.tier;
      if (!groups[key]) groups[key] = { tier: key, label: d.fuelTier.label, days: [] };
      groups[key].days.push(d);
    }
    return FUEL_TIERS
      .map((t) => groups[t.tier])
      .filter(Boolean)
      .map((g) => {
        const n = g.days.length;
        const avgCarb = g.days.reduce((s, d) => s + (d.carbs ?? 0), 0) / n;
        const avgCarbTarget = g.days.reduce((s, d) => s + d.carbTargetG, 0) / n;
        const avgProtein = g.days.reduce((s, d) => s + (d.protein ?? 0), 0) / n;
        const avgProteinTarget = g.days.reduce((s, d) => s + d.proteinTargetG, 0) / n;
        const avgFat = g.days.reduce((s, d) => s + (d.fat ?? 0), 0) / n;
        const avgFatTarget = g.days.reduce((s, d) => s + (d.fatTargetG ?? 0), 0) / n;
        return { ...g, n, avgCarb, avgCarbTarget, avgProtein, avgProteinTarget, avgFat, avgFatTarget };
      });
  }, [dailyRows]);

  return (
    <div style={{ background: ink, minHeight: "100vh", color: paper, fontFamily: body }}>
      <style>{`
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
        table.data th { text-align:right; padding: 8px 10px; color: ${dim}; font-weight:600; border-bottom: 1px solid ${line}; text-transform:uppercase; font-size:10.5px; letter-spacing:0.05em; }
        table.data td { text-align:right; padding: 7px 10px; border-bottom: 1px solid ${line}; }
        table.data th:first-child, table.data td:first-child { text-align:left; font-family: ${body}; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
      `}</style>

      <div style={{ borderBottom: `1px solid ${line}`, padding: "18px 28px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src="/logo-header.png" alt="" width={28} height={28} style={{ borderRadius: 6, display: "block" }} />
          <div>
            <div style={{ fontFamily: grotesk, fontWeight: 700, fontSize: 17, letterSpacing: "-0.01em" }}>Energy Balance</div>
            <div style={{ fontSize: 11, color: dim, fontFamily: mono, marginTop: 1 }}>training demand vs. fuel intake — local build</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {[
            { id: "setup", label: "Setup", icon: ICONS.settings },
            { id: "import", label: "Log", icon: ICONS.upload },
            { id: "schedule", label: "Schedule", icon: ICONS.calendar },
            { id: "dashboard", label: "Dashboard", icon: ICONS.activity },
          ].map(({ id, label, icon }) => (
            <div key={id} className={`navbtn ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
              <Icon path={icon} size={14} /> {label}
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: "24px 28px", maxWidth: 1080, margin: "0 auto" }}>
        {tab === "setup" && (
          <SetupTab profile={profile} setProfile={setProfile} bmr={bmr} onFetch={pullAll}
            fetching={fetching || stravaFetching} fetchError={fetchError} rangeDays={rangeDays} setRangeDays={setRangeDays}
            lastFetched={lastFetched} stravaStatus={stravaStatus} stravaError={stravaError}
            stravaLastFetched={stravaLastFetched} stravaSyncedCount={stravaData.syncedDates.length}
            intervalsStatus={intervalsStatus} intervalsSyncedCount={intervalsData.syncedDates.length}
            goalParams={goalParams} trendCorrection={trendCorrection} />
        )}
        {tab === "import" && (
          <ImportTab onFile={handleCSVFile} csvPreview={csvPreview} colMap={colMap} setColMap={setColMap}
            onImport={importMappedCSV} nutrition={nutrition} onSaveManualDay={saveManualDay}
            onDeleteDay={deleteNutritionDay} weightLog={weightLog} onSaveWeight={saveManualWeight}
            onDeleteWeight={deleteWeightDay} googleStatus={googleStatus} googleFetching={googleFetching}
            googleError={googleError} onSyncGoogleSheet={syncGoogleSheet} googleLastAutoSync={googleLastAutoSync}
            activitiesNeedingCalories={activitiesNeedingCalories} calorieOverrides={calorieOverrides}
            activityLabelsById={activityLabelsById} onSaveActivityCalories={saveActivityCalories}
            onDeleteActivityCalories={deleteActivityCalories} />
        )}
        {tab === "schedule" && (
          <ScheduleTab schedule={schedule} onAdd={addScheduleEntry} onUpdate={updateScheduleEntry}
            onDelete={deleteScheduleEntry} />
        )}
        {tab === "dashboard" && (
          <DashboardTab rows={dailyRows} summary={summary} bmr={bmr} fuelingByTier={fuelingByTier}
            goalParams={goalParams} trendCorrection={trendCorrection} trendCalibration={profile.trendCalibration}
            proteinGPerKg={profile.proteinGPerKg} />
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return <div><span className="fieldlabel">{label}</span>{children}</div>;
}

function SetupTab({ profile, setProfile, bmr, onFetch, fetching, fetchError, rangeDays, setRangeDays, lastFetched, stravaStatus, stravaError, stravaLastFetched, stravaSyncedCount, intervalsStatus, intervalsSyncedCount, goalParams, trendCorrection }) {
  const set = (k) => (e) => setProfile((p) => ({ ...p, [k]: e.target.value }));
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 16 }}>Athlete profile</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          <Field label="Sex">
            <select className="inp" value={profile.sex} onChange={set("sex")}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </Field>
          <Field label="Weight (kg)"><input className="inp" value={profile.weightKg} onChange={set("weightKg")} placeholder="70" /></Field>
          <Field label="Height (cm)"><input className="inp" value={profile.heightCm} onChange={set("heightCm")} placeholder="178" /></Field>
          <Field label="Age"><input className="inp" value={profile.age} onChange={set("age")} placeholder="34" /></Field>
        </div>
        {bmr && (
          <div style={{ marginTop: 16, fontFamily: mono, fontSize: 13, color: cyan }}>
            Mifflin-St Jeor BMR: <b>{fmt(bmr)} kcal/day</b>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}>
          <Icon path={ICONS.flame} size={16} color={amber} /> Training calories — Strava
        </div>
        <div style={{ fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 }}>
          Strava only exposes accurate per-activity <code>calories</code> through an authenticated,
          server-side call — this runs through <code>server.py</code> next to this page, which keeps your
          client secret out of the browser. See <code>config.example.json</code> for setup. Every pull is
          cached to disk by date server-side, so repeat pulls only ever hit Strava for today — a fresh
          nutrition entry also triggers a background sync for just that date.
        </div>
        {!stravaStatus.checked ? (
          <div style={{ fontSize: 12.5, color: dim }}>Checking connection…</div>
        ) : stravaStatus.unreachable ? (
          <div style={{ fontSize: 12.5, color: coral }}>Can't reach the local server. Make sure you're running this page via <code>python3 server.py</code>, not a plain file server.</div>
        ) : stravaStatus.configError ? (
          <div style={{ fontSize: 12.5, color: coral }}>Server is missing <code>config.json</code> — copy <code>config.example.json</code>, fill in your Strava client_id/secret, and restart <code>server.py</code>.</div>
        ) : stravaStatus.connected ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <Icon path={ICONS.check} size={15} color={mint} />
            <span>Connected{stravaStatus.athlete?.firstname ? ` as ${stravaStatus.athlete.firstname} ${stravaStatus.athlete.lastname || ""}` : ""}</span>
          </div>
        ) : ["localhost", "127.0.0.1"].includes(window.location.hostname) ? (
          <a className="btn-primary" href="/login" style={{ textDecoration: "none", width: "fit-content" }}>
            <Icon path={ICONS.link} size={13} color={ink} /> Connect to Strava
          </a>
        ) : (
          <div style={{ fontSize: 12.5, color: dim, lineHeight: 1.5 }}>
            Connect from <code>http://localhost:{window.location.port}/</code> on the computer running <code>server.py</code> — Strava's OAuth callback only works there.
            Every device on this network shares that connection automatically once it's made.
          </div>
        )}
        {stravaLastFetched && <div style={{ marginTop: 10, fontSize: 11.5, color: dim, fontFamily: mono }}>last synced {new Date(stravaLastFetched).toLocaleString()} · {stravaSyncedCount} day{stravaSyncedCount === 1 ? "" : "s"} covered</div>}
        {stravaError && (
          <div style={{ marginTop: 14, background: "rgba(225,96,77,0.12)", border: `1px solid ${coral}`, borderRadius: 4, padding: "10px 12px", fontSize: 12.5, display: "flex", gap: 8 }}>
            <Icon path={ICONS.warn} size={15} color={coral} />
            <span>{stravaError}</span>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4 }}>intervals.icu connection <span style={{ color: dim, fontWeight: 400 }}>(optional — wellness / TSB only)</span></div>
        <div style={{ fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 }}>
          Used only for CTL/ATL/TSB (recovery buffer below) and as a calorie fallback on days Strava has no
          data. Fetched and cached server-side too, the same way as Strava — add <code>intervals_api_key</code>
          (and optionally <code>intervals_athlete_id</code>, default <code>0</code>) to <code>config.json</code>
          and restart <code>server.py</code>. Get the key from intervals.icu → Settings → Developer Settings.
        </div>
        {!intervalsStatus.checked ? (
          <div style={{ fontSize: 12.5, color: dim }}>Checking connection…</div>
        ) : intervalsStatus.unreachable ? (
          <div style={{ fontSize: 12.5, color: coral }}>Can't reach the local server. Make sure you're running this page via <code>python3 server.py</code>, not a plain file server.</div>
        ) : intervalsStatus.configured ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <Icon path={ICONS.check} size={15} color={mint} />
            <span>Configured — athlete {intervalsStatus.athleteId}</span>
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: dim }}>Not configured — add <code>intervals_api_key</code> to <code>config.json</code> and restart the server to enable this.</div>
        )}
        {lastFetched && <div style={{ marginTop: 10, fontSize: 11.5, color: dim, fontFamily: mono }}>last synced {new Date(lastFetched).toLocaleString()} · {intervalsSyncedCount} day{intervalsSyncedCount === 1 ? "" : "s"} covered</div>}
      </div>

      <div className="card" style={{ padding: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <Field label="Days of history">
            <select className="inp" style={{ width: 120 }} value={rangeDays} onChange={(e) => setRangeDays(parseInt(e.target.value))}>
              <option value={14}>14 days</option>
              <option value={21}>21 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
            </select>
          </Field>
          <button className="btn-primary" style={{ marginTop: 18 }} onClick={onFetch} disabled={fetching}>
            <Icon path={ICONS.refresh} size={13} color={ink} />
            {fetching ? "Fetching…" : "Pull training data"}
          </button>
          {lastFetched && <div style={{ marginTop: 18, fontSize: 11.5, color: dim, fontFamily: mono }}>intervals last synced {new Date(lastFetched).toLocaleString()}</div>}
        </div>
        {fetchError && (
          <div style={{ marginTop: 14, background: "rgba(225,96,77,0.12)", border: `1px solid ${coral}`, borderRadius: 4, padding: "10px 12px", fontSize: 12.5, display: "flex", gap: 8 }}>
            <Icon path={ICONS.warn} size={15} color={coral} />
            <span>{fetchError}</span>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 16, display: "flex", alignItems: "center", gap: 7 }}>
          <Icon path={ICONS.gauge} size={16} color={amber} /> Model tuning
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 20 }}>
          <Field label={`Non-training activity factor — ${profile.neatFactor}×`}>
            <input type="range" min="1.0" max="1.4" step="0.01" value={profile.neatFactor}
              onChange={(e) => setProfile((p) => ({ ...p, neatFactor: e.target.value }))} style={{ width: "100%" }} />
            <div style={{ fontSize: 11, color: dim, marginTop: 4 }}>BMR × this factor covers daily NEAT/light activity, before training is added on top.</div>
          </Field>
          <Field label={`EPOC / recovery sensitivity — ${profile.epocSensitivity}×`}>
            <input type="range" min="0.5" max="1.5" step="0.05" value={profile.epocSensitivity}
              onChange={(e) => setProfile((p) => ({ ...p, epocSensitivity: e.target.value }))} style={{ width: "100%" }} />
            <div style={{ fontSize: 11, color: dim, marginTop: 4 }}>Scales the post-exercise afterburn estimate (5–12% of session kcal by intensity).</div>
          </Field>
          <Field label={`Protein target — ${profile.proteinGPerKg} g/kg/day`}>
            <input type="range" min="0.6" max="2.5" step="0.05" value={profile.proteinGPerKg}
              onChange={(e) => setProfile((p) => ({ ...p, proteinGPerKg: e.target.value }))} style={{ width: "100%" }} />
            <div style={{ fontSize: 11, color: dim, marginTop: 4 }}>Flat daily rate, not tier-scaled like carbs. Default 1.0 g/kg; athlete guidelines typically range 1.2–2.0+ g/kg.</div>
          </Field>
          <Field label={`Pre-load funding — ${Math.round(profile.preloadBorrowRatio * 100)}% borrowed`}>
            <input type="range" min="0" max="1" step="0.05" value={profile.preloadBorrowRatio}
              onChange={(e) => setProfile((p) => ({ ...p, preloadBorrowRatio: e.target.value }))} style={{ width: "100%" }} />
            <div style={{ fontSize: 11, color: dim, marginTop: 4 }}>How pre-loaded carbs get funded: 0% shrinks that day's fat target to make room; 100% raises that day's calorie Target instead, and debits the same amount from the next day's Target to balance it out.</div>
          </Field>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 18, fontSize: 12.5, cursor: "pointer" }}>
          <input type="checkbox" checked={profile.fatigueBuffer} onChange={(e) => setProfile((p) => ({ ...p, fatigueBuffer: e.target.checked }))} />
          Add a +5% BMR recovery buffer on days with a strongly negative training stress balance (TSB &lt; −10)
        </label>
      </div>

      <GoalCard profile={profile} setProfile={setProfile} goalParams={goalParams} trendCorrection={trendCorrection} />

      <div style={{ display: "flex", gap: 8, fontSize: 12, color: dim, alignItems: "flex-start" }}>
        <Icon path={ICONS.info} size={14} color={dim} />
        <div>BMR uses the Mifflin-St Jeor equation. The training and recovery adjustments beyond that are heuristics commonly used in endurance-coaching practice, not a single peer-reviewed formula — tune the sliders above to match how your coach or experience calibrates it.</div>
      </div>
    </div>
  );
}

function GoalCard({ profile, setProfile, goalParams, trendCorrection }) {
  const setGoal = (goal) => setProfile((p) => ({ ...p, goal }));
  const range = profile.goal === "build" ? GOAL_DEFAULTS.build : profile.goal === "lose" ? GOAL_DEFAULTS.lose : null;
  const rateKey = profile.goal === "build" ? "buildRatePct" : "loseRatePct";

  return (
    <div className="card" style={{ padding: 22 }}>
      <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}>
        <Icon path={ICONS.flame} size={16} color={amber} /> Goal
      </div>
      <div style={{ fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.6 }}>
        Shifts your daily Target (shown alongside modeled TDEE on the dashboard) by a steady surplus or
        deficit for 2–3x/week lifting. Defaults: ~0.25%/week gain (a common lean-bulk ceiling for
        experienced lifters) and ~0.5%/week loss (the conservative end of a sustainable-deficit range) —
        both adjustable below.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: profile.goal === "maintain" ? 0 : 18 }}>
        {[["maintain", "Maintain"], ["build", "Build"], ["lose", "Lose"]].map(([id, label]) => (
          <button key={id} onClick={() => setGoal(id)}
            className={id === profile.goal ? "" : "btn-ghost"}
            style={id === profile.goal
              ? { flex: 1, padding: "10px 14px", borderRadius: 4, fontWeight: 700, fontSize: 13, cursor: "pointer", border: "none", background: cyan, color: ink }
              : { flex: 1, padding: "10px 14px" }}>
            {label}
          </button>
        ))}
      </div>

      {range && (
        <Field label={`${profile.goal === "build" ? "Weight gain" : "Weight loss"} rate — ${profile[rateKey]}%/week`}>
          <input type="range" min={range.min} max={range.max} step="0.05" value={profile[rateKey]}
            onChange={(e) => setProfile((p) => ({ ...p, [rateKey]: e.target.value }))} style={{ width: "100%" }} />
          <div style={{ fontSize: 11, color: dim, marginTop: 4 }}>
            Safe range {range.min}–{range.max}%/week. Faster {profile.goal === "build" ? "gains skew toward fat" : "loss risks muscle and performance"}.
          </div>
        </Field>
      )}

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 18, fontSize: 12.5, cursor: "pointer" }}>
        <input type="checkbox" checked={profile.trendCalibration} onChange={(e) => setProfile((p) => ({ ...p, trendCalibration: e.target.checked }))} />
        Auto-calibrate the target from your logged weight trend
      </label>
      <div style={{ fontSize: 11, color: dim, marginTop: 6, marginLeft: 24, lineHeight: 1.5 }}>
        Compares your actual weight trend (needs ~10+ days logged) against the {goalParams.label.toLowerCase()} rate above,
        and nudges the daily target toward what your real data says you need — rather than trusting the formula alone.
      </div>
      {trendCorrection && (
        <div style={{ marginTop: 12, fontFamily: mono, fontSize: 12, color: dim }}>
          {trendCorrection.insufficient
            ? `Gathering data — ${trendCorrection.n} weight entries logged so far, need ~8+ spanning 10+ days.`
            : `Trend: ${trendCorrection.actualWeeklyRateKg >= 0 ? "+" : ""}${fmt(trendCorrection.actualWeeklyRateKg, 2)} kg/wk actual vs ${trendCorrection.targetWeeklyRateKg >= 0 ? "+" : ""}${fmt(trendCorrection.targetWeeklyRateKg, 2)} kg/wk target → correction ${trendCorrection.correctionKcal >= 0 ? "+" : ""}${fmt(trendCorrection.correctionKcal)} kcal/day`}
        </div>
      )}
    </div>
  );
}

function ImportTab({ onFile, csvPreview, colMap, setColMap, onImport, nutrition, onSaveManualDay, onDeleteDay, weightLog, onSaveWeight, onDeleteWeight, googleStatus, googleFetching, googleError, onSyncGoogleSheet, googleLastAutoSync, activitiesNeedingCalories, calorieOverrides, activityLabelsById, onSaveActivityCalories, onDeleteActivityCalories }) {
  const [dragOver, setDragOver] = useState(false);
  const dayCount = Object.keys(nutrition).length;
  const weightCount = Object.keys(weightLog).length;
  return (
    <div style={{ display: "grid", gap: 20 }}>
      <ActivityCalorieCard activitiesNeedingCalories={activitiesNeedingCalories} calorieOverrides={calorieOverrides}
        activityLabelsById={activityLabelsById} onSave={onSaveActivityCalories} onDelete={onDeleteActivityCalories} />
      <ManualEntryCard nutrition={nutrition} onSave={onSaveManualDay} />
      <WeightEntryCard weightLog={weightLog} onSave={onSaveWeight} />

      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}>
          <Icon path={ICONS.upload} size={16} color={cyan} /> MacrosFirst via Google Sheets
        </div>
        <div style={{ fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 }}>
          MacrosFirst's own API is partner-gated, but its Premium Google Sheets Importer already
          writes your daily log to a Sheet you own — this connects to that Sheet directly, through
          <code> server.py</code>, the same pattern as Strava. See <code>config.example.json</code> for setup.
        </div>
        {!googleStatus.checked ? (
          <div style={{ fontSize: 12.5, color: dim }}>Checking connection…</div>
        ) : googleStatus.unreachable ? (
          <div style={{ fontSize: 12.5, color: coral }}>Can't reach the local server. Make sure you're running this page via <code>python3 server.py</code>, not a plain file server.</div>
        ) : googleStatus.configError ? (
          <div style={{ fontSize: 12.5, color: coral }}>Not configured — add <code>google_client_id</code>, <code>google_client_secret</code>, and <code>google_sheet_id</code> to <code>config.json</code> and restart the server.</div>
        ) : googleStatus.connected ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <Icon path={ICONS.check} size={15} color={mint} /><span>Connected</span>
              </div>
              <button className="btn-primary" onClick={onSyncGoogleSheet} disabled={googleFetching}>
                <Icon path={ICONS.refresh} size={13} color={ink} /> {googleFetching ? "Syncing…" : "Sync from Google Sheet"}
              </button>
            </div>
            <div style={{ marginTop: 10, fontSize: 11.5, color: dim, fontFamily: mono }}>
              {googleLastAutoSync
                ? `Last automatic sync: ${new Date(googleLastAutoSync).toLocaleString()}`
                : "No automatic sync yet — runs daily once you've imported at least once (set google_sync_time in config.json, default 04:00)."}
            </div>
          </div>
        ) : ["localhost", "127.0.0.1"].includes(window.location.hostname) ? (
          <a className="btn-primary" href="/google/login" style={{ textDecoration: "none", width: "fit-content", display: "inline-flex" }}>
            <Icon path={ICONS.link} size={13} color={ink} /> Connect Google Sheets
          </a>
        ) : (
          <div style={{ fontSize: 12.5, color: dim, lineHeight: 1.5 }}>
            Connect from <code>http://localhost:{window.location.port}/</code> on the computer running <code>server.py</code> — Google's OAuth callback only works there.
            Every device on this network shares that connection automatically once it's made.
          </div>
        )}
        {googleError && (
          <div style={{ marginTop: 14, background: "rgba(225,96,77,0.12)", border: `1px solid ${coral}`, borderRadius: 4, padding: "10px 12px", fontSize: 12.5, display: "flex", gap: 8 }}>
            <Icon path={ICONS.warn} size={15} color={coral} />
            <span>{googleError}</span>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Or import a CSV manually</div>
        <div style={{ fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 }}>
          MacrosFirst Premium → Download Food Log (Excel), or export any spreadsheet as CSV. Drop the file here and map its columns below.
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}
          style={{
            border: `1.5px dashed ${dragOver ? cyan : line}`, borderRadius: 6, padding: "36px 20px",
            textAlign: "center", background: dragOver ? "rgba(79,209,217,0.05)" : "transparent", transition: "all 0.15s",
          }}
        >
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}><Icon path={ICONS.upload} size={22} color={dim} /></div>
          <div style={{ fontSize: 13, marginBottom: 12 }}>Drop your CSV export here, or</div>
          <label className="btn-ghost" style={{ display: "inline-block" }}>
            Choose file
            <input type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => e.target.files[0] && onFile(e.target.files[0])} />
          </label>
        </div>
      </div>

      {csvPreview && (
        <div className="card" style={{ padding: 22 }}>
          <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Map columns</div>
          <div style={{ fontSize: 12.5, color: dim, marginBottom: 16 }}>{csvPreview.rows.length} rows found. Match the columns to the fields below.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
            {["date", "calories", "protein", "carbs", "fat"].map((k) => (
              <Field key={k} label={k}>
                <select className="inp" value={colMap[k]} onChange={(e) => setColMap((m) => ({ ...m, [k]: e.target.value }))}>
                  <option value="">— none —</option>
                  {csvPreview.fields.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <button className="btn-primary" style={{ marginTop: 18 }} onClick={onImport}>Import {csvPreview.rows.length} rows</button>
        </div>
      )}

      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Stored nutrition log</div>
        <div style={{ fontSize: 12.5, color: dim, marginBottom: dayCount ? 16 : 0 }}>{dayCount} day{dayCount === 1 ? "" : "s"} of intake saved. Click a row to edit it.</div>
        {dayCount > 0 && <NutritionLogTable nutrition={nutrition} onSave={onSaveManualDay} onDelete={onDeleteDay} />}
      </div>

      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Stored weight log</div>
        <div style={{ fontSize: 12.5, color: dim, marginBottom: weightCount ? 16 : 0 }}>{weightCount} day{weightCount === 1 ? "" : "s"} of weight saved. Click a row to edit it.</div>
        {weightCount > 0 && <WeightLogTable weightLog={weightLog} onSave={onSaveWeight} onDelete={onDeleteWeight} />}
      </div>
    </div>
  );
}

function macroCalories(protein, carbs, fat) {
  return protein * 4 + carbs * 4 + fat * 9;
}

// Strava has no `calories` for activity types it can't estimate power/HR
// energy for (e.g. weight training, some walks), and neither does
// intervals.icu when an activity has no power meter data. Rather than
// silently treating that session as a zero-calorie non-event, this panel
// surfaces exactly the activities where both sources came up empty and lets
// the athlete fill in a number by hand — nothing else, so a normal ride with
// real Strava calories never shows up here.
function ActivityCalorieCard({ activitiesNeedingCalories, calorieOverrides, activityLabelsById, onSave, onDelete }) {
  const overrideIds = Object.keys(calorieOverrides);
  return (
    <div className="card" style={{ padding: 22 }}>
      <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}>
        <Icon path={ICONS.flame} size={16} color={cyan} /> Manual calories for unsynced activities
      </div>
      <div style={{ fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 }}>
        Only listed here when neither Strava nor intervals.icu supplied a calorie value for the
        activity (e.g. weight training, or anything logged without a power meter/HR strap). Once
        saved, the value feeds into that day's exercise kcal like any synced figure.
      </div>
      {activitiesNeedingCalories.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: mint }}>
          <Icon path={ICONS.check} size={14} color={mint} /> Every synced activity already has a calorie value.
        </div>
      ) : (
        <table className="data">
          <thead>
            <tr><th>Date</th><th>Activity</th><th>Source</th><th>Duration</th><th>Calories</th><th></th></tr>
          </thead>
          <tbody>
            {activitiesNeedingCalories.map((item) => (
              <ActivityCalorieRow key={item.id} item={item} onSave={onSave} />
            ))}
          </tbody>
        </table>
      )}
      {overrideIds.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 12.5, color: dim, marginBottom: 10 }}>{overrideIds.length} manual override{overrideIds.length === 1 ? "" : "s"} on file:</div>
          <table className="data">
            <thead>
              <tr><th>Date</th><th>Activity</th><th>Calories</th><th></th></tr>
            </thead>
            <tbody>
              {overrideIds.map((id) => {
                const label = activityLabelsById[id];
                return (
                  <tr key={id}>
                    <td>{label?.date || "—"}</td>
                    <td>{label?.name || `Activity ${id}`}</td>
                    <td style={{ color: amber }}>{fmt(calorieOverrides[id])}</td>
                    <td style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                      <button title="Delete" onClick={() => { if (confirm(`Remove the manual calorie value for ${label?.name || id}?`)) onDelete(id); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: dim }}><Icon path={ICONS.trash} size={13} color={coral} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivityCalorieRow({ item, onSave }) {
  const [value, setValue] = useState("");
  const kcal = parseFloat(value);
  const valid = !Number.isNaN(kcal) && kcal > 0;
  return (
    <tr>
      <td>{item.date}</td>
      <td>{item.name}{item.type ? <span style={{ color: dim }}> · {item.type}</span> : null}</td>
      <td style={{ textTransform: "capitalize" }}>{item.source}</td>
      <td>{item.durationMin ? `${fmt(item.durationMin)} min` : "—"}</td>
      <td><input className="inp" style={{ padding: "4px 6px", width: 90, textAlign: "right" }} type="number" min="0" step="1" value={value} placeholder="kcal" onChange={(e) => setValue(e.target.value)} /></td>
      <td style={{ textAlign: "left", whiteSpace: "nowrap" }}>
        <button className="btn-ghost" style={{ padding: "4px 10px" }} disabled={!valid} onClick={() => onSave(item.id, kcal)}>Save</button>
      </td>
    </tr>
  );
}

function ManualEntryCard({ nutrition, onSave }) {
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [saved, setSaved] = useState(false);

  const normalized = normalizeNutritionEntry(nutrition[date]);
  const hasMacrosFirst = !!normalized.macrosfirst;

  // Prefill from whichever entry is currently effective, so editing shows
  // what you'd actually see elsewhere in the app — but Save always writes
  // to the manual slot, never overwrites a MacrosFirst import in place.
  useEffect(() => {
    const existing = normalizeNutritionEntry(nutrition[date]);
    const prefill = existing.macrosfirst || existing.manual;
    setProtein(prefill ? String(prefill.protein ?? "") : "");
    setCarbs(prefill ? String(prefill.carbs ?? "") : "");
    setFat(prefill ? String(prefill.fat ?? "") : "");
    setSaved(false);
    // eslint-disable-next-line
  }, [date]);

  const p = parseFloat(protein) || 0;
  const c = parseFloat(carbs) || 0;
  const f = parseFloat(fat) || 0;
  const calories = macroCalories(p, c, f);
  const hasAny = protein !== "" || carbs !== "" || fat !== "";

  function handleSave() {
    onSave(date, { calories, protein: p, carbs: c, fat: f });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="card" style={{ padding: 22 }}>
      <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}>
        <Icon path={ICONS.plus} size={16} color={cyan} /> Enter a day's macros directly
      </div>
      <div style={{ fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 }}>
        Skip the CSV for a single day — type in totals from MacrosFirst (or anywhere) and calories are
        computed automatically (4 kcal/g protein & carbs, 9 kcal/g fat). Pick a date that's already logged
        to edit it. A MacrosFirst import always takes priority over a manual entry for the same day.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14 }}>
        <Field label="Date">
          <input className="inp" type="date" value={date} max={toISODate(new Date())} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Protein (g)">
          <input className="inp" type="number" min="0" step="1" value={protein} onChange={(e) => setProtein(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Carbs (g)">
          <input className="inp" type="number" min="0" step="1" value={carbs} onChange={(e) => setCarbs(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Fat (g)">
          <input className="inp" type="number" min="0" step="1" value={fat} onChange={(e) => setFat(e.target.value)} placeholder="0" />
        </Field>
      </div>
      {hasMacrosFirst && (
        <div style={{ marginTop: 14, background: "rgba(232,163,61,0.1)", border: `1px solid ${amber}`, borderRadius: 4, padding: "9px 12px", fontSize: 12, color: paper, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <Icon path={ICONS.warn} size={14} color={amber} />
          <span>MacrosFirst data already exists for this day and will be used everywhere in the app instead of what you save here — unless that import is later removed.</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
        <div style={{ fontFamily: mono, fontSize: 13, color: amber }}>≈ {fmt(calories)} kcal</div>
        <button className="btn-primary" onClick={handleSave} disabled={!hasAny}>
          {normalized.manual ? "Update manual entry" : "Save this day"}
        </button>
        {saved && <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: mint }}><Icon path={ICONS.check} size={13} color={mint} /> Saved</div>}
      </div>
    </div>
  );
}

function SourceBadge({ source }) {
  const isMF = source === "macrosfirst";
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
      padding: "2px 6px", borderRadius: 3, marginLeft: 8,
      background: isMF ? "rgba(232,163,61,0.15)" : "rgba(124,139,143,0.15)",
      color: isMF ? amber : dim,
    }}>
      {isMF ? "MacrosFirst" : "Manual"}
    </span>
  );
}

function NutritionLogTable({ nutrition, onSave, onDelete }) {
  const [editingDate, setEditingDate] = useState(null);
  const [draft, setDraft] = useState({ protein: "", carbs: "", fat: "" });
  const dates = Object.keys(nutrition).sort().reverse();

  function startEdit(date) {
    const eff = effectiveNutritionEntry(nutrition[date]);
    setEditingDate(date);
    setDraft({ protein: String(eff?.protein ?? ""), carbs: String(eff?.carbs ?? ""), fat: String(eff?.fat ?? "") });
  }
  function commitEdit(date) {
    const p = parseFloat(draft.protein) || 0;
    const c = parseFloat(draft.carbs) || 0;
    const f = parseFloat(draft.fat) || 0;
    onSave(date, { calories: macroCalories(p, c, f), protein: p, carbs: c, fat: f });
    setEditingDate(null);
  }

  return (
    <table className="data">
      <thead>
        <tr>
          <th>Date</th><th>Protein (g)</th><th>Carbs (g)</th><th>Fat (g)</th><th>Calories</th><th></th>
        </tr>
      </thead>
      <tbody>
        {dates.map((date) => {
          const normalized = normalizeNutritionEntry(nutrition[date]);
          const e = normalized.macrosfirst || normalized.manual;
          const source = normalized.macrosfirst ? "macrosfirst" : "manual";
          const editing = editingDate === date;
          return (
            <tr key={date}>
              <td>{date}<SourceBadge source={source} /></td>
              {editing ? (
                <>
                  <td><input className="inp" style={{ padding: "4px 6px", textAlign: "right" }} type="number" value={draft.protein} onChange={(ev) => setDraft((d) => ({ ...d, protein: ev.target.value }))} /></td>
                  <td><input className="inp" style={{ padding: "4px 6px", textAlign: "right" }} type="number" value={draft.carbs} onChange={(ev) => setDraft((d) => ({ ...d, carbs: ev.target.value }))} /></td>
                  <td><input className="inp" style={{ padding: "4px 6px", textAlign: "right" }} type="number" value={draft.fat} onChange={(ev) => setDraft((d) => ({ ...d, fat: ev.target.value }))} /></td>
                  <td style={{ color: dim }}>≈ {fmt(macroCalories(parseFloat(draft.protein) || 0, parseFloat(draft.carbs) || 0, parseFloat(draft.fat) || 0))}</td>
                  <td style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                    <button className="btn-ghost" style={{ padding: "4px 10px", marginRight: 6 }} onClick={() => commitEdit(date)}
                      title={source === "macrosfirst" ? "Saves as a manual fallback — MacrosFirst data still takes priority for this day" : undefined}>Save</button>
                    <button className="btn-ghost" style={{ padding: "4px 10px" }} onClick={() => setEditingDate(null)}>Cancel</button>
                  </td>
                </>
              ) : (
                <>
                  <td>{fmt(e.protein)}</td>
                  <td>{fmt(e.carbs)}</td>
                  <td>{fmt(e.fat)}</td>
                  <td style={{ color: amber }}>{fmt(e.calories)}</td>
                  <td style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                    <button title="Edit" onClick={() => startEdit(date)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: dim }}><Icon path={ICONS.pencil} size={13} color={dim} /></button>
                    <button title="Delete" onClick={() => { if (confirm(`Delete ${source === "macrosfirst" ? "the MacrosFirst import and any manual entry" : "the manual entry"} for ${date}?`)) onDelete(date); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: dim }}><Icon path={ICONS.trash} size={13} color={coral} /></button>
                  </td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function WeightEntryCard({ weightLog, onSave }) {
  const [date, setDate] = useState(() => toISODate(new Date()));
  const [unit, setUnit] = useState("kg");
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const existingKg = weightLog[date];
    if (existingKg === undefined) {
      setValue("");
    } else {
      setValue(String(unit === "kg" ? existingKg : existingKg / 0.453592));
    }
    setSaved(false);
    // eslint-disable-next-line
  }, [date]);

  // Re-express the displayed number (not the stored value) when the unit toggle changes.
  function switchUnit(next) {
    const v = parseFloat(value);
    if (!Number.isNaN(v)) {
      setValue(next === "kg" ? String(v * 0.453592) : String(v / 0.453592));
    }
    setUnit(next);
  }

  function handleSave() {
    const v = parseFloat(value);
    if (Number.isNaN(v) || v <= 0) return;
    const kg = unit === "kg" ? v : v * 0.453592;
    onSave(date, Math.round(kg * 100) / 100);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="card" style={{ padding: 22 }}>
      <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}>
        <Icon path={ICONS.plus} size={16} color={cyan} /> Log today's weight
      </div>
      <div style={{ fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 }}>
        Feeds directly into BMR and fueling targets for that day — body weight shifts across a training
        block, so this keeps demand and g/kg targets tracking you rather than a fixed Setup value.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 14, alignItems: "end" }}>
        <Field label="Date">
          <input className="inp" type="date" value={date} max={toISODate(new Date())} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={`Weight (${unit})`}>
          <input className="inp" type="number" min="0" step="0.1" value={value} onChange={(e) => setValue(e.target.value)} placeholder={unit === "kg" ? "70.0" : "154.0"} />
        </Field>
        <div style={{ display: "flex", gap: 4, marginBottom: 1 }}>
          <button className="btn-ghost" style={{ padding: "9px 12px", background: unit === "kg" ? panel2 : "transparent", borderColor: unit === "kg" ? cyan : line }} onClick={() => switchUnit("kg")}>kg</button>
          <button className="btn-ghost" style={{ padding: "9px 12px", background: unit === "lb" ? panel2 : "transparent", borderColor: unit === "lb" ? cyan : line }} onClick={() => switchUnit("lb")}>lb</button>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
        <button className="btn-primary" onClick={handleSave} disabled={!value}>
          {weightLog[date] !== undefined ? "Update this day" : "Save this day"}
        </button>
        {saved && <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: mint }}><Icon path={ICONS.check} size={13} color={mint} /> Saved</div>}
      </div>
    </div>
  );
}

function WeightLogTable({ weightLog, onSave, onDelete }) {
  const [editingDate, setEditingDate] = useState(null);
  const [draft, setDraft] = useState("");
  const dates = Object.keys(weightLog).sort().reverse();

  function startEdit(date) {
    setEditingDate(date);
    setDraft(String(weightLog[date]));
  }
  function commitEdit(date) {
    const v = parseFloat(draft);
    if (!Number.isNaN(v) && v > 0) onSave(date, Math.round(v * 100) / 100);
    setEditingDate(null);
  }

  return (
    <table className="data">
      <thead>
        <tr><th>Date</th><th>Weight (kg)</th><th>Weight (lb)</th><th></th></tr>
      </thead>
      <tbody>
        {dates.map((date) => {
          const kg = weightLog[date];
          const editing = editingDate === date;
          return (
            <tr key={date}>
              <td>{date}</td>
              {editing ? (
                <>
                  <td colSpan={2}><input className="inp" style={{ padding: "4px 6px", textAlign: "right" }} type="number" step="0.1" value={draft} onChange={(ev) => setDraft(ev.target.value)} /></td>
                  <td style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                    <button className="btn-ghost" style={{ padding: "4px 10px", marginRight: 6 }} onClick={() => commitEdit(date)}>Save</button>
                    <button className="btn-ghost" style={{ padding: "4px 10px" }} onClick={() => setEditingDate(null)}>Cancel</button>
                  </td>
                </>
              ) : (
                <>
                  <td>{fmt(kg, 1)}</td>
                  <td style={{ color: dim }}>{fmt(kg / 0.453592, 1)}</td>
                  <td style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                    <button title="Edit" onClick={() => startEdit(date)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: dim }}><Icon path={ICONS.pencil} size={13} color={dim} /></button>
                    <button title="Delete" onClick={() => { if (confirm(`Delete weight entry for ${date}?`)) onDelete(date); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: dim }}><Icon path={ICONS.trash} size={13} color={coral} /></button>
                  </td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}


const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ACTIVITY_COLORS = { Run: coral, Ride: cyan, Swim: mint, Row: lavender, Strength: gold, Other: amber };

function emptyScheduleForm() {
  return {
    activityType: "Run",
    zone: 2,
    durationMin: "45",
    daysOfWeek: [],
    startDate: toLocalISODate(new Date()),
    endDate: "",
    ongoing: true,
    notes: "",
  };
}

function ScheduleTab({ schedule, onAdd, onUpdate, onDelete }) {
  const [form, setForm] = useState(emptyScheduleForm());
  const [editingId, setEditingId] = useState(null);

  function toggleDay(n) {
    setForm((f) => ({
      ...f,
      daysOfWeek: f.daysOfWeek.includes(n) ? f.daysOfWeek.filter((d) => d !== n) : [...f.daysOfWeek, n].sort(),
    }));
  }

  function startEdit(s) {
    setEditingId(s.id);
    setForm({
      activityType: s.activityType, zone: s.zone, durationMin: String(s.durationMin),
      daysOfWeek: s.daysOfWeek, startDate: s.startDate, endDate: s.endDate || "",
      ongoing: !s.endDate, notes: s.notes || "",
    });
  }
  function cancelEdit() {
    setEditingId(null);
    setForm(emptyScheduleForm());
  }

  function handleSubmit() {
    if (form.daysOfWeek.length === 0) { alert("Pick at least one day of the week."); return; }
    const entry = {
      activityType: form.activityType,
      zone: form.zone,
      durationMin: parseInt(form.durationMin) || 0,
      daysOfWeek: form.daysOfWeek,
      startDate: form.startDate,
      endDate: form.ongoing ? null : (form.endDate || null),
      notes: form.notes,
    };
    if (editingId) onUpdate(editingId, entry); else onAdd(entry);
    cancelEdit();
  }

  // 3 full weeks starting from the most recent Sunday, so the schedule's actual
  // effect is visible as a calendar before it shows up on the dashboard.
  const calendarStart = daysAgo(new Date().getDay());
  const calendarDays = [];
  for (let i = 0; i < 21; i++) {
    const d = new Date(calendarStart);
    d.setDate(d.getDate() + i);
    const key = toLocalISODate(d);
    calendarDays.push({ key, date: d, sessions: getScheduledSessionsForDate(schedule, key) });
  }
  const todayKey = toLocalISODate(new Date());

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}>
          <Icon path={ICONS.calendar} size={16} color={cyan} /> {editingId ? "Edit scheduled session" : "Add a recurring session"}
        </div>
        <div style={{ fontSize: 12.5, color: dim, marginBottom: 16, lineHeight: 1.5 }}>
          Repeats on the days you pick, within the date range. Projects up to {FORWARD_DAYS} days ahead on the
          dashboard as an estimate — once a real activity syncs in for that day, it takes over automatically.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
          <Field label="Activity type">
            <select className="inp" value={form.activityType} onChange={(e) => setForm((f) => ({ ...f, activityType: e.target.value }))}>
              {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Duration (min)">
            <input className="inp" type="number" min="1" value={form.durationMin} onChange={(e) => setForm((f) => ({ ...f, durationMin: e.target.value }))} />
          </Field>
        </div>

        <Field label="Intensity zone">
          <div style={{ display: "flex", gap: 4 }}>
            {ZONES.map((z) => (
              <button key={z.n} type="button" onClick={() => setForm((f) => ({ ...f, zone: z.n }))}
                title={z.hrPct}
                style={form.zone === z.n
                  ? { flex: 1, padding: "9px 6px", borderRadius: 4, fontWeight: 700, fontSize: 12, cursor: "pointer", border: "none", background: cyan, color: ink }
                  : { flex: 1, padding: "9px 6px", borderRadius: 4, fontWeight: 600, fontSize: 12, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim }}>
                Z{z.n}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: dim, marginTop: 4 }}>{ZONES[form.zone - 1].label} · {ZONES[form.zone - 1].hrPct}</div>
        </Field>

        <div style={{ marginTop: 14 }}>
          <span className="fieldlabel">Days of week</span>
          <div style={{ display: "flex", gap: 4 }}>
            {WEEKDAY_LABELS.map((label, n) => (
              <button key={n} type="button" onClick={() => toggleDay(n)}
                style={form.daysOfWeek.includes(n)
                  ? { flex: 1, padding: "8px 4px", borderRadius: 4, fontWeight: 700, fontSize: 11.5, cursor: "pointer", border: "none", background: amber, color: ink }
                  : { flex: 1, padding: "8px 4px", borderRadius: 4, fontWeight: 600, fontSize: 11.5, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 14, marginTop: 14, alignItems: "end" }}>
          <Field label="Start date">
            <input className="inp" type="date" value={form.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))} />
          </Field>
          <Field label="End date">
            <input className="inp" type="date" value={form.endDate} disabled={form.ongoing}
              onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))} style={{ opacity: form.ongoing ? 0.5 : 1 }} />
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 10, cursor: "pointer", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={form.ongoing} onChange={(e) => setForm((f) => ({ ...f, ongoing: e.target.checked }))} />
            Ongoing
          </label>
        </div>

        <div style={{ marginTop: 14 }}>
          <Field label="Notes (optional)">
            <input className="inp" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g. track intervals" />
          </Field>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button className="btn-primary" onClick={handleSubmit}>{editingId ? "Save changes" : "Add to schedule"}</button>
          {editingId && <button className="btn-ghost" onClick={cancelEdit}>Cancel</button>}
        </div>
      </div>

      {schedule.length > 0 && (
        <div className="card" style={{ padding: 22 }}>
          <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 14 }}>Recurring sessions</div>
          <div style={{ display: "grid", gap: 8 }}>
            {schedule.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: panel2, border: `1px solid ${line}`, borderRadius: 5, fontSize: 12.5 }}>
                <div style={{ flex: 1 }}>
                  <b>{s.activityType}</b> · {ZONES[s.zone - 1].label.split(" · ")[1]} · {s.durationMin}min
                  <div style={{ color: dim, fontSize: 11, marginTop: 2 }}>
                    {s.daysOfWeek.map((n) => WEEKDAY_LABELS[n]).join(", ")} · from {s.startDate}{s.endDate ? ` to ${s.endDate}` : " (ongoing)"}
                    {s.notes ? ` · ${s.notes}` : ""}
                  </div>
                </div>
                <button title="Edit" onClick={() => startEdit(s)} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: dim }}><Icon path={ICONS.pencil} size={13} color={dim} /></button>
                <button title="Delete" onClick={() => { if (confirm("Delete this scheduled session?")) onDelete(s.id); }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, color: dim }}><Icon path={ICONS.trash} size={13} color={coral} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 22 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 15, marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}>
          <Icon path={ICONS.calendar} size={16} color={cyan} /> Upcoming
        </div>
        <div style={{ fontSize: 12.5, color: dim, marginBottom: 14, display: "flex", alignItems: "center", gap: 5 }}>
          Next 3 weeks · <Icon path={ICONS.flame} size={10} color={amber} /> pre-loads the day before
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} style={{ fontSize: 11, color: dim, textAlign: "center", paddingBottom: 2 }}>{label}</div>
          ))}
          {calendarDays.map((day) => {
            const isToday = day.key === todayKey;
            const isFirstOfMonth = day.date.getDate() === 1;
            return (
              <div key={day.key} style={{
                background: panel2,
                border: isToday ? `2px solid ${cyan}` : `1px solid ${line}`,
                borderRadius: 5,
                padding: 6,
                minHeight: 76,
                display: "flex",
                flexDirection: "column",
                gap: 3,
              }}>
                <div style={{ fontSize: 11, color: isToday ? cyan : dim, fontWeight: isToday ? 700 : 600 }}>
                  {isFirstOfMonth ? day.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : day.date.getDate()}
                </div>
                {day.sessions.map((s, i) => (
                  <div key={i} title={`${s.activityType} · ${ZONES[s.zone - 1].label.split(" · ")[1]} · ${s.durationMin}min${s.notes ? ` · ${s.notes}` : ""}`}
                    style={{
                      background: ACTIVITY_COLORS[s.activityType] || dim,
                      color: ink,
                      borderRadius: 3,
                      padding: "2px 5px",
                      fontSize: 10.5,
                      lineHeight: 1.3,
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                    }}>
                    {s.activityType} Z{s.zone} · {s.durationMin}m
                    {isPreloadWorthy(s) && <Icon path={ICONS.flame} size={9} color={ink} />}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}


function DashboardTab({ rows, summary, bmr, fuelingByTier, goalParams, trendCorrection, trendCalibration, proteinGPerKg }) {
  const [visibleMacros, setVisibleMacros] = useState({ carbs: false, protein: false, fat: false });
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
  // Default view is the most recent 7 days — scroll every chart fully right
  // once the data (and therefore each chart's scrollWidth) has settled.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      chartScrollRefs.current.forEach((el) => {
        if (el) el.scrollLeft = el.scrollWidth - el.clientWidth;
      });
    });
    return () => cancelAnimationFrame(id);
  }, [rows.length]);
  if (!bmr) return <EmptyState icon={ICONS.settings} text="Enter your weight, height, age and sex in Setup to calculate a baseline." />;
  if (!rows.length || rows.every((r) => r.activityCount === 0 && r.intake === null)) {
    return <EmptyState icon={ICONS.activity} text="Pull training data from intervals.icu and import a nutrition CSV to see your energy balance." />;
  }
  const hasWeight = rows.some((r) => r.weight !== null);
  const chartWidth = Math.max(rows.length * CHART_DAY_WIDTH, CHART_DAY_WIDTH * 7);
  // 7-day trailing average, since daily body weight swings ~1-2kg from water/glycogen.
  const rowsWithTrend = rows.map((r, i) => {
    const window = rows.slice(Math.max(0, i - 6), i + 1).filter((x) => x.weight !== null);
    const trend = window.length ? window.reduce((s, x) => s + x.weight, 0) / window.length : null;
    return { ...r, weightTrend: trend };
  });
  return (
    <div style={{ display: "grid", gap: 20 }}>
      {(summary.trainingMissingDays > 0 || summary.nutritionMissingDays > 0) && (
        <div style={{ display: "flex", gap: 8, background: "rgba(232,163,61,0.1)", border: `1px solid ${amber}`, borderRadius: 6, padding: "12px 16px", fontSize: 12.5, alignItems: "flex-start" }}>
          <Icon path={ICONS.warn} size={16} color={amber} />
          <div>
            {summary.trainingMissingDays > 0 && <div><b>{summary.trainingMissingDays}</b> day{summary.trainingMissingDays === 1 ? "" : "s"} with no training data synced yet (demand is a floor, not the full picture).</div>}
            {summary.nutritionMissingDays > 0 && <div><b>{summary.nutritionMissingDays}</b> day{summary.nutritionMissingDays === 1 ? "" : "s"} with no nutrition logged.</div>}
          </div>
        </div>
      )}

      {goalParams.sign !== 0 && (
        <div style={{ display: "flex", gap: 8, background: "rgba(79,209,217,0.08)", border: `1px solid ${cyan}`, borderRadius: 6, padding: "12px 16px", fontSize: 12.5, alignItems: "flex-start" }}>
          <Icon path={ICONS.gauge} size={16} color={cyan} />
          <div>
            <b>{goalParams.label}</b> at {goalParams.ratePct}%/week.
            {trendCalibration && trendCorrection && !trendCorrection.insufficient && (
              <> Trend calibration is live: {trendCorrection.correctionKcal >= 0 ? "+" : ""}{fmt(trendCorrection.correctionKcal)} kcal/day applied based on your actual {fmt(trendCorrection.actualWeeklyRateKg, 2)} kg/wk trend.</>
            )}
            {trendCalibration && trendCorrection && trendCorrection.insufficient && (
              <> Log weight for ~10+ days to enable trend-based calibration ({trendCorrection.n} logged so far).</>
            )}
          </div>
        </div>
      )}

      {!summary.noIntake && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          <StatCard label="Avg. daily target" value={`${fmt(summary.avgTarget)} kcal`} color={cyan} />
          <StatCard label="Avg. daily intake" value={`${fmt(summary.avgIntake)} kcal`} color={paper} />
          <StatCard label="Avg. gap" value={`${summary.avgGap >= 0 ? "+" : ""}${fmt(summary.avgGap)} kcal`} color={summary.avgGap < -200 ? coral : summary.avgGap > 200 ? amber : mint} />
          <StatCard label="Off-target days" value={`${summary.deficitDays} / ${summary.trackedDays}`} color={summary.deficitDays > summary.trackedDays / 3 ? coral : dim} />
        </div>
      )}

      <div className="card" style={{ padding: "20px 20px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12, padding: "0 4px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
            <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 14 }}>Target vs. intake</div>
            <button onClick={() => setShowInfoPopout((v) => !v)} title="About these targets"
              style={{ width: 17, height: 17, borderRadius: "50%", border: `1px solid ${dim}`, background: "transparent", color: dim, fontSize: 10.5, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, lineHeight: 1, fontStyle: "italic", fontFamily: "serif" }}>
              i
            </button>
            {showInfoPopout && <FuelingInfoPopout proteinGPerKg={proteinGPerKg} onClose={() => setShowInfoPopout(false)} />}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[["carbs", "Carbs", mint], ["protein", "Protein", lavender], ["fat", "Fat", gold]].map(([key, label, color]) => (
              <button key={key} onClick={() => setVisibleMacros((v) => ({ ...v, [key]: !v[key] }))}
                style={visibleMacros[key]
                  ? { padding: "5px 11px", borderRadius: 20, fontWeight: 700, fontSize: 11.5, cursor: "pointer", border: "none", background: color, color: ink }
                  : { padding: "5px 11px", borderRadius: 20, fontWeight: 600, fontSize: 11.5, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim }}>
                {label}
              </button>
            ))}
            <button onClick={() => setShowFuelingRef((v) => !v)}
              style={showFuelingRef
                ? { padding: "5px 11px", borderRadius: 20, fontWeight: 700, fontSize: 11.5, cursor: "pointer", border: "none", background: amber, color: ink }
                : { padding: "5px 11px", borderRadius: 20, fontWeight: 600, fontSize: 11.5, cursor: "pointer", border: `1px solid ${line}`, background: "transparent", color: dim }}>
              Fueling ref
            </button>
          </div>
        </div>
        <div ref={registerChartScroll} onScroll={syncChartScroll} style={{ overflowX: "auto", overflowY: "hidden", maxWidth: "100%" }}>
          <ComposedChart width={chartWidth} height={280} data={rows} margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
            <CartesianGrid stroke={line} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: dim, fontSize: 11, fontFamily: mono }} axisLine={{ stroke: line }} tickLine={false} />
            <YAxis yAxisId="kcal" tick={{ fill: dim, fontSize: 11, fontFamily: mono }} axisLine={false} tickLine={false} />
            {(visibleMacros.carbs || visibleMacros.protein || visibleMacros.fat) && (
              <YAxis yAxisId="grams" orientation="right" tick={{ fill: dim, fontSize: 11, fontFamily: mono }} axisLine={false} tickLine={false} label={{ value: "grams", angle: 90, position: "insideRight", fill: dim, fontSize: 10 }} />
            )}
            <Tooltip content={<CustomTooltip />} />
            <Bar yAxisId="kcal" dataKey="demand" name="Modeled TDEE (kcal)" fill={panel2} stroke={line} strokeWidth={1} radius={[2, 2, 0, 0]} />
            <Line yAxisId="kcal" type="monotone" dataKey="target" name="Target (kcal)" stroke={cyan} strokeWidth={2} dot={false} strokeDasharray={goalParams.sign !== 0 ? "5 3" : undefined} connectNulls />
            <Line yAxisId="kcal" type="monotone" dataKey="intake" name="Intake (kcal)" stroke={amber} strokeWidth={2.2} dot={{ r: 2.5, fill: amber }} connectNulls />
            {visibleMacros.carbs && <Line yAxisId="grams" type="monotone" dataKey="carbs" name="Carbs actual (g)" stroke={mint} strokeWidth={2} dot={{ r: 2, fill: mint }} connectNulls />}
            {visibleMacros.carbs && <Line yAxisId="grams" type="monotone" dataKey="carbTargetG" name="Carbs target (g)" stroke={mint} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />}
            {visibleMacros.protein && <Line yAxisId="grams" type="monotone" dataKey="protein" name="Protein actual (g)" stroke={lavender} strokeWidth={2} dot={{ r: 2, fill: lavender }} connectNulls />}
            {visibleMacros.protein && <Line yAxisId="grams" type="monotone" dataKey="proteinTargetG" name="Protein target (g)" stroke={lavender} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />}
            {visibleMacros.fat && <Line yAxisId="grams" type="monotone" dataKey="fat" name="Fat actual (g)" stroke={gold} strokeWidth={2} dot={{ r: 2, fill: gold }} connectNulls />}
            {visibleMacros.fat && <Line yAxisId="grams" type="monotone" dataKey="fatTargetG" name="Fat target (g)" stroke={gold} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />}
          </ComposedChart>
        </div>
        {showFuelingRef && <FuelingReferencePanel fuelingByTier={fuelingByTier} />}
      </div>

      <div className="card" style={{ padding: "20px 20px 8px" }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 14, marginBottom: 12, padding: "0 4px" }}>Daily gap (intake − target)</div>
        <div ref={registerChartScroll} onScroll={syncChartScroll} style={{ overflowX: "auto", overflowY: "hidden", maxWidth: "100%" }}>
          <ComposedChart width={chartWidth} height={200} data={rows} margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
            <CartesianGrid stroke={line} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: dim, fontSize: 11, fontFamily: mono }} axisLine={{ stroke: line }} tickLine={false} />
            <YAxis tick={{ fill: dim, fontSize: 11, fontFamily: mono }} axisLine={false} tickLine={false} />
            <ReferenceLine y={0} stroke={dim} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="gap" name="Gap (kcal)" radius={[2, 2, 2, 2]}>
              {rows.map((r, i) => (
                <Cell key={i} fill={r.gap === null ? line : r.gap < -200 ? coral : r.gap > 200 ? amber : mint} />
              ))}
            </Bar>
          </ComposedChart>
        </div>
      </div>

      {hasWeight && (
        <div className="card" style={{ padding: "20px 20px 8px" }}>
          <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 14, marginBottom: 12, padding: "0 4px" }}>Body weight</div>
          <div ref={registerChartScroll} onScroll={syncChartScroll} style={{ overflowX: "auto", overflowY: "hidden", maxWidth: "100%" }}>
            <ComposedChart width={chartWidth} height={200} data={rowsWithTrend} margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
              <CartesianGrid stroke={line} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: dim, fontSize: 11, fontFamily: mono }} axisLine={{ stroke: line }} tickLine={false} />
              <YAxis tick={{ fill: dim, fontSize: 11, fontFamily: mono }} axisLine={false} tickLine={false} domain={["dataMin - 1", "dataMax + 1"]} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="weight" name="Weight (kg)" stroke={dim} strokeWidth={1} dot={{ r: 2.5, fill: dim }} connectNulls={false} />
              <Line type="monotone" dataKey="weightTrend" name="7-day avg (kg)" stroke={cyan} strokeWidth={2.2} dot={false} connectNulls />
            </ComposedChart>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 20, overflowX: "auto" }}>
        <div style={{ fontFamily: grotesk, fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Daily breakdown</div>
        <table className="data">
          <thead>
            <tr>
              <th>Date</th><th>Data</th><th>Weight</th><th>BMR</th><th>Baseline</th><th>Training</th><th>EPOC</th><th>Fatigue+</th>
              <th>Demand</th><th>Target</th><th>Intake</th><th>Gap</th><th>TSB</th><th>Carbs (g)</th><th>Protein (g)</th><th>Fat (g)</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice().reverse().map((r) => (
              <tr key={r.date}>
                <td>{r.label}</td>
                <td style={{ textAlign: "left" }}>
                  <span style={{ display: "inline-flex", gap: 5 }}>
                    <span title={
                        r.trainingMissing ? "No training data synced for this day"
                        : r.source === "strava" ? "Training data from Strava"
                        : r.source === "intervals" ? "Training data from intervals.icu (fallback)"
                        : r.source === "planned" ? "Estimated from your training schedule — replaced automatically once synced"
                        : "No training expected"
                      }
                      style={{ width: 7, height: 7, borderRadius: "50%", background: r.trainingMissing ? coral : r.source === "planned" ? cyan : (r.source ? mint : line), display: "inline-block" }} />
                    <span title={r.nutritionMissing ? "No nutrition logged for this day" : r.nutritionSource === "macrosfirst" ? "Nutrition from MacrosFirst" : "Nutrition entered manually"}
                      style={{ width: 7, height: 7, borderRadius: "50%", background: r.nutritionMissing ? coral : (r.intake !== null ? (r.nutritionSource === "macrosfirst" ? amber : mint) : line), display: "inline-block" }} />
                    <span title={r.weightMissing ? "No weight logged for this day (using Setup default)" : "Weight logged"}
                      style={{ width: 7, height: 7, borderRadius: "50%", background: r.weightMissing ? line : mint, display: "inline-block" }} />
                    {r.preloading && <span title={`Pre-loading carbs for tomorrow's ${r.preloadSession?.activityType || "session"}${r.borrowedKcal > 5 ? ` — borrowing ${fmt(r.borrowedKcal)} kcal from tomorrow's target` : ""}`}><Icon path={ICONS.flame} size={10} color={amber} /></span>}
                    {r.repaidKcal > 5 && <span title={`Repaying ${fmt(r.repaidKcal)} kcal borrowed by yesterday's pre-load`}><Icon path={ICONS.gauge} size={10} color={dim} /></span>}
                  </span>
                </td>
                <td style={{ color: dim }}>{r.weight !== null ? `${fmt(r.weight, 1)}kg` : "—"}</td>
                <td style={{ color: dim }}>{fmt(r.bmr)}</td>
                <td style={{ color: dim }}>{fmt(r.baseline)}</td>
                <td>{r.exerciseKcal ? fmt(r.exerciseKcal) : (r.trainingMissing ? <span style={{ color: coral }}>?</span> : "—")}</td>
                <td style={{ color: dim }}>{r.epocKcal ? fmt(r.epocKcal) : "—"}</td>
                <td style={{ color: dim }}>{r.fatigueBuffer ? fmt(r.fatigueBuffer) : "—"}</td>
                <td style={{ color: dim }}>{fmt(r.demand)}</td>
                <td style={{ color: cyan, fontWeight: 600 }}>{fmt(r.target)}</td>
                <td style={{ color: amber }}>{r.intake !== null ? fmt(r.intake) : (r.nutritionMissing ? <span style={{ color: coral }}>?</span> : "—")}</td>
                <td style={{ color: r.gap === null ? dim : r.gap < -200 ? coral : r.gap > 200 ? amber : mint, fontWeight: 600 }}>
                  {r.gap !== null ? `${r.gap >= 0 ? "+" : ""}${fmt(r.gap)}` : "—"}
                </td>
                <td style={{ color: dim }}>{r.tsb !== null ? fmt(r.tsb, 1) : "—"}</td>
                <td><MacroCell actual={r.carbs} target={r.carbTargetG} /></td>
                <td><MacroCell actual={r.protein} target={r.proteinTargetG} /></td>
                <td><MacroCell actual={r.fat} target={r.fatTargetG} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MacroCell({ actual, target }) {
  if (target === null) return <span style={{ color: dim }}>—</span>;
  const pct = actual !== null ? actual / target : null;
  const color = pct === null ? dim : pct < 0.7 ? coral : pct > 1.3 ? amber : mint;
  return (
    <span style={{ color, fontWeight: 600 }}>
      {actual !== null ? fmt(actual) : "?"}<span style={{ color: dim, fontWeight: 400 }}> / {fmt(target)}</span>
    </span>
  );
}

function FuelingInfoPopout({ proteinGPerKg, onClose }) {
  return (
    <div style={{ position: "absolute", top: 26, left: 0, zIndex: 20, width: 340, maxWidth: "80vw", background: panel2, border: `1px solid ${line}`, borderRadius: 6, padding: 16, boxShadow: "0 10px 28px rgba(0,0,0,0.45)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div style={{ fontFamily: grotesk, fontWeight: 700, fontSize: 12.5 }}>About these targets</div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: dim, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
      </div>
      <div style={{ fontSize: 11.5, color: dim, lineHeight: 1.6 }}>
        Carbs follow the IOC/Burke carbohydrate-periodization framework (3–5 g/kg on light days up to
        8–12 g/kg on 3h+ high-volume days), blending toward the top of the range the harder the day's
        training was — and if tomorrow has a demanding session scheduled (90min+ or Zone 4+), today's
        target pre-loads toward that higher tier too, per GSSI guidance to scale carbs to the demands of
        the <i>upcoming</i> session. Protein is a flat <b style={{ color: paper }}>{proteinGPerKg} g/kg/day</b> (adjustable
        in Setup — Model tuning). Fat fills whatever's left of the day's calorie Target after carbs and
        protein, with a floor of 20% of Target — sports-nutrition consensus treats fat below ~20% of
        total energy as a performance/health risk. These are general guidelines, not individualized advice.
      </div>
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${line}`, fontSize: 11.5, color: dim, lineHeight: 1.6 }}>
        <b style={{ color: paper }}>In-session (≥60 min):</b> 30–60 g carb/hour, up to ~90 g/hour beyond
        ~2.5h using multiple carb sources — practice this in training, don't debut it on race day.<br />
        <b style={{ color: paper }}>Recovery window:</b> if under ~8h until your next session, aim for
        ~1.0–1.2 g/kg carb plus 20–40 g protein within the first couple hours post-workout.
      </div>
    </div>
  );
}

function FuelingReferencePanel({ fuelingByTier }) {
  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${line}` }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: fuelingByTier.length ? 18 : 0 }}>
        {FUEL_TIERS.map((t) => (
          <div key={t.tier} style={{ background: panel2, border: `1px solid ${line}`, borderRadius: 5, padding: "10px 12px" }}>
            <div style={{ fontSize: 11, color: dim, marginBottom: 4 }}>{t.label}</div>
            <div style={{ fontFamily: mono, fontSize: 12.5 }}>{t.carbLo}–{t.carbHi} g/kg carb</div>
          </div>
        ))}
      </div>

      {fuelingByTier.length > 0 && (
        <>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>Your averages by tier, this window</div>
          <div style={{ display: "grid", gap: 8 }}>
            {fuelingByTier.map((g) => (
              <div key={g.tier} style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12.5 }}>
                <div style={{ width: 130, color: dim, flexShrink: 0 }}>{g.label} <span style={{ fontFamily: mono }}>({g.n}d)</span></div>
                <div style={{ flex: 1 }}>
                  Carb: <MacroCell actual={g.avgCarb} target={g.avgCarbTarget} /> g
                </div>
                <div style={{ flex: 1 }}>
                  Protein: <MacroCell actual={g.avgProtein} target={g.avgProteinTarget} /> g
                </div>
                <div style={{ flex: 1 }}>
                  Fat: <MacroCell actual={g.avgFat} target={g.avgFatTarget} /> g
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: panel2, border: `1px solid ${line}`, borderRadius: 4, padding: "10px 12px", fontFamily: mono, fontSize: 12 }}>
      <div style={{ color: dim, marginBottom: 6 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, display: "flex", justifyContent: "space-between", gap: 16 }}>
          <span>{p.name}</span><span>{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="card" style={{ padding: "16px 18px" }}>
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: dim, fontWeight: 600, marginBottom: 8 }}>{label}</div>
      <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

function EmptyState({ icon, text }) {
  return (
    <div style={{ padding: "80px 20px", textAlign: "center", color: dim }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 14, opacity: 0.6 }}><Icon path={icon} size={28} color={dim} /></div>
      <div style={{ fontSize: 14, maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>{text}</div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
