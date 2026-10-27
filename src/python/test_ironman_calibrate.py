"""
Unit tests for ironman_calibrate.py — SYNTHETIC fixtures only (never the
athlete's real store). Run from the project root:

    python3 -m unittest discover -s src/python -p 'test_*.py'
"""
import datetime as dt
import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ironman_calibrate as ic  # noqa: E402


def bmr_fn(kg):
    return ic.calc_bmr("male", kg, 188.0, 34)


def simulate(true_neat, true_k, n_days=140, seed=1, noise_kg=0.35, start=dt.date(2026, 1, 1)):
    """Daily intake/session kcal with a known expenditure model; weight evolves
    by (intake - E)/7700 and is observed with Gaussian noise ~5 days/week."""
    rng = random.Random(seed)
    w = 74.0
    days, weights = [], {}
    for i in range(n_days):
        d = start + dt.timedelta(days=i)
        # Strongly varying training load (rest / easy / big) and an intake
        # that only partly tracks it, so neat and k are separately identifiable.
        sess = rng.choice([0, 0, 600, 900, 1200, 1800, 2600, 3400])
        e_true = true_neat * bmr_fn(w) + true_k * sess
        intake = e_true + rng.gauss(0, 450) + 250 * math.sin(i / 9.0)
        if rng.random() < 0.72:
            weights[d.isoformat()] = round(w + rng.gauss(0, noise_kg), 2)
        days.append({"date": d.isoformat(), "intake": intake, "carbs": 600.0, "sessionKcal": float(sess)})
        w += (intake - e_true) / ic.KCAL_PER_KG
    return days, weights


class EnergyBalanceRecovery(unittest.TestCase):
    def test_recovers_known_neat_and_scale_with_weak_prior(self):
        days, weights = simulate(1.35, 0.90)
        r = ic.fit_energy_balance(days, weights, bmr_fn, prior_neat=1.2, prior_k=1.1,
                                  prior_sd_neat=1.0, prior_sd_k=1.0)
        self.assertFalse(r["insufficient"])
        self.assertAlmostEqual(r["neat"], 1.35, delta=max(0.08, 2.5 * r["neatSd"]))
        self.assertAlmostEqual(r["activityScale"], 0.90, delta=max(0.08, 2.5 * r["activityScaleSd"]))

    def test_recovers_scale_above_one(self):
        days, weights = simulate(1.20, 1.25, seed=7)
        r = ic.fit_energy_balance(days, weights, bmr_fn, prior_neat=1.3, prior_k=1.0,
                                  prior_sd_neat=1.0, prior_sd_k=1.0)
        self.assertAlmostEqual(r["neat"], 1.20, delta=max(0.08, 2.5 * r["neatSd"]))
        self.assertAlmostEqual(r["activityScale"], 1.25, delta=max(0.08, 2.5 * r["activityScaleSd"]))

    def test_total_expenditure_well_identified_even_when_split_is_not(self):
        # Short window, constant training load: neat vs k is unidentifiable,
        # but the total daily expenditure still must come out right.
        rng = random.Random(3)
        w, days, weights = 74.0, [], {}
        for i in range(60):
            d = (dt.date(2026, 3, 1) + dt.timedelta(days=i)).isoformat()
            sess = 2000.0
            e = 1.25 * bmr_fn(w) + 1.1 * sess
            intake = e + rng.gauss(0, 300)
            if i % 2 == 0:
                weights[d] = w + rng.gauss(0, 0.3)
            days.append({"date": d, "intake": intake, "carbs": 600.0, "sessionKcal": sess})
            w += (intake - e) / ic.KCAL_PER_KG
        r = ic.fit_energy_balance(days, weights, bmr_fn, prior_neat=1.15, prior_k=1.0,
                                  prior_sd_neat=0.10, prior_sd_k=0.15)
        true_total = 1.25 * bmr_fn(74.0) + 1.1 * 2000
        self.assertAlmostEqual(r["meanDailyExpenditure"], true_total, delta=150)
        self.assertLess(r["corrNeatScale"], -0.5)  # the split trades off, as it should

    def test_prior_dominates_with_no_signal(self):
        days, weights = simulate(1.30, 1.0, n_days=20, seed=11, noise_kg=1.5)
        r = ic.fit_energy_balance(days, weights, bmr_fn, prior_neat=1.15, prior_k=1.0,
                                  prior_sd_neat=0.03, prior_sd_k=0.03)
        self.assertAlmostEqual(r["neat"], 1.15, delta=0.05)

    def test_insufficient_weighins(self):
        days, _ = simulate(1.3, 1.0, n_days=10)
        r = ic.fit_energy_balance(days, {days[0]["date"]: 74.0}, bmr_fn, 1.2, 1.0)
        self.assertTrue(r["insufficient"])


