"""Exercise coach plan and summary (Step 13): T-EX-01, T-EX-02."""

import json
from pathlib import Path

import pytest

from astra.core.errors import ProtocolError
from astra.core.exercise import ExerciseResult, OpenAlert, SetResult, form_score, plan_for, session_summary
from astra.core.protocols import ProtocolBundle, load_protocol_bundle


def _plan(bundle: ProtocolBundle, *alerts: tuple[str, str]) -> tuple[str, list[tuple[str, int]], int]:
    assert bundle.exercise is not None
    plan = plan_for(bundle.exercise, [OpenAlert(rule, severity, rule) for rule, severity in alerts])
    return plan.level, [(i.exercise.id, i.sets) for i in plan.items], plan.rest_seconds


def test_plan_follows_the_astronauts_condition(bundle: ProtocolBundle) -> None:
    assert _plan(bundle) == ("standard", [("squat", 3), ("deadlift", 3), ("heel_raise", 3)], 90)
    assert _plan(bundle, ("BEH-FATIGUE-COMPOSITE", "Attention")) == (
        "lighter", [("squat", 2), ("deadlift", 2), ("heel_raise", 2)], 120,
    )  # fmt: skip
    assert _plan(bundle, ("MSK-STRENGTH-DECLINE", "Attention")) == (
        "more", [("squat", 4), ("deadlift", 4), ("heel_raise", 3)], 90,
    )  # fmt: skip
    # tired and losing strength: the changes add up, and the longer rest is kept
    assert _plan(bundle, ("MSK-EXERCISE-ADHERENCE", "Attention"), ("SLP-DEFICIT", "Attention")) == (
        "adjusted", [("squat", 3), ("deadlift", 3), ("heel_raise", 2)], 120,
    )  # fmt: skip


@pytest.mark.parametrize(
    ("alerts", "adjustment"),
    [
        ([("TH-FEVER", "Attention"), ("MSK-STRENGTH-DECLINE", "Attention")], "rest-fever"),
        ([("CV-BP-CRITICAL", "Urgent")], "rest-urgent"),
    ],
)
def test_fever_or_an_urgent_alert_means_a_rest_day(
    bundle: ProtocolBundle, alerts: list[tuple[str, str]], adjustment: str
) -> None:
    assert bundle.exercise is not None
    plan = plan_for(bundle.exercise, [OpenAlert(r, s, f"{r} title") for r, s in alerts])
    assert plan.rest_day and plan.items == ()
    assert [a.id for a in plan.adjustments] == [adjustment]
    assert plan.adjustments[0].because == (f"{alerts[0][0]} title",)


def test_summary_counts_reps_form_and_the_most_frequent_tip() -> None:
    results = [
        ExerciseResult("squat", "Squat", (SetResult(10, 10, 90), SetResult(8, 10, 70)),
                       (("Keep your chest up", 3), ("Go a little lower", 1))),
        ExerciseResult("heel_raise", "Heel raise", (SetResult(15, 15, 100),), ()),
    ]  # fmt: skip
    assert form_score(results) == round((90 * 10 + 70 * 8 + 100 * 15) / 33)
    text = session_summary(results, 12.4)
    assert text.startswith("2 exercises, 3 sets, 33 reps in 12 min (33 of 35 planned).")
    assert "Form 90% (very good)" in text and "“Keep your chest up” (3× in squat)" in text
    assert session_summary([ExerciseResult("squat", "Squat", (SetResult(0, 10, None),), ())], 1) == (
        "No repetitions were counted in this session."
    )


def test_exercise_plan_must_name_real_rules_and_exercises(protocols_copy: Path) -> None:
    path = protocols_copy / "exercise-plans.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["adjustments"][0]["whenAlerts"] = ["TH-FEVR"]
    data["adjustments"][3]["extraSets"] = {"bench": 1}
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ProtocolError) as exc_info:
        load_protocol_bundle(protocols_copy)
    problems = "\n".join(exc_info.value.problems)
    assert "unknown rule 'TH-FEVR'" in problems and "unknown exercise 'bench'" in problems
