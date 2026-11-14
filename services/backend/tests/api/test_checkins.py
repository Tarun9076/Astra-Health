from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import auth

CHECKIN: dict[str, Any] = {
    "sleepHours": 6.5,
    "sleepQuality": 7,
    "mood": 7,
    "stress": 3,
    "fatigue": 3,
    "completedInSeconds": 41,
}


def test_checkin_stores_scores_and_vitals(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    body = CHECKIN | {
        "vitals": [
            {"indicator": "bp_sys", "value": 118, "unit": "mmHg"},
            {"indicator": "bp_dia", "value": 76, "unit": "mmHg"},
            {"indicator": "body_temp", "value": 98.4, "unit": "°F"},
        ]
    }
    result = seeded_client.post("/api/checkins", json=body, headers=ast1)
    assert result.status_code == 201, result.text
    out = result.json()
    assert out["accepted"] == 8 and out["rejected"] == [] and out["newAlerts"] == []

    dash = seeded_client.get("/api/astronauts/AST-001/dashboard", headers=ast1).json()
    values = {v["indicator"]: v["value"] for v in dash["vitals"]}
    assert values["fatigue"] == 3 and values["body_temp"] == 36.9 and values["bp_sys"] == 118


def test_checkin_with_high_fever_raises_alert_immediately(seeded_client: TestClient) -> None:
    body = CHECKIN | {"vitals": [{"indicator": "body_temp", "value": 39.7, "unit": "°C"}]}
    out = seeded_client.post("/api/checkins", json=body, headers=auth(seeded_client, "ast1")).json()
    assert sorted(a["ruleId"] for a in out["newAlerts"]) == ["TH-FEVER", "TH-FEVER-HIGH"]


def test_inconsistent_blood_pressure_is_rejected_not_stored(seeded_client: TestClient) -> None:
    body = CHECKIN | {
        "vitals": [
            {"indicator": "bp_sys", "value": 70, "unit": "mmHg"},
            {"indicator": "bp_dia", "value": 90, "unit": "mmHg"},
        ]
    }
    out = seeded_client.post("/api/checkins", json=body, headers=auth(seeded_client, "ast1")).json()
    assert [p["reason"] for p in out["rejected"]] == ["bp_inconsistent", "bp_inconsistent"]


def test_only_astronauts_check_in_and_scores_are_validated(seeded_client: TestClient) -> None:
    surgeon = seeded_client.post("/api/checkins", json=CHECKIN, headers=auth(seeded_client, "surgeon1"))
    assert surgeon.status_code == 403
    bad = seeded_client.post(
        "/api/checkins", json=CHECKIN | {"mood": 11}, headers=auth(seeded_client, "ast1")
    )
    assert bad.status_code == 422


def test_profile_includes_mission(seeded_client: TestClient) -> None:
    me = seeded_client.get("/api/me", headers=auth(seeded_client, "surgeon1")).json()
    assert me["missionCode"] == "ARES-1" and me["missionStart"] == "2026-07-17"


def test_astronaut_completes_own_task(seeded_client: TestClient) -> None:
    ast1, ast2 = auth(seeded_client, "ast1"), auth(seeded_client, "ast2")
    body = CHECKIN | {"vitals": [{"indicator": "body_temp", "value": 38.2, "unit": "°C"}]}
    seeded_client.post("/api/checkins", json=body, headers=ast1)
    task = seeded_client.get("/api/astronauts/AST-001/dashboard", headers=ast1).json()["tasks"][0]
    assert seeded_client.post(f"/api/tasks/{task['id']}/complete", headers=ast2).status_code == 404
    done = seeded_client.post(f"/api/tasks/{task['id']}/complete", headers=ast1).json()
    assert done["status"] == "Done"
    remaining = seeded_client.get("/api/astronauts/AST-001/dashboard", headers=ast1).json()["tasks"]
    assert task["id"] not in {t["id"] for t in remaining}
