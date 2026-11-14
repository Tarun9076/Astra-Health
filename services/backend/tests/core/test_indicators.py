import pytest

from astra.core.indicators import IndicatorError, round_half_up
from astra.core.protocols import ProtocolBundle


def test_catalog_has_all_indicators(bundle: ProtocolBundle) -> None:
    catalog = bundle.catalog
    assert len(catalog) == 22
    for code in (
        "heart_rate",
        "resting_hr",
        "bp_sys",
        "body_temp",
        "glucose",
        "spo2",
        "sleep_hours",
        "mood",
        "stress",
        "fatigue",
        "activity_min",
        "radiation_dose",
        "cabin_co2",
    ):
        assert code in catalog


def test_glucose_mmol_converts_to_mg_dl(bundle: ProtocolBundle) -> None:
    # T-V-01
    assert bundle.catalog.to_canonical("glucose", 5.5, "mmol/L") == 99.1


def test_fahrenheit_converts_to_celsius(bundle: ProtocolBundle) -> None:
    # T-V-02
    assert bundle.catalog.to_canonical("body_temp", 98.6, "°F") == 37.0
    assert bundle.catalog.to_canonical("body_temp", 98.6, "f") == 37.0  # unit lookup ignores case


@pytest.mark.parametrize(
    ("code", "value", "unit", "expected"),
    [
        ("bp_sys", 16.0, "kPa", 120.0),
        ("sleep_hours", 390, "min", 6.5),
        ("body_weight", 154.3, "lb", 70.0),
        ("hydration_ml", 2.5, "L", 2500.0),
        ("radiation_dose", 640, "uSv", 0.64),
        ("cabin_co2", 1316, "ppm", 1.0),
        ("heart_rate", 72, "bpm", 72.0),
    ],
)
def test_unit_conversions(
    bundle: ProtocolBundle, code: str, value: float, unit: str, expected: float
) -> None:
    assert bundle.catalog.to_canonical(code, value, unit) == expected


def test_unknown_unit_is_rejected_with_accepted_list(bundle: ProtocolBundle) -> None:
    with pytest.raises(IndicatorError, match="accepted: mg/dL, mmol/L"):
        bundle.catalog.to_canonical("glucose", 5.5, "g/L")


def test_unknown_indicator_is_rejected(bundle: ProtocolBundle) -> None:
    with pytest.raises(IndicatorError, match="unknown indicator 'pulse'"):
        bundle.catalog.to_canonical("pulse", 70, "bpm")


def test_rounding_is_half_up_not_bankers() -> None:
    assert round_half_up(37.05, 1) == 37.1
    assert round_half_up(2.5, 0) == 3.0


def test_baseline_indicators_have_spread_floors(bundle: ProtocolBundle) -> None:
    assert bundle.catalog.get("resting_hr").has_baseline
    assert not bundle.catalog.get("radiation_dose").has_baseline  # absolute rules only
