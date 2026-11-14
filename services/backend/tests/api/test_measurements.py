from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, func, select

from astra.db.models import AuditLog, HealthMeasurement, SyncOutbox

T0 = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=2)


def _reading(indicator: str, value: float, unit: str, minutes: int = 0, **extra: Any) -> dict[str, Any]:
    return {"indicator": indicator, "value": value, "unit": unit,
            "measuredAt": (T0 + timedelta(minutes=minutes)).isoformat(), **extra}  # fmt: skip


def _post(client: TestClient, items: list[dict[str, Any]], backfill: bool = False) -> dict[str, Any]:
    response = client.post(
        "/api/measurements/batch",
        json={"astronautId": "AST-001", "items": items},
        headers={"X-Backfill": "true"} if backfill else {},
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def test_crew_list(seeded_client: TestClient) -> None:
    crew = seeded_client.get("/api/astronauts").json()
    assert [a["code"] for a in crew] == ["AST-001", "AST-002", "AST-003"]
    assert crew[0]["missionCode"] == "ARES-1"


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
    assert body["newAlerts"] == []


def test_same_reading_twice_is_stored_once(seeded_client: TestClient) -> None:
    # T-V-04: idempotent by id, and by (indicator, time, device) when no id is sent
    items = [_reading("resting_hr", 64, "bpm", 10, id="0193a6f2-7c1e-7b10-9a11-2f6f3c1b0001"),
             _reading("spo2", 98, "%", 11, deviceId="OX-1")]  # fmt: skip
    first = _post(seeded_client, items)
    second = _post(seeded_client, items)
    assert len(first["accepted"]) == 2
    assert second["accepted"] == [] and sorted(second["duplicates"]) == sorted(first["accepted"])

    engine = seeded_client.app.state.engine  # type: ignore[attr-defined]
    with Session(engine) as session:
        assert session.exec(select(func.count()).select_from(HealthMeasurement)).one() == 2
        assert session.exec(select(func.count()).select_from(SyncOutbox)).one() == 2  # queued for Earth
        assert session.exec(select(func.count()).select_from(AuditLog)).one() == 2  # one per batch


def test_unknown_astronaut_is_404(seeded_client: TestClient) -> None:
    response = seeded_client.post(
        "/api/measurements/batch", json={"astronautId": "AST-999", "items": [_reading("mood", 7, "score")]}
    )
    assert response.status_code == 404


def test_naive_timestamp_is_refused(seeded_client: TestClient) -> None:
    item = _reading("mood", 7, "score") | {"measuredAt": "2026-11-14T07:00:00"}
    response = seeded_client.post("/api/measurements/batch", json={"astronautId": "AST-001", "items": [item]})
    assert response.status_code == 422


def test_daily_buckets_average_valid_readings_only(seeded_client: TestClient) -> None:
    day = datetime(2026, 11, 10, tzinfo=UTC)
    items = [
        {
            "indicator": "resting_hr",
            "value": v,
            "unit": "bpm",
            "measuredAt": (day + timedelta(hours=h)).isoformat(),
        }
        for v, h in ((60, 6), (64, 7), (68, 8))
    ]
    items.append(
        {
            "indicator": "resting_hr",
            "value": 400,
            "unit": "bpm",
            "measuredAt": (day + timedelta(hours=9)).isoformat(),
        }
    )
    _post(seeded_client, items, backfill=True)

    series = seeded_client.get(
        "/api/astronauts/AST-001/measurements", params={"indicator": "resting_hr", "bucket": "day"}
    ).json()
    assert series["unit"] == "bpm"
    assert [(p["value"], p["min"], p["max"], p["n"]) for p in series["points"]] == [(64.0, 60.0, 68.0, 3)]


def test_radiation_is_stored_per_channel(seeded_client: TestClient) -> None:
    _post(seeded_client, [_reading("radiation_dose", 640, "uSv", 0),
                          _reading("radiation_dose", 0.19, "mSv", 0, channel="Neutron")])  # fmt: skip
    total = seeded_client.get(
        "/api/astronauts/AST-001/measurements", params={"indicator": "radiation_dose"}
    ).json()
    neutron = seeded_client.get(
        "/api/astronauts/AST-001/measurements", params={"indicator": "radiation_dose", "channel": "Neutron"}
    ).json()
    assert [p["value"] for p in total["points"]] == [0.64]
    assert [p["value"] for p in neutron["points"]] == [0.19]
