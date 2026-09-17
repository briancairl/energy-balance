#!/usr/bin/env python3
"""
sync_schedule_from_plan.py — manually run (or dry-run) the training-plan
import that server.py otherwise does automatically in the background.

WHAT THIS DOES
---------------
energy-balance only ever consults `training-schedule` for two things:
  1. Estimating kcal demand for TODAY through FORWARD_DAYS (4) days ahead,
     whenever Strava/intervals.icu hasn't synced real activity data yet for
     that date (see getScheduledSessionsForDate / dailyRows in app-source.jsx).
  2. Auto-taper and carb-loading, which look at the *nearest upcoming race*
     regardless of how far out it is (getUpcomingRace).
So importing a plan does two different things on two different time horizons
— see schedule_sync.sync_plan_into_store for the full logic (shared with the
background importer in server.py, not duplicated here):
  - RACES: every race in the plan gets a `kind: "race"` entry, added once.
  - SESSIONS: only the next `--weeks-ahead` weeks (default 8) become
    `kind: "single"` schedule entries.

Every plan file in schedule_sources/ is tagged with its own source (its
filename minus ".json"), so importing several plans at once never confuses
one file's entries for another's, and re-importing a file only replaces that
file's own previously-synced entries — anything you added by hand in the
app's UI is left untouched.

AUTOMATIC IMPORTS
------------------
server.py already watches every schedule_sources/*.json file and re-imports
one automatically (via content hash, not mtime) within ~30s of it changing —
no restart needed, and this script does NOT need to be run for that to work.
This script exists for manual/offline use: previewing what a change would do
before saving it (--dry-run), or forcing a re-import without waiting.

USAGE
-----
    python3 sync_schedule_from_plan.py [--weeks-ahead 8] [--dry-run]
    python3 sync_schedule_from_plan.py --file some_plan.json [--dry-run]

With no --file, every schedule_sources/*.json file is synced. Run it from
inside the energy-balance project directory (it looks for app_store.json and
schedule_sources/ next to itself).
"""
import json, os, sys, argparse

import schedule_sync

HERE = os.path.dirname(os.path.abspath(__file__))
STORE_PATH = os.path.join(HERE, "app_store.json")
SOURCES_DIR = os.path.join(HERE, "schedule_sources")


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weeks-ahead", type=int, default=8,
                     help="How many weeks of recurring sessions to sync from today (default 8).")
    ap.add_argument("--file", help="Sync just this one plan file instead of every "
                                    "schedule_sources/*.json file. Its source tag is its "
                                    "filename minus '.json'.")
    ap.add_argument("--dry-run", action="store_true", help="Print what would change, write nothing.")
    args = ap.parse_args()

    if args.file:
        path = os.path.abspath(args.file)
        if not os.path.exists(path):
            sys.exit(f"Missing {path}")
        sources = [(path, os.path.basename(path).removesuffix(".json"))]
    else:
        sources = schedule_sync.discover_schedule_sources(SOURCES_DIR)
        if not sources:
            sys.exit(f"No *.json files found in {SOURCES_DIR} — drop a plan export there first.")

    store = load_json(STORE_PATH, {})

    for path, source_tag in sources:
        plan = load_json(path, None)
        if plan is None:
            print(f"[{source_tag}] skipped — {path} not found")
            continue
        new_schedule, lines = schedule_sync.sync_source_into_store(
            store, plan, source_tag, weeks_ahead=args.weeks_ahead)
        store["training-schedule"] = new_schedule
        for line in lines:
            print(line)

    if args.dry_run:
        print("(dry run — nothing written)")
        return

    save_json_atomic(STORE_PATH, store)
    print(f"Wrote {STORE_PATH}")


if __name__ == "__main__":
    main()
