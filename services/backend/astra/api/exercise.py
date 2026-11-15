"""Camera exercise coach (Step 13; LLD §15.6).

- GET  /api/astronauts/{id}/exercise-plan     — today's plan from open alerts, with the reasons.
- GET  /api/astronauts/{id}/exercise-sessions — recent coached sessions (astronaut and Earth staff).
- POST /api/exercise/sessions                 — the astronaut saves a finished session.

The camera video never reaches the server: the browser counts the reps and checks posture, and only
the results are sent. A saved session also updates `activity_min` (today) and `exercise_sessions`
(7 days) through the normal intake, so rules, progress, tasks and the Ground copy all see it.
"""

import json
from datetime import UTC, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import AwareDatetime, Field
from sqlmodel import Session, col, select

from astra.api.alerts import publish_alert_changes
from astra.api.base import ApiModel
from astra.api.reports import publish_report
from astra.core.alerts import ACTIVE_STATUSES
from astra.core.enums import MeasurementQuality, MeasurementSource, NodeRole, Role
from astra.core.exercise import (
    ExercisePlan,
    ExerciseProgramme,
    ExerciseResult,
    OpenAlert,
    SetResult,
    form_score,
    plan_for,
    session_summary,
)
from astra.db.models import (
    Astronaut,
    ExerciseSession,
    HealthAlert,
    HealthMeasurement,
    Mission,
    RecommendationTask,
    SyncOutbox,
)
from astra.db.session import SessionDep
from astra.realtime.hub import hub
from astra.security.deps import CurrentUser, ViewableAstronaut
from astra.services.ingestion import IncomingReading, ingest_batch
from astra.services.reports import report_new_alerts

router = APIRouter(prefix="/api", tags=["exercise coach"])

COACH_DEVICE = "COACH"  # device id of the readings written by the coach
EXERCISE_TASK = "REC-EXERCISE-SESSION"


# --- plan ---------------------------------------------------------------------------------------


class PlannedOut(ApiModel):
    exercise: str
    name: str
    device: str
    camera: Literal["side", "front"]
    how_to: str
    loads: str
    sets: int
    reps: int


class AdjustmentOut(ApiModel):
    id: str
    effect: Literal["rest", "lighter", "more"]
    reason: str
    because: list[str]


class SetOut(ApiModel):
    reps: int
    target: int
    form_score: int | None


class TipOut(ApiModel):
    tip: str
    count: int


class ExerciseResultOut(ApiModel):
    exercise: str
    name: str
    sets: list[SetOut]
    tips: list[TipOut]


class ExerciseSessionOut(ApiModel):
    id: str
    astronaut_code: str
    started_at: datetime
    finished_at: datetime
    source: Literal["camera", "demo"]
    plan_level: str
    results: list[ExerciseResultOut]
    total_reps: int
    form_score: int | None
    summary: str


class ExercisePlanOut(ApiModel):
    astronaut_code: str
    rest_day: bool
    level: Literal["rest", "lighter", "standard", "more", "adjusted"]
    items: list[PlannedOut]
    rest_seconds: int
    adjustments: list[AdjustmentOut]
    sessions_week: float | None
    target_per_week: int | None
    done_today: int
    recent: list[ExerciseSessionOut]
    disclaimer: str


def _programme(request: Request) -> ExerciseProgramme:
    programme: ExerciseProgramme | None = request.app.state.protocols.exercise
    if programme is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "No exercise programme (protocols/exercise-plans.json)"
        )
    return programme


def _open_alerts(session: Session, astronaut_id: str) -> list[OpenAlert]:
    rows = session.exec(
        select(HealthAlert).where(
            HealthAlert.astronaut_id == astronaut_id,
            col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]),
        )
    ).all()
    return [OpenAlert(a.rule_id, a.severity, a.title) for a in rows]


def _session_out(row: ExerciseSession, code: str) -> ExerciseSessionOut:
    return ExerciseSessionOut(
        id=row.id,
        astronaut_code=code,
        started_at=row.started_at,
        finished_at=row.finished_at,
        source="demo" if row.source == "demo" else "camera",
        plan_level=row.plan_level,
        results=[ExerciseResultOut.model_validate(r) for r in json.loads(row.results_json)],
        total_reps=row.total_reps,
        form_score=row.form_score,
        summary=row.summary,
    )


def _sessions(session: Session, astronaut_id: str, since: datetime | None = None) -> list[ExerciseSession]:
    query = select(ExerciseSession).where(ExerciseSession.astronaut_id == astronaut_id)
    if since is not None:
        query = query.where(col(ExerciseSession.finished_at) >= since)
    return list(session.exec(query.order_by(col(ExerciseSession.finished_at).desc())).all())


