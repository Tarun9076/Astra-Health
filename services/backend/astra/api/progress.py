"""My progress: points, streaks, weekly goals and badges (gamification).

A read-only view over data that already exists. Points reward **actions the astronaut controls**
(doing the check-in, exercising, sleeping enough, drinking enough, finishing guidance tasks), never
the health readings themselves: a high heart rate or a low blood sugar never costs points, so the
game can't push anyone to hide or "improve" a reading.
"""

from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Request
from sqlmodel import Session, col, select

from astra.api.base import ApiModel
from astra.core.enums import MeasurementQuality
from astra.core.protocols import ProtocolBundle
from astra.db.models import Astronaut, HealthMeasurement, Mission, RecommendationTask, WellnessCheckin
from astra.db.session import SessionDep
from astra.security.deps import ViewableAstronaut

router = APIRouter(prefix="/api", tags=["progress"])

ACTIVE_MINUTES = 30  # an "active day": at least this many minutes of exercise
SLEEP_HOURS = 7.0  # a "good night": at least this much sleep
POINTS = {"checkin": 10, "active": 5, "sleep": 5, "hydration": 5, "task": 5}
# (minimum points, title); the titles describe the habit, not health
LEVELS = [
    (0, "Getting started"),
    (100, "Building the habit"),
    (250, "Steady routine"),
    (500, "Consistent"),
    (900, "Self-care specialist"),
    (1400, "Health ally"),
    (2000, "Health pathfinder"),
    (2800, "Mission-ready"),
    (3800, "Health commander"),
    (5000, "Role model"),
]

StreakId = Literal["checkin", "active", "sleep", "hydration"]


class PointRule(ApiModel):
    action: str
    points: int


class Level(ApiModel):
    number: int
    title: str
    min_points: int
    next_points: int | None  # points needed for the next level; None at the top


class Streak(ApiModel):
    id: StreakId
    label: str
    current: int  # days in a row up to today (or yesterday, while today is still open)
    best: int
    done_today: bool


class WeeklyGoal(ApiModel):
    id: StreakId
    label: str
    done: int
    target: int


class Badge(ApiModel):
    id: str
    title: str
    description: str
    earned: bool
    earned_on: date | None
    progress: int
    target: int


class ProgressOut(ApiModel):
    astronaut_code: str
    points: int
    points_today: int
    level: Level
    streaks: list[Streak]
    weekly: list[WeeklyGoal]
    badges: list[Badge]
    how_points_work: list[PointRule]


def _days(
    session: Session, astronaut_id: str, indicator: str, since: datetime, minimum: float | None
) -> set[date]:
    rows = session.exec(
        select(HealthMeasurement.measured_at, HealthMeasurement.value).where(
            HealthMeasurement.astronaut_id == astronaut_id,
            HealthMeasurement.indicator_code == indicator,
            HealthMeasurement.quality == MeasurementQuality.VALID.value,
            col(HealthMeasurement.measured_at) >= since,
        )
    ).all()
    return {at.date() for at, value in rows if value is not None and (minimum is None or value >= minimum)}


def _runs(days: set[date]) -> tuple[int, int, date | None, dict[int, date]]:
    """(best run, run ending at the latest day, that latest day, first date each run length was reached)."""
    best, run, prev, last = 0, 0, None, None
    reached: dict[int, date] = {}
    for d in sorted(days):
        run = run + 1 if prev is not None and d - prev == timedelta(days=1) else 1
        reached.setdefault(run, d)
        best, prev, last = max(best, run), d, d
    return best, run, last, reached


def _current(days: set[date], today: date) -> int:
    """Days in a row ending today, or ending yesterday while today is not done yet."""
    day = today if today in days else today - timedelta(days=1)
    n = 0
    while day in days:
        n, day = n + 1, day - timedelta(days=1)
    return n


def _nth(items: Iterable[date], n: int) -> date | None:
    ordered = sorted(items)
    return ordered[n - 1] if len(ordered) >= n else None


def _best_window(days: set[date], target: int) -> tuple[int, date | None]:
    """Most days in any 7-day window, and the first day a window reached `target`."""
    best, first = 0, None
    for end in sorted(days):
        n = sum(1 for d in days if end - timedelta(days=6) <= d <= end)
        best = max(best, n)
        if first is None and n >= target:
            first = end
    return best, first


@router.get("/astronauts/{astronaut}/progress", response_model=ProgressOut)
def get_progress(astronaut: ViewableAstronaut, request: Request, session: SessionDep) -> ProgressOut:
    return build_progress(session, request.app.state.protocols, astronaut)


