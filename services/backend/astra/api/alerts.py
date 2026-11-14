"""Alerts: list, detail, and lifecycle actions (LLD §13.3)."""

import json
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import Field
from sqlmodel import Session, col, select

from astra.api.base import ApiModel
from astra.core.alerts import ACTIVE_STATUSES, TransitionError
from astra.core.enums import AlertStatus, Role
from astra.core.protocols import ProtocolBundle
from astra.db.models import Astronaut, HealthAlert, RecommendationTask
from astra.db.session import SessionDep
from astra.realtime.hub import hub
from astra.security.deps import CurrentUser, ViewableAstronaut, can_view_astronaut, require_role
from astra.security.jwt import TokenClaims
from astra.services.alerts import AlertChanges, transition_alert

router = APIRouter(prefix="/api", tags=["alerts"])


class AlertSummary(ApiModel):
    id: str
    astronaut_code: str
    rule_id: str
    rule_version: str
    category: str
    hazard: str
    severity: Literal["Attention", "Urgent"]
    status: AlertStatus
    title: str
    reason: str
    first_triggered_at: datetime
    last_triggered_at: datetime
    trigger_count: int
    escalation_required: bool
    protocol: str | None


class TaskOut(ApiModel):
    id: str
    code: str
    title: str
    body: str
    category: str
    priority: int
    status: str
    due_at: datetime | None
    alert_id: str | None


class ProtocolOut(ApiModel):
    id: str
    title: str
    body: str
    disclaimer: str


class AlertDetail(AlertSummary):
    evidence: dict[str, dict[str, Any]]
    recommendations: list[TaskOut]
    emergency_protocol: ProtocolOut | None
    acknowledged_at: datetime | None
    acknowledged_by: str | None
    reviewed_by: str | None
    resolved_at: datetime | None
    resolution_note: str | None
    disclaimer: str = "Decision support only — not a diagnosis. Thresholds are illustrative."


class NoteIn(ApiModel):
    note: str | None = Field(default=None, max_length=2000)


def summarize(alert: HealthAlert, astronaut_code: str) -> AlertSummary:
    return AlertSummary(
        id=alert.id,
        astronaut_code=astronaut_code,
        rule_id=alert.rule_id,
        rule_version=alert.rule_version,
        category=alert.category,
        hazard=alert.hazard,
        severity="Urgent" if alert.severity == "Urgent" else "Attention",
        status=AlertStatus(alert.status),
        title=alert.title,
        reason=alert.reason,
        first_triggered_at=alert.first_triggered_at,
        last_triggered_at=alert.last_triggered_at,
        trigger_count=alert.trigger_count,
        escalation_required=alert.escalation_required,
        protocol=alert.protocol,
    )


def task_out(task: RecommendationTask, bundle: ProtocolBundle) -> TaskOut:
    rec = bundle.recommendations.get(task.code)
    return TaskOut(
        id=task.id,
        code=task.code,
        title=rec.title if rec else task.code,
        body=rec.body if rec else "",
        category=rec.category if rec else "General",
        priority=rec.priority if rec else 3,
        status=task.status,
        due_at=task.due_at,
        alert_id=task.alert_id,
    )


def publish_alert_changes(changes: AlertChanges, astronaut: Astronaut) -> None:
    """Live updates: full detail to the astronaut and medical staff, status only to mission control."""
    private = [f"astronaut:{astronaut.id}", "medical"]
    events = [("AlertRaised", a) for a in changes.created] + [
        ("AlertUpdated", a) for a in changes.updated + changes.resolved
    ]
    for kind, alert in events:
        payload = summarize(alert, astronaut.code).model_dump(mode="json", by_alias=True)
        hub.publish_from_thread(private, kind, payload)
        hub.publish_from_thread(
            ["mission"],
            kind,
            {
                "astronautCode": astronaut.code,
                "severity": alert.severity,
                "status": alert.status,
                "category": alert.category,
            },
        )


def _bundle(request: Request) -> ProtocolBundle:
    bundle: ProtocolBundle = request.app.state.protocols
    return bundle