def _latest(session: Session, astronaut_id: str, code: str, since: datetime) -> HealthMeasurement | None:
    return session.exec(
        select(HealthMeasurement)
        .where(
            HealthMeasurement.astronaut_id == astronaut_id,
            HealthMeasurement.indicator_code == code,
            HealthMeasurement.quality == MeasurementQuality.VALID.value,
            col(HealthMeasurement.measured_at) >= since,
        )
        .order_by(col(HealthMeasurement.measured_at).desc())
    ).first()


def plan_out(session: Session, request: Request, astronaut: Astronaut) -> ExercisePlanOut:
    programme = _programme(request)
    plan: ExercisePlan = plan_for(programme, _open_alerts(session, astronaut.id))
    mission = session.get(Mission, astronaut.mission_id)
    profile = request.app.state.protocols.mission_profiles.get(mission.profile_code) if mission else None
    now = datetime.now(UTC)
    week = _latest(session, astronaut.id, "exercise_sessions", now - timedelta(days=8))
    start_of_day = datetime.combine(now.date(), time.min, tzinfo=UTC)
    recent = _sessions(session, astronaut.id)[:5]
    return ExercisePlanOut(
        astronaut_code=astronaut.code,
        rest_day=plan.rest_day,
        level=plan.level,
        items=[
            PlannedOut(
                exercise=p.exercise.id,
                name=p.exercise.name,
                device=p.exercise.device,
                camera=p.exercise.camera,
                how_to=p.exercise.how_to,
                loads=p.exercise.loads,
                sets=p.sets,
                reps=p.reps,
            )  # fmt: skip
            for p in plan.items
        ],
        rest_seconds=plan.rest_seconds,
        adjustments=[
            AdjustmentOut(id=a.id, effect=a.effect, reason=a.reason, because=list(a.because))
            for a in plan.adjustments
        ],  # fmt: skip
        sessions_week=week.value if week else None,
        target_per_week=profile.exercise_target_sessions_per_week if profile else None,
        done_today=sum(1 for s in recent if s.finished_at >= start_of_day),
        recent=[_session_out(s, astronaut.code) for s in recent],
        disclaimer=programme.disclaimer,
    )


@router.get("/astronauts/{astronaut}/exercise-plan", response_model=ExercisePlanOut)
def get_exercise_plan(astronaut: ViewableAstronaut, request: Request, session: SessionDep) -> ExercisePlanOut:
    return plan_out(session, request, astronaut)


@router.get("/astronauts/{astronaut}/exercise-sessions", response_model=list[ExerciseSessionOut])
def get_exercise_sessions(
    astronaut: ViewableAstronaut, session: SessionDep, limit: int = Query(default=20, ge=1, le=100)
) -> list[ExerciseSessionOut]:
    return [_session_out(s, astronaut.code) for s in _sessions(session, astronaut.id)[:limit]]


# --- results ------------------------------------------------------------------------------------


class SetIn(ApiModel):
    reps: int = Field(ge=0, le=100)
    target: int = Field(ge=1, le=50)
    form_score: int | None = Field(default=None, ge=0, le=100)


class TipIn(ApiModel):
    tip: str = Field(min_length=1, max_length=120)
    count: int = Field(ge=1, le=500)


class ExerciseIn(ApiModel):
    exercise: str
    sets: list[SetIn] = Field(min_length=1, max_length=10)
    tips: list[TipIn] = Field(default_factory=list, max_length=20)


class SessionIn(ApiModel):
    id: str = Field(
        min_length=8, max_length=64, pattern=r"^[A-Za-z0-9-]+$", description="Client id (idempotent)"
    )
    started_at: AwareDatetime
    finished_at: AwareDatetime
    source: Literal["camera", "demo"]
    plan_level: Literal["rest", "lighter", "standard", "more", "adjusted"]
    exercises: list[ExerciseIn] = Field(min_length=1, max_length=10)


def _readings(session: Session, astronaut: Astronaut, row: ExerciseSession) -> list[IncomingReading]:
    """Today's activity minutes and the 7-day session count, each including this session.

    Readings from other sources (wearable, weekly log) are the base; the coach adds its own sessions
    that came after them, so nothing is counted twice when the coach saves again."""
    at = row.finished_at
    simulated = row.source == "demo"
    day_start = datetime.combine(at.date(), time.min, tzinfo=UTC)

    def base(code: str, since: datetime) -> HealthMeasurement | None:
        return session.exec(
            select(HealthMeasurement)
            .where(
                HealthMeasurement.astronaut_id == astronaut.id,
                HealthMeasurement.indicator_code == code,
                HealthMeasurement.quality == MeasurementQuality.VALID.value,
                HealthMeasurement.device_id != COACH_DEVICE,
                col(HealthMeasurement.measured_at) >= since,
                col(HealthMeasurement.measured_at) <= at,
            )
            .order_by(col(HealthMeasurement.measured_at).desc())
        ).first()

    today = [s for s in _sessions(session, astronaut.id, day_start) if s.finished_at <= at]
    act_base = base("activity_min", day_start)
    minutes = sum(
        (s.finished_at - s.started_at).total_seconds() / 60
        for s in today
        if act_base is None or s.finished_at > act_base.measured_at
    )
    week_start = at - timedelta(days=7)
    week_base = base("exercise_sessions", week_start)
    week = [
        s for s in _sessions(session, astronaut.id, week_start) if s.finished_at <= at and s.total_reps > 0
    ]
    count = len([s for s in week if week_base is None or s.finished_at > week_base.measured_at])
    source = MeasurementSource.SIMULATED.value if simulated else MeasurementSource.DEVICE.value

    def reading(suffix: str, code: str, unit: str, value: float) -> IncomingReading:
        return IncomingReading(
            id=f"{row.id}-{suffix}", indicator=code, unit=unit, value=value, measured_at=at,
            source=source, device_id=COACH_DEVICE, is_simulated=simulated,
        )  # fmt: skip

    act = (act_base.value or 0) if act_base else 0
    sessions = (week_base.value or 0) if week_base else 0
    return [
        reading("act", "activity_min", "min", round(min(600.0, act + minutes))),
        reading("ses", "exercise_sessions", "count", min(21.0, sessions + count)),
    ]


