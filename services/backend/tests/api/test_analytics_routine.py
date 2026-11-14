from datetime import UTC, datetime, time, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from astra.db.models import RecommendationTask
from astra.services.routine import ensure_routine_tasks
from tests.conftest import auth

TODAY = datetime.now(UTC).date()


def _post_history(
    client: TestClient, values: list[float], indicator: str = "resting_hr", unit: str = "bpm"
) -> None:
    """One reading per day at 06:30, ending yesterday."""
    start = TODAY - timedelta(days=len(values))
    items: list[dict[str, Any]] = [
        {
            "indicator": indicator,
            "value": v,
            "unit": unit,
            "measuredAt": datetime.combine(start + timedelta(days=i), time(6, 30), tzinfo=UTC).isoformat(),
        }
        for i, v in enumerate(values)
    ]
    headers = auth(client, "admin") | {"X-Backfill": "true"}
    response = client.post(
        "/api/measurements/batch", json={"astronautId": "AST-001", "items": items}, headers=headers
    )
    assert response.status_code == 201, response.text


def test_analytics_returns_daily_values_with_personal_band(seeded_client: TestClient) -> None:
    _post_history(seeded_client, [64, 65, 63, 64, 66, 62, 64, 65, 63, 64] * 2 + [80, 85, 90])
    body = seeded_client.get(
        "/api/astronauts/AST-001/analytics",
        params={"indicator": "resting_hr", "range": "30d"},
        headers=auth(seeded_client, "ast1"),
    ).json()
    assert body["name"] == "Resting heart rate" and body["unit"] == "bpm" and body["hasBaseline"] is True
    days = {d["day"]: d for d in body["days"]}
    assert len(body["days"]) == 30
    last = days[str(TODAY - timedelta(days=1))]
    assert last["value"] == 90 and last["median"] == 64 and last["low"] == 58 and last["high"] == 70
    assert last["z"] is not None and last["z"] > 5
    assert [a["ruleId"] for a in body["alerts"]] == ["CV-RHR-BASELINE"]  # alert marker on the chart


def test_analytics_access_and_unknown_indicator(seeded_client: TestClient) -> None:
    url = "/api/astronauts/AST-001/analytics"
    assert (
        seeded_client.get(url, params={"indicator": "mood"}, headers=auth(seeded_client, "ast2")).status_code
        == 403
    )
    assert (
        seeded_client.get(url, params={"indicator": "pulse"}, headers=auth(seeded_client, "ast1")).status_code
        == 404
    )


def test_wellness_is_on_the_dashboard_and_stored_daily(seeded_client: TestClient) -> None:
    _post_history(seeded_client, [64, 65, 63, 64, 66, 62, 64, 65, 63, 64] * 2 + [80, 85, 90])
    ast1 = auth(seeded_client, "ast1")
    dash = seeded_client.get("/api/astronauts/AST-001/dashboard", headers=ast1).json()
    assert dash["wellnessIndex"] == dash["wellness"]["overall"] and dash["wellnessIndex"] <= 75  # alert cap
    cardio = next(d for d in dash["wellness"]["domains"] if d["domain"] == "Cardiovascular")
    assert any("resting_hr" in r for r in cardio["reasons"])
    trend = seeded_client.get(
        "/api/astronauts/AST-001/wellness", params={"range": "30d"}, headers=ast1
    ).json()
    assert len(trend) == 23 and trend[0]["overall"] == 100 and trend[-1]["overall"] <= 75


def test_routine_tasks_are_created_once_and_checkin_ticks_off_the_reminder(seeded_client: TestClient) -> None:
    engine = seeded_client.app.state.engine  # type: ignore[attr-defined]
    bundle = seeded_client.app.state.protocols  # type: ignore[attr-defined]
    with Session(engine) as session:
        assert ensure_routine_tasks(session, bundle) == 6  # check-in reminder + hydration for 3 crew
        assert ensure_routine_tasks(session, bundle) == 0  # idempotent

    ast1 = auth(seeded_client, "ast1")
    body = {"sleepHours": 7, "sleepQuality": 7, "mood": 7, "stress": 3, "fatigue": 3}
    assert seeded_client.post("/api/checkins", json=body, headers=ast1).status_code == 201
    with Session(engine) as session:
        assert ensure_routine_tasks(session, bundle) == 0  # reminder done; not re-created today
        tasks = session.exec(
            select(RecommendationTask).where(RecommendationTask.code == "REC-WELLNESS-CHECKIN")
        ).all()
        assert sorted(t.status for t in tasks) == ["Done", "Pending", "Pending"]


def test_exercise_task_when_behind_target(seeded_client: TestClient) -> None:
    _post_history(seeded_client, [2], indicator="exercise_sessions", unit="count")
    engine = seeded_client.app.state.engine  # type: ignore[attr-defined]
    with Session(engine) as session:
        ensure_routine_tasks(session, seeded_client.app.state.protocols)  # type: ignore[attr-defined]
        codes = set(session.exec(select(RecommendationTask.code)).all())
    assert "REC-EXERCISE-SESSION" in codes


def test_old_routine_tasks_are_skipped_next_day(seeded_client: TestClient) -> None:
    engine = seeded_client.app.state.engine  # type: ignore[attr-defined]
    bundle = seeded_client.app.state.protocols  # type: ignore[attr-defined]
    yesterday = datetime.now(UTC) - timedelta(days=1)
    with Session(engine) as session:
        ensure_routine_tasks(session, bundle, now=yesterday)
        ensure_routine_tasks(session, bundle)
        statuses = [t.status for t in session.exec(select(RecommendationTask)).all()]
    assert statuses.count("Skipped") == 6 and statuses.count("Pending") == 6
