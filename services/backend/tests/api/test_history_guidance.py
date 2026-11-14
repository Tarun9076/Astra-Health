"""UI redesign APIs: check-in symptoms, idempotent re-send, timeline, guidance, richer vitals."""

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from tests.conftest import auth

CHECKIN = {"sleepHours": 7, "sleepQuality": 7, "mood": 7, "stress": 3, "fatigue": 3}


def test_symptom_catalog_marks_red_flags(seeded_client: TestClient) -> None:
    rows = seeded_client.get("/api/catalog/symptoms", headers=auth(seeded_client, "ast1")).json()
    by_code = {r["code"]: r for r in rows}
    assert by_code["chest_pain"]["redFlag"] and by_code["chest_pain"]["protocol"] == "EMG-CHEST-PAIN"
    assert not by_code["headache"]["redFlag"] and by_code["headache"]["protocol"] is None


def test_checkin_symptoms_are_stored_and_red_flags_raise_urgent(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    body = {
        **CHECKIN,
        "symptoms": [{"code": "headache", "severity": 3}, {"code": "chest_pain", "severity": 7}],
    }
    r = seeded_client.post("/api/checkins", json=body, headers=ast1)
    assert r.status_code == 201, r.text
    new = r.json()["newAlerts"]
    assert [a["ruleId"] for a in new] == ["SYM-CHEST-PAIN"] and new[0]["severity"] == "Urgent"
    assert new[0]["protocol"] == "EMG-CHEST-PAIN"
    timeline = seeded_client.get("/api/astronauts/AST-001/timeline?days=1", headers=ast1).json()["events"]
    symptoms = {e["title"]: e for e in timeline if e["kind"] == "Symptom"}
    assert "Symptom reported: Headache" in symptoms
    assert symptoms["Symptom reported: Chest pain or pressure"]["severity"] == "Urgent"


def test_headache_alone_raises_no_alert(seeded_client: TestClient) -> None:
    body = {**CHECKIN, "symptoms": [{"code": "headache", "severity": 4}]}
    r = seeded_client.post("/api/checkins", json=body, headers=auth(seeded_client, "ast2"))
    assert r.json()["newAlerts"] == []


def test_resent_checkin_is_a_no_op(seeded_client: TestClient) -> None:
    ast3 = auth(seeded_client, "ast3")
    body = {**CHECKIN, "id": "0190f0a0-0000-7000-8000-000000000001"}
    first = seeded_client.post("/api/checkins", json=body, headers=ast3)
    again = seeded_client.post("/api/checkins", json=body, headers=ast3)
    assert first.status_code == 201 and again.status_code == 201
    assert first.json()["accepted"] == 5 and again.json()["accepted"] == 0
    timeline = seeded_client.get("/api/astronauts/AST-003/timeline?days=1", headers=ast3).json()["events"]
    assert sum(e["kind"] == "Checkin" for e in timeline) == 1


def test_timeline_has_daily_readings_alerts_and_tasks(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    t = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
    seeded_client.post(
        "/api/measurements/batch",
        json={
            "astronautId": "AST-001",
            "items": [{"indicator": "body_temp", "value": 39.8, "unit": "°C", "measuredAt": t}],
        },
        headers=ast1,
    )
    out = seeded_client.get("/api/astronauts/AST-001/timeline?days=2", headers=ast1).json()
    kinds = {e["kind"] for e in out["events"]}
    assert {"Readings", "Alert", "Recommendation"} <= kinds
    readings = next(e for e in out["events"] if e["kind"] == "Readings")
    assert "Temp 39.8 °C" in readings["detail"]
    ats = [e["at"] for e in out["events"]]
    assert ats == sorted(ats, reverse=True)  # newest first


def test_guidance_lists_tasks_with_their_alert_and_the_library(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    t = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
    seeded_client.post(
        "/api/measurements/batch",
        json={
            "astronautId": "AST-001",
            "items": [{"indicator": "body_temp", "value": 39.8, "unit": "°C", "measuredAt": t}],
        },
        headers=ast1,
    )
    g = seeded_client.get("/api/astronauts/AST-001/guidance", headers=ast1).json()
    linked = [i for i in g["items"] if i["alert"]]
    assert linked and linked[0]["alert"]["severity"] == "Urgent" and linked[0]["medicalReview"] is True
    assert len(g["library"]) == 22 and all(item["source"] for item in g["library"])


def test_astronaut_cannot_read_another_astronauts_history(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    for path in ("timeline", "guidance"):
        assert seeded_client.get(f"/api/astronauts/AST-002/{path}", headers=ast1).status_code == 403


def test_dashboard_vitals_show_previous_reading_and_source(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    now = datetime.now(UTC)
    items = [
        {
            "indicator": "mood",
            "value": v,
            "unit": "score",
            "measuredAt": (now - timedelta(minutes=m)).isoformat(),
        }
        for v, m in ((6, 30), (4, 5))
    ]
    seeded_client.post(
        "/api/measurements/batch", json={"astronautId": "AST-001", "items": items}, headers=ast1
    )
    vitals = {
        v["indicator"]: v
        for v in seeded_client.get("/api/astronauts/AST-001/dashboard", headers=ast1).json()["vitals"]
    }
    mood = vitals["mood"]
    assert mood["value"] == 4 and mood["previousValue"] == 6
    assert mood["source"] == "Manual" and mood["quality"] == "Valid"
