"""Body Explorer, Wellness Center, cabin environment, radiation and space weather (Step 10)."""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import auth

NOW = datetime.now(UTC).replace(microsecond=0)


def _post(client: TestClient, items: list[dict[str, Any]], backfill: bool = False) -> None:
    headers = auth(client, "ast1") | ({"X-Backfill": "true"} if backfill else {})
    r = client.post(
        "/api/measurements/batch", json={"astronautId": "AST-001", "items": items}, headers=headers
    )
    assert r.status_code == 201, r.text


def _fatigue_history(client: TestClient) -> None:
    """Ten ordinary days, then today's short sleep, high resting HR and fatigue (the fatigue pattern)."""
    items = []
    for d in range(12, 0, -1):
        t = (NOW - timedelta(days=d)).replace(hour=7, minute=0, second=0)
        items += [
            {"indicator": "resting_hr", "value": 62 + d % 3, "unit": "bpm", "measuredAt": t.isoformat()},
            {
                "indicator": "sleep_hours",
                "value": 7.0 + (d % 2) * 0.4,
                "unit": "h",
                "measuredAt": t.isoformat(),
            },
            {"indicator": "fatigue", "value": 3 + d % 2, "unit": "score", "measuredAt": t.isoformat()},
        ]
    _post(client, items, backfill=True)
    t = (NOW - timedelta(minutes=10)).isoformat()
    _post(client, [
        {"indicator": "sleep_hours", "value": 4.0, "unit": "h", "measuredAt": t},
        {"indicator": "resting_hr", "value": 82, "unit": "bpm", "measuredAt": t},
        {"indicator": "fatigue", "value": 8, "unit": "score", "measuredAt": t},
        {"indicator": "mood", "value": 3, "unit": "score", "measuredAt": t},
    ])  # fmt: skip


def test_clicking_the_heart_shows_resting_hr_vs_normal_the_alert_and_the_reduced_gravity_note(
    seeded_client: TestClient,
) -> None:
    # Step 10 "done when"
    _fatigue_history(seeded_client)
    body = seeded_client.get(
        "/api/astronauts/AST-001/body-systems", headers=auth(seeded_client, "ast1")
    ).json()
    heart = next(r for r in body["regions"] if r["id"] == "heart")
    rhr = next(m for m in heart["metrics"] if m["indicator"] == "resting_hr")
    assert rhr["value"] == 82 and rhr["baseline"] is not None and rhr["z"] > 2
    assert heart["status"] == "YELLOW"
    assert "BEH-FATIGUE-COMPOSITE" in {a["ruleId"] for a in heart["alerts"]}
    note = heart["knowledge"][0]
    assert note["noteId"] == "kb-cardio-reduced-gravity" and "gravity" in note["whatHappens"].lower()
    assert note["source"].startswith("http") and len(rhr["spark"]) >= 7
    brain = next(r for r in body["regions"] if r["id"] == "brain")
    assert "BEH-FATIGUE-COMPOSITE" in {a["ruleId"] for a in brain["alerts"]}
    assert next(r for r in body["regions"] if r["id"] == "eyes")["status"] == "GREY"  # no vision data yet
    other = seeded_client.get("/api/astronauts/AST-001/body-systems", headers=auth(seeded_client, "ast2"))
    assert other.status_code == 403


def test_cabin_co2_raises_the_environment_alert_for_the_crew(seeded_client: TestClient) -> None:
    admin = auth(seeded_client, "admin")
    t = (NOW - timedelta(minutes=5)).isoformat()
    r = seeded_client.post(
        "/api/environment/readings",
        json={"items": [{"indicator": "cabin_co2", "value": 4.6, "unit": "mmHg", "measuredAt": t},
                        {"indicator": "cabin_temp", "value": 23.0, "unit": "°C", "measuredAt": t}]},
        headers=admin,
    )  # fmt: skip
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["accepted"] == 2 and {"AST-001:ENV-CO2-HIGH", "AST-002:ENV-CO2-HIGH"} <= set(out["newAlerts"])
    again = seeded_client.post(
        "/api/environment/readings",
        json={"items": [{"indicator": "cabin_co2", "value": 4.6, "unit": "mmHg", "measuredAt": t}]},
        headers=admin,
    )
    assert again.json()["duplicates"] == 1
    current = seeded_client.get("/api/environment/current", headers=auth(seeded_client, "ast1")).json()
    co2 = next(c for c in current if c["indicator"] == "cabin_co2")
    assert (co2["value"], co2["status"]) == (4.6, "out_of_range")
    bad = seeded_client.post(
        "/api/environment/readings",
        json={"items": [{"indicator": "cabin_co2", "value": 4.6, "unit": "mmHg", "measuredAt": t}]},
        headers=auth(seeded_client, "ast1"),
    )
    assert bad.status_code == 403


def test_radiation_per_channel_and_space_weather(seeded_client: TestClient) -> None:
    t = (NOW - timedelta(hours=1)).isoformat()
    _post(seeded_client, [
        {"indicator": "radiation_dose", "value": 0.7, "unit": "mSv", "measuredAt": t, "channel": "Total"},
        {"indicator": "radiation_dose", "value": 0.2, "unit": "mSv", "measuredAt": t, "channel": "Neutron"},
    ])  # fmt: skip
    rad = seeded_client.get("/api/astronauts/AST-001/radiation", headers=auth(seeded_client, "ast1")).json()
    today = rad["days"][-1]
    assert (today["total"], today["neutron"], today["charged"]) == (0.7, 0.2, 0.5)
    assert rad["limitMsv"] == 600 and rad["neutronShare"] == 0.286
    assert (
        rad["replayedStorm"].startswith("Real NASA DONKI solar particle events, ")
        and "2024" in rad["replayedStorm"]
    )
    assert 3 < rad["lightTimeMinutes"] < 23
    now = seeded_client.get("/api/space-weather/now", headers=auth(seeded_client, "mission1")).json()
    assert now["source"] == "noaa-fixture" and now["protonFluxPfu"] is not None and now["thresholdPfu"] == 10


def test_wellness_center_hydration_and_missions(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    start = seeded_client.get("/api/astronauts/AST-001/wellness-center", headers=ast1).json()
    assert start["hydrationTodayMl"] == 0 and start["hydrationTargetMl"] == 2500
    for _ in range(5):
        out = seeded_client.post(
            "/api/wellness/activity", json={"kind": "fluid", "amount": 500}, headers=ast1
        ).json()
    assert out["hydrationTodayMl"] == 2500
    out = seeded_client.post(
        "/api/wellness/activity", json={"kind": "breathing", "amount": 240}, headers=ast1
    ).json()
    assert (out["breathingSessionsWeek"], out["breathingMinutesWeek"]) == (1, 4.0)
    assert {m["id"] for m in out["missions"]} == {"checkin-streak", "hydration", "strength", "sleep", "calm"}
    surgeon = auth(seeded_client, "surgeon1")
    assert seeded_client.post("/api/wellness/activity", json={"kind": "fluid", "amount": 250},
                              headers=surgeon).status_code == 403  # fmt: skip
