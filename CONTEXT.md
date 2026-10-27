# Energy Balance — Project Context

For picking this project back up in a future session (with Claude or otherwise) without
re-deriving everything from scratch. Written August 2026.

## What this is

A local-first web app for endurance athletes: compares modeled training energy demand
against actual nutrition intake, sets goal-adjusted calorie and macro targets, projects a
few days ahead from a training schedule, and pre-loads fueling before hard sessions. Runs
as a small Python server + a React frontend, self-hosted on the athlete's own machine
(desktop, optionally reachable from phone/other devices over LAN or Tailscale).

## Files

The tree is grouped by kind rather than flat:

```
assets/       Icons, logo, PWA manifest image
configs/      config.json, schedule_sources/, Tailscale cert/key
caches/       Strava/intervals.icu response caches
secrets/      app_store.json, tokens.json — gitignored, never committed
src/js/       Frontend source + compiled output
src/python/   Backend
index.html    Served as-is from the project root
```

| File | What it is |
|---|---|
| `src/python/server.py` | Python 3, **stdlib only** (no pip installs). HTTP server, OAuth brokers, API proxies, all data storage. |
| `src/js/app-source.jsx` | **The real frontend source** (React/JSX). Edit this, not `app.js`. |
| `src/js/app.js` | Compiled output of `app-source.jsx` (esbuild, IIFE, unminified). Never hand-edit — see Build Process. |
| `index.html` | Thin shell: loads React/ReactDOM/Recharts/PapaParse from CDN as globals, then `/app.js`. |
| `configs/config.json` | Secrets and settings. **Not delivered/committed** — copy from `configs/config.example.json`. |
| `configs/config.example.json` | Template with every recognized config field. |
| `src/python/ironman_calibrate.py` | IronMan-mode calibration (stdlib only): session-cost fit, energy-balance fit, empirical intake-vs-load relation, whole-plan projection. CLI + imported by `server.py`. |
| `src/python/test_*.py` | Unit tests (synthetic fixtures only): `python3 -m unittest discover -s src/python -p 'test_*.py'`. |
| `src/python/repair_store.py` | One-off recovery tool for a corrupted `secrets/app_store.json` (see Concurrency below). Keep around. |
| `assets/favicon.ico`, `assets/icon-*.png`, `assets/apple-touch-icon.png`, `assets/logo-header.png`, `configs/manifest.json`, `assets/logo-master.svg` | App icon set + PWA manifest. `logo-master.svg` is the editable source if the mark ever needs to change. |

Data files server.py creates/manages at runtime (gitignore-worthy, contain personal data and
secrets — never share these):
`secrets/app_store.json` (main data store), `secrets/tokens.json` (Strava),
`caches/strava_cache.json`, `caches/intervals_cache.json`, `configs/tailscale.crt` / `configs/tailscale.key`.

## Build process

Frontend source is `src/js/app-source.jsx`. After editing it, recompile with (from the project root):

```
esbuild src/js/app-source.jsx --jsx-factory=React.createElement --jsx-fragment=React.Fragment \
  --format=iife --target=es2019 --outfile=src/js/app.js
```

No bundler config, no `node_modules` needed for the app itself — React, ReactDOM, Recharts,
and PapaParse are loaded as browser globals from CDN in `index.html`, not bundled in. The
JSX is compiled to plain `React.createElement(...)` calls specifically so the browser never
needs an in-page JSX transformer (an earlier attempt to use `@babel/standalone` in-browser
broke — see conversation history for why — precompiling sidesteps that entirely).

Validate before shipping: a brace-balance check + `tsc --noEmit --jsx react-jsx` (used as a
JSX/syntax linter, not real TypeScript) catches most mistakes before compiling. `node -c
src/js/app.js` confirms the compiled output is valid JS.

## Integrations

### Strava
- OAuth2, server-brokered (`/login`, `/callback` in `server.py`). Config: `client_id`,
  `client_secret`. Tokens in `tokens.json`.
- **The OAuth callback only works from `http://localhost:<port>/callback`** — tied to
  Strava's registered "Authorization Callback Domain". The one-time connect step must
  happen on the machine running `server.py`, not from a phone over LAN/Tailscale. Guarded
  both server-side (`WRONG_HOST_LOGIN_HTML`) and client-side (checks
  `window.location.hostname`).
- Activities cached per-date in `strava_cache.json`; only "today" is ever re-fetched live —
  a historical date is fetched from Strava at most once, ever. `/api/strava/activities`
  accepts either `?days=N` (full window, used for the initial bootstrap) or `?dates=csv`
  (surgical, used for incremental syncs triggered by new nutrition/training data).
