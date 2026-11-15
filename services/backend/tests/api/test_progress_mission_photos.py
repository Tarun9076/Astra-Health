"""Problem-statement gaps: blood sugar in the check-in, gamification, mission environments, photos."""

import base64
import json
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from astra.config import BACKEND_ROOT
from astra.core.enums import NodeRole
from astra.core.protocols import ProtocolBundle
from astra.db.models import HealthPhoto, LinkState, Mission, SyncOutbox
from astra.sync.merge import apply_items
from tests.conftest import auth

CHECKIN = {"sleepHours": 7, "sleepQuality": 7, "mood": 7, "stress": 3, "fatigue": 3}
JPEG = b"\xff\xd8\xff\xe0" + bytes(64)


def _data_url(raw: bytes, content_type: str = "image/jpeg") -> str:
    return f"data:{content_type};base64,{base64.b64encode(raw).decode()}"


def _engine(client: TestClient):  # type: ignore[no-untyped-def]
    return client.app.state.engine  # type: ignore[attr-defined]


# --- blood sugar and body mass in the check-in ---------------------------------------------------


def test_checkin_records_blood_sugar_and_low_value_raises_urgent(seeded_client: TestClient) -> None:
    body = {
        **CHECKIN,
        "vitals": [
            {"indicator": "glucose", "value": 50, "unit": "mg/dL"},
            {"indicator": "body_weight", "value": 71.4, "unit": "kg"},
        ],
    }
    r = seeded_client.post("/api/checkins", json=body, headers=auth(seeded_client, "ast1"))
    assert r.status_code == 201, r.text
    assert r.json()["accepted"] == 7
    low = [a for a in r.json()["newAlerts"] if a["ruleId"] == "MET-GLUCOSE-LOW"]
    assert low and low[0]["severity"] == "Urgent" and low[0]["protocol"] == "EMG-LOW-GLUCOSE"


# --- gamification ---------------------------------------------------------------------------------


def test_progress_rewards_actions_not_readings(seeded_client: TestClient) -> None:
    ast2 = auth(seeded_client, "ast2")
    now = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=1)
    items = [
        {
            "indicator": "mood",
            "value": 6,
            "unit": "score",
            "measuredAt": (now - timedelta(days=d)).isoformat(),
        }
        for d in range(7)
    ] + [{"indicator": "activity_min", "value": 45, "unit": "min", "measuredAt": now.isoformat()}]
    r = seeded_client.post(
        "/api/measurements/batch", json={"astronautId": "AST-002", "items": items}, headers=ast2
    )
    assert r.status_code in (200, 201), r.text

    out = seeded_client.get("/api/astronauts/AST-002/progress", headers=ast2).json()
    assert out["points"] == 7 * 10 + 5 and out["pointsToday"] == 15
    streaks = {s["id"]: s for s in out["streaks"]}
    assert streaks["checkin"]["current"] == 7 and streaks["checkin"]["doneToday"]
    assert streaks["active"]["current"] == 1 and streaks["sleep"]["current"] == 0
    badges = {b["id"]: b for b in out["badges"]}
    assert badges["first-checkin"]["earned"] and badges["checkin-7"]["earned"]
    assert badges["checkin-7"]["earnedOn"] == now.date().isoformat()
    assert not badges["checkin-30"]["earned"] and badges["checkin-30"]["progress"] == 7
    weekly = {g["id"]: g for g in out["weekly"]}
    assert weekly["checkin"] == {"id": "checkin", "label": "Daily check-in", "done": 7, "target": 7}
    assert out["level"]["number"] == 1 and out["level"]["nextPoints"] == 100

    # a worrying reading never costs points
    high = [{"indicator": "resting_hr", "value": 120, "unit": "bpm", "measuredAt": now.isoformat()}]
    seeded_client.post(
        "/api/measurements/batch", json={"astronautId": "AST-002", "items": high}, headers=ast2
    )
    assert seeded_client.get("/api/astronauts/AST-002/progress", headers=ast2).json()["points"] == 75


def test_progress_is_private_to_the_astronaut(seeded_client: TestClient) -> None:
    r = seeded_client.get("/api/astronauts/AST-001/progress", headers=auth(seeded_client, "ast2"))
    assert r.status_code == 403


# --- mission environments -------------------------------------------------------------------------


def test_all_mission_profiles_load_and_cite_existing_notes(bundle: ProtocolBundle) -> None:
    profiles = bundle.mission_profiles
    assert {"iss-leo", "mars-transit", "lunar-rover", "mars-surface"} <= set(profiles)
    assert {p.environment for p in profiles.values()} == {
        "Space station", "Spacecraft", "Pressurized rover", "Planetary base",
    }  # fmt: skip
    notes = {f.stem for f in (BACKEND_ROOT.parent.parent / "knowledge").glob("kb-*.md")}
    for p in profiles.values():
        assert all(f.kb in notes for f in p.health_focus), p.code


