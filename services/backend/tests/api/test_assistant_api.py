"""AI Health Assistant through the API (Step 7 "done when")."""

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from tests.assistant.test_assistant import fake_claude, reply
from tests.conftest import auth

QUESTION = "Why is my resting heart rate increasing?"


def _seed_readings(client: TestClient) -> None:
    t = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=30)
    body = {
        "astronautId": "AST-001",
        "items": [{"indicator": "resting_hr", "value": 70, "unit": "bpm", "measuredAt": t.isoformat()}],
    }
    assert client.post("/api/measurements/batch", json=body, headers=auth(client, "ast1")).status_code == 201


def test_chest_pain_shows_the_emergency_protocol_and_raises_an_urgent_alert(
    seeded_client: TestClient,
) -> None:
    ast1 = auth(seeded_client, "ast1")
    out = seeded_client.post(
        "/api/assistant/chat", json={"question": "I have chest pain"}, headers=ast1
    ).json()
    assert (out["mode"], out["provider"], out["emergencyProtocolId"]) == (
        "emergency",
        "redflag",
        "EMG-CHEST-PAIN",
    )
    assert out["alertId"]

    alert = seeded_client.get(f"/api/alerts/{out['alertId']}", headers=ast1).json()
    assert (alert["ruleId"], alert["severity"], alert["status"]) == ("SYM-CHEST-PAIN", "Urgent", "Open")
    assert alert["escalationRequired"] and alert["emergencyProtocol"]["id"] == "EMG-CHEST-PAIN"
    assert {t["code"] for t in alert["recommendations"]} == {"REC-CONTACT-SURGEON"}
    assert seeded_client.get("/api/astronauts/AST-001/dashboard", headers=ast1).json()["status"] == "RED"

    again = seeded_client.post(
        "/api/assistant/chat", json={"question": "chest pain again"}, headers=ast1
    ).json()
    assert again["alertId"] == out["alertId"]  # same active alert, seen twice
    assert seeded_client.get(f"/api/alerts/{out['alertId']}", headers=ast1).json()["triggerCount"] == 2


def test_hypothetical_question_shows_protocol_without_an_alert(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    out = seeded_client.post(
        "/api/assistant/chat", json={"question": "What should I do if I get chest pain?"}, headers=ast1
    ).json()
    assert out["emergencyProtocolId"] == "EMG-CHEST-PAIN" and out["alertId"] is None
    assert seeded_client.get("/api/astronauts/AST-001/alerts", headers=ast1).json() == []


def test_same_question_answers_via_template_then_claude(seeded_client: TestClient) -> None:
    _seed_readings(seeded_client)
    ast1 = auth(seeded_client, "ast1")
    status = seeded_client.get("/api/assistant/status", headers=ast1).json()
    assert status["defaultProvider"] == "template" and not status["claudeConfigured"]
    assert status["knowledgeNotes"] >= 25 and status["redFlags"] == 6

    offline = seeded_client.post("/api/assistant/chat", json={"question": QUESTION}, headers=ast1).json()
    assert (offline["mode"], offline["provider"]) == ("template", "template")
    assert "Your resting heart rate is 70 bpm" in offline["answer"] and offline["citations"]

    assistant = seeded_client.app.state.assistant  # type: ignore[attr-defined]
    chunk = offline["citations"][0]["chunkId"]
    assistant.claude = fake_claude(reply("Your resting heart rate is 70 bpm today.", [chunk]))
    try:
        online = seeded_client.post("/api/assistant/chat", json={"question": QUESTION}, headers=ast1).json()
    finally:
        assistant.claude = None
    assert (online["mode"], online["provider"]) == ("llm", "claude")
    assert [c["chunkId"] for c in online["citations"]] == [chunk]

    history = seeded_client.get("/api/assistant/history", headers=ast1).json()
    assert [(h["role"], h["provider"]) for h in history] == [
        ("user", None), ("assistant", "template"), ("user", None), ("assistant", "claude"),
    ]  # fmt: skip


def test_assistant_roles(seeded_client: TestClient) -> None:
    surgeon = auth(seeded_client, "surgeon1")
    assert (
        seeded_client.post("/api/assistant/chat", json={"question": QUESTION}, headers=surgeon).status_code
        == 400
    )
    ok = seeded_client.post(
        "/api/assistant/chat",
        json={"question": "I have chest pain", "astronautId": "AST-002"},
        headers=surgeon,
    ).json()
    assert (
        ok["emergencyProtocolId"] == "EMG-CHEST-PAIN" and ok["alertId"] is None
    )  # only astronauts self-report

    mission = auth(seeded_client, "mission1")
    assert (
        seeded_client.post("/api/assistant/chat", json={"question": QUESTION}, headers=mission).status_code
        == 403
    )
    other = seeded_client.post(
        "/api/assistant/chat",
        json={"question": QUESTION, "astronautId": "AST-002"},
        headers=auth(seeded_client, "ast1"),
    )
    assert other.status_code == 403
