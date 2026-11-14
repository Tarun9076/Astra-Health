"""Daily routine tasks (LLD §8): check-in reminder, hydration log, resistance exercise when behind.

Runs on the Habitat node from an asyncio loop started in the app's lifespan; idempotent, so it
can run every few minutes. Scheduled assessments (bone, vision, …) join once assessments are recorded.
"""

from datetime import UTC, datetime, time, timedelta

from sqlmodel import Session, col, select

from astra.core.enums import MeasurementQuality
from astra.core.protocols import ProtocolBundle
from astra.db.models import Astronaut, HealthMeasurement, Mission, RecommendationTask, WellnessCheckin

CHECKIN, HYDRATION, EXERCISE = "REC-WELLNESS-CHECKIN", "REC-HYDRATION", "REC-EXERCISE-SESSION"


def _start_of_day(now: datetime) -> datetime:
    return datetime.combine(now.date(), time.min, tzinfo=UTC)


def _pending(session: Session, astronaut_id: str) -> list[RecommendationTask]:
    return list(
        session.exec(
            select(RecommendationTask).where(
                RecommendationTask.astronaut_id == astronaut_id, RecommendationTask.status == "Pending"
            )
        ).all()
    )


def _behind_on_exercise(session: Session, astronaut_id: str, target: int, now: datetime) -> bool:
    latest = session.exec(
        select(HealthMeasurement)
        .where(
            HealthMeasurement.astronaut_id == astronaut_id,
            HealthMeasurement.indicator_code == "exercise_sessions",
            HealthMeasurement.quality == MeasurementQuality.VALID.value,
            col(HealthMeasurement.measured_at) >= now - timedelta(days=8),
        )
        .order_by(col(HealthMeasurement.measured_at).desc())
    ).first()
    return latest is not None and latest.value is not None and latest.value < target


def ensure_routine_tasks(session: Session, bundle: ProtocolBundle, now: datetime | None = None) -> int:
    """Create missing routine tasks for today; skip yesterday's unfinished ones. Returns tasks created."""
    now = now or datetime.now(UTC)
    today = _start_of_day(now)
    end_of_day = today + timedelta(hours=23, minutes=59)
    created = 0
    for astronaut in session.exec(select(Astronaut)).all():
        mission = session.get(Mission, astronaut.mission_id)
        profile = bundle.mission_profiles.get(mission.profile_code) if mission else None
        pending = _pending(session, astronaut.id)

        for task in pending:  # routine tasks are for one day only
            if task.source == "Routine" and task.created_at < today:
                task.status, task.completed_at = "Skipped", now
                session.add(task)
        open_codes = {t.code for t in pending if t.status == "Pending"}

        wanted: list[tuple[str, datetime]] = []
        checked_in = session.exec(
            select(WellnessCheckin).where(
                WellnessCheckin.astronaut_id == astronaut.id, WellnessCheckin.checkin_date == now.date()
            )
        ).first()
        if checked_in is None:
            wanted.append((CHECKIN, today + timedelta(hours=12)))
        wanted.append((HYDRATION, end_of_day))
        if profile and _behind_on_exercise(
            session, astronaut.id, profile.exercise_target_sessions_per_week, now
        ):
            wanted.append((EXERCISE, end_of_day))

        for code, due in wanted:
            if code in open_codes or code not in bundle.recommendations:
                continue
            already_today = session.exec(
                select(RecommendationTask).where(
                    RecommendationTask.astronaut_id == astronaut.id,
                    RecommendationTask.code == code,
                    RecommendationTask.source == "Routine",
                    col(RecommendationTask.created_at) >= today,
                )
            ).first()
            if already_today is None:  # done earlier today: don't nag again
                session.add(
                    RecommendationTask(
                        astronaut_id=astronaut.id, code=code, due_at=due, source="Routine", created_at=now
                    )
                )
                created += 1
    session.commit()
    return created


def complete_checkin_reminder(session: Session, astronaut_id: str, now: datetime) -> None:
    """A submitted check-in ticks off the check-in reminder."""
    for task in _pending(session, astronaut_id):
        if task.code == CHECKIN:
            task.status, task.completed_at = "Done", now
            session.add(task)
