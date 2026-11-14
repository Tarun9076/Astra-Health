"""Alert lifecycle and dashboard through the API, using a high fever (no baseline needed)."""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import auth

T = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=30)


def _fever(client: TestClient) -> dict[str, Any]:
    body = {
        "astronautId": "AST-001",
        "items": [
            {"indicator": "body_temp", "value": 103.6, "unit": "°F", "measuredAt": T.isoformat()},
            {"indicator": "resting_hr", "value": 70, "unit": "bpm", "measuredAt": T.isoformat()},
        ],
    }
    response = client.post("/api/measurements/batch", json=body, headers=auth(client, "ast1"))
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


def test_fever_raises_urgent_alert_with_protocol_and_tasks(seeded_client: TestClient) -> None:
    result = _fever(seeded_client)
    rules = sorted(a["ruleId"] for a in result["newAlerts"])
    assert rules == ["TH-FEVER", "TH-FEVER-HIGH"]  # 103.6 °F = 39.8 °C

    ast1 = auth(seeded_client, "ast1")
    alerts = seeded_client.get("/api/astronauts/AST-001/alerts", headers=ast1).json()
    urgent = next(a for a in alerts if a["ruleId"] == "TH-FEVER-HIGH")
    assert urgent["severity"] == "Urgent" and urgent["status"] == "Open" and urgent["escalationRequired"]

    detail = seeded_client.get(f"/api/alerts/{urgent['id']}", headers=ast1).json()
    assert "39.8 °C" in detail["reason"]
    assert detail["evidence"]["body_temp"]["value"] == 39.8
    assert detail["emergencyProtocol"]["id"] == "EMG-FEVER"
    assert {t["code"] for t in detail["recommendations"]} >= {"REC-RECHECK-TEMP", "REC-CONTACT-SURGEON"}

    other = seeded_client.get(f"/api/alerts/{urgent['id']}", headers=auth(seeded_client, "ast2"))
    assert other.status_code == 403


def test_dashboard_goes_red_then_green_after_surgeon_resolves(seeded_client: TestClient) -> None:
    _fever(seeded_client)
    ast1, surgeon = auth(seeded_client, "ast1"), auth(seeded_client, "surgeon1")
    dash = seeded_client.get("/api/astronauts/AST-001/dashboard", headers=ast1).json()
    assert dash["status"] == "RED" and dash["missionCode"] == "ARES-1"
    assert {v["indicator"] for v in dash["vitals"]} == {"body_temp", "resting_hr"}
    assert dash["tasks"] and dash["simulatedData"] is True

    for alert in dash["activeAlerts"]:
        url = f"/api/alerts/{alert['id']}"
        assert seeded_client.post(f"{url}/acknowledge", headers=ast1).json()["status"] == "Acknowledged"
        assert seeded_client.post(f"{url}/review", json={}, headers=surgeon).json()["status"] == "InReview"
        no_note = seeded_client.post(f"{url}/resolve", json={}, headers=surgeon)
        assert no_note.status_code == 409 and "note is required" in no_note.json()["detail"]
        resolved = seeded_client.post(f"{url}/resolve", json={"note": "Recheck 37.1 °C"}, headers=surgeon)
        assert resolved.json()["status"] == "Resolved"

    after = seeded_client.get("/api/astronauts/AST-001/dashboard", headers=ast1).json()
    assert after["status"] == "GREEN"
    assert after["tasks"] == []  # tasks raised by the resolved alerts closed with them


def test_roles_are_enforced_on_alert_actions(seeded_client: TestClient) -> None:
    alert_id = _fever(seeded_client)["newAlerts"][0]["id"]
    url = f"/api/alerts/{alert_id}"
    assert (
        seeded_client.post(f"{url}/review", json={}, headers=auth(seeded_client, "ast1")).status_code == 403
    )
    assert (
        seeded_client.post(f"{url}/acknowledge", headers=auth(seeded_client, "surgeon1")).status_code == 403
    )
    dash = seeded_client.get("/api/astronauts/AST-001/dashboard", headers=auth(seeded_client, "mission1"))
    assert dash.status_code == 403  # mission control sees status only, not vitals
