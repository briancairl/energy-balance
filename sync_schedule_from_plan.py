#!/usr/bin/env python3
"""
sync_schedule_from_plan.py — feed the "Road to Placid" IRONMAN training plan
into energy-balance's `training-schedule` store key.

WHAT THIS DOES
---------------
energy-balance only ever consults `training-schedule` for two things:
  1. Estimating kcal demand for TODAY through FORWARD_DAYS (4) days ahead,
     whenever Strava/intervals.icu hasn't synced real activity data yet for
     that date (see getScheduledSessionsForDate / dailyRows in app-source.jsx).
  2. Auto-taper and carb-loading, which look at the *nearest upcoming race*
     regardless of how far out it is (getUpcomingRace).
So this script does two different things on two different time horizons:
  - RACES: every race in the plan gets a `kind: "race"` entry, added once,
    since taper/carb-load math needs the full race calendar no matter how
    far away the race is. Skipped if a race entry with the same date already
    exists (so it never clobbers a race you entered by hand).
  - SESSIONS: only the next `--weeks-ahead` weeks (default 8) of the plan get
    turned into schedule entries, one per session, as `kind: "single"`
    entries (a `date`, not a weekly recurrence) — these don't repeat and
    don't show up in the app's "Recurring sessions" list, since each one
    really is a one-off day out of the plan, not an actual weekly pattern.
    That's plenty for the 4-day lookahead + preload logic, and re-running
    this script periodically (weekly is plenty) keeps the window fresh as
    the plan progresses — there's no point encoding a year of sessions up
    front when the app never looks more than a few days into the future for
    them.

Every entry this script creates is tagged `"source": "road_to_placid"` so a
re-run can cleanly replace its own old entries without touching anything you
added by hand in the app's UI. Entries without that tag are never touched or
removed — except: any of YOUR OWN open-ended recurring entries (endDate is
null) that overlap the sync window get their endDate capped to the day
before the window starts, since otherwise they'd keep firing forever and
double-count against what this script adds. This is printed every time it
happens — nothing is silently changed.

USAGE
-----
    python3 sync_schedule_from_plan.py [--weeks-ahead 8] [--dry-run]

Run it from inside the energy-balance project directory (it looks for
app_store.json and road_to_placid_plan.json next to itself). The server
(server.py) reads app_store.json fresh on every request — no restart needed
after this runs.

Re-generate road_to_placid_plan.json whenever the underlying plan changes
(e.g. a re-published version of the "Road to Placid" artifact) — this
script only reads it, it doesn't fetch anything live.
"""
import json, os, sys, argparse, random, string, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
STORE_PATH = os.path.join(HERE, "app_store.json")
PLAN_PATH = os.path.join(HERE, "road_to_placid_plan.json")
SOURCE_TAG = "road_to_placid"

DISC_TO_ACTIVITY = {"swim": "Swim", "bike": "Ride", "run": "Run", "strength": "Strength"}
SKIP_DISC = {"rest", "walk"}

RACE_TUNING = {
    # plan race id -> (taperDays, zone)
    "oly2026": (7, 2),        # already hand-entered by the athlete; left alone if present
    "half2026": (4, 3),
    "marathon2026": (10, 3),
    "lp2027": (14, 3),
    "li703_2027": (7, 3),
}


def gen_id(offset=0):
    ms = int(dt.datetime.now().timestamp() * 1000) + offset
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"{ms}-{suffix}"


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def save_json_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def classify_zone(disc, title, detail):
    if disc == "strength":
        return 1
    text = f"{title} {detail}".lower()
    if "recovery" in text and "spin" in text:
        return 1
    if any(k in text for k in ["dress rehearsal", "marathon pace", "tempo", "race power",
                                "race-pace", "race pace", "hills", "surges", "70.3 pace"]):
        return 3
    return 2


def short_note(title):
    # "Swim — Technique" -> "Technique", "Bike — Long w/ Climbing" -> "Long w/ Climbing"
    if "—" in title:
        return title.split("—", 1)[1].strip()
    return title


