"""Turn rule outcomes into alerts, and move alerts through their lifecycle (LLD §7, §8).

- One active alert per (astronaut, rule): a re-match updates it (trigger count, evidence).
- New alerts create their recommendation tasks, an audit entry and a sync outbox item.
- Attention alerts auto-resolve only when acknowledged and clear for 3 evaluations + 24 h.
"""

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlmodel import Session, col, select

from astra.core.alerts import ACTIVE_STATUSES, Actor, can_auto_resolve, check_transition, needs_escalation
from astra.core.enums import AlertStatus, Severity
from astra.core.ids import uuid7
from astra.core.protocols import ProtocolBundle
from astra.core.rules.engine import RuleOutcome
from astra.db.models import Astronaut, AuditLog, HealthAlert, RecommendationTask, SyncOutbox


@dataclass
class AlertChanges:
    created: list[HealthAlert] = field(default_factory=list)
    updated: list[HealthAlert] = field(default_factory=list)
    resolved: list[HealthAlert] = field(default_factory=list)

    def extend(self, other: "AlertChanges") -> None:
        self.created += other.created
        self.updated += [a for a in other.updated if a not in self.created and a not in self.updated]
        self.resolved += other.resolved


def _queue(session: Session, alert: HealthAlert) -> None:
    urgent = alert.severity == Severity.URGENT.name.title()
    session.add(
        SyncOutbox(
            entity_type="HealthAlert",
            entity_id=alert.id,
            payload_json=alert.model_dump_json(),
            priority=1 if urgent else 3,
        )
    )


def _audit(
    session: Session,
    alert: HealthAlert,
    action: str,
    node_id: str,
    user_id: str | None = None,
    details: dict[str, object] | None = None,
) -> None:
    session.add(
        AuditLog(
            user_id=user_id,
            action=action,
            entity_type="HealthAlert",
            entity_id=alert.id,
            node_id=node_id,
            details=json.dumps({"ruleId": alert.rule_id, "status": alert.status, **(details or {})}),
        )
    )


def _create_tasks(
    session: Session, bundle: ProtocolBundle, alert: HealthAlert, codes: list[str], at: datetime
) -> None:
    pending = set(
        session.exec(
            select(RecommendationTask.code).where(
                RecommendationTask.astronaut_id == alert.astronaut_id, RecommendationTask.status == "Pending"
            )
        ).all()
    )
    for code in codes:
        if code in pending:
            continue
        rec = bundle.recommendations[code]
        due = at + timedelta(hours=rec.due_in_hours) if rec.due_in_hours is not None else None
        session.add(
            RecommendationTask(
                astronaut_id=alert.astronaut_id,
                alert_id=alert.id,
                code=code,
                due_at=due,
                source="Rule",
                created_at=at,
            )
        )


def apply_outcomes(
    session: Session,
    bundle: ProtocolBundle,
    astronaut: Astronaut,
    outcomes: list[RuleOutcome],
    at: datetime,
    *,
    node_id: str,
) -> AlertChanges:
    changes = AlertChanges()
    active = {
        a.rule_id: a
        for a in session.exec(
            select(HealthAlert).where(
                HealthAlert.astronaut_id == astronaut.id,
                col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]),
            )
        ).all()
    }
    now = datetime.now(UTC)
    for outcome in outcomes:
        rule = outcome.rule
        alert = active.get(rule.id)
        if outcome.matched:
            evidence = json.dumps(outcome.evidence_json())
            if alert is None:
                alert = HealthAlert(
                    id=str(uuid7(int(at.timestamp() * 1000))),
                    astronaut_id=astronaut.id,
                    rule_id=rule.id,
                    rule_version=rule.version,
                    category=rule.category.value,
                    hazard=rule.hazard.value,
                    severity=rule.severity,
                    status=AlertStatus.OPEN.value,
                    title=rule.title,
                    reason=outcome.reason,
                    evidence_json=evidence,
                    first_triggered_at=at,
                    last_triggered_at=at,
                    trigger_count=1,
                    escalation_required=needs_escalation(
                        rule.severity_level, 1, rule.escalation.when_trigger_count_gte
                    ),
                    protocol=rule.protocol,
                    origin_node_id=node_id,
                    updated_at=now,
                )
                session.add(alert)
                _create_tasks(session, bundle, alert, rule.recommendations, at)
                _audit(session, alert, "AlertRaised", node_id)
                _queue(session, alert)
                active[rule.id] = alert
                changes.created.append(alert)
            elif at > alert.last_triggered_at:  # re-evaluating the same moment never double-counts
                alert.last_triggered_at = at
                alert.trigger_count += 1
                alert.reason, alert.evidence_json, alert.rule_version = outcome.reason, evidence, rule.version
                alert.consecutive_clear = 0
                alert.escalation_required = needs_escalation(
                    rule.severity_level, alert.trigger_count, rule.escalation.when_trigger_count_gte
                )
                alert.version += 1
                alert.updated_at = now
                session.add(alert)
                _queue(session, alert)
                changes.updated.append(alert)
        elif alert is not None and at > alert.last_triggered_at:
            alert.consecutive_clear += 1
            severity = Severity.URGENT if alert.severity == "Urgent" else Severity.ATTENTION
            if can_auto_resolve(
                AlertStatus(alert.status), severity, alert.consecutive_clear, alert.last_triggered_at, at
            ):
                _set_status(
                    session,
                    alert,
                    AlertStatus.RESOLVED,
                    "system",
                    "Auto-resolved: the condition has been clear for 3 evaluations and 24 hours.",
                    at,
                )
                _audit(session, alert, "AlertAutoResolved", node_id)
                _queue(session, alert)
                changes.resolved.append(alert)
            session.add(alert)
    return changes


def _close_tasks(session: Session, alert: HealthAlert, at: datetime) -> None:
    """Pending tasks raised by an alert close with it (they no longer apply)."""
    for task in session.exec(
        select(RecommendationTask).where(
            RecommendationTask.alert_id == alert.id, RecommendationTask.status == "Pending"
        )
    ).all():
        task.status, task.completed_at = "Closed", at
        session.add(task)


def _set_status(
    session: Session, alert: HealthAlert, target: AlertStatus, actor: Actor, note: str | None, at: datetime
) -> None:
    alert.status = target.value
    if target == AlertStatus.ACKNOWLEDGED:
        alert.acknowledged_at = at
    if target in (AlertStatus.RESOLVED, AlertStatus.DISMISSED):
        alert.resolved_at = at
        alert.resolution_note = note
        _close_tasks(session, alert, at)
    alert.version += 1
    alert.updated_at = datetime.now(UTC)


def transition_alert(
    session: Session,
    alert: HealthAlert,
    target: AlertStatus,
    *,
    actor: Actor,
    user_id: str,
    username: str,
    node_id: str,
    note: str | None = None,
) -> HealthAlert:
    """A person moves an alert (acknowledge / review / resolve / dismiss). Raises TransitionError."""
    check_transition(AlertStatus(alert.status), target, actor, note)
    now = datetime.now(UTC)
    _set_status(session, alert, target, actor, note, now)
    if target == AlertStatus.ACKNOWLEDGED:
        alert.acknowledged_by = username
    if target in (AlertStatus.IN_REVIEW, AlertStatus.RESOLVED, AlertStatus.DISMISSED):
        alert.reviewed_by = username
    session.add(alert)
    _audit(session, alert, f"Alert{target.value}", node_id, user_id, {"note": note} if note else None)
    _queue(session, alert)
    session.commit()
    session.refresh(alert)
    return alert
