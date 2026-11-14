"""Daily wellness check-in (LLD §13.2) and task completion.

One submission = a WellnessCheckin row + its scores and optional vitals stored as readings,
then the usual assessment, so a check-in can raise alerts live.
"""

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import Field
from sqlmodel import Session

from astra.api.alerts import AlertSummary, TaskOut, publish_alert_changes, summarize, task_out
from astra.api.base import ApiModel
from astra.api.measurements import ItemProblem
from astra.api.reports import publish_report
from astra.core.enums import MeasurementSource, NodeRole, Role
from astra.core.ids import new_id
from astra.core.protocols import ProtocolBundle
from astra.db.models import Astronaut, RecommendationTask, WellnessCheckin
from astra.db.session import SessionDep
from astra.realtime.hub import hub
from astra.security.deps import CurrentUser
from astra.security.jwt import TokenClaims
from astra.services.ingestion import IncomingReading, ingest_batch
from astra.services.reports import report_new_alerts
from astra.services.routine import complete_checkin_reminder

router = APIRouter(prefix="/api", tags=["check-in"])

VitalIndicator = Literal["resting_hr", "bp_sys", "bp_dia", "body_temp", "spo2", "glucose", "body_weight"]


class VitalIn(ApiModel):
    indicator: VitalIndicator
    value: float
    unit: str = Field(examples=["bpm"])


class CheckinIn(ApiModel):
    id: str | None = Field(
        default=None, description="UUIDv7 from the client (offline outbox); generated if missing"
    )
    sleep_hours: float = Field(ge=0, le=16, description="Last night's sleep")
    sleep_quality: int = Field(ge=1, le=10)
    mood: int = Field(ge=1, le=10)
    stress: int = Field(ge=1, le=10)
    fatigue: int = Field(ge=1, le=10)
    vitals: list[VitalIn] = Field(default_factory=list, max_length=10)
    private_note: str | None = Field(default=None, max_length=1000, description="Visible to you only")
    completed_in_seconds: int | None = Field(default=None, ge=0, le=3600)


class CheckinOut(ApiModel):
    checkin_id: str
    accepted: int
    questionable: list[ItemProblem]
    rejected: list[ItemProblem]
    new_alerts: list[AlertSummary]
    updated_alerts: list[AlertSummary]


def _own_astronaut(session: Session, user: TokenClaims) -> Astronaut:
    if user.role != Role.ASTRONAUT or not user.astronaut_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only astronauts submit check-ins")
    astronaut = session.get(Astronaut, user.astronaut_id)
    if astronaut is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Astronaut not found")
    return astronaut


@router.post("/checkins", status_code=status.HTTP_201_CREATED, response_model=CheckinOut)
def post_checkin(body: CheckinIn, request: Request, session: SessionDep, user: CurrentUser) -> CheckinOut:
    if request.app.state.settings.node_role == NodeRole.GROUND:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Readings are taken onboard: send them to the Habitat node"
        )
    astronaut = _own_astronaut(session, user)
    bundle: ProtocolBundle = request.app.state.protocols
    now = datetime.now(UTC).replace(microsecond=0)
    checkin_id = body.id or new_id()

    session.add(
        WellnessCheckin(
            id=checkin_id,
            astronaut_id=astronaut.id,
            checkin_date=now.date(),
            sleep_hours=body.sleep_hours,
            sleep_quality=body.sleep_quality,
            mood=body.mood,
            stress=body.stress,
            fatigue=body.fatigue,
            private_note=body.private_note,
            completed_in_seconds=body.completed_in_seconds,
            created_at=now,
        )
    )
    manual = MeasurementSource.MANUAL.value
    scores = [
        ("sleep_hours", body.sleep_hours, "h"),
        ("sleep_quality", body.sleep_quality, "score"),
        ("mood", body.mood, "score"),
        ("stress", body.stress, "score"),
        ("fatigue", body.fatigue, "score"),
    ]
    panel = f"BP-{checkin_id}" if {"bp_sys", "bp_dia"} <= {v.indicator for v in body.vitals} else None
    items = [
        IncomingReading(indicator=i, value=v, unit=u, measured_at=now, source=manual) for i, v, u in scores
    ]
    items += [
        IncomingReading(
            indicator=v.indicator,
            value=v.value,
            unit=v.unit,
            measured_at=now,
            source=manual,
            panel_id=panel if v.indicator.startswith("bp_") else None,
        )
        for v in body.vitals
    ]
    complete_checkin_reminder(session, astronaut.id, now)
    outcome = ingest_batch(
        session,
        bundle,
        astronaut,
        items,
        node_id=request.app.state.settings.node_id,
        now=now,
        user_id=user.user_id,
    )

    hub.publish_from_thread(
        [f"astronaut:{astronaut.id}", "medical"],
        "CheckinCompleted",
        {"astronautCode": astronaut.code, "checkinId": checkin_id},
    )
    publish_alert_changes(outcome.alerts, astronaut)
    report = report_new_alerts(
        session, bundle, astronaut, outcome.alerts.created, node_id=request.app.state.settings.node_id
    )
    if report is not None:
        publish_report(report)
    return CheckinOut(
        checkin_id=checkin_id,
        accepted=len(outcome.accepted),
        questionable=[ItemProblem(id=i, reason=r) for i, r in outcome.questionable],
        rejected=[ItemProblem(id=i, reason=r) for i, r in outcome.rejected],
        new_alerts=[summarize(a, astronaut.code) for a in outcome.alerts.created],
        updated_alerts=[summarize(a, astronaut.code) for a in outcome.alerts.updated],
    )


@router.post("/tasks/{task_id}/complete", response_model=TaskOut)
def complete_task(task_id: str, request: Request, session: SessionDep, user: CurrentUser) -> TaskOut:
    """The astronaut ticks off a recommended action."""
    astronaut = _own_astronaut(session, user)
    task = session.get(RecommendationTask, task_id)
    if task is None or task.astronaut_id != astronaut.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
    if task.status == "Pending":
        task.status, task.completed_at = "Done", datetime.now(UTC)
        session.add(task)
        session.commit()
        session.refresh(task)
    return task_out(task, request.app.state.protocols)
