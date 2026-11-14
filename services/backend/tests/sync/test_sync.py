"""Habitat ↔ Ground sync over the simulated link (Step 9; LLD §12): T-S-01..03, T-A-03.

Two real apps in-process (separate databases); each node's sync pass posts to the other's
`/node/sync/...` routes through its TestClient. Time is driven by hand (`now=`), so the link delay
is checked without sleeping.
"""

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from astra.api.sync import close_alert_tasks, publish_merge
from astra.config import BACKEND_ROOT, Settings
from astra.core.enums import NodeRole
from astra.db.models import HealthAlert, MedicalReport, SyncInbox, SyncOutbox
from astra.main import create_app
from astra.seed import load_seed, seed_database
from astra.sync.engine import SyncEngine, signed_headers
from astra.sync.envelope import canonical
from astra.sync.merge import apply_items
from tests.conftest import DEMO_PASSWORDS

DELAY = 10.0  # seconds one way (10 light-minutes × 1 s)


def _node(tmp: Path, role: NodeRole, node_id: str) -> tuple[TestClient, Settings]:
    cfg = Settings(
        database_url=f"sqlite:///{(tmp / f'{node_id}.db').as_posix()}",
        node_role=role,
        node_id=node_id,
        bcrypt_rounds=4,
        routine_interval_minutes=0,
        sync_interval_seconds=0,
        space_weather_interval_minutes=0,
        models_path=tmp / f"models-{node_id}",
        anthropic_api_key=None,
        sync_key="test-sync-key",
        peer_url=None,
    )
    client = TestClient(create_app(cfg))
    client.__enter__()
    with Session(client.app.state.engine) as session:  # type: ignore[attr-defined]
        seed_database(session, load_seed(BACKEND_ROOT / "seed.example.json"), bcrypt_rounds=4)
    return client, cfg


@pytest.fixture
def nodes(tmp_path: Path) -> Iterator[dict[str, Any]]:
    habitat, hab_cfg = _node(tmp_path, NodeRole.HABITAT, "HAB-TEST")
    ground, gnd_cfg = _node(tmp_path, NodeRole.GROUND, "GND-TEST")
    hab_sync = SyncEngine(habitat.app.state.engine, hab_cfg, publish_merge, close_alert_tasks)  # type: ignore[attr-defined]
    gnd_sync = SyncEngine(ground.app.state.engine, gnd_cfg, publish_merge, close_alert_tasks)  # type: ignore[attr-defined]
    admin = _auth(habitat, "admin")
    r = habitat.put(
        "/api/admin/link", json={"realDelayMinutes": 10, "compressionSecondsPerMinute": 1}, headers=admin
    )
    assert r.status_code == 200 and r.json()["oneWaySeconds"] == DELAY
    yield {
        "hab": habitat,
        "gnd": ground,
        "hab_sync": hab_sync,
        "gnd_sync": gnd_sync,
        "admin": admin,
        "hab_cfg": hab_cfg,
    }
    habitat.__exit__(None, None, None)
    ground.__exit__(None, None, None)


def _auth(client: TestClient, user: str) -> dict[str, str]:
    r = client.post("/api/auth/login", json={"username": user, "password": DEMO_PASSWORDS[user]})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['accessToken']}"}


def _link(n: dict[str, Any], status: str) -> None:
    assert n["hab"].put("/api/admin/link", json={"status": status}, headers=n["admin"]).status_code == 200


def _fever_checkin(n: dict[str, Any]) -> list[str]:
    body = {"sleepHours": 7, "sleepQuality": 7, "mood": 6, "stress": 3, "fatigue": 3,
            "vitals": [{"indicator": "body_temp", "value": 39.8, "unit": "°C"}]}  # fmt: skip
    r = n["hab"].post("/api/checkins", json=body, headers=_auth(n["hab"], "ast1"))
    assert r.status_code == 201, r.text
    return sorted(a["ruleId"] for a in r.json()["newAlerts"])


def _rows(client: TestClient, model: Any) -> list[Any]:
    with Session(client.app.state.engine) as session:  # type: ignore[attr-defined]
        return list(session.exec(select(model)).all())


