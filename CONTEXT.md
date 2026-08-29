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

| File | What it is |
|---|---|
| `server.py` | Python 3, **stdlib only** (no pip installs). HTTP server, OAuth brokers, API proxies, all data storage. |
| `app-source.jsx` | **The real frontend source** (React/JSX). Edit this, not `app.js`. |
| `app.js` | Compiled output of `app-source.jsx` (esbuild, IIFE, unminified). Never hand-edit — see Build Process. |
| `index.html` | Thin shell: loads React/ReactDOM/Recharts/PapaParse from CDN as globals, then `/app.js`. |
| `config.json` | Secrets and settings. **Not delivered/committed** — copy from `config.example.json`. |
| `config.example.json` | Template with every recognized config field. |
| `repair_store.py` | One-off recovery tool for a corrupted `app_store.json` (see Concurrency below). Keep around. |
| `favicon.ico`, `icon-*.png`, `apple-touch-icon.png`, `logo-header.png`, `manifest.json`, `logo-master.svg` | App icon set + PWA manifest. `logo-master.svg` is the editable source if the mark ever needs to change. |

Data files server.py creates/manages at runtime (same directory, gitignore-worthy, contain
personal data and secrets — never share these):
`app_store.json` (main data store), `tokens.json` (Strava), `google_tokens.json` (Google),
`strava_cache.json`, `intervals_cache.json`, `tailscale.crt` / `tailscale.key`.

## Build process

Frontend source is `app-source.jsx`. After editing it, recompile with:

```
esbuild app-source.jsx --jsx-factory=React.createElement --jsx-fragment=React.Fragment \
  --format=iife --target=es2019 --outfile=app.js
```

No bundler config, no `node_modules` needed for the app itself — React, ReactDOM, Recharts,
and PapaParse are loaded as browser globals from CDN in `index.html`, not bundled in. The
JSX is compiled to plain `React.createElement(...)` calls specifically so the browser never
needs an in-page JSX transformer (an earlier attempt to use `@babel/standalone` in-browser
broke — see conversation history for why — precompiling sidesteps that entirely).

Validate before shipping: a brace-balance check + `tsc --noEmit --jsx react-jsx` (used as a
JSX/syntax linter, not real TypeScript) catches most mistakes before compiling. `node -c
app.js` confirms the compiled output is valid JS.

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

### MacrosFirst (nutrition) via Google Sheets
- MacrosFirst's own API is partner-gated (not available to individuals). Instead: MacrosFirst
  Premium has a "Google Sheets Importer" add-on that writes the food log to a Sheet the user
  owns — we read *that* directly via the standard Google Sheets API.
- OAuth2 to Google (`/google/login`, `/google/callback`), same localhost-only constraint as
  Strava. Config: `google_client_id`, `google_client_secret`, `google_sheet_id`,
  `google_sheet_range` (default `"A1:Z1000"`).
- **Google does not rotate refresh tokens on renewal** (unlike Strava) —
  `ensure_fresh_google_token` reuses the original one; don't "fix" this into expecting a new
  one each refresh.
- Manual flow: Log tab → "Sync from Google Sheet". If the fetched sheet's columns still match
  the mapping saved from a previous import (`google-sheet-colmap`), it imports immediately —
  no re-mapping or a separate "Import Rows" click needed. Only falls back to the manual
  map-columns-then-import step (same UI/logic as a CSV import) when there's no cached mapping
  yet, or the sheet's columns have changed since. Either way, the mapping used gets saved back
  to `google-sheet-colmap`, which is also what seeds the automatic job (below).
- **Automatic daily sync**: `google_auto_sync_loop` (background thread) wakes at
  `google_sync_time` (default `"04:00"`) every day, re-fetches the sheet, and merges rows
  into `nutrition-log`'s `macrosfirst` slot per date. It refuses to run (logs why, doesn't
  crash) until at least one manual sync+import has happened, since that's what seeds the
  column mapping. Last-run timestamp recorded at store key `google-last-auto-sync`.
- Date parsing (`parse_sheet_date` in Python, `parseFlexibleDate` in JS — kept in sync, same
  test cases) handles ISO, US slash (2- or 4-digit year), month-name format, and any of
  those with a trailing time component (Sheets' FORMATTED_VALUE output varies a lot by cell
  format/locale). If an import ever silently returns 0 rows again, the UI now shows the
  actual unparseable raw value instead of failing silently — check that message first.

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
- **Trend calibration** (`profile.trendCalibration`, default on): linear regression over the
  last ~21 days of `weightLog` vs. the goal's target rate; the gap becomes a daily kcal
  correction, clamped to ±400 kcal, applied once ≥8 data points spanning ≥10 days exist.
  `computeTrendCorrection()`.
