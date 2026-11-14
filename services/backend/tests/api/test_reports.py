"""Medical reports, surgeon instructions, crew summary and surgeon-read audit (Step 8)."""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from astra.db.models import AuditLog, MedicalReport, SyncOutbox
from astra.services.reports import ensure_reports
from tests.assistant.test_assistant import fake_claude
from tests.conftest import auth

NOW = datetime.now(UTC).replace(microsecond=0)


def _post(client: TestClient, items: list[dict[str, Any]], backfill: bool = False) -> dict[str, Any]:
    headers = auth(client, "ast1") | ({"X-Backfill": "true"} if backfill else {})
    response = client.post(
        "/api/measurements/batch", json={"astronautId": "AST-001", "items": items}, headers=headers
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


def _history_and_fever(client: TestClient) -> None:
    """Ten quiet days of resting HR and sleep, then a high fever today (Urgent alert)."""
    items = []
    for d in range(10, 0, -1):
        t = (NOW - timedelta(days=d)).replace(hour=7, minute=0, second=0)
        items += [
            {"indicator": "resting_hr", "value": 62 + d % 3, "unit": "bpm", "measuredAt": t.isoformat()},
            {
                "indicator": "sleep_hours",
                "value": 7.0 + (d % 2) * 0.3,
                "unit": "h",
                "measuredAt": t.isoformat(),
            },
        ]
    _post(client, items, backfill=True)
    t = (NOW - timedelta(minutes=20)).isoformat()
    _post(client, [{"indicator": "body_temp", "value": 39.8, "unit": "°C", "measuredAt": t}])


def _engine(client: TestClient) -> Any:
    return client.app.state.engine  # type: ignore[attr-defined]


def _ensure(client: TestClient, narrator: Any = None) -> list[MedicalReport]:
    with Session(_engine(client)) as session:
        reports = ensure_reports(
            session,
            client.app.state.protocols,
            node_id="TEST",
            narrator=narrator,  # type: ignore[attr-defined]
        )
        for r in reports:
            session.refresh(r)
            session.expunge(r)
        return reports


def test_automatic_reports_are_created_once(seeded_client: TestClient) -> None:
    _history_and_fever(seeded_client)
    created = _ensure(seeded_client)
    # the live fever reading already produced its alert report; the loop adds daily + weekly only
    assert sorted(r.type for r in created) == ["Daily", "Weekly"]
    assert _ensure(seeded_client) == []  # idempotent
    with Session(_engine(seeded_client)) as session:
        alert_report = session.exec(select(MedicalReport).where(MedicalReport.type == "AlertTriggered")).one()
        assert alert_report.alert_id and alert_report.transmission_status == "Queued"
        queued = session.exec(select(SyncOutbox).where(SyncOutbox.entity_id == alert_report.id)).one()
    assert queued.priority == 1  # Urgent alert → sent first on the next link window


def test_report_content_and_access(seeded_client: TestClient) -> None:
    _history_and_fever(seeded_client)
    _ensure(seeded_client)
    ast1 = auth(seeded_client, "ast1")
    reports = seeded_client.get("/api/astronauts/AST-001/reports", headers=ast1).json()
    alert_report = next(r for r in reports if r["type"] == "AlertTriggered")
    detail = seeded_client.get(f"/api/reports/{alert_report['id']}", headers=ast1).json()
    assert detail["narrativeProvider"] == "template"
    assert "Body temperature outside the critical range (Urgent, open" in detail["narrative"]
    assert "Active alerts:" in detail["narrative"] and "Decision support only" in detail["narrative"]
    temp = next(i for i in detail["summary"]["indicators"] if i["indicator"] == "body_temp")
    assert temp["max"] == 39.8
    assert any(a["severity"] == "Urgent" for a in detail["summary"]["alerts"])

    assert (
        seeded_client.get(
            f"/api/reports/{alert_report['id']}", headers=auth(seeded_client, "ast2")
        ).status_code
        == 403
    )
    assert (
        seeded_client.get("/api/astronauts/AST-001/reports", headers=auth(seeded_client, "ast2")).status_code
        == 403
    )


def test_on_demand_report_uses_claude_when_configured(seeded_client: TestClient) -> None:
    _history_and_fever(seeded_client)
    surgeon = auth(seeded_client, "surgeon1")
    period = {"start": (NOW - timedelta(days=6)).date().isoformat(), "end": NOW.date().isoformat()}

    offline = seeded_client.post("/api/astronauts/AST-001/reports", json=period, headers=surgeon)
    assert offline.status_code == 201 and offline.json()["narrativeProvider"] == "template"

    assistant = seeded_client.app.state.assistant  # type: ignore[attr-defined]
    from types import SimpleNamespace

    good = SimpleNamespace(
        stop_reason="end_turn",
        content=[
            SimpleNamespace(
                type="text",
                text='{"narrative": "Resting heart rate stayed near normal; an urgent fever alert is open."}',
            )
        ],
    )
    bad = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(
        type="text", text='{"narrative": "You have pneumonia; take 400 mg ibuprofen."}')])  # fmt: skip
    assistant.claude = fake_claude(good, bad)
    try:
        online = seeded_client.post("/api/astronauts/AST-001/reports", json=period, headers=surgeon).json()
        guarded = seeded_client.post("/api/astronauts/AST-001/reports", json=period, headers=surgeon).json()
    finally:
        assistant.claude = None
    assert online["narrativeProvider"] == "claude" and "urgent fever alert" in online["narrative"]
    assert guarded["narrativeProvider"] == "template"  # diagnosis + dose → rejected, template used

    too_long = {"start": (NOW - timedelta(days=40)).date().isoformat(), "end": NOW.date().isoformat()}
    assert (
        seeded_client.post("/api/astronauts/AST-001/reports", json=too_long, headers=surgeon).status_code
        == 422
    )
    mission = auth(seeded_client, "mission1")
    assert (
        seeded_client.post("/api/astronauts/AST-001/reports", json=period, headers=mission).status_code == 403
    )