def test_done_when_alert_report_reach_ground_once_and_instruction_returns(
    nodes: dict[str, Any],
) -> None:
    n = nodes
    hab, gnd, hab_sync, gnd_sync = n["hab"], n["gnd"], n["hab_sync"], n["gnd_sync"]
    surgeon_gnd = _auth(gnd, "surgeon1")
    t0 = datetime.now(UTC)

    # Link DOWN: the check-in raises the alert onboard; the surgeon on Earth sees nothing
    _link(n, "Down")
    assert _fever_checkin(n) == ["TH-FEVER", "TH-FEVER-HIGH"]
    assert hab_sync.run_once(gnd, now=t0).sent_envelopes == 0
    assert gnd.get("/api/astronauts/AST-001/alerts", headers=surgeon_gnd).json() == []

    # Link UP: sent now, but held by the link for the one-way delay
    _link(n, "Up")
    sent = hab_sync.run_once(gnd, now=t0 + timedelta(seconds=1))
    assert sent.sent_envelopes == 1 and sent.sent_items >= 4  # readings, 2 alerts, report
    assert gnd_sync.run_once(hab, now=t0 + timedelta(seconds=1 + DELAY - 1)).delivered == 0
    assert gnd.get("/api/astronauts/AST-001/alerts", headers=surgeon_gnd).json() == []

    arrived = gnd_sync.run_once(hab, now=t0 + timedelta(seconds=1 + DELAY + 0.5))
    assert arrived.delivered == 1 and arrived.acks_sent == 1
    alerts = gnd.get("/api/astronauts/AST-001/alerts", headers=surgeon_gnd).json()
    assert sorted(a["ruleId"] for a in alerts) == ["TH-FEVER", "TH-FEVER-HIGH"]  # exactly once
    reports = gnd.get("/api/astronauts/AST-001/reports", headers=surgeon_gnd).json()
    assert [(r["type"], r["transmissionStatus"]) for r in reports] == [("AlertTriggered", "Delivered")]
    crew = gnd.get("/api/crew/summary", headers=surgeon_gnd).json()
    assert next(c for c in crew if c["code"] == "AST-001")["status"] == "RED"

    # T-S-01: the same envelope delivered again changes nothing
    envelope_body = _rows(gnd, SyncInbox)[0].body_json.encode()
    again = gnd.post(
        "/node/sync/envelopes", content=envelope_body, headers=signed_headers(n["hab_cfg"], envelope_body)
    )
    assert again.json()["duplicate"] is True
    assert len(_rows(gnd, HealthAlert)) == 2 and len(_rows(gnd, MedicalReport)) == 1

    # The ACK also takes the delay; then the Habitat marks the items Acked and the report Delivered
    real_now = datetime.now(UTC)
    hab_sync.run_once(gnd, now=real_now + timedelta(seconds=DELAY + 1))
    assert {o.status for o in _rows(hab, SyncOutbox)} == {"Acked"}
    assert _rows(hab, MedicalReport)[0].transmission_status == "Delivered"

    # The surgeon's instruction travels back: queued on Earth, delivered onboard after the delay
    fever = next(a for a in alerts if a["ruleId"] == "TH-FEVER-HIGH")
    instruction = {"astronautId": "AST-001", "alertId": fever["id"], "text": "Follow EMG-FEVER now."}
    sent_instr = gnd.post("/api/instructions", json=instruction, headers=surgeon_gnd)
    assert sent_instr.status_code == 201 and sent_instr.json()["deliveredAt"] is None  # not onboard yet
    gnd_sync.run_once(hab, now=datetime.now(UTC))
    ast1 = _auth(hab, "ast1")
    assert hab.get("/api/astronauts/AST-001/instructions", headers=ast1).json() == []
    hab_sync.run_once(gnd, now=datetime.now(UTC) + timedelta(seconds=DELAY + 1))
    onboard = hab.get("/api/astronauts/AST-001/instructions", headers=ast1).json()
    assert [i["text"] for i in onboard] == ["Follow EMG-FEVER now."] and onboard[0]["deliveredAt"]
    # …and the delivery time travels back to Earth (the same pass already sent it)
    gnd_sync.run_once(hab, now=datetime.now(UTC) + timedelta(seconds=2 * DELAY + 2))  # two hops later
    on_earth = gnd.get("/api/astronauts/AST-001/instructions", headers=surgeon_gnd).json()
    assert on_earth[0]["deliveredAt"] == onboard[0]["deliveredAt"]