def build_progress(
    session: Session, bundle: ProtocolBundle, astronaut: Astronaut, now: datetime | None = None
) -> ProgressOut:
    now = now or datetime.now(UTC)
    today = now.date()
    mission = session.get(Mission, astronaut.mission_id)
    profile = bundle.mission_profiles.get(mission.profile_code) if mission else None
    hydration_target = float(profile.hydration_target_ml_per_day) if profile else 2500.0
    active_target = min(7, profile.exercise_target_sessions_per_week) if profile else 5
    start = mission.start_date if mission and mission.start_date <= today else today - timedelta(days=365)
    since = datetime.combine(start, datetime.min.time(), tzinfo=UTC)

    # a check-in day: the daily check-in was sent (its mood score is always recorded)
    sent = session.exec(
        select(WellnessCheckin).where(
            WellnessCheckin.astronaut_id == astronaut.id, col(WellnessCheckin.checkin_date) >= start
        )
    ).all()
    checkin = _days(session, astronaut.id, "mood", since, None) | {c.checkin_date for c in sent}
    days: dict[StreakId, set[date]] = {
        "checkin": checkin,
        "active": _days(session, astronaut.id, "activity_min", since, ACTIVE_MINUTES),
        "sleep": _days(session, astronaut.id, "sleep_hours", since, SLEEP_HOURS),
        "hydration": _days(session, astronaut.id, "hydration_ml", since, hydration_target),
    }
    tasks = [
        t.completed_at.date()
        for t in session.exec(
            select(RecommendationTask).where(
                RecommendationTask.astronaut_id == astronaut.id,
                RecommendationTask.status == "Done",
                col(RecommendationTask.completed_at).is_not(None),
            )
        ).all()
        if t.completed_at is not None and t.completed_at.date() >= start
    ]

    points = sum(POINTS[k] * len(v) for k, v in days.items()) + POINTS["task"] * len(tasks)
    points_today = sum(POINTS[k] for k, v in days.items() if today in v) + POINTS["task"] * tasks.count(today)
    number = max(i for i, (low, _) in enumerate(LEVELS) if points >= low)
    level = Level(
        number=number + 1,
        title=LEVELS[number][1],
        min_points=LEVELS[number][0],
        next_points=LEVELS[number + 1][0] if number + 1 < len(LEVELS) else None,
    )

    labels: dict[StreakId, str] = {
        "checkin": "Daily check-in",
        "active": f"Exercise ({ACTIVE_MINUTES}+ min)",
        "sleep": f"Sleep ({SLEEP_HOURS:g}+ h)",
        "hydration": f"Drink {hydration_target / 1000:g} L",
    }
    runs = {k: _runs(v) for k, v in days.items()}
    streaks = [
        Streak(id=k, label=labels[k], current=_current(v, today), best=runs[k][0], done_today=today in v)
        for k, v in days.items()
    ]
    week = {k: sum(1 for d in v if today - timedelta(days=6) <= d <= today) for k, v in days.items()}
    targets: dict[StreakId, int] = {"checkin": 7, "active": active_target, "sleep": 5, "hydration": 5}
    weekly = [WeeklyGoal(id=k, label=labels[k], done=week[k], target=targets[k]) for k in days]

    def streak_badge(bid: str, title: str, desc: str, kind: StreakId, n: int) -> Badge:
        best, _, _, reached = runs[kind]
        return Badge(id=bid, title=title, description=desc, earned=best >= n, earned_on=reached.get(n),
                     progress=min(best, n), target=n)  # fmt: skip

    def count_badge(bid: str, title: str, desc: str, items: Iterable[date], n: int) -> Badge:
        items = list(items)
        return Badge(id=bid, title=title, description=desc, earned=len(items) >= n,
                     earned_on=_nth(items, n), progress=min(len(items), n), target=n)  # fmt: skip

    active_best, active_first = _best_window(days["active"], active_target)
    active = Badge(
        id="active-week",
        title="Exercise target met",
        description=f"Exercised on {active_target} days within one week.",
        earned=active_first is not None,
        earned_on=active_first,
        progress=min(active_best, active_target),
        target=active_target,
    )
    good_nights = f"Slept {SLEEP_HOURS:g} hours or more 5 nights in a row."
    badges = [
        count_badge("first-checkin", "First check-in", "Sent your first daily check-in.", checkin, 1),
        streak_badge("checkin-7", "One week, every day", "Checked in 7 days in a row.", "checkin", 7),
        streak_badge("checkin-30", "A month of check-ins", "Checked in 30 days in a row.", "checkin", 30),
        count_badge("checkins-100", "100 check-ins", "Sent 100 daily check-ins.", checkin, 100),
        active,
        streak_badge("sleep-5", "Well rested", good_nights, "sleep", 5),
        streak_badge(
            "hydration-7", "Well hydrated", "Reached your fluid goal 7 days in a row.", "hydration", 7
        ),
        count_badge("tasks-10", "Following through", "Finished 10 guidance tasks.", tasks, 10),
    ]

    rules = [
        PointRule(action="Send your daily check-in", points=POINTS["checkin"]),
        PointRule(action=f"Exercise {ACTIVE_MINUTES} minutes or more", points=POINTS["active"]),
        PointRule(action=f"Sleep {SLEEP_HOURS:g} hours or more", points=POINTS["sleep"]),
        PointRule(action="Reach your daily fluid goal", points=POINTS["hydration"]),
        PointRule(action="Finish a guidance task", points=POINTS["task"]),
    ]
    return ProgressOut(
        astronaut_code=astronaut.code,
        points=points,
        points_today=points_today,
        level=level,
        streaks=streaks,
        weekly=weekly,
        badges=badges,
        how_points_work=rules,
    )