def test_instruction_reaches_the_astronaut_live_and_is_acknowledged(seeded_client: TestClient) -> None:
    ast1_token = auth(seeded_client, "ast1")["Authorization"].removeprefix("Bearer ")
    surgeon = auth(seeded_client, "surgeon1")
    with seeded_client.websocket_connect(f"/ws?token={ast1_token}") as ws:
        assert ws.receive_json()["type"] == "Connected"
        sent = seeded_client.post(
            "/api/instructions",
            json={"astronautId": "AST-001", "text": "Rest today and recheck resting HR at wake-up tomorrow."},
            headers=surgeon,
        )
        assert sent.status_code == 201, sent.text
        event = ws.receive_json()
    assert event["type"] == "InstructionReceived" and event["payload"]["text"].startswith("Rest today")
    instruction = sent.json()
    assert instruction["fromName"] and instruction["deliveredAt"] and instruction["acknowledgedAt"] is None

    ast1 = auth(seeded_client, "ast1")
    listed = seeded_client.get("/api/astronauts/AST-001/instructions", headers=ast1).json()
    assert [i["id"] for i in listed] == [instruction["id"]]
    acked = seeded_client.post(f"/api/instructions/{instruction['id']}/acknowledge", headers=ast1).json()
    assert acked["acknowledgedAt"]

    ast2 = auth(seeded_client, "ast2")
    assert (
        seeded_client.post(f"/api/instructions/{instruction['id']}/acknowledge", headers=ast2).status_code
        == 404
    )
    body = {"astronautId": "AST-002", "text": "Please rest."}
    assert seeded_client.post("/api/instructions", json=body, headers=ast1).status_code == 403
    assert (
        seeded_client.post(
            "/api/instructions", json=body, headers=auth(seeded_client, "mission1")
        ).status_code
        == 403
    )


def test_crew_summary_by_role(seeded_client: TestClient) -> None:
    _history_and_fever(seeded_client)
    surgeon = seeded_client.get("/api/crew/summary", headers=auth(seeded_client, "surgeon1")).json()
    ast1 = next(r for r in surgeon if r["code"] == "AST-001")
    assert ast1["status"] == "RED" and ast1["urgentAlerts"] >= 1 and ast1["topAlert"]
    assert ast1["alertsAwaitingReview"] >= 1 and ast1["lastReadingAt"]
    assert next(r for r in surgeon if r["code"] == "AST-002")["status"] == "GREEN"

    mission = seeded_client.get("/api/crew/summary", headers=auth(seeded_client, "mission1")).json()
    row = next(r for r in mission if r["code"] == "AST-001")
    assert row["status"] == "RED" and row["topAlert"] is None and row["wellnessIndex"] is None  # status only
    assert seeded_client.get("/api/crew/summary", headers=auth(seeded_client, "ast1")).status_code == 403


def test_surgeon_reads_are_audited_without_flooding(seeded_client: TestClient) -> None:
    surgeon = auth(seeded_client, "surgeon1")
    for _ in range(3):
        assert seeded_client.get("/api/astronauts/AST-002/dashboard", headers=surgeon).status_code == 200
    seeded_client.get("/api/astronauts/AST-002/dashboard", headers=auth(seeded_client, "ast2"))  # not audited
    with Session(_engine(seeded_client)) as session:
        rows = session.exec(select(AuditLog).where(AuditLog.action == "SurgeonRead")).all()
    assert [(r.entity_id, r.details) for r in rows] == [("AST-002", '{"data": "dashboard"}')]
