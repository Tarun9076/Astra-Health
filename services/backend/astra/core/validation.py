"""Validation & normalisation of incoming readings (LLD §4). Pure: no database access.

Order of checks for one reading:
  1. indicator exists                       → Rejected  unknown_indicator
  2. radiation channel only on radiation    → Rejected  channel_not_allowed
  3. unit accepted, convert to canonical    → Rejected  unknown_unit
  4. timestamp not > 5 min in the future    → Rejected  future_timestamp
     older than 30 days (unless backfill)   → Questionable late_arrival
  5. inside the plausible range             → Rejected  implausible
  6. device signal quality / motion         → Questionable low_signal
  7. sudden jump vs previous valid reading  → Questionable sudden_jump
Panel check (bp_sys/bp_dia measured together) runs over the batch: systolic ≤ diastolic
→ both Rejected bp_inconsistent. Duplicate detection needs the database, so the
ingestion service does it.
"""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from astra.core.enums import MeasurementQuality
from astra.core.indicators import IndicatorCatalog, IndicatorError

FUTURE_TOLERANCE = timedelta(minutes=5)
LATE_ARRIVAL = timedelta(days=30)
MIN_SIGNAL_QUALITY = 0.6
JUMP_CHECK_INDICATORS = frozenset({"heart_rate", "spo2", "body_temp"})
JUMP_WINDOW = timedelta(minutes=10)
JUMP_SIGMAS = 6.0
RADIATION_CHANNELS = frozenset({"Total", "Charged", "Neutron"})


@dataclass(frozen=True)
class RawReading:
    indicator: str
    value: float
    unit: str
    measured_at: datetime  # timezone-aware
    channel: str | None = None
    panel_id: str | None = None
    signal_quality: float | None = None  # 0–1, reported by the device
    motion_artifact: bool = False


@dataclass(frozen=True)
class PreviousValid:
    value: float  # canonical unit
    measured_at: datetime


@dataclass(frozen=True)
class ValidationResult:
    quality: MeasurementQuality
    reason: str | None
    value: float | None  # canonical value (None if it could not be converted)
    unit: str | None  # canonical unit

    @property
    def stored_for_analytics(self) -> bool:
        return self.quality == MeasurementQuality.VALID


def _rejected(reason: str, value: float | None = None, unit: str | None = None) -> ValidationResult:
    return ValidationResult(MeasurementQuality.REJECTED, reason, value, unit)


def validate_reading(
    reading: RawReading,
    catalog: IndicatorCatalog,
    *,
    now: datetime,
    backfill: bool = False,
    previous: PreviousValid | None = None,
    sigma: float | None = None,
) -> ValidationResult:
    """Validate one reading. `sigma` is the personal baseline spread (falls back to the
    indicator's sigmaFloor until baselines exist)."""
    if reading.indicator not in catalog:
        return _rejected("unknown_indicator")
    indicator = catalog.get(reading.indicator)

    if reading.indicator == "radiation_dose":
        if reading.channel is not None and reading.channel not in RADIATION_CHANNELS:
            return _rejected("unknown_channel")
    elif reading.channel is not None:
        return _rejected("channel_not_allowed")

    try:
        value = catalog.to_canonical(reading.indicator, reading.value, reading.unit)
    except IndicatorError:
        return _rejected("unknown_unit")
    unit = indicator.unit

    if reading.measured_at.tzinfo is None:
        return _rejected("timestamp_without_timezone", value, unit)
    if reading.measured_at > now + FUTURE_TOLERANCE:
        return _rejected("future_timestamp", value, unit)
    questionable: str | None = None
    if not backfill and reading.measured_at < now - LATE_ARRIVAL:
        questionable = "late_arrival"

    if not indicator.plausible.min <= value <= indicator.plausible.max:
        return _rejected("implausible", value, unit)

    if questionable is None and (
        reading.motion_artifact
        or (reading.signal_quality is not None and reading.signal_quality < MIN_SIGNAL_QUALITY)
    ):
        questionable = "low_signal"

    if (
        questionable is None
        and previous is not None
        and reading.indicator in JUMP_CHECK_INDICATORS
        and timedelta(0) <= reading.measured_at - previous.measured_at <= JUMP_WINDOW
    ):
        spread = max(sigma or 0.0, indicator.sigma_floor or 0.0)
        if spread > 0 and abs(value - previous.value) / spread > JUMP_SIGMAS:
            questionable = "sudden_jump"

    if questionable:
        return ValidationResult(MeasurementQuality.QUESTIONABLE, questionable, value, unit)
    return ValidationResult(MeasurementQuality.VALID, None, value, unit)


def check_panels(items: Sequence[tuple[RawReading, ValidationResult]]) -> list[ValidationResult]:
    """Cross-field checks for readings that share a panel_id (e.g. one blood-pressure cuff reading)."""
    results = [result for _, result in items]
    panels: dict[str, dict[str, int]] = defaultdict(dict)
    for index, (reading, _) in enumerate(items):
        if reading.panel_id:
            panels[reading.panel_id][reading.indicator] = index
    for members in panels.values():
        sys_i, dia_i = members.get("bp_sys"), members.get("bp_dia")
        if sys_i is None or dia_i is None:
            continue
        sys_v, dia_v = results[sys_i].value, results[dia_i].value
        if sys_v is not None and dia_v is not None and sys_v <= dia_v:
            for i in (sys_i, dia_i):
                results[i] = replace(results[i], quality=MeasurementQuality.REJECTED, reason="bp_inconsistent")
    return results
