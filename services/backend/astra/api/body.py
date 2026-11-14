"""Body Explorer and Wellness Center (Step 10; LLD §13.2, §15.3).

- GET  /api/astronauts/{id}/body-systems   — regions with readings vs normal, alerts, tasks, knowledge.
- GET  /api/astronauts/{id}/wellness-center — hydration, exercise, sleep, breathing, missions + streaks.
- POST /api/wellness/activity              — the astronaut logs a drink (mL) or a breathing session (s).
"""

from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import Field
from sqlmodel import Session, col, select

from astra.api.base import ApiModel
from astra.core.enums import MeasurementQuality, Role
from astra.core.ids import uuid7
from astra.db.models import (
    Astronaut,
    HealthMeasurement,
    Mission,
    RecommendationTask,
    WellnessActivity,
    WellnessCheckin,
)
from astra.db.session import SessionDep
from astra.security.deps import CurrentUser, ViewableAstronaut
from astra.services.body import body_systems

router = APIRouter(prefix="/api", tags=["body & wellness"])


@router.get("/astronauts/{astronaut}/body-systems")
def get_body_systems(astronaut: ViewableAstronaut, request: Request, session: SessionDep) -> dict[str, Any]:
    regions = body_systems(
        session, request.app.state.protocols, request.app.state.assistant.retriever, astronaut
    )
    return {"astronautCode": astronaut.code, "regions": regions, "generatedAt": datetime.now(UTC).isoformat()}


class ActivityIn(ApiModel):
    kind: Literal["fluid", "breathing"]
    amount: float = Field(gt=0, le=3000, description="mL of fluid, or seconds of breathing exercise")


class Mission_(ApiModel):
    id: str
    title: str
    description: str
    progress: float
    goal: float
    unit: str
    streak: int | None = None
    done: bool


class DayAmount(ApiModel):
    day: date
    value: float | None


class WellnessCenterOut(ApiModel):
    astronaut_code: str
    hydration_today_ml: float
    hydration_target_ml: float
    hydration_days: list[DayAmount]
    exercise_sessions_week: float | None
    exercise_target: int | None
    strength_index: float | None
    sleep_days: list[DayAmount]
    sleep_normal_hours: float | None
    breathing_sessions_week: int
    breathing_minutes_week: float
    missions: list[Mission_]


def _measure(session: Session, astronaut_id: str, code: str, since: datetime) -> list[HealthMeasurement]:
    return list(
        session.exec(
            select(HealthMeasurement)
            .where(
                HealthMeasurement.astronaut_id == astronaut_id,
                HealthMeasurement.indicator_code == code,
                HealthMeasurement.quality == MeasurementQuality.VALID.value,
                col(HealthMeasurement.measured_at) >= since,
            )
            .order_by(col(HealthMeasurement.measured_at))
        ).all()
    )


def _fluid_by_day(session: Session, astronaut_id: str, since: datetime) -> dict[date, float]:
    """Per day: the larger of the logged drinks and the daily intake reading (same thing, two sources)."""
    totals: dict[date, float] = {}
    for a in session.exec(
        select(WellnessActivity).where(
            WellnessActivity.astronaut_id == astronaut_id,
            WellnessActivity.kind == "fluid",
            col(WellnessActivity.at) >= since,
        )  # fmt: skip
    ).all():
        totals[a.at.date()] = totals.get(a.at.date(), 0.0) + a.amount
    for m in _measure(session, astronaut_id, "hydration_ml", since):
        d = m.measured_at.date()
        totals[d] = max(totals.get(d, 0.0), m.value or 0.0)
    return totals