- **Fueling targets**:
  - Carbs: IOC/Burke tier (rest/moderate/endurance/extreme, by session duration), blended
    within the tier's g/kg range by today's training intensity.
  - Protein: flat, adjustable g/kg/day (`profile.proteinGPerKg`, default 1.0) — **not**
    tier-scaled (this was deliberately simplified from an earlier ISSN-tier-based version).
  - Fat: whatever's left of Target after carb+protein calories, floored at 20% of Target so
    it can't get squeezed toward zero.
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
- **Races + auto-taper**: races are a second `schedule` entry kind (`kind: "race"` — a single
  `raceDate` + `taperDays` instead of a weekly recurrence) rather than a separate store key, so
  taper/carb-load math can look at the same array as recurring sessions. Inside the taper
  window, recurring sessions get duration scaled down to as low as 40% on race-eve while
  intensity is only mildly trimmed (floor 90%) — standard taper guidance (Mujika & Padilla,
  2003) is to shed volume, not intensity. The final `CARB_LOAD_DAYS` (3) before a race
  ≥`CARB_LOAD_MIN_DURATION` (90 min) pin carb targets to the top tier's top end regardless of
  that day's own (tapered) training, and — unlike ordinary pre-loading — that surplus is *not*
  funded by debiting a later day; it's a deliberate short-term glycogen-loading overshoot, not
  a swap. See `getTaperState` / `getCarbLoadState` / `getEffectiveSessionsForDate` in
  `app-source.jsx`.

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
  `access_username`/`access_password` into `config.json` on first run if not already set.
  There's no "off" mode; this was a deliberate choice once the server became LAN-reachable.
- Server binds `0.0.0.0` (LAN/Tailscale-reachable). OAuth callbacks (Strava, Google) are
  hardcoded to `localhost` and can only be completed on the machine running `server.py` — see
  the Strava/Google sections above.
- Optional real HTTPS via Tailscale: `tls_enabled` / `tls_hostname` (auto-detected from
  `tailscale status --json` if blank) / `tls_port` (default `port + 1`). Runs as a **second**
  listener alongside the plain-HTTP one (doesn't replace it — this is what keeps local OAuth
  working). Cert obtained via `tailscale cert` on startup, renewed daily in a background
  thread, reloaded into the running `SSLContext` in place (no restart needed). Requires
  MagicDNS + "Enable HTTPS" turned on once in the Tailscale admin console.

## `config.json` field reference

| Field | Default if omitted | Purpose |
|---|---|---|
| `client_id` / `client_secret` | — (required) | Strava app credentials |
| `port` | 8081 | Main HTTP port |
| `access_username` / `access_password` | auto-generated | Basic Auth login |
| `intervals_api_key` / `intervals_athlete_id` | — / `"0"` | intervals.icu |
| `tls_enabled` / `tls_hostname` / `tls_port` | false / auto-detect / `port+1` | Tailscale HTTPS |
| `google_client_id` / `google_client_secret` / `google_sheet_id` | — | Google OAuth + target sheet |
| `google_sheet_range` | `"A1:Z1000"` | Range to read |
| `google_sync_time` | `"04:00"` | Daily auto-sync time (24h, local time) |

## Known limitations / deliberately not built

- No native mobile app — PWA "Add to Home Screen" is the mobile story, by design (see
  conversation for the cost/benefit reasoning).
- COROS integration: investigated and declined — their API is partner-gated for individuals,
  and "Active Calories" doesn't cleanly separate from workout calories anyway, so it wouldn't
  give a clean NEAT signal even with access. Recommended manual NEAT-factor calibration
  against COROS's own numbers instead (see Setup's Model Tuning slider).
- Terra API (third-party health-data aggregator) investigated for MacrosFirst/COROS access —
  ruled out, business pricing ($399+/mo), not viable for personal use.
- No committed automated test suite. Testing during development was thorough but ad hoc:
  pure-function unit tests, a real concurrency stress test, and Playwright browser tests
  (including one against a dependency-free standalone harness, since this sandbox has no
  outbound network access to load Recharts/React from CDN for a full render test) — all run
  in-conversation, not saved as a runnable suite. Worth setting one up if this keeps growing.

## If you're picking this up cold

1. Read `app-source.jsx` — it's commented at the point of most decisions above.
2. `dailyRows` (search for it) is the single most important function in the app — nearly
   every number on the dashboard traces back to that one `useMemo`.
3. Check `server.py`'s module docstring — it has the full setup walkthrough for Strava,
   intervals.icu, Tailscale HTTPS, and Google Sheets, kept up to date as features were added.
4. Anything touching `app_store.json` server-side: use `update_store`, not
   `load_store`/`save_store` separately.
