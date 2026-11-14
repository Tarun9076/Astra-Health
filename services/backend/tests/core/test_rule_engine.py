"""Rule engine against the real starter rules, with an in-memory context (T-R-01..05)."""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

import pytest

from astra.core.baselines import Baseline
from astra.core.protocols import ProtocolBundle
from astra.core.rules.engine import Point, RuleOutcome, evaluate, window_points
from astra.core.rules.models import Rule

AS_OF = datetime(2026, 11, 13, 23, 59, tzinfo=UTC)


def _base(indicator: str, median: float, sigma: float) -> Baseline:
    return Baseline(indicator, median, sigma / 1.4826, sigma, 28, "Rolling", False)


@dataclass
class MemoryContext:
    data: dict[str, list[float]]  # one value per day, oldest first, last value = AS_OF's day
    baselines: dict[str, Baseline] = field(default_factory=dict)
    as_of: datetime = AS_OF
    mission_start: date | None = date(2026, 7, 17)
    limits: dict[str, float] = field(default_factory=dict)
    insights: dict[str, float] = field(default_factory=dict)  # kind -> best score in the window

    def points(self, indicator: str) -> Sequence[Point]:
        values = self.data.get(indicator, [])
        n = len(values)
        return [
            Point(self.as_of.replace(hour=7, minute=0) - timedelta(days=n - 1 - i), v)
            for i, v in enumerate(values)
        ]

    def baseline(self, indicator: str) -> Baseline | None:
        return self.baselines.get(indicator)

    def limit(self, indicator: str) -> float | None:
        return self.limits.get(indicator)

    def insight_score(self, kind: str, since: datetime) -> float | None:
        return self.insights.get(kind)


def _run(bundle: ProtocolBundle, rule_id: str, ctx: MemoryContext) -> RuleOutcome:
    rule: Rule = next(r for r in bundle.rules if r.id == rule_id)
    (outcome,) = evaluate([rule], ctx)
    return outcome


RHR = {"resting_hr": _base("resting_hr", 64, 3)}


def test_single_raised_heart_rate_is_not_enough(bundle: ProtocolBundle) -> None:
    # T-R-01: z = 2.5 once → no alert (needs 2 of the last 3 readings)
    outcome = _run(bundle, "CV-RHR-BASELINE", MemoryContext({"resting_hr": [64, 64, 71.5]}, RHR))
    assert not outcome.matched
    assert outcome.evidence["resting_hr"].z == 2.5
    assert outcome.evidence["resting_hr_repeats"].value == 1


def test_two_of_last_three_raised_triggers_alert(bundle: ProtocolBundle) -> None:
    # T-R-02
    outcome = _run(bundle, "CV-RHR-BASELINE", MemoryContext({"resting_hr": [64, 71, 72]}, RHR))
    assert outcome.matched
    assert outcome.reason.startswith("Resting heart rate is 72 bpm against your normal of 64 bpm (+2.7σ)")


def test_same_heart_rate_means_different_things_for_different_people(bundle: ProtocolBundle) -> None:
    # T-R-03: 85 bpm twice — normal for someone at 82, abnormal for someone at 55
    a = MemoryContext({"resting_hr": [82, 85, 85]}, {"resting_hr": _base("resting_hr", 82, 3)})
    b = MemoryContext({"resting_hr": [55, 85, 85]}, {"resting_hr": _base("resting_hr", 55, 2.5)})
    assert not _run(bundle, "CV-RHR-BASELINE", a).matched
    assert _run(bundle, "CV-RHR-BASELINE", b).matched


def test_high_fever_is_urgent_and_also_trips_fever(bundle: ProtocolBundle) -> None:
    # T-R-05
    ctx = MemoryContext({"body_temp": [36.7, 39.6]}, {"body_temp": _base("body_temp", 36.7, 0.15)})
    high = _run(bundle, "TH-FEVER-HIGH", ctx)
    assert high.matched and high.rule.severity == "Urgent"
    assert "39.6 °C" in high.reason
    assert _run(bundle, "TH-FEVER", ctx).matched


def test_low_temperature_is_urgent_too(bundle: ProtocolBundle) -> None:
    assert _run(bundle, "TH-FEVER-HIGH", MemoryContext({"body_temp": [34.8]})).matched