def test_link_down_blocks_both_directions_and_items_stay_pending(nodes: dict[str, Any]) -> None:
    n = nodes
    _link(n, "Down")
    surgeon_gnd = _auth(n["gnd"], "surgeon1")
    n["gnd"].post(
        "/api/instructions",
        json={"astronautId": "AST-002", "text": "Please rest today."},
        headers=surgeon_gnd,
    )
    result = n["gnd_sync"].run_once(n["hab"], now=datetime.now(UTC))
    assert result.sent_envelopes == 0 and any("503" in e for e in result.errors)
    assert {o.status for o in _rows(n["gnd"], SyncOutbox)} == {"Pending"}
    _link(n, "Up")
    assert n["gnd_sync"].run_once(n["hab"], now=datetime.now(UTC)).sent_envelopes == 1


def test_unacked_envelopes_are_resent(nodes: dict[str, Any]) -> None:
    # T-S-02: an envelope that never gets an ACK goes back to Pending after 2 × delay + 30 s
    n = nodes
    _fever_checkin(n)
    t0 = datetime.now(UTC)
    assert n["hab_sync"].run_once(n["gnd"], now=t0).sent_envelopes == 1
    later = n["hab_sync"].run_once(n["gnd"], now=t0 + timedelta(seconds=2 * DELAY + 31))
    assert later.retried >= 4 and later.sent_envelopes == 1  # re-sent in a new envelope


def test_ground_review_flows_back_and_never_regresses(nodes: dict[str, Any]) -> None:
    # T-A-03: state-order merge — the surgeon's In Review on Earth wins over the Habitat's Open
    n = nodes
    _fever_checkin(n)
    t0 = datetime.now(UTC)
    n["hab_sync"].run_once(n["gnd"], now=t0)
    n["gnd_sync"].run_once(n["hab"], now=t0 + timedelta(seconds=DELAY + 1))
    surgeon_gnd = _auth(n["gnd"], "surgeon1")
    alert = next(a for a in n["gnd"].get("/api/astronauts/AST-001/alerts", headers=surgeon_gnd).json()
                 if a["ruleId"] == "TH-FEVER")  # fmt: skip
    assert (
        n["gnd"]
        .post(f"/api/alerts/{alert['id']}/review", json={"note": "Looking"}, headers=surgeon_gnd)
        .status_code
        == 200
    )
    n["gnd_sync"].run_once(n["hab"], now=datetime.now(UTC))
    n["hab_sync"].run_once(n["gnd"], now=datetime.now(UTC) + timedelta(seconds=DELAY + 1))
    with Session(n["hab"].app.state.engine) as session:  # type: ignore[attr-defined]
        onboard = session.get(HealthAlert, alert["id"])
        assert onboard is not None and onboard.status == "InReview" and onboard.reviewed_by == "surgeon1"
        older = json.loads(onboard.model_dump_json()) | {"status": "Open", "reviewed_by": None}
        apply_items(session, [{"entityType": "HealthAlert", "payload": older}], role=NodeRole.HABITAT,
                    on_alert_closed=lambda a: None)  # fmt: skip
        assert onboard.status == "InReview"  # an older copy never moves the state backwards


def test_node_routes_need_the_shared_key_and_tokens_work_on_both_nodes(nodes: dict[str, Any]) -> None:
    n = nodes
    body = canonical({"envelopeIds": ["x"]})
    assert (
        n["gnd"].post("/node/sync/acks", content=body, headers={"X-Astra-Signature": "nope"}).status_code
        == 401
    )
    assert n["hab"].get("/node/sync/link").status_code == 401
    # stable ids: a token from the Habitat is valid on the Ground node too
    token = _auth(n["hab"], "surgeon1")
    assert n["gnd"].get("/api/me", headers=token).json()["username"] == "surgeon1"
    # the Ground node doesn't take readings
    r = n["gnd"].post("/api/checkins", json={"sleepHours": 7, "sleepQuality": 7, "mood": 6, "stress": 3,
                                             "fatigue": 3}, headers=_auth(n["gnd"], "ast1"))  # fmt: skip
    assert r.status_code == 409
    status = n["gnd"].get("/api/sync/status", headers=token).json()
    assert status["nodeRole"] == "Ground" and status["pending"] == 0