- Per-activity `calories` only exists on the *detail* endpoint, not the summary list — the
  server makes one extra call per activity, but only for dates not already cached.
- Outbound requests send a real browser User-Agent (`OUTBOUND_HEADERS`) — Strava/Cloudflare
  fronting can otherwise 403 on Python's default `Python-urllib/3.x` UA (this bit
  intervals.icu in practice; applied everywhere defensively).

### intervals.icu
- Server-side proxy mirroring Strava's exact caching pattern, in `intervals_cache.json`.
- Config: `intervals_api_key`, `intervals_athlete_id` (default `"0"` — intervals.icu
  resolves that to whichever athlete the key belongs to).
- Basic auth to intervals.icu itself: username is the literal string `"API_KEY"`, password
  is the actual key.
- Used for CTL/ATL/TSB (recovery/fatigue buffer) and as an activity-data fallback on dates
  Strava has nothing for.

### MacrosFirst (nutrition) via its personal API
- MacrosFirst now has its own personal API (`https://my.macrosfirst.com`, OpenAPI spec at
  `/openapi.json`) — no more Google Sheets Importer add-on or column-mapping step. Auth is a
  static bearer token (a "personal access token", created at
  `https://app.macrosfirst.com/personal-access-tokens`, looks like `mf_live_...`) — not OAuth,
  so there's no refresh flow, no `/callback`, no localhost-only constraint.
- Config: `macrosfirst_api_token`, `macrosfirst_sync_time` (default `"04:00"`).
- `GET /v1/days?from_date=&to_date=` returns full day detail (max 62 days/request) including a
  `nutrients` map keyed by USDA nutrient code — `macrosfirst_day_macros()` reads calories/
  protein/carbs/fat from there (keys `208`/`203`/`205`/`204`), falling back to the same-named
  top-level fields only if a nutrient key is missing (those top-level fields are marked
  deprecated in the API's own schema).
- Manual flow: Log tab → "Sync now" (`/api/macrosfirst/sync`, POST) — fetches the last
  `MACROSFIRST_SYNC_LOOKBACK_DAYS` (35) days and merges directly into `nutrition-log`'s
  `macrosfirst` slot per date. No column mapping, no preview step — the API already returns
  structured macros.
- **Automatic daily sync**: `macrosfirst_auto_sync_loop` (background thread) wakes at
  `macrosfirst_sync_time` every day and calls the same `sync_macrosfirst()` the manual endpoint
  uses. Re-fetching already-synced dates is intentional (cheap, and picks up corrections made
  in MacrosFirst after the fact) rather than something to "optimize" into an incremental sync.
  Last-run timestamp recorded at store key `macrosfirst-last-auto-sync`.

## Data model — things that aren't obvious from a schema alone

### Nutrition is dual-source, not a flat value
Each date in the `nutrition-log` store key is `{ manual: {...} | null, macrosfirst: {...} | null }`.
**`macrosfirst` always wins** when both exist for the same date — manual entries are a
fallback that's preserved, never silently overwritten. Legacy flat-shaped entries (from
before this existed) are treated as `manual` on read. Helpers: `effectiveNutritionEntry()` /
`normalizeNutritionEntry()` in JS, `normalize_nutrition_entry()` mirrored in Python for the
auto-sync job. If you touch nutrition data anywhere, go through these — don't read/write the
date's value directly as if it were flat.

### Training-data source priority, per day
Strava (actual) → intervals.icu (actual, fallback) → scheduled/planned session (estimate,
only if neither actual source has anything) → confirmed rest day (a real zero, not a gap).
A day is only flagged "missing" if genuinely none of these apply.

### Weight auto-populates from history
`weightLog` is keyed by date. On every app load, `profile.weightKg` is overwritten with the
*most recent* `weightLog` entry if one exists (this is intentional — Setup's weight field is
meant to always reflect "current," not a stale one-time value). Height and age have no such
history and just persist as entered.

## Core model (all computed in the `dailyRows` `useMemo` — the heart of the app)

- **BMR**: Mifflin-St Jeor, using *that day's* weight (from `weightLog`, falling back to
  `profile.weightKg`).
- **Demand** = BMR × NEAT factor (`profile.neatFactor`, default 1.15) + exercise kcal + EPOC
  (afterburn, 5–12% of session kcal scaled by intensity) + fatigue buffer (+5% BMR if
  TSB < −10 and `profile.fatigueBuffer` enabled).
