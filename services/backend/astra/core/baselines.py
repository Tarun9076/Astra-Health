"""Personal baselines: robust median and spread per astronaut × indicator (LLD §5, TDD ADR-05).

    sigma = max(1.4826 × MAD, sigmaFloor)      z = (value − median) / sigma

Rolling window = the 28 days before `as_of`, skipping the most recent 3 days (so a
developing trend doesn't drag its own baseline along) and any day already flagged
abnormal for this indicator (don't learn the abnormal as normal). On the mission, the
window never reaches back into pre-flight days.
"""

from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from statistics import median
from typing import Literal

MAD_TO_SIGMA = 1.4826  # makes MAD comparable to a standard deviation for normal data


@dataclass(frozen=True)
class DailyValue:
    day: date
    value: float


@dataclass(frozen=True)
class BaselineOptions:
    window_days: int = 28
    min_samples: int = 7
    recent_days_excluded: int = 3


@dataclass(frozen=True)
class Baseline:
    indicator: str
    median: float
    mad: float
    sigma: float
    samples: int
    source: Literal["Rolling", "Preflight"]
    provisional: bool  # True when computed from fewer days than wanted
    window_start: date | None = None
    window_end: date | None = None

    def z(self, value: float) -> float | None:
        return (value - self.median) / self.sigma if self.sigma > 0 else None

    def ratio(self, value: float) -> float | None:
        return value / self.median if self.median > 0 else None


def daily_values(points: Iterable[tuple[datetime, float]]) -> list[DailyValue]:
    """Collapse readings to one value per day (the daily median), sorted by day."""
    by_day: dict[date, list[float]] = defaultdict(list)
    for t, v in points:
        by_day[t.date()].append(v)
    return [DailyValue(d, float(median(vs))) for d, vs in sorted(by_day.items())]


def robust_stats(values: Sequence[float], sigma_floor: float | None) -> tuple[float, float, float]:
    """(median, MAD, sigma) with sigma floored, so a very steady series can't make tiny changes look huge."""
    mid = float(median(values))
    mad = float(median(abs(v - mid) for v in values))
    sigma = max(MAD_TO_SIGMA * mad, sigma_floor or 0.0)
    return mid, mad, sigma


def compute_baseline(
    indicator: str,
    history: Sequence[DailyValue],
    as_of: date,
    *,
    sigma_floor: float | None,
    excluded_days: frozenset[date] | set[date] = frozenset(),
    not_before: date | None = None,
    preflight: "Baseline | None" = None,
    options: BaselineOptions | None = None,
) -> Baseline | None:
    """Rolling baseline at `as_of`; falls back to `preflight` when there are too few days.

    Returns None when there are fewer than `min_samples` days and no pre-flight fallback: a
    baseline from 2–6 days is too noisy to judge anyone against, so z-score conditions stay
    unknown (no alert) until enough history exists.
    """
    opts = options or BaselineOptions()
    window_end = as_of - timedelta(days=opts.recent_days_excluded)
    window_start = window_end - timedelta(days=opts.window_days - 1)
    if not_before is not None:
        window_start = max(window_start, not_before)
    values = [
        dv.value for dv in history if window_start <= dv.day <= window_end and dv.day not in excluded_days
    ]
    if len(values) >= opts.min_samples:
        mid, mad, sigma = robust_stats(values, sigma_floor)
        return Baseline(indicator, mid, mad, sigma, len(values), "Rolling", False, window_start, window_end)
    return preflight


def compute_preflight_baseline(
    indicator: str,
    history: Sequence[DailyValue],
    mission_start: date,
    *,
    sigma_floor: float | None,
    options: BaselineOptions | None = None,
) -> Baseline | None:
    """Baseline from all pre-flight days (before `mission_start`): the 'digital twin' reference."""
    opts = options or BaselineOptions()
    days = [dv for dv in history if dv.day < mission_start]
    if not days:
        return None
    mid, mad, sigma = robust_stats([dv.value for dv in days], sigma_floor)
    return Baseline(
        indicator,
        mid,
        mad,
        sigma,
        len(days),
        "Preflight",
        len(days) < opts.min_samples,
        days[0].day,
        days[-1].day,
    )