def test_admin_switches_the_environment_and_it_is_sent_to_earth(seeded_client: TestClient) -> None:
    ast1, admin = auth(seeded_client, "ast1"), auth(seeded_client, "admin")
    mission = seeded_client.get("/api/mission", headers=ast1).json()
    assert mission["profile"]["code"] == "mars-surface" and mission["profile"]["dayName"] == "Sol"
    assert len(mission["options"]) == 4

    assert (
        seeded_client.put(
            "/api/admin/mission/profile", json={"profileCode": "iss-leo"}, headers=ast1
        ).status_code
        == 403
    )
    bad = seeded_client.put("/api/admin/mission/profile", json={"profileCode": "venus"}, headers=admin)
    assert bad.status_code == 422

    r = seeded_client.put("/api/admin/mission/profile", json={"profileCode": "iss-leo"}, headers=admin)
    assert r.status_code == 200, r.text
    profile = r.json()["profile"]
    assert profile["environment"] == "Space station" and profile["gravityG"] == 0
    assert seeded_client.get("/api/mission", headers=ast1).json()["profile"]["code"] == "iss-leo"
    radiation = seeded_client.get("/api/astronauts/AST-001/radiation", headers=ast1).json()
    assert radiation["limitMsv"] == 200
    with Session(_engine(seeded_client)) as session:
        link = session.get(LinkState, 1)
        assert link is not None and link.real_delay_minutes < 0.1 and link.delay_source == "profile"
        sent = session.exec(select(SyncOutbox).where(SyncOutbox.entity_type == "Mission")).all()
        assert [json.loads(o.payload_json)["profile_code"] for o in sent] == ["iss-leo"]


def test_ground_applies_the_environment_change(seeded_client: TestClient) -> None:
    with Session(_engine(seeded_client)) as session:
        code = session.exec(select(Mission)).one().code
        item = {"entityType": "Mission", "payload": {"code": code, "profile_code": "lunar-rover"}}
        result = apply_items(session, [item], role=NodeRole.GROUND, on_alert_closed=lambda a: None)
        assert result.applied == 1 and result.events[0][0] == "MissionChanged"
        assert session.exec(select(Mission)).one().profile_code == "lunar-rover"
        again = apply_items(session, [item], role=NodeRole.GROUND, on_alert_closed=lambda a: None)
        assert again.applied == 0


# --- photos ---------------------------------------------------------------------------------------


def test_photo_is_stored_listed_served_and_synced(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    body = {"id": "photo-1", "kind": "Skin", "note": "Rash on the forearm", "dataUrl": _data_url(JPEG)}
    r = seeded_client.post("/api/photos", json=body, headers=ast1)
    assert r.status_code == 201, r.text
    assert r.json()["kindLabel"] == "Skin" and r.json()["sizeBytes"] == len(JPEG)
    again = seeded_client.post("/api/photos", json=body, headers=ast1)
    assert again.status_code == 201  # the outbox re-sent it: stored once

    listed = seeded_client.get("/api/astronauts/AST-001/photos", headers=ast1).json()
    assert [p["id"] for p in listed] == ["photo-1"] and "dataUrl" not in listed[0]
    image = seeded_client.get("/api/astronauts/AST-001/photos/photo-1/image", headers=ast1)
    assert image.status_code == 200 and image.content == JPEG
    assert image.headers["content-type"] == "image/jpeg"

    surgeon = auth(seeded_client, "surgeon1")
    assert (
        seeded_client.get("/api/astronauts/AST-001/photos/photo-1/image", headers=surgeon).status_code == 200
    )
    assert (
        seeded_client.get("/api/astronauts/AST-001/photos", headers=auth(seeded_client, "ast2")).status_code
        == 403
    )
    assert (
        seeded_client.get("/api/astronauts/AST-002/photos/photo-1/image", headers=surgeon).status_code == 404
    )

    timeline = seeded_client.get("/api/astronauts/AST-001/timeline?days=1", headers=ast1).json()["events"]
    photo = next(e for e in timeline if e["kind"] == "Photo")
    assert photo["title"] == "Photo added: Skin" and photo["refId"] == "photo-1"
    with Session(_engine(seeded_client)) as session:
        sent = session.exec(select(SyncOutbox).where(SyncOutbox.entity_type == "HealthPhoto")).all()
        assert len(sent) == 1
        payload = json.loads(sent[0].payload_json)
        session.delete(session.get(HealthPhoto, "photo-1"))
        session.commit()
        result = apply_items(
            session, [{"entityType": "HealthPhoto", "payload": payload}], role=NodeRole.GROUND,
            on_alert_closed=lambda a: None,
        )  # fmt: skip
        assert result.applied == 1 and result.events[0][0] == "PhotoAdded"


def test_photo_upload_rejects_non_images_and_non_astronauts(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    fake = {"kind": "Other", "dataUrl": _data_url(b"<script>alert(1)</script>")}
    assert seeded_client.post("/api/photos", json=fake, headers=ast1).status_code == 422
    gif = {"kind": "Other", "dataUrl": _data_url(b"GIF89a", "image/gif")}
    assert seeded_client.post("/api/photos", json=gif, headers=ast1).status_code == 422
    broken = {"kind": "Other", "dataUrl": "data:image/jpeg;base64,@@@"}
    assert seeded_client.post("/api/photos", json=broken, headers=ast1).status_code == 422
    good = {"kind": "Other", "dataUrl": _data_url(JPEG)}
    assert (
        seeded_client.post("/api/photos", json=good, headers=auth(seeded_client, "surgeon1")).status_code
        == 403
    )