def _load_alert(session: Session, alert_id: str, user: TokenClaims) -> tuple[HealthAlert, Astronaut]:
    alert = session.get(HealthAlert, alert_id)
    astronaut = session.get(Astronaut, alert.astronaut_id) if alert else None
    if alert is None or astronaut is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Alert not found")
    if not can_view_astronaut(user, astronaut):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only view your own alerts")
    return alert, astronaut


@router.get("/astronauts/{astronaut}/alerts", response_model=list[AlertSummary])
def list_alerts(
    astronaut: ViewableAstronaut,
    session: SessionDep,
    status_filter: Annotated[Literal["active", "all"], Query(alias="status")] = "active",
) -> list[AlertSummary]:
    query = select(HealthAlert).where(HealthAlert.astronaut_id == astronaut.id)
    if status_filter == "active":
        query = query.where(col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]))
    rows = session.exec(query.order_by(col(HealthAlert.last_triggered_at).desc())).all()
    return [summarize(a, astronaut.code) for a in rows]


@router.get("/alerts/{alert_id}", response_model=AlertDetail)
def get_alert(alert_id: str, request: Request, session: SessionDep, user: CurrentUser) -> AlertDetail:
    alert, astronaut = _load_alert(session, alert_id, user)
    bundle = _bundle(request)
    tasks = session.exec(select(RecommendationTask).where(RecommendationTask.alert_id == alert.id)).all()
    protocol = bundle.emergency_protocols.get(alert.protocol) if alert.protocol else None
    return AlertDetail(
        **summarize(alert, astronaut.code).model_dump(),
        evidence=json.loads(alert.evidence_json),
        recommendations=[task_out(t, bundle) for t in tasks],
        emergency_protocol=ProtocolOut(
            id=protocol.id, title=protocol.title, body=protocol.body, disclaimer=protocol.disclaimer
        )
        if protocol
        else None,
        acknowledged_at=alert.acknowledged_at,
        acknowledged_by=alert.acknowledged_by,
        reviewed_by=alert.reviewed_by,
        resolved_at=alert.resolved_at,
        resolution_note=alert.resolution_note,
    )


def _move(
    alert_id: str,
    target: AlertStatus,
    request: Request,
    session: Session,
    user: TokenClaims,
    note: str | None,
) -> AlertSummary:
    alert, astronaut = _load_alert(session, alert_id, user)
    try:
        alert = transition_alert(
            session,
            alert,
            target,
            actor=user.role,
            user_id=user.user_id,
            username=user.username,
            node_id=request.app.state.settings.node_id,
            note=note,
        )
    except TransitionError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    publish_alert_changes(AlertChanges(updated=[alert]), astronaut)
    return summarize(alert, astronaut.code)


Astronaut_ = Annotated[TokenClaims, Depends(require_role(Role.ASTRONAUT))]
Surgeon = Annotated[TokenClaims, Depends(require_role(Role.FLIGHT_SURGEON))]


@router.post("/alerts/{alert_id}/acknowledge", response_model=AlertSummary)
def acknowledge(alert_id: str, request: Request, session: SessionDep, user: Astronaut_) -> AlertSummary:
    """The astronaut confirms they have seen the alert."""
    return _move(alert_id, AlertStatus.ACKNOWLEDGED, request, session, user, None)


@router.post("/alerts/{alert_id}/review", response_model=AlertSummary)
def review(alert_id: str, body: NoteIn, request: Request, session: SessionDep, user: Surgeon) -> AlertSummary:
    return _move(alert_id, AlertStatus.IN_REVIEW, request, session, user, body.note)


@router.post("/alerts/{alert_id}/resolve", response_model=AlertSummary)
def resolve(
    alert_id: str, body: NoteIn, request: Request, session: SessionDep, user: Surgeon
) -> AlertSummary:
    """Flight surgeon closes an alert under review (note required)."""
    return _move(alert_id, AlertStatus.RESOLVED, request, session, user, body.note)


@router.post("/alerts/{alert_id}/dismiss", response_model=AlertSummary)
def dismiss(
    alert_id: str, body: NoteIn, request: Request, session: SessionDep, user: Surgeon
) -> AlertSummary:
    """Flight surgeon marks a false alarm (note required)."""
    return _move(alert_id, AlertStatus.DISMISSED, request, session, user, body.note)
