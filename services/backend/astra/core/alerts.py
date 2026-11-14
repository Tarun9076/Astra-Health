"""Alert lifecycle rules (LLD §7). Pure: the alert service applies them to database rows.

Open ──astronaut acknowledges──▶ Acknowledged ──surgeon──▶ InReview ──surgeon──▶ Resolved
  │                                  │                         └──surgeon──▶ Dismissed (false alarm)
  ├──surgeon──▶ InReview             └──system: auto-resolve (Attention only)──▶ Resolved
  └──surgeon──▶ Dismissed
"""

from datetime import datetime, timedelta
from typing import Literal

from astra.core.enums import ALERT_STATUS_RANK, AlertStatus, Role, Severity

Actor = Role | Literal["system"]

ACTIVE_STATUSES: frozenset[AlertStatus] = frozenset(
    {AlertStatus.OPEN, AlertStatus.ACKNOWLEDGED, AlertStatus.IN_REVIEW}
)

TRANSITIONS: dict[AlertStatus, dict[AlertStatus, frozenset[Actor]]] = {
    AlertStatus.OPEN: {
        AlertStatus.ACKNOWLEDGED: frozenset({Role.ASTRONAUT}),
        AlertStatus.IN_REVIEW: frozenset({Role.FLIGHT_SURGEON}),
        AlertStatus.DISMISSED: frozenset({Role.FLIGHT_SURGEON}),
    },
    AlertStatus.ACKNOWLEDGED: {
        AlertStatus.IN_REVIEW: frozenset({Role.FLIGHT_SURGEON}),
        AlertStatus.RESOLVED: frozenset({"system"}),
    },
    AlertStatus.IN_REVIEW: {
        AlertStatus.RESOLVED: frozenset({Role.FLIGHT_SURGEON}),
        AlertStatus.DISMISSED: frozenset({Role.FLIGHT_SURGEON}),
    },
    AlertStatus.RESOLVED: {},
    AlertStatus.DISMISSED: {},
}

NOTE_REQUIRED: frozenset[AlertStatus] = frozenset({AlertStatus.RESOLVED, AlertStatus.DISMISSED})
AUTO_RESOLVE_CLEAR_EVALUATIONS = 3
AUTO_RESOLVE_QUIET_PERIOD = timedelta(hours=24)


class TransitionError(ValueError):
    pass


def check_transition(
    current: AlertStatus, target: AlertStatus, actor: Actor, note: str | None = None
) -> None:
    allowed = TRANSITIONS[current].get(target)
    if allowed is None:
        raise TransitionError(f"An alert can't go from {current.value} to {target.value}")
    if actor not in allowed:
        who = actor if isinstance(actor, str) else actor.value
        raise TransitionError(f"{who} can't move an alert from {current.value} to {target.value}")
    if target in NOTE_REQUIRED and actor != "system" and not (note and note.strip()):
        raise TransitionError(f"A note is required to mark an alert {target.value}")


def needs_escalation(severity: Severity, trigger_count: int, when_trigger_count_gte: int | None) -> bool:
    """Urgent always escalates; Attention escalates once it has re-triggered often enough."""
    if severity == Severity.URGENT:
        return True
    return when_trigger_count_gte is not None and trigger_count >= when_trigger_count_gte


def can_auto_resolve(
    status: AlertStatus,
    severity: Severity,
    consecutive_clear: int,
    last_triggered_at: datetime,
    now: datetime,
) -> bool:
    """Only acknowledged Attention alerts whose condition has stayed clear. Urgent alerts never
    auto-resolve: a flight surgeon must close them (T-A-02)."""
    return (
        status == AlertStatus.ACKNOWLEDGED
        and severity == Severity.ATTENTION
        and consecutive_clear >= AUTO_RESOLVE_CLEAR_EVALUATIONS
        and now - last_triggered_at >= AUTO_RESOLVE_QUIET_PERIOD
    )


def merge_status(a: AlertStatus, b: AlertStatus) -> AlertStatus:
    """When Habitat and Ground disagree after sync, the further-along state wins (T-A-03)."""
    return b if ALERT_STATUS_RANK[b] > ALERT_STATUS_RANK[a] else a