- **Target** = Demand + goal adjustment + trend-calibration correction + pre-load
  borrow/repay (all below).
- **Goal**: maintain / build / lose (`profile.goal`), adjustable rate
  (`profile.buildRatePct` default 0.25%/wk, `profile.loseRatePct` default 0.5%/wk), converted
  to kcal via the ~7700 kcal/kg tissue approximation.
- **Trend calibration** (`profile.trendCalibration`, default on): linear regression over
  `weightLog` vs. the goal's target rate; the gap becomes a daily kcal correction, clamped to
  ±400 kcal, applied once ≥8 data points spanning ≥10 days exist. `computeTrendCorrection()`.
- **Fixed per-day target window** (`profile.targetWindowDays`, default 21, 14–60, tunable in
  the Goal card): each day's target only looks at the weigh-ins in the N days *before* that
  day (`targetAnchorKey()` — future days anchor at tomorrow, i.e. everything logged through
  today), never "the last N days from now". That window drives the day's trend correction
  (using that day's own goal) and, for maintain, the BMR weight (window average). Days with
  no weigh-in use the last weigh-in on or before them, not `profile.weightKg`. The pre-load
  carry-forward loop starts N days before the first visible row (warm-up rows are dropped),
  so the oldest visible day still gets its repayment. Net effect: a past day's target never
  moves as new data arrives or as the visible range (`rangeDays`) scrolls forward.
- **Fueling targets**:
  - Carbs: IOC/Burke tier (rest/moderate/endurance/extreme, by session duration), blended
    within the tier's g/kg range by today's training intensity.
  - Protein: flat, adjustable g/kg/day (`profile.proteinGPerKg`, default 1.0) — **not**
    tier-scaled (this was deliberately simplified from an earlier ISSN-tier-based version).
  - Fat: whatever's left of Target after carb+protein calories, floored at 20% of Target so
    it can't get squeezed toward zero. On race carb-loading days that floor drops to
    `profile.carbLoadFatFloorPct` (default 10%) and the flat `minFatG` doesn't apply — carbs
    are meant to displace fat there, not stack on top of it.
- **Pre-loading**: if *tomorrow* has a scheduled session ≥90 min or Zone 4+, today's carb
  target escalates to tomorrow's (higher) tier. The resulting extra carb calories get funded
  per `profile.preloadBorrowRatio` (default 1.0 = fully borrowed): 0% shrinks today's fat to
  make room (Target unchanged); 100% actually raises today's Target and debits the identical
  amount from tomorrow's Target (net zero across the two days — verified by test, not just
  reasoned about). Implemented as a single chronological pass through the day list with a
  carry-forward "amount owed to the next day" variable — don't refactor this into computing
  days independently/out of order, the carry-forward is load-bearing.
- **Training schedule**: recurring entries (`activityType`, 1–5 intensity zone → MET lookup
  table, `durationMin`, `daysOfWeek`, date range). Used to (a) estimate kcal for
  future/unsynced days (MET × weight × hours) and (b) drive pre-loading. Dashboard projects
  `FORWARD_DAYS` (4) days beyond today.
- **Single (non-recurring) sessions**: a third `schedule` entry kind (`kind: "single"` — one
  `date` instead of `daysOfWeek`/`startDate`/`endDate`), for a one-off session that doesn't
  repeat. Feeds the same `getScheduledSessionsForDate` lookup as recurring entries (matches on
  exact date instead of weekday), but is kept in its own "Single sessions" list in
  `ScheduleTab` — it deliberately never appears under "Recurring sessions", which used to be
  faked by giving a recurring entry `startDate === endDate` (the `road_to_placid` sync script
  did exactly that before it was switched to emit real `kind: "single"` entries).
- **Races + auto-taper**: races are a third `schedule` entry kind (`kind: "race"` — a single
  `raceDate` + `taperDays` instead of a weekly recurrence) rather than a separate store key, so
  taper/carb-load math can look at the same array as recurring sessions. Inside the taper
  window, recurring sessions get duration scaled down to as low as 40% on race-eve while
  intensity is only mildly trimmed (floor 90%) — standard taper guidance (Mujika & Padilla,
  2003) is to shed volume, not intensity. The final `carbLoadDays` (per race, 0 = off; `CARB_LOAD_DAYS` = 3 if unset) before a race
  ≥`CARB_LOAD_MIN_DURATION` (90 min) pin carb targets to the top tier's top end regardless of
  that day's own (tapered) training, and — unlike ordinary pre-loading — that surplus is *not*
  funded by debiting a later day; it's a deliberate short-term glycogen-loading overshoot, not
  a swap. See `getTaperState` / `getCarbLoadState` / `getEffectiveSessionsForDate` in
  `app-source.jsx`.