def test_fatigue_composite_explains_every_value(bundle: ProtocolBundle) -> None:
    ctx = MemoryContext(
        {
            "sleep_hours": [6.5, 5.0, 4.6, 4.3, 4.1],
            "resting_hr": [64, 80, 86],
            "fatigue": [3, 7, 8],
            "mood": [7, 4, 4],
        },
        {"sleep_hours": _base("sleep_hours", 6.5, 0.5), "resting_hr": _base("resting_hr", 64, 3)},
    )
    outcome = _run(bundle, "BEH-FATIGUE-COMPOSITE", ctx)
    assert outcome.matched
    assert outcome.reason == (
        "Sleep has averaged 4.5 h over 4 days (your normal 6.5 h), resting heart rate is 86 bpm "
        "(your normal 64), and fatigue was rated 8/10."
    )
    assert set(outcome.evidence) == {"sleep_hours", "resting_hr", "fatigue", "mood"}  # all evaluated


def test_fatigue_composite_needs_every_part(bundle: ProtocolBundle) -> None:
    ctx = MemoryContext(
        {"sleep_hours": [6.5, 5.0, 4.6, 4.3, 4.1], "resting_hr": [64, 64, 65], "fatigue": [8], "mood": [3]},
        {"sleep_hours": _base("sleep_hours", 6.5, 0.5), "resting_hr": _base("resting_hr", 64, 3)},
    )
    assert not _run(bundle, "BEH-FATIGUE-COMPOSITE", ctx).matched  # heart rate is normal


def test_solar_particle_event_uses_ratio_to_normal(bundle: ProtocolBundle) -> None:
    ctx = MemoryContext(
        {"radiation_dose": [0.64, 19.2]}, {"radiation_dose": _base("radiation_dose", 0.64, 0.03)}
    )
    outcome = _run(bundle, "RAD-SPE-EVENT", ctx)
    assert outcome.matched and outcome.rule.protocol == "EMG-RADIATION-SHELTER"
    assert "about 30× the habitat's normal of 0.64 mSv/day" in outcome.reason


def test_missing_data_or_baseline_never_matches(bundle: ProtocolBundle) -> None:
    no_data = _run(bundle, "CV-RHR-BASELINE", MemoryContext({}, RHR))
    no_baseline = _run(bundle, "CV-RHR-BASELINE", MemoryContext({"resting_hr": [90, 95, 99]}))
    assert not no_data.matched and no_data.evidence["resting_hr"].missing
    assert not no_baseline.matched and no_baseline.evidence["resting_hr"].missing


def test_sleep_deficit_any_branch(bundle: ProtocolBundle) -> None:
    # absolute branch (< 5.5 h) fires even when the baseline is low too
    ctx = MemoryContext(
        {"sleep_hours": [5.2, 5.3, 5.1, 5.0]}, {"sleep_hours": _base("sleep_hours", 5.4, 0.5)}
    )
    outcome = _run(bundle, "SLP-DEFICIT", ctx)
    assert outcome.matched and not outcome.evidence["sleep_vs_normal"].missing
    assert "averaged 5.2 h" in outcome.reason


def test_windows() -> None:
    pts = [Point(AS_OF - timedelta(days=d), float(d)) for d in (5, 4, 3, 2, 1, 0)]
    assert [p.value for p in window_points(pts, "3r", AS_OF, None)] == [2, 1, 0]
    assert [p.value for p in window_points(pts, "2d", AS_OF, None)] == [1, 0]
    assert [p.value for p in window_points(pts, "3r", AS_OF - timedelta(days=2), None)] == [4, 3, 2]


# --- Step 5 rules: one case that must fire and one that must not, per rule -------------------------