def covered_by_existing(session_date, kept_entries):
    """True if a KEPT (hand-entered, non-road_to_placid) recurring or single
    entry already applies to this date — regardless of activity type.
    Prevents double-counting a day the athlete already has their own entry
    for, which matters on the very first sync (today can fall inside a
    hand-managed near-term window, e.g. a taper the athlete already set up
    before this script ever ran)."""
    js_weekday = (session_date.weekday() + 1) % 7
    iso = session_date.isoformat()
    for e in kept_entries:
        if e.get("kind") == "race":
            continue
        if e.get("kind") == "single":
            if e.get("date") == iso:
                return True
            continue
        days = e.get("daysOfWeek") or []
        if js_weekday not in days:
            continue
        if iso < e.get("startDate", "0000-00-00"):
            continue
        end = e.get("endDate")
        if end and iso > end:
            continue
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weeks-ahead", type=int, default=8,
                     help="How many weeks of recurring sessions to sync from today (default 8).")
    ap.add_argument("--dry-run", action="store_true", help="Print what would change, write nothing.")
    args = ap.parse_args()

    if not os.path.exists(PLAN_PATH):
        sys.exit(f"Missing {PLAN_PATH} — copy the Road to Placid plan export here first.")
    plan = load_json(PLAN_PATH, None)
    store = load_json(STORE_PATH, {})
    schedule = store.get("training-schedule", [])

    today = dt.date.today()
    window_start = today
    window_end = today + dt.timedelta(weeks=args.weeks_ahead)

    existing_race_dates = {e["raceDate"] for e in schedule if e.get("kind") == "race"}

    kept = [e for e in schedule if e.get("source") != SOURCE_TAG]
    capped_log = []
    for e in kept:
        if e.get("kind") in ("race", "single"):
            continue
        if e.get("endDate") in (None, ""):
            new_end = (window_start - dt.timedelta(days=1)).isoformat()
            capped_log.append((e.get("id"), e.get("notes") or e.get("activityType"), new_end))
            e["endDate"] = new_end

    new_entries = []

    # --- races (whole calendar, not window-limited) ---
    for race in plan["meta"]["races"]:
        if race["date"] in existing_race_dates:
            continue
        taper_days, zone = RACE_TUNING.get(race["id"], (7, 3))
        duration_lookup = {
            "oly2026": 100, "half2026": 105, "marathon2026": 240,
            "lp2027": 720, "li703_2027": 300,
        }
        new_entries.append({
            "id": gen_id(len(new_entries)),
            "kind": "race",
            "activityType": "Other",
            "zone": zone,
            "durationMin": duration_lookup.get(race["id"], 120),
            "raceDate": race["date"],
            "taperDays": taper_days,
            "notes": race["name"],
            "source": SOURCE_TAG,
        })

    # --- recurring sessions, window-limited ---
    n_sessions = 0
    n_skipped_conflict = 0
    for week in plan["weeks"]:
        week_start = dt.date.fromisoformat(week["weekStart"])
        if week_start > window_end:
            continue
        week_end = dt.date.fromisoformat(week["weekEnd"])
        if week_end < window_start:
            continue
        for s in week["sessions"]:
            disc = s["disc"]
            if disc in SKIP_DISC or s["mins"] <= 0:
                continue
            if s["title"].upper().startswith("RACE"):
                continue  # represented by the race entry instead
            activity_type = DISC_TO_ACTIVITY.get(disc)
            if not activity_type:
                continue
            day_offset = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].index(s["day"])
            session_date = week_start + dt.timedelta(days=day_offset)
            if not (window_start <= session_date <= window_end):
                continue
            if covered_by_existing(session_date, kept):
                n_skipped_conflict += 1
                continue
            new_entries.append({
                "id": gen_id(len(new_entries) + 1000),
                "kind": "single",
                "activityType": activity_type,
                "zone": classify_zone(disc, s["title"], s.get("detail", "")),
                "durationMin": s["mins"],
                "date": session_date.isoformat(),
                "notes": short_note(s["title"]),
                "source": SOURCE_TAG,
            })
            n_sessions += 1

    final_schedule = kept + new_entries
    store["training-schedule"] = final_schedule

    print(f"Window: {window_start} .. {window_end} ({args.weeks_ahead} weeks)")
    print(f"Kept {len(kept)} existing entries (not created by this script).")
    for eid, label, new_end in capped_log:
        print(f"  capped open-ended entry {eid!r} ({label!r}) -> endDate {new_end}")
    n_races_added = sum(1 for e in new_entries if e.get("kind") == "race")
    print(f"Added {n_races_added} race entries, {n_sessions} single session entries.")
    if n_skipped_conflict:
        print(f"Skipped {n_skipped_conflict} plan session(s) that overlapped a date you already had your own entry for.")
    print(f"Total training-schedule entries after sync: {len(final_schedule)}")

    if args.dry_run:
        print("(dry run — nothing written)")
        return

    save_json_atomic(STORE_PATH, store)
    print(f"Wrote {STORE_PATH}")


if __name__ == "__main__":
    main()