## IronMan mode (`profile.ironmanMode`, Setup → Goal)

A layer on top of the core model, for an athlete whose real failure mode is under-fueling a
long-course build. **Off = byte-for-byte the old behavior.** Verified by rendering every tab
against `main`'s compiled app.js with the same store: identical DOM apart from the toggle
itself, and identical requests. Every IronMan branch in `dailyRows` is gated on
`imCalibrationReady(profile, imCal)`, and the calibration/overrides are only fetched while the mode is on.

**Calibration** (`ironman_calibrate.py` → store key `ironman-calibration`, written via
`update_store` by `POST /api/ironman/calibrate`. The fit itself runs on a snapshot *outside*
the lock, and only the single-key write is locked):
- *Session cost*: kcal per moving hour by discipline (Swim, Run, Ride + VirtualRide, Strength) and
  zone, from Strava `calories` (`activity-kcal-overrides` win; ride calories that disagree with
  `kilojoules` × the athlete's own median ratio by >20–25% are re-derived from kJ). Intensity
  proxy: avg power ÷ FTP for rides (FTP = intervals.icu eFTP → plan `meta.athlete.estFTP` → 285), suffer
  score per hour for runs/swims (no distance in the cache, so no pace). Weighted linear fit, evaluated at the
  average intensity of a session *labelled* with that zone (`ZONE_REF` — a "Z4" session's average
  includes warm-up, so it is far below threshold). The result is compared against the `ZONES` MET table.
- *Energy balance*: 1-D Kalman filter on tissue weight, `w += (intake − E)/7700`,
  `E = neat·BMR(w) + k·sessionKcal`, weigh-ins as measurements (variance inflated the morning after
  a >2,000 kcal day or a big carb swing, to absorb glycogen/water). `neat`, `k` come from a grid posterior
  (innovation likelihood + Gaussian prior centred on the current profile: neatFactor
  (+0.05 if the fatigue buffer is on), 1 + 0.08·epocSensitivity). `neat` is therefore an
  *effective* NEAT that absorbs the fatigue buffer, and `k` absorbs EPOC. The total expenditure is
  well identified; the split between them leans on the prior (reported as `shrinkage` / `corrNeatScale`).
- *Empirical*: weekly intake, corrected by the smoothed weight slope, vs hours / device kcal / CTL (OLS).
  CTL for the first 42 days of intervals history is skipped (it's seeded at 0).

**In `dailyRows`** (mode on + calibration present):
- Strava kcal respects `activity-kcal-overrides`. Planned sessions use the calibrated zone rate
  (a `sourceActivity` still wins). Demand = `neat·BMR + k·sessionKcal`: the EPOC column shows
  `(k−1)·sessionKcal`, and the fatigue buffer is 0 because both are inside the fitted parameters.
- **Training-day floor**: on any day with session kcal, `carbDrivenTarget = max(…, demand)`. The goal
  deficit, trend correction or a pre-load repayment can't take Target below calibrated maintenance + session.
  The rolloverCapped bookkeeping sees the same floor, so an unrealized repayment still rolls forward.
- **Carbs** = max(IOC/Burke tier value, day-load periodization on session kcal:
  `IM_CARB_LOAD_ANCHORS`, ~5–7 g/kg easy → 8–10 moderate-long → 10–12 big). On pre-load/race-load
  days that becomes the floor under the bump, so borrow/repay and carb-load still only fund the
  bump *above* the day's own carbs. Protein is unchanged (`proteinGPerKg`).
- Rows gain `imCarbGPerKg`, `imFloorKcal`, `imFloorApplied`, `imSessionFuel` (planned Ride/Run
  ≥75 min: the session's `fuel` wins field by field, otherwise defaults by duration/zone capped by
  `profile.imGutCarbGPerH`, default 90 g/h), and `imKeySessions` (`key`, Z4+, or ≥120 min → recovery prompt
  of 1.0–1.2 g/kg carb + 0.3 g/kg protein).
- `ironmanStatus` memo: 7-day intake vs calibrated demand (warn below −300 kcal/d), forward
  Kalman weight trend (`imWeightTrend`, warn when falling faster than 0.3%/wk), and today's remaining
  kcal/carbs/protein. Shown in `IronmanPanel` on the Dashboard.

**Whole-plan projection**: `GET /api/ironman/projection` reads every plan-shaped
`configs/schedule_sources/*.json` directly. The newest file (by mtime) wins for any week two files
both cover. It is needed because `training-schedule` only ever holds ~8 weeks. The endpoint returns per-week mean
demand/target/carbs/fat and the peak day, uses each session's `zone` when present (else
`classify_zone`), and excludes race-titled sessions from the averages. It is read-only and fits on the
fly if no calibration is saved yet. Rendered by `IronmanProjection`.

**Plan import additions** (`schedule_sync.py`): a session's own `zone` (int 1–5) wins over
`classify_zone`. An optional `fuel` ({carbGPerH, fluidMlPerH, sodiumMgPerH}) and `key: true` are carried
onto the single-session entry. Plan races are reconciled with existing race entries: a race whose name
matches an existing entry's `notes` (case-insensitive) on a different date *moves* that entry (id,
taperDays, carbLoadDays kept) instead of adding a duplicate. An entry already sitting on another of
the plan's race dates is never moved.

