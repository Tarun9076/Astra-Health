from datetime import date, timedelta

import numpy as np
import pytest

from astra.core.baselines import (
    DailyValue,
    compute_baseline,
    compute_preflight_baseline,
    daily_values,
    robust_stats,
)

AS_OF = date(2026, 11, 13)


def _history(values: list[float], end: date = AS_OF) -> list[DailyValue]:
    start = end - timedelta(days=len(values) - 1)
    return [DailyValue(start + timedelta(days=i), v) for i, v in enumerate(values)]


def test_normal_data_gives_median_and_sigma() -> None:
    # T-B-01
    rng = np.random.default_rng(1)
    history = _history(list(64 + 3 * rng.standard_normal(40)))
    b = compute_baseline("resting_hr", history, AS_OF, sigma_floor=2)
    assert b is not None and b.source == "Rolling" and b.samples == 28
    assert b.median == pytest.approx(64, abs=1.5)
    assert b.sigma == pytest.approx(3, abs=1.0)


def test_one_outlier_does_not_move_the_baseline() -> None:
    # T-B-02
    values = [64.0, 65.0, 63.0, 64.0, 66.0, 62.0, 64.0] * 4 + [140.0] + [64.0] * 3
    b = compute_baseline("resting_hr", _history(values), AS_OF, sigma_floor=2)
    assert b is not None and b.median == 64 and b.sigma < 3


def test_constant_series_uses_sigma_floor() -> None:
    # T-B-03
    b = compute_baseline("resting_hr", _history([60.0] * 35), AS_OF, sigma_floor=2)
    assert b is not None and b.mad == 0 and b.sigma == 2


def test_too_few_days_falls_back_to_preflight() -> None:
    # T-B-04
    preflight = compute_preflight_baseline(
        "resting_hr", _history([60.0] * 30, end=date(2026, 7, 16)), date(2026, 7, 17), sigma_floor=2
    )
    mission = _history([70.0] * 5, end=date(2026, 7, 21))
    b = compute_baseline(
        "resting_hr",
        mission,
        date(2026, 7, 24),
        sigma_floor=2,
        not_before=date(2026, 7, 17),
        preflight=preflight,
    )
    assert b is preflight and b is not None and b.source == "Preflight" and b.median == 60


def test_no_data_and_no_preflight_gives_none() -> None:
    assert compute_baseline("resting_hr", [], AS_OF, sigma_floor=2) is None


def test_recent_three_days_are_excluded() -> None:
    # The last 3 days (a developing trend) must not pull the baseline towards themselves.
    b = compute_baseline("resting_hr", _history([64.0] * 30 + [95.0] * 3), AS_OF, sigma_floor=2)
    assert b is not None and b.median == 64


def test_flagged_abnormal_days_are_excluded() -> None:
    history = _history([64.0] * 20 + [90.0] * 10 + [64.0] * 3)
    abnormal = {d.day for d in history if d.value == 90.0}
    assert compute_baseline("resting_hr", history, AS_OF, sigma_floor=2, excluded_days=abnormal).median == 64  # type: ignore[union-attr]


def test_daily_values_take_the_daily_median() -> None:
    from datetime import UTC, datetime

    points = [(datetime(2026, 11, 1, h, tzinfo=UTC), v) for h, v in ((6, 60.0), (12, 90.0), (18, 62.0))]
    assert daily_values(points) == [DailyValue(date(2026, 11, 1), 62.0)]


def test_robust_stats_and_ratio() -> None:
    mid, mad, sigma = robust_stats([0.6, 0.64, 0.66, 0.62, 0.64], sigma_floor=None)
    assert mid == pytest.approx(0.64)
    assert mad == pytest.approx(0.02)
    assert sigma == pytest.approx(0.02 * 1.4826)
    b = compute_baseline("radiation_dose", _history([0.64] * 30), AS_OF, sigma_floor=None)
    assert b is not None and b.ratio(19.2) == pytest.approx(30)
    assert b.z(0.7) is None  # constant series without a floor: z undefined, ratio still works
