"""ML module unit tests (LLD §10): features, Isolation Forest scoring, recovery-strain trend."""

from datetime import date, timedelta

import numpy as np
import pytest

from astra.ml import isolation
from astra.ml.features import FEATURES, STRAIN, feature_frame, strain
from astra.ml.trend import strain_trend, trend

D0 = date(2026, 9, 1)


def _days(n: int) -> list[date]:
    return [D0 + timedelta(days=i) for i in range(n)]


def test_features_forward_fill_two_days_then_zero() -> None:
    z = {D0: dict.fromkeys(FEATURES, 1.0)}
    for i in range(1, 4):  # resting_hr missing on days 1–3, everything else present
        z[D0 + timedelta(days=i)] = {**dict.fromkeys(FEATURES, 1.0), "resting_hr": None}
    frame = feature_frame(z)
    assert list(frame["resting_hr"]) == [1.0, 1.0, 1.0, 0.0]  # carried 2 days, then "normal"


def test_thin_days_are_dropped() -> None:
    z = {D0: dict.fromkeys(FEATURES, 0.5), D0 + timedelta(days=1): {"resting_hr": 2.0, "sleep_hours": -1.0}}
    assert list(feature_frame(z).index) == [D0]


def test_strain_is_signed_and_needs_four_indicators() -> None:
    worse = {code: 2.0 * sign for code, sign in STRAIN.items()}  # every indicator 2σ the unhealthy way
    assert strain(worse) == pytest.approx(2.0)
    assert strain({"resting_hr": 3.0, "fatigue": 3.0}) is None


def test_isolation_forest_scores_an_unusual_day_above_ordinary_days() -> None:
    rng = np.random.default_rng(1)
    ordinary = {d: dict(zip(FEATURES, rng.normal(0, 1, len(FEATURES)), strict=True)) for d in _days(40)}
    model = isolation.train(feature_frame(ordinary), valid_from=D0 + timedelta(days=40))
    assert model is not None and model.n_train == 40 and model.version.startswith("iforest-1:")

    odd_day = D0 + timedelta(days=41)
    episode = {
        "resting_hr": 5.0,
        "sleep_hours": -4.0,
        "fatigue": 4.5,
        "mood": -3.0,
        "stress": 3.0,
        "sleep_quality": -3.0,
    }
    odd = {odd_day: {**dict.fromkeys(FEATURES, 0.0), **episode}}  # a fatigue-like day: several move together
    calm = {odd_day: dict.fromkeys(FEATURES, 0.0)}
    (high,) = isolation.score(model, feature_frame(odd))
    (low,) = isolation.score(model, feature_frame(calm))
    assert high.score > 0.5 > low.score  # beyond the training 95th percentile
    assert [c for c, _ in high.contributors] == ["resting_hr", "fatigue", "sleep_hours"]


def test_too_few_days_means_no_model() -> None:
    rows = feature_frame({d: dict.fromkeys(FEATURES, 0.0) for d in _days(10)})
    assert isolation.train(rows, valid_from=D0) is None


def test_model_round_trips_through_joblib(tmp_path: object) -> None:
    from pathlib import Path

    rng = np.random.default_rng(2)
    rows = feature_frame(
        {d: dict(zip(FEATURES, rng.normal(0, 1, len(FEATURES)), strict=True)) for d in _days(30)}
    )
    model = isolation.train(rows, valid_from=D0)
    assert model is not None
    path = Path(str(tmp_path)) / "m.joblib"
    isolation.save(model, path)
    loaded = isolation.load(path)
    assert loaded is not None and loaded.version == model.version


def test_mann_kendall_trend() -> None:
    assert trend([1, 2, 3, 4, 5, 6, 7, 8]).direction == "increasing"
    assert trend([5, 5, 5, 5, 5]).direction == "none"


def test_strain_trend_fires_on_a_steady_rise_only() -> None:
    rising = [0.0, 0.1, 0.0, 0.3, 0.5, 0.6, 0.9, 1.2, 1.4, 1.8]
    parts = {"resting_hr": [v * 2 for v in rising], "fatigue": rising, "sleep_hours": [-v for v in rising]}
    signs = {"resting_hr": 1, "fatigue": 1, "sleep_hours": -1}
    found = strain_trend(rising, parts, signs)
    assert found is not None and found.p < 0.05 and found.rise >= 1.0 and found.level == 1.8
    assert found.contributors[0][0] == "resting_hr"

    noise = [0.2, -0.3, 0.5, 0.1, -0.2, 0.4, 0.0, 0.3, -0.1, 0.2]
    assert strain_trend(noise, {}, {}) is None
    small = [v / 4 for v in rising]  # rising, but never 1σ from normal
    assert strain_trend(small, {}, {}) is None