## Server concurrency (fixed after a real corruption incident — don't regress this)

`app_store.json` writes MUST go through `update_store(mutate_fn)`, which holds a single lock
(`_json_lock`) for the entire read-modify-write, and `save_json` writes to a temp file then
atomically `os.replace`s it into place. The bug this fixes: two nearly-simultaneous requests
(e.g. saving a column mapping right after saving imported nutrition data) each doing a bare
`store = load_store(); store[k] = v; save_store(store)` will race and corrupt the file —
reproduced and confirmed fixed with a concurrent-write stress test during development. If
you add a new code path that reads-modifies-writes the store, use `update_store`, not
`load_store()`/`save_store()` called separately.

`load_json` also now catches `JSONDecodeError`, backs up the bad file
(`<name>.corrupt-<timestamp>`), and returns the default instead of crashing every subsequent
request. `repair_store.py` does best-effort recovery of a corrupted file (walks backward
looking for the longest valid-JSON prefix) — keep it around.

## Auth / multi-device / networking

- HTTP Basic Auth is **always** required — `ensure_auth_config()` auto-generates
  `access_username`/`access_password` into `configs/config.json` on first run if not already set.
  There's no "off" mode; this was a deliberate choice once the server became LAN-reachable.
- Server binds `0.0.0.0` (LAN/Tailscale-reachable). Strava's OAuth callback is hardcoded to
  `localhost` and can only be completed on the machine running `server.py` — see the Strava
  section above. MacrosFirst uses a static bearer token instead of OAuth, so it has no such
  constraint.
- Optional real HTTPS via Tailscale: `tls_enabled` / `tls_hostname` (auto-detected from
  `tailscale status --json` if blank) / `tls_port` (default `port + 1`). Runs as a **second**
  listener alongside the plain-HTTP one (doesn't replace it — this is what keeps local OAuth
  working). Cert obtained via `tailscale cert` on startup, renewed daily in a background
  thread, reloaded into the running `SSLContext` in place (no restart needed). Requires
  MagicDNS + "Enable HTTPS" turned on once in the Tailscale admin console.

## `configs/config.json` field reference

| Field | Default if omitted | Purpose |
|---|---|---|
| `client_id` / `client_secret` | — (required) | Strava app credentials |
| `port` | 8081 | Main HTTP port |
| `access_username` / `access_password` | auto-generated | Basic Auth login |
| `intervals_api_key` / `intervals_athlete_id` | — / `"0"` | intervals.icu |
| `tls_enabled` / `tls_hostname` / `tls_port` | false / auto-detect / `port+1` | Tailscale HTTPS |
| `macrosfirst_api_token` | — | MacrosFirst personal access token |
| `macrosfirst_sync_time` | `"04:00"` | Daily auto-sync time (24h, local time) |

## Known limitations / deliberately not built

- No native mobile app — PWA "Add to Home Screen" is the mobile story, by design (see
  conversation for the cost/benefit reasoning).
- COROS integration: investigated and declined — their API is partner-gated for individuals,
  and "Active Calories" doesn't cleanly separate from workout calories anyway, so it wouldn't
  give a clean NEAT signal even with access. Recommended manual NEAT-factor calibration
  against COROS's own numbers instead (see Setup's Model Tuning slider).
- Terra API (third-party health-data aggregator) investigated for MacrosFirst/COROS access —
  ruled out, business pricing ($399+/mo), not viable for personal use.
