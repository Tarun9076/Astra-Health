from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, func, select

from astra.db.models import AuditLog, HealthMeasurement, SyncOutbox
from tests.conftest import auth

T0 = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=2)


def _reading(indicator: str, value: float, unit: str, minutes: int = 0, **extra: Any) -> dict[str, Any]:
    return {
        "indicator": indicator,
        "value": value,
        "unit": unit,
        "measuredAt": (T0 + timedelta(minutes=minutes)).isoformat(),
        **extra,
    }


def _post(
    client: TestClient, items: list[dict[str, Any]], backfill: bool = False, user: str = "ast1"
) -> dict[str, Any]:
    headers = auth(client, user) | ({"X-Backfill": "true"} if backfill else {})
    response = client.post(
        "/api/measurements/batch", json={"astronautId": "AST-001", "items": items}, headers=headers
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def test_crew_list_depends_on_role(seeded_client: TestClient) -> None:
    crew = seeded_client.get("/api/astronauts", headers=auth(seeded_client, "surgeon1")).json()
    assert [a["code"] for a in crew] == ["AST-001", "AST-002", "AST-003"]
    assert crew[0]["missionCode"] == "ARES-1"
    mine = seeded_client.get("/api/astronauts", headers=auth(seeded_client, "ast2")).json()
    assert [a["code"] for a in mine] == ["AST-002"]


def test_batch_sorts_readings_into_accepted_questionable_rejected(seeded_client: TestClient) -> None:
    body = _post(
        seeded_client,
        [
            _reading("resting_hr", 64, "bpm"),
            _reading("glucose", 5.5, "mmol/L", 1),
            _reading("heart_rate", 300, "bpm", 2),  # T-V-03
            _reading("heart_rate", 120, "bpm", 3, signalQuality=0.3, deviceId="WR-1"),
            _reading("bp_sys", 80, "mmHg", 4, panelId="P1"),  # T-V-05
            _reading("bp_dia", 95, "mmHg", 4, panelId="P1"),
        ],
    )
    assert len(body["accepted"]) == 2
    assert [p["reason"] for p in body["questionable"]] == ["low_signal"]
    assert sorted(p["reason"] for p in body["rejected"]) == [
        "bp_inconsistent",
        "bp_inconsistent",
        "implausible",
    ]
    assert body["newAlerts"] == [] and body["evaluations"] == 1


def test_same_reading_twice_is_stored_once(seeded_client: TestClient) -> None:
    # T-V-04: idempotent by id, and by (indicator, time, device) when no id is sent
    items = [
        _reading("resting_hr", 64, "bpm", 10, id="0193a6f2-7c1e-7b10-9a11-2f6f3c1b0001"),
        _reading("spo2", 98, "%", 11, deviceId="OX-1"),
    ]
    first = _post(seeded_client, items)
    second = _post(seeded_client, items)
    assert len(first["accepted"]) == 2
    assert second["accepted"] == [] and sorted(second["duplicates"]) == sorted(first["accepted"])

    engine = seeded_client.app.state.engine  # type: ignore[attr-defined]
    with Session(engine) as session:
        assert session.exec(select(func.count()).select_from(HealthMeasurement)).one() == 2
        assert session.exec(select(func.count()).select_from(SyncOutbox)).one() == 2  # queued for Earth
        assert session.exec(select(func.count()).select_from(AuditLog)).one() == 2  # one per batch


def test_astronauts_can_only_post_and_read_their_own_data(seeded_client: TestClient) -> None:
    ast2 = auth(seeded_client, "ast2")
    body = {"astronautId": "AST-001", "items": [_reading("mood", 7, "score")]}
    assert seeded_client.post("/api/measurements/batch", json=body, headers=ast2).status_code == 403
    read = seeded_client.get(
        "/api/astronauts/AST-001/measurements", params={"indicator": "mood"}, headers=ast2
    )
    assert read.status_code == 403
    surgeon_read = seeded_client.get(
        "/api/astronauts/AST-001/measurements",
        params={"indicator": "mood"},
        headers=auth(seeded_client, "surgeon1"),
    )
    assert surgeon_read.status_code == 200


def test_admin_may_post_for_anyone_mission_control_may_not(seeded_client: TestClient) -> None:
    assert _post(seeded_client, [_reading("mood", 7, "score")], user="admin")["accepted"]
    body = {"astronautId": "AST-001", "items": [_reading("mood", 6, "score", 5)]}
    response = seeded_client.post(
        "/api/measurements/batch", json=body, headers=auth(seeded_client, "mission1")
    )
    assert response.status_code == 403


def test_unknown_astronaut_is_404(seeded_client: TestClient) -> None:
    response = seeded_client.post(
        "/api/measurements/batch",
        json={"astronautId": "AST-999", "items": [_reading("mood", 7, "score")]},
        headers=auth(seeded_client, "admin"),
    )
    assert response.status_code == 404


def test_naive_timestamp_is_refused(seeded_client: TestClient) -> None:
    item = _reading("mood", 7, "score") | {"measuredAt": "2026-11-14T07:00:00"}
    response = seeded_client.post(
        "/api/measurements/batch",
        json={"astronautId": "AST-001", "items": [item]},
        headers=auth(seeded_client, "ast1"),
    )
    assert response.status_code == 422


def test_daily_buckets_average_valid_readings_only(seeded_client: TestClient) -> None:
    day = datetime(2026, 11, 10, tzinfo=UTC)
    values = ((60, 6), (64, 7), (68, 8), (400, 9))  # 400 bpm is implausible → rejected, not averaged
    items = [
        {
            "indicator": "resting_hr",
            "value": v,
            "unit": "bpm",
            "measuredAt": (day + timedelta(hours=h)).isoformat(),
        }
        for v, h in values
    ]
    _post(seeded_client, items, backfill=True)

    series = seeded_client.get(
        "/api/astronauts/AST-001/measurements",
        params={"indicator": "resting_hr", "bucket": "day"},
        headers=auth(seeded_client, "ast1"),
    ).json()
    assert series["unit"] == "bpm"
    assert [(p["value"], p["min"], p["max"], p["n"]) for p in series["points"]] == [(64.0, 60.0, 68.0, 3)]


def test_radiation_is_stored_per_channel(seeded_client: TestClient) -> None:
    _post(
        seeded_client,
        [
            _reading("radiation_dose", 640, "uSv", 0),
            _reading("radiation_dose", 0.19, "mSv", 0, channel="Neutron"),
        ],
    )
    headers = auth(seeded_client, "ast1")
    url = "/api/astronauts/AST-001/measurements"
    total = seeded_client.get(url, params={"indicator": "radiation_dose"}, headers=headers).json()
    neutron = seeded_client.get(
        url, params={"indicator": "radiation_dose", "channel": "Neutron"}, headers=headers
    ).json()
    assert [p["value"] for p in total["points"]] == [0.64]
    assert [p["value"] for p in neutron["points"]] == [0.19]
