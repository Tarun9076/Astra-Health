"""The real protocol files load, and broken files are reported clearly (T-R-07)."""

import json
from pathlib import Path
from typing import Any

import pytest

from astra.core.enums import Severity
from astra.core.errors import ProtocolError
from astra.core.protocols import ProtocolBundle, load_protocol_bundle


def test_real_protocols_load_with_expected_counts(bundle: ProtocolBundle) -> None:
    counts = bundle.counts()
    assert (counts.indicators, counts.rules, counts.recommendations) == (22, 16, 21)
    assert (counts.emergency_protocols, counts.mission_profiles) == (8, 1)


def test_starter_rules_and_severities(bundle: ProtocolBundle) -> None:
    severities = {r.id: r.severity_level for r in bundle.rules}
    urgent = {rid for rid, s in severities.items() if s == Severity.URGENT}
    assert urgent == {
        "TH-FEVER-HIGH",
        "RAD-SPE-EVENT",
        "CV-BP-CRITICAL",
        "RS-SPO2-CRITICAL",
        "MET-GLUCOSE-LOW",
    }
    assert len(severities) == 16 and severities["BEH-FATIGUE-COMPOSITE"] == Severity.ATTENTION


def test_urgent_rules_link_an_emergency_protocol(bundle: ProtocolBundle) -> None:
    for rule in bundle.rules:
        if rule.severity == "Urgent":
            assert rule.protocol in bundle.emergency_protocols, rule.id


def test_fatigue_rule_combines_sleep_heart_rate_and_wellbeing(bundle: ProtocolBundle) -> None:
    rule = next(r for r in bundle.rules if r.id == "BEH-FATIGUE-COMPOSITE")
    assert {leaf.indicator for leaf in rule.leaves()} == {"sleep_hours", "resting_hr", "fatigue", "mood"}


def test_mars_profile(bundle: ProtocolBundle) -> None:
    mars = bundle.mission_profiles["mars-surface"]
    assert mars.gravity_g == 0.38
    assert mars.radiation_limit_msv == 600


# --- Broken files: each case edits one rule in a copy of protocols/ -------------------------------


def _edit_rule(root: Path, rule_id: str, change: dict[str, Any]) -> None:
    path = root / "rules" / f"{rule_id}.json"
    rule = json.loads(path.read_text(encoding="utf-8"))
    rule.update(change)
    path.write_text(json.dumps(rule), encoding="utf-8")


def _problems(root: Path) -> str:
    with pytest.raises(ProtocolError) as exc_info:
        load_protocol_bundle(root)
    return "\n".join(exc_info.value.problems)


LEAF = {"indicator": "body_temp", "agg": "latest", "window": "1d", "op": "gte", "value": 38.0}


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"when": {**LEAF, "indicator": "temp"}}, "unknown indicator 'temp'"),
        ({"when": {**LEAF, "op": "greater"}}, "when.leaf.op"),
        ({"when": {**LEAF, "op": "between"}}, "needs value2 greater than value"),
        ({"when": {**LEAF, "window": "4 days"}}, "when.leaf.window"),
        ({"when": {**LEAF, "indicator": "radiation_dose", "op": "z_gte"}}, "has no personal baseline"),
        (
            {"when": {**LEAF, "op": "insight"}, "severity": "Urgent", "protocol": "EMG-FEVER"},
            "Urgent rules may not depend on ML insights",
        ),
        ({"when": {"all": [LEAF, LEAF]}}, "evidence key used twice: body_temp"),
        ({"recommendations": ["REC-DOES-NOT-EXIST"]}, "unknown recommendation 'REC-DOES-NOT-EXIST'"),
        ({"protocol": "EMG-NOPE"}, "unknown emergency protocol 'EMG-NOPE'"),
        ({"reasonTemplate": "Temp {temperature.value:.1f}"}, "no evidence key 'temperature'"),
        ({"reasonTemplate": "Temp {body_temp.mean:.1f}"}, "attribute must be one of"),
        ({"reasonTemplate": "Temp {body_temp.value:.1q}"}, "format spec ':.1q'"),
        ({"version": "1.0"}, "version: String should match pattern"),
        ({"sigmaFlor": 1}, "sigmaFlor: Extra inputs are not permitted"),
        ({"id": "TH-FEVER-HIGH"}, "duplicate rule id 'TH-FEVER-HIGH'"),
    ],
)
def test_broken_rule_is_reported_with_file_name(
    protocols_copy: Path, change: dict[str, Any], expected: str
) -> None:
    _edit_rule(protocols_copy, "TH-FEVER", change)
    problems = _problems(protocols_copy)
    assert "rules/TH-FEVER.json" in problems
    assert expected in problems


def test_all_problems_are_reported_together(protocols_copy: Path) -> None:
    _edit_rule(protocols_copy, "TH-FEVER", {"recommendations": ["REC-NOPE"]})
    _edit_rule(protocols_copy, "SLP-DEFICIT", {"protocol": "EMG-NOPE"})
    problems = _problems(protocols_copy)
    assert "rules/TH-FEVER.json: unknown recommendation 'REC-NOPE'" in problems
    assert "rules/SLP-DEFICIT.json: unknown emergency protocol 'EMG-NOPE'" in problems


def test_emergency_protocol_without_front_matter_is_rejected(protocols_copy: Path) -> None:
    (protocols_copy / "emergency" / "EMG-SYNCOPE.md").write_text("1. Lie down.\n", encoding="utf-8")
    assert "emergency/EMG-SYNCOPE.md: missing YAML front matter" in _problems(protocols_copy)


def test_catalog_with_duplicate_code_is_rejected(protocols_copy: Path) -> None:
    path = protocols_copy / "indicators.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["indicators"].append(data["indicators"][0])
    path.write_text(json.dumps(data), encoding="utf-8")
    assert "duplicate indicator codes: heart_rate" in _problems(protocols_copy)