- Only a small committed test suite (`src/python/test_*.py`: calibration math on synthetic
  fixtures, schedule_sync zone/fuel/race reconciliation). The frontend has none.
- Previously: no committed automated test suite. Testing during development was thorough but ad hoc:
  pure-function unit tests, a real concurrency stress test, and Playwright browser tests
  (including one against a dependency-free standalone harness, since this sandbox has no
  outbound network access to load Recharts/React from CDN for a full render test) — all run
  in-conversation, not saved as a runnable suite. Worth setting one up if this keeps growing.

## Training-plan import (schedule_sources/)

Any periodized training plan export — e.g. `schedule_sources/road_to_placid.json`, a static
export of the plan built in the "Road to Placid" artifact (Sept 2026 → IRONMAN Lake Placid,
July 2027 — see the published Claude artifact for the human-facing checklist/notes version) —
can be dropped as a `*.json` file into `schedule_sources/`. **The running server watches that
directory and imports automatically**: `schedule_sources_sync_loop()` in `server.py` polls
every ~30s, hashes (sha256, not mtime — a touch with no content change must not trigger a
re-import) each file, and re-imports any file whose hash has changed since last time. Hashes
are kept in the store itself (`schedule-source-hashes`), so nothing gets re-imported from
scratch on a server restart, and editing a plan file (e.g. regenerating it after a re-published
version of the source artifact) takes effect on its own within about 30 seconds — no restart,
no manual step. Each file's source tag is its filename minus `.json`, so several plans can be
dropped in side by side (a base plan plus a separate race-specific block, say) without their
entries colliding.

The actual plan → schedule-entry conversion (shared by the background importer and the manual
CLI below) lives in `schedule_sync.py`, `sync_plan_into_store()`. For each file it writes into
`training-schedule`:

- **Race entries** (`kind: "race"`) for every race in the plan — added once, covering the
  whole calendar (e.g. out to Lake Placid and the Long Island 70.3), since taper/carb-load math
  looks at the nearest upcoming race regardless of distance. Skipped if a race entry with the
  same `raceDate` already exists (so it never clobbers a race added by hand — e.g. the Olympic
  tri entry was hand-entered before this ever existed and is left alone). Once added, a source's
  own race entries are never removed or rebuilt on a later sync — only regenerated if genuinely
  missing — since races are meant to persist even as the file's near-term sessions keep churning.
- **Single-session entries** (`kind: "single"`), one per planned session, but only for the next
  `--weeks-ahead` weeks (default 8) — the app only ever consults the schedule for
  `FORWARD_DAYS` (4) days of lookahead plus taper-window scaling, so encoding a full year of
  sessions up front would be pure clutter. These are genuinely non-recurring (a `date`, not a
  weekly pattern), so they show up under "Single sessions" in the app, not "Recurring sessions".
  Every sync fully regenerates a source's own single-session entries against the current window
  (that's the piece that has to re-run as the plan progresses/today's date moves forward).

Every entry a source creates is tagged `"source": "<filename-without-.json>"`, so re-syncing one
file only replaces that file's own previously-synced single-session entries — anything added by
hand in the app's UI, or by another source file, is left untouched, with one exception: your own
open-ended (`endDate: null`) recurring entries that overlap the sync window get their `endDate`
capped to the day before the window starts (printed every time it happens), since otherwise
they'd keep firing forever and double-count against what the sync adds. It also skips generating
a session for any date already covered by an entry from outside that source, so a hand-entered
override (or another plan file's entry) is never double-booked.

**Manual/offline use** (previewing a change before saving it, or forcing an immediate re-import
without waiting ~30s for the background poll): `python3 src/python/sync_schedule_from_plan.py
[--weeks-ahead 8] [--dry-run] [--file some_plan.json]`. With no `--file`, it syncs every
`configs/schedule_sources/*.json` file in one pass. This script is *not* required for the
automatic import to work — it's a convenience for testing/forcing, not the primary mechanism
anymore.

## If you're picking this up cold

1. Read `src/js/app-source.jsx` — it's commented at the point of most decisions above.
2. `dailyRows` (search for it) is the single most important function in the app — nearly
   every number on the dashboard traces back to that one `useMemo`.
3. Check `src/python/server.py`'s module docstring — it has the full setup walkthrough for
   Strava, intervals.icu, Tailscale HTTPS, and MacrosFirst, kept up to date as features were added.
4. Anything touching `secrets/app_store.json` server-side: use `update_store`, not
   `load_store`/`save_store` separately.
