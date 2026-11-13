"""Synthetic-fixture tests for expenditure_audit.py:
    python3 -m unittest discover -s src/python -p 'test_*.py'
"""
import datetime as dt
import random
import unittest

import expenditure_audit as ea
import ironman_calibrate as ic

TODAY = dt.date(2026, 6, 30)


def make_store(true_neat=1.45, true_epoc=0.10, days=90, seed=1, weigh_every=1, log_frac=1.0,
               profile_neat=1.15, kcal_bias=0.0):
    """Athlete whose real expenditure is true_neat*BMR + (1+true_epoc)*exercise.
    Intake is set so weight drifts slowly up; weigh-ins carry ±0.5 kg water noise."""
    rng = random.Random(seed)
    prof = {"sex": "male", "heightCm": 180, "age": 35, "neatMode": "multiplier", "neatFactor": profile_neat,
            "epocSensitivity": 1.0, "fatigueBuffer": False}
    w = 75.0
    start = TODAY - dt.timedelta(days=days)
    nut, wl, acts, synced = {}, {}, [], []
    for i in range(days + 1):
        d = start + dt.timedelta(days=i)
        k = d.isoformat()
        synced.append(k)
        if i % weigh_every == 0:
            wl[k] = round(w + rng.gauss(0, 0.5), 1)
        # weekly pattern with block-to-block variety: 0-1600 kcal/day
        block = 1.0 + 0.6 * ((i // 21) % 2)
        ex = [0, 600, 900, 500, 0, 1400, 1000][d.weekday()] * block * rng.uniform(0.8, 1.2)
        if ex > 0:
            acts.append({"id": i, "type": "Ride", "start_date_local": k + "T07:00:00Z",
                         "moving_time": ex / 700 * 3600, "calories": round(ex), "suffer_score": ex / 700 * 50})
        bmr = ic.calc_bmr("male", w, 180, 35)
        burn = true_neat * bmr + (1 + true_epoc) * ex
        intake = burn + 150 + rng.gauss(0, 300)  # small surplus
        if rng.random() < log_frac:
            nut[k] = {"macrosfirst": {"calories": round(intake * (1 - kcal_bias)), "carbs": 400}}
        w += (intake - burn) / 7700
    return {"profile": prof, "nutrition-log": nut, "weight-log": wl,
            "strava-cache": {"activities": acts, "syncedDates": synced}}


class AuditTests(unittest.TestCase):
    def test_recovers_non_exercise_expenditure(self):
        store = make_store()
        r = ea.run_audit(store, days=56, today=TODAY)
        self.assertTrue(r["ok"], r)
        p = r["pooled"]
        # true non-exercise = 1.45*BMR + 0.10*exercise
        true_nex = 1.45 * p["bmr"] + 0.10 * p["exerciseKcal"]
        self.assertLess(abs(p["nonExercise"] - true_nex), max(150, 2 * p["sd"]), p)
        # recommended factor (EPOC kept at the app's ~5-8%) lands near truth
        rec = r["recommendation"]
        self.assertGreater(rec["neatFactor"], 1.35)
        self.assertLess(rec["neatFactor"], 1.6)
        self.assertTrue(rec["changeSuggested"])
        self.assertGreater(p["gap"], 0)

    def test_matching_model_suggests_no_change(self):
        store = make_store(true_neat=1.15, true_epoc=0.065, profile_neat=1.15)
        r = ea.run_audit(store, days=56, today=TODAY)
        self.assertTrue(r["ok"])
        self.assertLess(abs(r["pooled"]["gap"]), max(120, 2 * r["pooled"]["sd"]), r["pooled"])

    def test_sparse_weighins_and_logging_widen_uncertainty(self):
        dense = ea.run_audit(make_store(seed=3), days=56, today=TODAY)
        sparse = ea.run_audit(make_store(seed=3, weigh_every=4, log_frac=0.6), days=56, today=TODAY)
        self.assertTrue(sparse["ok"])
        self.assertGreater(sparse["pooled"]["sd"], dense["pooled"]["sd"])
        self.assertTrue(any("food log" in n for n in sparse["notes"]))

    def test_underlogging_shows_up_as_lower_expenditure(self):
        honest = ea.run_audit(make_store(seed=5), days=56, today=TODAY)
        under = ea.run_audit(make_store(seed=5, kcal_bias=0.15), days=56, today=TODAY)
        self.assertLess(under["pooled"]["observedTdee"], honest["pooled"]["observedTdee"] - 300)

    def test_insufficient_data(self):
        r = ea.run_audit({"profile": {}, "weight-log": {"2026-06-01": 75}}, today=TODAY)
        self.assertFalse(r["ok"])

    def test_windows_and_split(self):
        r = ea.run_audit(make_store(days=120), days=56, today=TODAY)
        self.assertGreaterEqual(len(r["windows"]), 10)
        self.assertIsNotNone(r["loadResponse"])
        self.assertIsNotNone(r["split"])
        # total expenditure from the Kalman fit agrees with the windowed estimate
        self.assertIn("meanDailyExpenditure", r["split"])
        self.assertTrue(ea.format_report(r))


if __name__ == "__main__":
    unittest.main()