def test_space_weather_events_are_queued_once() -> None:
    from astra.db.models import SpaceWeatherEvent
    from astra.db.session import init_db, make_engine
    from astra.integrations.fixtures import FIXTURES_DIR, load_fixture
    from astra.integrations.nasa_donki import parse_sep
    from astra.services.space_weather import store_events

    engine = make_engine("sqlite://")
    init_db(engine)
    events = parse_sep(load_fixture(FIXTURES_DIR / "donki-sep-2024-05.json"))
    with Session(engine) as session:
        assert store_events(session, events, "donki-fixture") == len(events) > 0
        assert store_events(session, events, "donki-fixture") == 0  # idempotent
        assert len(
            session.exec(select(SyncOutbox).where(SyncOutbox.entity_type == "SpaceWeatherEvent")).all()
        ) == len(events)
        assert session.exec(select(SpaceWeatherEvent)).first() is not None


def test_tampered_envelope_is_rejected_or_dropped(nodes: dict[str, Any]) -> None:
    # T-S-03: without the key the body signature fails (401); items changed after signing are dropped
    n = nodes
    _fever_checkin(n)
    n["hab_sync"].run_once(n["gnd"], now=datetime.now(UTC))
    inbox = _rows(n["gnd"], SyncInbox)[0]
    envelope = json.loads(inbox.body_json)
    envelope["envelopeId"] = "tampered-1"
    envelope["items"][0]["payload"]["value"] = 999.0  # items no longer match the envelope's HMAC
    body = canonical(envelope)
    forged = n["gnd"].post("/node/sync/envelopes", content=body, headers={"X-Astra-Signature": "forged"})
    assert forged.status_code == 401
    # a peer holding the key but sending altered items: accepted at the door, dropped on delivery
    assert (
        n["gnd"]
        .post("/node/sync/envelopes", content=body, headers=signed_headers(n["hab_cfg"], body))
        .status_code
        == 202
    )
    n["gnd_sync"].run_once(n["hab"], now=datetime.now(UTC) + timedelta(seconds=DELAY + 1))
    from astra.db.models import HealthMeasurement

    assert all(m.value != 999.0 for m in _rows(n["gnd"], HealthMeasurement))


def test_space_weather_event_reaches_the_habitat(nodes: dict[str, Any]) -> None:
    # T-EXT-04: a DONKI SEP event stored on the Ground node arrives onboard after the link delay
    from astra.db.models import SpaceWeatherEvent
    from astra.integrations.fixtures import DONKI_SEP_MAY_2024, load_fixture
    from astra.integrations.nasa_donki import parse_sep
    from astra.services.space_weather import store_events

    n = nodes
    events = parse_sep(load_fixture(DONKI_SEP_MAY_2024))
    with Session(n["gnd"].app.state.engine) as session:  # type: ignore[attr-defined]
        assert store_events(session, events, "donki-fixture") == len(events)
    assert n["gnd_sync"].run_once(n["hab"], now=datetime.now(UTC)).sent_envelopes == 1
    assert _rows(n["hab"], SpaceWeatherEvent) == []
    n["hab_sync"].run_once(n["gnd"], now=datetime.now(UTC) + timedelta(seconds=DELAY + 1))
    assert {e.id for e in _rows(n["hab"], SpaceWeatherEvent)} == {e.sep_id for e in events}


def test_restart_mid_sync_loses_nothing(nodes: dict[str, Any]) -> None:
    # Edge case: both nodes restart while an envelope is in flight (all state is in the databases)
    n = nodes
    _fever_checkin(n)
    t0 = datetime.now(UTC)
    assert n["hab_sync"].run_once(n["gnd"], now=t0).sent_envelopes == 1
    fresh_hab = SyncEngine(n["hab"].app.state.engine, n["hab_cfg"], publish_merge, close_alert_tasks)  # type: ignore[attr-defined]
    gnd_cfg = n["gnd_sync"].cfg
    fresh_gnd = SyncEngine(n["gnd"].app.state.engine, gnd_cfg, publish_merge, close_alert_tasks)  # type: ignore[attr-defined]
    assert fresh_gnd.run_once(n["hab"], now=t0 + timedelta(seconds=DELAY + 1)).delivered == 1
    fresh_hab.run_once(n["gnd"], now=datetime.now(UTC) + timedelta(seconds=DELAY + 1))
    assert {o.status for o in _rows(n["hab"], SyncOutbox)} == {"Acked"}
    assert len(_rows(n["gnd"], HealthAlert)) == 2
