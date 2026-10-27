"""
Unit tests for schedule_sync.py's plan import: per-session zone/fuel
carry-through and race-date reconciliation. Run from the project root:

    python3 -m unittest discover -s src/python -p 'test_*.py'
"""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import schedule_sync as ss  # noqa: E402


def _plan_with_week(sessions, races=None):
    today = dt.date.today()
    ws = today + dt.timedelta(days=7 - today.weekday())  # next Monday — inside the window
    return {
        "meta": {"races": races or []},
        "weeks": [{"weekStart": ws.isoformat(), "weekEnd": (ws + dt.timedelta(days=6)).isoformat(),
                   "sessions": sessions}],
    }


class ZoneAndFuel(unittest.TestCase):
    def test_plan_zone_preferred_and_fuel_carried(self):
        plan = _plan_with_week([
            {"day": "Sat", "disc": "bike", "title": "Bike — Long", "detail": "easy", "mins": 300, "key": True,
             "zone": 3, "fuel": {"carbGPerH": 90, "fluidMlPerH": 750, "sodiumMgPerH": 700, "junk": "x"}},
            {"day": "Tue", "disc": "run", "title": "Run — Tempo", "detail": "tempo", "mins": 60},
        ])
        sched, _ = ss.sync_plan_into_store({"training-schedule": []}, plan, "p")
        by_type = {e["activityType"]: e for e in sched if e.get("kind") == "single"}
        self.assertEqual(by_type["Ride"]["zone"], 3)
        self.assertEqual(by_type["Ride"]["fuel"], {"carbGPerH": 90, "fluidMlPerH": 750, "sodiumMgPerH": 700})
        self.assertTrue(by_type["Ride"]["key"])
        # no zone in the file -> classify_zone fallback ("tempo" -> 3); no fuel key at all
        self.assertEqual(by_type["Run"]["zone"], 3)
        self.assertNotIn("fuel", by_type["Run"])

    def test_bad_zone_falls_back(self):
        self.assertEqual(ss.session_zone({"disc": "bike", "title": "Bike", "detail": "", "zone": 9}), 2)
        self.assertEqual(ss.session_zone({"disc": "bike", "title": "Bike", "detail": "", "zone": True}), 2)


class RaceReconcile(unittest.TestCase):
    def test_moves_renamed_date_instead_of_duplicating(self):
        stale = {"id": "keep-me", "kind": "race", "activityType": "Other", "zone": 3, "durationMin": 240,
                 "raceDate": "2026-11-06", "taperDays": 0, "carbLoadDays": 3, "notes": "Marathon"}
        store = {"training-schedule": [stale]}
        plan = _plan_with_week([], races=[{"id": "marathon2026", "date": "2026-11-08", "name": "marathon"}])
        sched, lines = ss.sync_plan_into_store(store, plan, "plan")
        races = [e for e in sched if e.get("kind") == "race"]
        self.assertEqual(len(races), 1)
        self.assertEqual(races[0]["id"], "keep-me")
        self.assertEqual(races[0]["raceDate"], "2026-11-08")
        self.assertEqual(races[0]["carbLoadDays"], 3)
        self.assertEqual(races[0]["taperDays"], 0)
        self.assertTrue(any("moved race entry 'keep-me'" in l and "2026-11-06 -> 2026-11-08" in l for l in lines))
        # second sync is a no-op for races
        sched2, lines2 = ss.sync_plan_into_store({"training-schedule": sched}, plan, "plan")
        self.assertEqual(len([e for e in sched2 if e.get("kind") == "race"]), 1)
        self.assertFalse(any("moved race" in l for l in lines2))

    def test_unmatched_name_still_added(self):
        store = {"training-schedule": [{"id": "a", "kind": "race", "raceDate": "2026-11-06", "notes": "Other race"}]}
        plan = _plan_with_week([], races=[{"id": "marathon2026", "date": "2026-11-08", "name": "Marathon"}])
        sched, _ = ss.sync_plan_into_store(store, plan, "plan")
        dates = sorted(e["raceDate"] for e in sched if e.get("kind") == "race")
        self.assertEqual(dates, ["2026-11-06", "2026-11-08"])

    def test_does_not_steal_entry_on_another_plan_race_date(self):
        # Two plan races with the same name: the entry already on one of
        # them must stay put; the other gets a fresh entry.
        store = {"training-schedule": [{"id": "a", "kind": "race", "raceDate": "2027-01-01", "notes": "Duathlon"}]}
        plan = _plan_with_week([], races=[{"id": "d1", "date": "2027-01-01", "name": "Duathlon"},
                                          {"id": "d2", "date": "2027-06-01", "name": "Duathlon"}])
        sched, _ = ss.sync_plan_into_store(store, plan, "plan")
        dates = sorted(e["raceDate"] for e in sched if e.get("kind") == "race")
        self.assertEqual(dates, ["2027-01-01", "2027-06-01"])
        self.assertEqual([e for e in sched if e.get("id") == "a"][0]["raceDate"], "2027-01-01")


if __name__ == "__main__":
    unittest.main()