def wellness_center(session: Session, request: Request, astronaut: Astronaut) -> WellnessCenterOut:
    bundle = request.app.state.protocols
    mission = session.get(Mission, astronaut.mission_id)
    profile = bundle.mission_profiles.get(mission.profile_code) if mission else None
    target_ml = float(profile.hydration_target_ml_per_day) if profile else 2500.0
    target_ex = profile.exercise_target_sessions_per_week if profile else None
    now = datetime.now(UTC)
    today = now.date()
    days = [today - timedelta(days=i) for i in range(6, -1, -1)]
    since = datetime.combine(days[0], time.min, tzinfo=UTC)

    fluid = _fluid_by_day(session, astronaut.id, since)
    sleep_rows = _measure(session, astronaut.id, "sleep_hours", since)
    sleep = {r.measured_at.date(): r.value for r in sleep_rows}
    normal_rows = _measure(session, astronaut.id, "sleep_hours", now - timedelta(days=31))
    normal = sorted(r.value or 0 for r in normal_rows if r.measured_at < since)
    exercise = _measure(session, astronaut.id, "exercise_sessions", now - timedelta(days=8))
    strength = _measure(session, astronaut.id, "strength_index", now - timedelta(days=15))
    breathing = session.exec(
        select(WellnessActivity).where(
            WellnessActivity.astronaut_id == astronaut.id,
            WellnessActivity.kind == "breathing",
            col(WellnessActivity.at) >= since,
        )  # fmt: skip
    ).all()
    checkin_days = {
        c.checkin_date
        for c in session.exec(
            select(WellnessCheckin).where(
                WellnessCheckin.astronaut_id == astronaut.id,
                col(WellnessCheckin.checkin_date) >= today - timedelta(days=60),
            )
        ).all()
    }
    streak, d = 0, today if today in checkin_days else today - timedelta(days=1)
    while d in checkin_days:
        streak, d = streak + 1, d - timedelta(days=1)

    hydrated = sum(1 for day in days if fluid.get(day, 0) >= target_ml)
    slept = sum(1 for day in days if (sleep.get(day) or 0) >= 7)
    sessions = exercise[-1].value if exercise else None
    missions = [
        Mission_(
            id="checkin-streak",
            title="Daily check-in streak",
            description="Check in every day for a week.",
            progress=min(streak, 7),
            goal=7,
            unit="days",
            streak=streak,
            done=streak >= 7,
        ),
        Mission_(
            id="hydration",
            title="Hydration hero",
            description=f"Reach {target_ml:.0f} mL on 5 of 7 days.",
            progress=hydrated,
            goal=5,
            unit="days",
            done=hydrated >= 5,
        ),
        Mission_(
            id="strength",
            title="Strength keeper",
            description="Complete your resistance sessions this week.",
            progress=sessions or 0,
            goal=target_ex or 5,
            unit="sessions",
            done=sessions is not None and sessions >= (target_ex or 5),
        ),
        Mission_(
            id="sleep",
            title="Sleep well",
            description="Sleep at least 7 h on 5 of 7 nights.",
            progress=slept,
            goal=5,
            unit="nights",
            done=slept >= 5,
        ),
        Mission_(
            id="calm",
            title="Calm minutes",
            description="Do 5 breathing exercises this week.",
            progress=len(breathing),
            goal=5,
            unit="sessions",
            done=len(breathing) >= 5,
        ),
    ]
    return WellnessCenterOut(
        astronaut_code=astronaut.code,
        hydration_today_ml=fluid.get(today, 0.0),
        hydration_target_ml=target_ml,
        hydration_days=[DayAmount(day=day, value=fluid.get(day)) for day in days],
        exercise_sessions_week=sessions,
        exercise_target=target_ex,
        strength_index=strength[-1].value if strength else None,
        sleep_days=[DayAmount(day=day, value=sleep.get(day)) for day in days],
        sleep_normal_hours=normal[len(normal) // 2] if normal else None,
        breathing_sessions_week=len(breathing),
        breathing_minutes_week=round(sum(b.amount for b in breathing) / 60, 1),
        missions=missions,
    )


@router.get("/astronauts/{astronaut}/wellness-center", response_model=WellnessCenterOut)
def get_wellness_center(
    astronaut: ViewableAstronaut, request: Request, session: SessionDep
) -> WellnessCenterOut:
    return wellness_center(session, request, astronaut)


@router.post("/wellness/activity", response_model=WellnessCenterOut, status_code=status.HTTP_201_CREATED)
def log_activity(
    body: ActivityIn, request: Request, session: SessionDep, user: CurrentUser
) -> WellnessCenterOut:
    if user.role != Role.ASTRONAUT or not user.astronaut_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only astronauts log wellness activities")
    astronaut = session.get(Astronaut, user.astronaut_id)
    assert astronaut is not None
    now = datetime.now(UTC)
    session.add(
        WellnessActivity(
            id=str(uuid7()), astronaut_id=astronaut.id, kind=body.kind, amount=body.amount, at=now
        )
    )
    session.commit()
    out = wellness_center(session, request, astronaut)
    if body.kind == "fluid" and out.hydration_today_ml >= out.hydration_target_ml:
        start = datetime.combine(now.date(), time.min, tzinfo=UTC)
        for task in session.exec(
            select(RecommendationTask).where(
                RecommendationTask.astronaut_id == astronaut.id,
                RecommendationTask.code == "REC-HYDRATION",
                RecommendationTask.status == "Pending",
                col(RecommendationTask.created_at) >= start,
            )  # fmt: skip
        ).all():
            task.status, task.completed_at = "Done", now
            session.add(task)
        session.commit()
    return out
