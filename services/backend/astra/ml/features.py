"""Daily feature vectors for the ML insights (LLD §10.1).

Each feature is a robust z-score against the astronaut's own baseline on that day, so the
models see "how unusual is this for you", never raw units. Pure: no database or web imports.
"""

from collections.abc import Mapping
from datetime import date, timedelta
from statistics import mean

import pandas as pd

FEATURES: tuple[str, ...] = (
    "resting_hr",
    "bp_sys",
    "bp_dia",
    "body_temp",
    "spo2",
    "sleep_hours",
    "sleep_quality",
    "mood",
    "stress",
    "fatigue",
    "activity_min",
)
MIN_OBSERVED = 6  # a day with fewer real features is too thin to score
FILL_LIMIT_DAYS = 2  # carry a value forward at most 2 days, then treat it as "normal" (z = 0)

# Recovery strain: the sleep / heart / how-you-feel indicators, signed so that + is worse.
STRAIN: dict[str, int] = {
    "resting_hr": 1,
    "sleep_hours": -1,
    "sleep_quality": -1,
    "mood": -1,
    "stress": 1,
    "fatigue": 1,
}
MIN_STRAIN_INDICATORS = 4

ZByDay = Mapping[date, Mapping[str, float | None]]


def feature_frame(z_by_day: ZByDay) -> pd.DataFrame:
    """One row per day (index = date), columns = FEATURES, gaps forward-filled ≤ 2 days, rest 0.

    Days with fewer than MIN_OBSERVED features actually measured are dropped.
    """
    if not z_by_day:
        return pd.DataFrame(columns=list(FEATURES), dtype=float)
    first, last = min(z_by_day), max(z_by_day)
    days = [first + timedelta(days=i) for i in range((last - first).days + 1)]
    raw = pd.DataFrame(
        [[_num(z_by_day.get(d, {}).get(f)) for f in FEATURES] for d in days],
        index=pd.Index(days, name="day"),
        columns=list(FEATURES),
        dtype=float,
    )
    observed = raw.notna().sum(axis=1)
    filled = raw.ffill(limit=FILL_LIMIT_DAYS).fillna(0.0)
    keep = (observed >= MIN_OBSERVED) & raw.index.isin(list(z_by_day))
    return filled[keep]


def strain(z: Mapping[str, float | None]) -> float | None:
    """Mean signed z of the recovery indicators (+ = further from normal in the unhealthy way)."""
    signed = [sign * v for code, sign in STRAIN.items() if (v := z.get(code)) is not None]
    return mean(signed) if len(signed) >= MIN_STRAIN_INDICATORS else None


def _num(v: float | None) -> float:
    return float("nan") if v is None else float(v)
