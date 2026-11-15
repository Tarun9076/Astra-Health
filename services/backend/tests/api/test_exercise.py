"""Exercise coach API (Step 13): T-EX-03..05."""

from datetime import UTC, datetime, time, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from astra.db.models import ExerciseSession, HealthMeasurement, RecommendationTask, SyncOutbox
from astra.services.routine import ensure_routine_tasks
from tests.api.test_body_environment import _fatigue_history
from tests.conftest import auth

NOW = datetime.now(UTC).replace(microsecond=0)


def _session(sid: str = "ex-session-0001", minutes: int = 20, **change: Any) -> dict[str, Any]:
    body = {
        "id": sid,
        "startedAt": (NOW - timedelta(minutes=minutes + 1)).isoformat(),
        "finishedAt": (NOW - timedelta(minutes=1)).isoformat(),
        "source": "camera",
        "planLevel": "standard",
        "exercises": [
            {"exercise": "squat",
             "sets": [{"reps": 10, "target": 10, "formScore": 90},
                      {"reps": 9, "target": 10, "formScore": 80}],
             "tips": [{"tip": "Keep your chest up", "count": 2}]},
            {"exercise": "heel_raise", "sets": [{"reps": 15, "target": 15, "formScore": 100}]},
        ],
    }  # fmt: skip
    return body | change


def _readings(client: TestClient, code: str) -> list[HealthMeasurement]:
    """All readings of one indicator (only AST-001 has any in these tests)."""
    with Session(client.app.state.engine) as session:  # type: ignore[attr-defined]
        rows = session.exec(select(HealthMeasurement).where(HealthMeasurement.indicator_code == code)).all()
        return sorted(rows, key=lambda r: r.measured_at)


def test_plan_is_lighter_when_tired_and_explains_why(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    plan = seeded_client.get("/api/astronauts/AST-001/exercise-plan", headers=ast1).json()
    assert plan["level"] == "standard" and [i["sets"] for i in plan["items"]] == [3, 3, 3]
    assert plan["items"][0]["howTo"] and plan["targetPerWeek"] is not None and plan["doneToday"] == 0

    _fatigue_history(seeded_client)
    plan = seeded_client.get("/api/astronauts/AST-001/exercise-plan", headers=ast1).json()
    assert plan["level"] == "lighter" and plan["restSeconds"] == 120
    assert [i["sets"] for i in plan["items"]] == [2, 2, 2]
    assert plan["adjustments"][0]["id"] == "lighter-recovery" and plan["adjustments"][0]["because"]
    # Earth staff can read it; another astronaut cannot
    assert (
        seeded_client.get(
            "/api/astronauts/AST-001/exercise-plan", headers=auth(seeded_client, "surgeon1")
        ).status_code
        == 200
    )
    assert (
        seeded_client.get(
            "/api/astronauts/AST-001/exercise-plan", headers=auth(seeded_client, "ast2")
        ).status_code
        == 403
    )


def test_saved_session_updates_counts_task_and_sync_once(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    # weekly log said 2 sessions yesterday; the routine asks for today's session
    yesterday = datetime.combine(NOW.date() - timedelta(days=1), time(6, 30), tzinfo=UTC)
    item = {
        "indicator": "exercise_sessions",
        "value": 2,
        "unit": "count",
        "measuredAt": yesterday.isoformat(),
    }
    r = seeded_client.post("/api/measurements/batch", json={"astronautId": "AST-001", "items": [item]},
                           headers=auth(seeded_client, "admin") | {"X-Backfill": "true"})  # fmt: skip
    assert r.status_code == 201
    with Session(seeded_client.app.state.engine) as session:  # type: ignore[attr-defined]
        ensure_routine_tasks(session, seeded_client.app.state.protocols)  # type: ignore[attr-defined]

    r = seeded_client.post("/api/exercise/sessions", json=_session(), headers=ast1)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["totalReps"] == 34 and out["formScore"] == round((90 * 10 + 80 * 9 + 100 * 15) / 34)
    assert out["summary"].startswith("2 exercises, 3 sets, 34 reps in 20 min")
    assert [r.value for r in _readings(seeded_client, "exercise_sessions")] == [2, 3]
    assert [r.value for r in _readings(seeded_client, "activity_min")] == [20]

    # sent again (offline outbox): same answer, nothing new
    again = seeded_client.post("/api/exercise/sessions", json=_session(), headers=ast1)
    assert again.status_code == 201 and again.json()["id"] == out["id"]
    # a second session the same day adds up
    second = _session(
        "ex-session-0002", startedAt=(NOW - timedelta(minutes=10)).isoformat(), finishedAt=NOW.isoformat()
    )
    assert seeded_client.post("/api/exercise/sessions", json=second, headers=ast1).status_code == 201
    assert [r.value for r in _readings(seeded_client, "exercise_sessions")] == [2, 3, 4]
    assert [r.value for r in _readings(seeded_client, "activity_min")][-1] == 30

    with Session(seeded_client.app.state.engine) as session:  # type: ignore[attr-defined]
        assert len(session.exec(select(ExerciseSession)).all()) == 2
        outbox = session.exec(select(SyncOutbox).where(SyncOutbox.entity_type == "ExerciseSession")).all()
        assert len(outbox) == 2
        tasks = session.exec(
            select(RecommendationTask).where(RecommendationTask.code == "REC-EXERCISE-SESSION")
        ).all()
        assert tasks and {t.status for t in tasks} == {"Done"}

    wellness = seeded_client.get("/api/astronauts/AST-001/wellness-center", headers=ast1).json()
    assert wellness["exerciseSessionsWeek"] == 4
    plan = seeded_client.get("/api/astronauts/AST-001/exercise-plan", headers=ast1).json()
    assert plan["doneToday"] == 2 and plan["recent"][0]["id"] == "ex-session-0002"
    staff = seeded_client.get(
        "/api/astronauts/AST-001/exercise-sessions", headers=auth(seeded_client, "surgeon1")
    )
    assert [s["id"] for s in staff.json()] == ["ex-session-0002", "ex-session-0001"]


def test_session_checks(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    bad = _session(exercises=[{"exercise": "bench", "sets": [{"reps": 5, "target": 5}]}])
    assert seeded_client.post("/api/exercise/sessions", json=bad, headers=ast1).status_code == 422
    too_long = _session(startedAt=(NOW - timedelta(hours=6)).isoformat())
    assert seeded_client.post("/api/exercise/sessions", json=too_long, headers=ast1).status_code == 422
    surgeon = auth(seeded_client, "surgeon1")
    assert seeded_client.post("/api/exercise/sessions", json=_session(), headers=surgeon).status_code == 403
    # a demo-playback session is stored as simulated data
    demo = _session("ex-demo-0001", source="demo")
    assert seeded_client.post("/api/exercise/sessions", json=demo, headers=ast1).status_code == 201
    assert all(r.is_simulated and r.device_id == "COACH" for r in _readings(seeded_client, "activity_min"))
    # nothing counted: stored, but no readings
    empty = _session("ex-empty-0001", exercises=[{"exercise": "squat", "sets": [{"reps": 0, "target": 10}]}])
    r = seeded_client.post("/api/exercise/sessions", json=empty, headers=ast1)
    assert r.status_code == 201 and r.json()["summary"] == "No repetitions were counted in this session."
    assert len(_readings(seeded_client, "exercise_sessions")) == 1
