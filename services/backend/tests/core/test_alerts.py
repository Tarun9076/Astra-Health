from datetime import UTC, datetime, timedelta

import pytest

from astra.core.alerts import (
    TransitionError,
    can_auto_resolve,
    check_transition,
    merge_status,
    needs_escalation,
)
from astra.core.enums import AlertStatus as S
from astra.core.enums import Role, Severity

NOW = datetime(2026, 11, 14, 8, tzinfo=UTC)


def test_astronaut_acknowledges_surgeon_reviews_and_resolves() -> None:
    check_transition(S.OPEN, S.ACKNOWLEDGED, Role.ASTRONAUT)
    check_transition(S.ACKNOWLEDGED, S.IN_REVIEW, Role.FLIGHT_SURGEON)
    check_transition(S.IN_REVIEW, S.RESOLVED, Role.FLIGHT_SURGEON, note="Recheck normal")


@pytest.mark.parametrize(
    ("current", "target", "actor", "message"),
    [
        (S.OPEN, S.RESOLVED, Role.FLIGHT_SURGEON, "can't go from Open to Resolved"),
        (S.OPEN, S.IN_REVIEW, Role.ASTRONAUT, "Astronaut can't move"),
        (S.OPEN, S.ACKNOWLEDGED, Role.MISSION_CONTROL, "MissionControl can't move"),
        (S.RESOLVED, S.OPEN, Role.FLIGHT_SURGEON, "can't go from Resolved"),
        (S.IN_REVIEW, S.DISMISSED, Role.FLIGHT_SURGEON, "note is required"),
    ],
)
def test_forbidden_transitions(current: S, target: S, actor: Role, message: str) -> None:
    with pytest.raises(TransitionError, match=message):
        check_transition(current, target, actor)


def test_escalation() -> None:
    # T-A-01: Attention escalates after enough re-triggers; Urgent always
    assert not needs_escalation(Severity.ATTENTION, 2, 3)
    assert needs_escalation(Severity.ATTENTION, 3, 3)
    assert needs_escalation(Severity.URGENT, 1, None)


def test_urgent_alerts_never_auto_resolve() -> None:
    # T-A-02
    long_ago = NOW - timedelta(days=3)
    assert can_auto_resolve(S.ACKNOWLEDGED, Severity.ATTENTION, 3, long_ago, NOW)
    assert not can_auto_resolve(S.ACKNOWLEDGED, Severity.URGENT, 10, long_ago, NOW)
    assert not can_auto_resolve(S.OPEN, Severity.ATTENTION, 10, long_ago, NOW)  # nobody has seen it yet
    assert not can_auto_resolve(S.ACKNOWLEDGED, Severity.ATTENTION, 3, NOW - timedelta(hours=2), NOW)


def test_merge_takes_the_further_state() -> None:
    # T-A-03
    assert merge_status(S.ACKNOWLEDGED, S.IN_REVIEW) == S.IN_REVIEW
    assert merge_status(S.IN_REVIEW, S.ACKNOWLEDGED) == S.IN_REVIEW
    assert merge_status(S.RESOLVED, S.OPEN) == S.RESOLVED
