"""Trend detection: Mann–Kendall test + Theil–Sen slope (LLD §10.3).

Single indicators drift by chance far too often (day-to-day noise is autocorrelated), so the
insight looks at **recovery strain**: the sleep / heart / how-you-feel indicators averaged
as signed z-scores. Averaging six noisy signals cancels most of the noise while a real
fatigue episode, which moves them together, stands out (tuned on the simulated mission:
0 false trends for the healthy crew, fatigue trend 2 days before the rule alert).
"""

import warnings
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

import pymannkendall as mk

STRAIN_WINDOW_DAYS = 10
STRAIN_MAX_P = 0.05
STRAIN_MIN_RISE = 1.0  # strain must rise by ≥ 1σ across the window …
STRAIN_MIN_LEVEL = 1.0  # … and be ≥ 1σ above normal today
N_TOP_CONTRIBUTORS = 3


@dataclass(frozen=True)
class TrendResult:
    direction: Literal["increasing", "decreasing", "none"]
    p: float
    slope_per_day: float  # Theil–Sen


@dataclass(frozen=True)
class StrainTrend:
    p: float
    slope_per_day: float
    rise: float  # slope × (days − 1), in σ
    level: float  # strain today, in σ
    contributors: list[tuple[str, float]]  # (indicator, its own rise in σ toward unhealthy)


def trend(series: Sequence[float]) -> TrendResult:
    if len(series) < 4 or len(set(series)) == 1:
        return TrendResult("none", 1.0, 0.0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        r = mk.original_test(list(series))
    direction: Literal["increasing", "decreasing", "none"] = (
        r.trend if r.trend in ("increasing", "decreasing") else "none"
    )
    return TrendResult(direction, float(r.p), float(r.slope))


def strain_trend(
    strain: Sequence[float | None], parts: Mapping[str, Sequence[float | None]], signs: Mapping[str, int]
) -> StrainTrend | None:
    """Rising recovery strain over the last STRAIN_WINDOW_DAYS days, or None.

    `strain` and every `parts[code]` are aligned day by day, oldest first, ending today.
    """
    window = list(strain[-STRAIN_WINDOW_DAYS:])
    values = [v for v in window if v is not None]
    if len(values) < STRAIN_WINDOW_DAYS - 1 or window[-1] is None:
        return None
    t = trend(values)
    rise = t.slope_per_day * (len(values) - 1)
    level = window[-1]
    if (
        t.direction != "increasing"
        or t.p >= STRAIN_MAX_P
        or rise < STRAIN_MIN_RISE
        or level < STRAIN_MIN_LEVEL
    ):
        return None
    moves = []
    for code, series in parts.items():
        own = [signs[code] * v for v in series[-STRAIN_WINDOW_DAYS:] if v is not None]
        if len(own) >= 4:
            moves.append((code, round(trend(own).slope_per_day * (len(own) - 1), 2)))
    top = sorted((m for m in moves if m[1] > 0), key=lambda m: -m[1])[:N_TOP_CONTRIBUTORS]
    return StrainTrend(round(t.p, 4), round(t.slope_per_day, 3), round(rise, 2), round(level, 2), top)