@router.post("/exercise/sessions", response_model=ExerciseSessionOut, status_code=status.HTTP_201_CREATED)
def post_exercise_session(
    body: SessionIn, request: Request, session: SessionDep, user: CurrentUser
) -> ExerciseSessionOut:
    if request.app.state.settings.node_role == NodeRole.GROUND:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Exercise is recorded onboard: send it to the Habitat node"
        )
    if user.role != Role.ASTRONAUT or not user.astronaut_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only astronauts record exercise sessions")
    astronaut = session.get(Astronaut, user.astronaut_id)
    assert astronaut is not None
    existing = session.get(ExerciseSession, body.id)
    if existing is not None:  # sent again (offline outbox, lost reply): same answer, nothing new
        if existing.astronaut_id != astronaut.id:
            raise HTTPException(status.HTTP_409_CONFLICT, "Session id already used")
        return _session_out(existing, astronaut.code)

    now = datetime.now(UTC)
    finished = min(body.finished_at.astimezone(UTC), now)
    started = min(body.started_at.astimezone(UTC), finished)
    if finished - started > timedelta(hours=4):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "A session cannot last more than 4 hours")
    names = {e.id: e.name for e in _programme(request).exercises}
    unknown = [e.exercise for e in body.exercises if e.exercise not in names]
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown exercise: {', '.join(unknown)}")
    results = [
        ExerciseResult(
            exercise=e.exercise,
            name=names[e.exercise],
            sets=tuple(SetResult(s.reps, s.target, s.form_score if s.reps else None) for s in e.sets),
            tips=tuple((t.tip, t.count) for t in e.tips),
        )
        for e in body.exercises
    ]
    total = sum(s.reps for r in results for s in r.sets)
    row = ExerciseSession(
        id=body.id,
        astronaut_id=astronaut.id,
        started_at=started,
        finished_at=finished,
        source=body.source,
        plan_level=body.plan_level,
        results_json=json.dumps(
            [
                {
                    "exercise": r.exercise,
                    "name": r.name,
                    "tips": [{"tip": tip, "count": n} for tip, n in r.tips],
                    "sets": [{"reps": s.reps, "target": s.target, "formScore": s.form_score} for s in r.sets],
                }
                for r in results
            ]
        ),  # fmt: skip
        total_reps=total,
        form_score=form_score(results),
        summary=session_summary(results, (finished - started).total_seconds() / 60),
        node_id=request.app.state.settings.node_id,
    )
    session.add(row)
    session.add(
        SyncOutbox(entity_type="ExerciseSession", entity_id=row.id, payload_json=row.model_dump_json())
    )
    session.flush()

    if total > 0:
        outcome = ingest_batch(
            session, request.app.state.protocols, astronaut, _readings(session, astronaut, row),
            node_id=request.app.state.settings.node_id, user_id=user.user_id,
        )  # fmt: skip
        publish_alert_changes(outcome.alerts, astronaut)
        report = report_new_alerts(session, request.app.state.protocols, astronaut, outcome.alerts.created,
                                   node_id=request.app.state.settings.node_id)  # fmt: skip
        if report is not None:
            publish_report(report)
        day_start = datetime.combine(now.date(), time.min, tzinfo=UTC)
        for task in session.exec(
            select(RecommendationTask).where(
                RecommendationTask.astronaut_id == astronaut.id,
                RecommendationTask.code == EXERCISE_TASK,
                RecommendationTask.status == "Pending",
                col(RecommendationTask.created_at) >= day_start - timedelta(days=1),
            )
        ).all():
            task.status, task.completed_at = "Done", now
            session.add(task)
    session.commit()
    hub.publish_from_thread(
        [f"astronaut:{astronaut.id}", "medical"],
        "ExerciseSessionRecorded",
        {"astronautCode": astronaut.code, "id": row.id, "reps": total},
    )
    return _session_out(row, astronaut.code)
