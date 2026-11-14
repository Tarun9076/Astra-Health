from datetime import UTC, datetime, timedelta

from astra.core.enums import MeasurementQuality as Q
from astra.core.ids import uuid7
from astra.core.protocols import ProtocolBundle
from astra.core.validation import PreviousValid, RawReading, check_panels, validate_reading

NOW = datetime(2026, 11, 14, 8, 0, tzinfo=UTC)


def _check(bundle: ProtocolBundle, reading: RawReading, **kwargs: object) -> tuple[Q, str | None]:
    result = validate_reading(reading, bundle.catalog, now=NOW, **kwargs)  # type: ignore[arg-type]
    return result.quality, result.reason


def _r(indicator: str, value: float, unit: str, minutes_ago: float = 5, **kw: object) -> RawReading:
    return RawReading(indicator, value, unit, NOW - timedelta(minutes=minutes_ago), **kw)  # type: ignore[arg-type]


def test_valid_reading_is_converted_to_canonical_unit(bundle: ProtocolBundle) -> None:
    result = validate_reading(_r("glucose", 5.5, "mmol/L"), bundle.catalog, now=NOW)
    assert (result.quality, result.value, result.unit) == (Q.VALID, 99.1, "mg/dL")


def test_implausible_heart_rate_is_rejected(bundle: ProtocolBundle) -> None:
    # T-V-03
    assert _check(bundle, _r("heart_rate", 300, "bpm")) == (Q.REJECTED, "implausible")


def test_unknown_indicator_and_unit_are_rejected(bundle: ProtocolBundle) -> None:
    assert _check(bundle, _r("pulse", 70, "bpm")) == (Q.REJECTED, "unknown_indicator")
    assert _check(bundle, _r("glucose", 1, "g/L")) == (Q.REJECTED, "unknown_unit")


def test_future_timestamp_is_rejected(bundle: ProtocolBundle) -> None:
    assert _check(bundle, _r("heart_rate", 70, "bpm", minutes_ago=-30)) == (Q.REJECTED, "future_timestamp")
    assert _check(bundle, _r("heart_rate", 70, "bpm", minutes_ago=-3))[0] == Q.VALID  # clock skew allowed


def test_old_reading_is_questionable_unless_backfill(bundle: ProtocolBundle) -> None:
    old = _r("heart_rate", 70, "bpm", minutes_ago=60 * 24 * 40)
    assert _check(bundle, old) == (Q.QUESTIONABLE, "late_arrival")
    assert _check(bundle, old, backfill=True) == (Q.VALID, None)


def test_low_signal_or_motion_is_questionable(bundle: ProtocolBundle) -> None:
    assert _check(bundle, _r("heart_rate", 190, "bpm", signal_quality=0.3)) == (Q.QUESTIONABLE, "low_signal")
    assert _check(bundle, _r("heart_rate", 70, "bpm", motion_artifact=True)) == (Q.QUESTIONABLE, "low_signal")


def test_sudden_jump_within_ten_minutes_is_questionable(bundle: ProtocolBundle) -> None:
    previous = PreviousValid(value=70, measured_at=NOW - timedelta(minutes=10))
    assert _check(bundle, _r("heart_rate", 95, "bpm"), previous=previous) == (Q.QUESTIONABLE, "sudden_jump")
    assert _check(bundle, _r("heart_rate", 80, "bpm"), previous=previous) == (Q.VALID, None)
    long_ago = PreviousValid(value=70, measured_at=NOW - timedelta(hours=2))
    assert _check(bundle, _r("heart_rate", 95, "bpm"), previous=long_ago) == (Q.VALID, None)


def test_radiation_channels(bundle: ProtocolBundle) -> None:
    assert _check(bundle, _r("radiation_dose", 0.2, "mSv", channel="Neutron")) == (Q.VALID, None)
    assert _check(bundle, _r("radiation_dose", 0.2, "mSv", channel="Gamma")) == (
        Q.REJECTED,
        "unknown_channel",
    )
    assert _check(bundle, _r("heart_rate", 70, "bpm", channel="Total")) == (Q.REJECTED, "channel_not_allowed")


def test_inconsistent_blood_pressure_panel_rejects_both(bundle: ProtocolBundle) -> None:
    # T-V-05: 80/95 mmHg
    items = [_r("bp_sys", 80, "mmHg", panel_id="P1"), _r("bp_dia", 95, "mmHg", panel_id="P1")]
    pairs = [(r, validate_reading(r, bundle.catalog, now=NOW)) for r in items]
    assert [(res.quality, res.reason) for res in check_panels(pairs)] == [(Q.REJECTED, "bp_inconsistent")] * 2


def test_consistent_blood_pressure_panel_is_valid(bundle: ProtocolBundle) -> None:
    items = [_r("bp_sys", 118, "mmHg", panel_id="P2"), _r("bp_dia", 76, "mmHg", panel_id="P2")]
    pairs = [(r, validate_reading(r, bundle.catalog, now=NOW)) for r in items]
    assert all(res.quality == Q.VALID for res in check_panels(pairs))


def test_uuid7_is_time_ordered_and_deterministic_with_entropy() -> None:
    a, b = uuid7(1_000), uuid7(2_000)
    assert a.version == 7 and str(a) < str(b)
    assert uuid7(5_000, b"same-input") == uuid7(5_000, b"same-input")