class WeightTrend(unittest.TestCase):
    def test_kalman_trend_recovers_slope_through_noise(self):
        rng = random.Random(5)
        log = {}
        for i in range(70):
            if rng.random() < 0.7:
                log[(dt.date(2026, 5, 1) + dt.timedelta(days=i)).isoformat()] = 74.0 - 0.03 * i + rng.gauss(0, 0.4)
        tr = ic.weight_trend(log)
        self.assertAlmostEqual(tr[-1]["slopeKgPerDay"] * 7, -0.21, delta=0.08)
        self.assertAlmostEqual(tr[len(tr) // 2]["levelKg"], 74.0 - 0.03 * (len(tr) // 2), delta=0.35)


class SessionCost(unittest.TestCase):
    def _store(self, ftp=280.0, seed=2):
        rng = random.Random(seed)
        acts = []
        i = 0
        for _ in range(80):
            frac = rng.uniform(0.45, 0.9)
            sec = rng.choice([3600, 5400, 7200, 10800])
            kj = frac * ftp * sec / 1000
            # Known truth: ride kcal/h = 1050 * IF (i.e. ~1 kcal per kJ at 24% eff.)
            kcal = 1050 * frac * sec / 3600 + rng.gauss(0, 15)
            acts.append({"id": i, "type": "VirtualRide", "start_date_local": "2026-07-01T07:00:00Z",
                         "moving_time": sec, "kilojoules": kj, "calories": kcal, "suffer_score": 50}); i += 1
        for _ in range(40):
            ssh = rng.uniform(30, 150)
            sec = rng.choice([1800, 3600, 5400])
            acts.append({"id": i, "type": "Run", "start_date_local": "2026-07-02T07:00:00Z",
                         "moving_time": sec, "kilojoules": None,
                         "calories": (800 + 2.0 * ssh) * sec / 3600, "suffer_score": ssh * sec / 3600}); i += 1
        # one ride with garbage calories vs kJ, and one overridden run
        acts.append({"id": 900, "type": "VirtualRide", "start_date_local": "2026-07-03T07:00:00Z",
                     "moving_time": 3600, "kilojoules": 700, "calories": 3000, "suffer_score": 60})
        acts.append({"id": 901, "type": "Run", "start_date_local": "2026-07-03T07:00:00Z",
                     "moving_time": 3600, "kilojoules": None, "calories": 5000, "suffer_score": 80})
        return {"strava-cache": {"activities": acts}, "activity-kcal-overrides": {"strava-901": 960}}

    def test_ride_and_run_lines_recovered(self):
        store = self._store()
        acts = ic.extract_activities(store, 280.0)
        costs, notes = ic.fit_session_costs(acts, 75.0, 280.0)
        self.assertAlmostEqual(costs["Ride"]["fit"]["slope"], 1050, delta=60)
        self.assertAlmostEqual(costs["Ride"]["fit"]["intercept"], 0, delta=40)
        self.assertAlmostEqual(costs["Run"]["fit"]["slope"], 2.0, delta=0.3)
        self.assertAlmostEqual(costs["Run"]["fit"]["intercept"], 800, delta=30)
        # zone values increase monotonically
        rz = costs["Ride"]["kcalPerHourByZone"]
        self.assertTrue(all(rz[z] < rz[z + 1] for z in range(1, 5)))

    def test_override_wins_and_kj_outlier_replaced(self):
        store = self._store()
        acts = ic.extract_activities(store, 280.0)
        ic.fit_session_costs(acts, 75.0, 280.0)
        by_id = {a["id"]: a for a in acts}
        self.assertEqual(by_id["strava-901"]["kcal"], 960)
        self.assertTrue(by_id["strava-901"]["overridden"])
        self.assertLess(by_id["strava-900"]["kcal"], 800)  # 3000 kcal re-derived from 700 kJ
        self.assertEqual(by_id["strava-900"]["kcalSource"], "kJ (calories outlier)")


class Projection(unittest.TestCase):
    def test_projection_uses_zone_and_skips_race_day(self):
        costs = {d: {"kcalPerHourByZone": {z: 600 + 100 * z for z in range(1, 6)}} for d in ic.DISCIPLINES}
        cal = {"sessionCost": costs, "energyBalance": {"neat": 1.3, "activityScale": 1.0}}
        ath = {"weightKg": 75.0, "sex": "male", "heightCm": 188.0, "age": 34, "goal": "maintain",
               "buildRatePct": 0.2, "loseRatePct": 0.5, "proteinGPerKg": 2.0, "targetWeightKg": None}
        plan = {"weeks": [{"weekStart": "2027-01-04", "phase": "x", "sessions": [
            {"day": "Mon", "disc": "bike", "title": "Bike", "detail": "", "mins": 120, "zone": 4},
            {"day": "Sun", "disc": "run", "title": "RACE — Thing", "detail": "", "mins": 300, "zone": 3},
        ]}]}
        wk = ic.project_plan([plan], cal, ath)[0]
        self.assertEqual(wk["plannedHours"], 2.0)
        bmr = ic.calc_bmr("male", 75, 188, 34)
        # 6 non-race days: one with a 2h Z4 ride (1000 kcal/h) and five rest days
        expect = (6 * 1.3 * bmr + 2000) / 6
        self.assertAlmostEqual(wk["demandKcalPerDay"], expect, delta=1)
        self.assertEqual(len(wk["raceDays"]), 1)

    def test_carb_anchor_monotone(self):
        vals = [ic.carb_g_per_kg_for_load(x) for x in range(0, 5000, 250)]
        self.assertTrue(all(a <= b for a, b in zip(vals, vals[1:])))
        self.assertEqual(vals[0], 5.0)
        self.assertEqual(ic.carb_g_per_kg_for_load(9999), 12.0)


if __name__ == "__main__":
    unittest.main()
