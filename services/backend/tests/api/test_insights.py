"""AI insights through the API, and ML failures never blocking alerts (T-ML-02)."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from astra.db.models import Insight
from astra.services import insights as ml_insights
from astra.services.crew import find_astronaut
from tests.conftest import auth

T = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=30)
FEVER = {
    "astronautId": "AST-001",
    "items": [{"indicator": "body_temp", "value": 39.8, "unit": "°C", "measuredAt": T.isoformat()}],
}


def test_ml_failure_never_blocks_measurements_or_alerts(
    seeded_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # T-ML-02: the ML raises → the batch is still stored (201) and the rule alerts are still raised
    def broken(*_: object) -> list[ml_insights.Found]:
        raise RuntimeError("model file corrupt")

    monkeypatch.setattr(ml_insights, "detect", broken)
    response = seeded_client.post("/api/measurements/batch", json=FEVER, headers=auth(seeded_client, "ast1"))
    assert response.status_code == 201, response.text
    assert {a["ruleId"] for a in response.json()["newAlerts"]} == {"TH-FEVER", "TH-FEVER-HIGH"}


def _add_insight(client: TestClient) -> None:
    engine = client.app.state.engine  # type: ignore[attr-defined]
    with Session(engine) as session:
        ast1 = find_astronaut(session, "AST-001")
        assert ast1 is not None
        day = T.date()
        contributors = [{"indicator": "body_temp", "value": 4.2}, {"indicator": "resting_hr", "value": 2.1}]
        session.add(
            Insight(
                id="0190-test-insight",
                astronaut_id=ast1.id,
                kind="Anomaly",
                insight_date=day,
                score=0.71,
                indicator_codes="body_temp,resting_hr",
                contributors_json=json.dumps(contributors),
                explanation="Today's combination of readings is unusual for you (anomaly score 0.71).",
                window_start=day,
                window_end=day,
                model_version="iforest-1:test",
            )
        )
        session.commit()


def test_insights_are_listed_and_shown_on_related_alerts(seeded_client: TestClient) -> None:
    _add_insight(seeded_client)
    ast1 = auth(seeded_client, "ast1")
    rows = seeded_client.get("/api/astronauts/AST-001/insights", headers=ast1).json()
    assert [(r["kind"], r["score"]) for r in rows] == [("Anomaly", 0.71)]
    assert (
        rows[0]["contributors"][0]["indicator"] == "body_temp" and rows[0]["contributors"][0]["value"] == 4.2
    )

    created = seeded_client.post("/api/measurements/batch", json=FEVER, headers=ast1).json()["newAlerts"]
    fever = next(a for a in created if a["ruleId"] == "TH-FEVER")
    detail = seeded_client.get(f"/api/alerts/{fever['id']}", headers=ast1).json()
    assert [i["kind"] for i in detail["insights"]] == ["Anomaly"]  # it involves body temperature


def test_insights_follow_the_same_access_rules(seeded_client: TestClient) -> None:
    _add_insight(seeded_client)
    other = seeded_client.get("/api/astronauts/AST-001/insights", headers=auth(seeded_client, "ast2"))
    assert other.status_code == 403
    surgeon = seeded_client.get(
        "/api/astronauts/AST-001/insights?range=mission", headers=auth(seeded_client, "surgeon1")
    )
    assert surgeon.status_code == 200 and len(surgeon.json()) == 1