BP = {"bp_sys": _base("bp_sys", 116, 5), "bp_dia": _base("bp_dia", 74, 4)}
STEP5_CASES = [
    ("CV-BP-HIGH", {"bp_sys": [138, 142, 145], "bp_dia": [80, 82, 84]}, BP, True),
    ("CV-BP-HIGH", {"bp_sys": [118, 120, 125], "bp_dia": [76, 78, 80]}, BP, False),
    ("CV-BP-CRITICAL", {"bp_sys": [150, 185, 190], "bp_dia": [90, 100, 104]}, BP, True),
    ("CV-BP-CRITICAL", {"bp_sys": [150, 120, 190], "bp_dia": [90, 80, 104]}, BP, False),  # not repeated
    ("RS-SPO2-LOW", {"spo2": [97, 93, 94]}, {"spo2": _base("spo2", 98, 0.7)}, True),
    ("RS-SPO2-LOW", {"spo2": [93, 97, 94]}, {"spo2": _base("spo2", 98, 0.7)}, False),
    ("RS-SPO2-CRITICAL", {"spo2": [96, 89, 88]}, {}, True),
    ("RS-SPO2-CRITICAL", {"spo2": [89, 92]}, {}, False),
    ("MET-GLUCOSE-LOW", {"glucose": [90, 50]}, {}, True),
    ("MET-GLUCOSE-LOW", {"glucose": [50, 60]}, {}, False),
    ("MET-GLUCOSE-OUT", {"glucose": [92, 66, 64]}, {"glucose": _base("glucose", 92, 8)}, True),
    ("MET-GLUCOSE-OUT", {"glucose": [190, 195]}, {"glucose": _base("glucose", 92, 8)}, True),
    (
        "MET-GLUCOSE-OUT",
        {"glucose": [92, 69]},
        {"glucose": _base("glucose", 92, 8)},
        False,
    ),  # single low reading
    ("MSK-EXERCISE-ADHERENCE", {"exercise_sessions": [5, 3]}, {}, True),
    ("MSK-EXERCISE-ADHERENCE", {"exercise_sessions": [3, 5]}, {}, False),
    (
        "MSK-STRENGTH-DECLINE",
        {"strength_index": [100 - 0.5 * d for d in range(28)]},
        {"strength_index": _base("strength_index", 99, 3)},
        True,
    ),
    (
        "MSK-STRENGTH-DECLINE",
        {"strength_index": [100.0] * 28},
        {"strength_index": _base("strength_index", 100, 3)},
        False,
    ),
    ("RAD-CUMULATIVE", {"radiation_dose": [3.0] * 120}, {}, True),  # 360 mSv = 60 % of 600
    ("RAD-CUMULATIVE", {"radiation_dose": [0.64] * 120}, {}, False),
    ("IMM-STRESS-FEVER", {"stress": [7, 8, 8, 7, 8], "body_temp": [36.7, 37.6]}, {}, True),
    ("IMM-STRESS-FEVER", {"stress": [7, 8, 8, 7, 8], "body_temp": [36.7, 37.0]}, {}, False),
]

STEP10_CASES = [
    ("ENV-CO2-HIGH", {"cabin_co2": [4.4]}, True),
    ("ENV-CO2-HIGH", {"cabin_co2": [2.7]}, False),
    ("ENV-HEAT-HYDRATION", {"cabin_temp": [28.0], "hydration_ml": [1500], "fatigue": [7]}, True),
    (
        "ENV-HEAT-HYDRATION",
        {"cabin_temp": [28.0], "hydration_ml": [2600], "fatigue": [7]},
        False,
    ),  # drinking enough
]


@pytest.mark.parametrize(("rule_id", "data", "expected"), STEP10_CASES)
def test_environment_rules(
    bundle: ProtocolBundle, rule_id: str, data: dict[str, list[float]], expected: bool
) -> None:
    outcome = _run(bundle, rule_id, MemoryContext(data))
    assert outcome.matched is expected
    if expected:
        assert "n/a" not in outcome.reason, outcome.reason


FATIGUE_DAY = {"resting_hr": [64, 64, 75], "fatigue": [3, 3, 8], "sleep_hours": [7, 5, 5]}
FATIGUE_BASE = {
    "resting_hr": _base("resting_hr", 64, 3),
    "fatigue": _base("fatigue", 3, 1),
    "sleep_hours": _base("sleep_hours", 7, 0.4),
}
ML_CASES = [
    # ML alone never alerts: the anomaly score and the strain trend must agree AND a reading must confirm
    ({"Anomaly": 0.63, "Trend": 1.7}, FATIGUE_DAY, True),
    ({"Anomaly": 0.63}, FATIGUE_DAY, False),  # no trend
    ({"Anomaly": 0.55, "Trend": 1.7}, FATIGUE_DAY, False),  # score below 0.6
    (
        {"Anomaly": 0.9, "Trend": 2.5},
        {"resting_hr": [64, 64, 65], "fatigue": [3, 3, 3]},
        False,
    ),  # unconfirmed
]


@pytest.mark.parametrize(("insights", "data", "expected"), ML_CASES)
def test_ml_anomaly_needs_trend_and_a_confirming_reading(
    bundle: ProtocolBundle, insights: dict[str, float], data: dict[str, list[float]], expected: bool
) -> None:
    outcome = _run(bundle, "ML-ANOMALY-CORROBORATED", MemoryContext(data, FATIGUE_BASE, insights=insights))
    assert outcome.matched is expected
    if expected:
        assert outcome.evidence["anomaly"].value == 0.63 and "0.63" in outcome.reason
        assert outcome.rule.severity == "Attention"


@pytest.mark.parametrize(("rule_id", "data", "baselines", "expected"), STEP5_CASES)
def test_step5_rules(
    bundle: ProtocolBundle,
    rule_id: str,
    data: dict[str, list[float]],
    baselines: dict[str, Baseline],
    expected: bool,
) -> None:
    ctx = MemoryContext(data, baselines, limits={"radiation_dose": 600})
    outcome = _run(bundle, rule_id, ctx)
    assert outcome.matched is expected
    if expected:
        assert "n/a" not in outcome.reason or rule_id == "MSK-STRENGTH-DECLINE", outcome.reason
