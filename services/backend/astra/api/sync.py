"""Sync API (LLD §12, §13.4; Step 9).

Node-to-node (`/node/sync/...`, HMAC-signed with the shared sync key, no user token):
- POST /node/sync/envelopes — the peer delivers an envelope; held until its simulated arrival time.
- POST /node/sync/acks      — the peer confirms envelopes it applied; also delayed.
- GET  /node/sync/link      — Habitat: current link state (the Ground reads it each pass).

Users:
- GET /api/sync/status       — this node, the link, outbox counts, last received / acknowledged.
- GET/PUT /api/admin/link    — Admin, Habitat: link Up/Down, delay (JPL Horizons or manual), compression.
- POST /api/admin/sim/scenario — Admin, Habitat: inject the fatigue episode or a solar storm now.
"""

import json
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import Field
from sqlmodel import Session, select

from astra.api.alerts import publish_alert_changes
from astra.api.base import ApiModel
from astra.api.reports import publish_report
from astra.config import Settings
from astra.core.enums import NodeRole, Role
from astra.db.models import Astronaut, LinkState, MedicalInstruction, SyncAck, SyncInbox
from astra.db.session import SessionDep
from astra.realtime.hub import hub
from astra.security.deps import CurrentUser, require_role
from astra.security.jwt import TokenClaims
from astra.services.alerts import AlertChanges, _close_tasks
from astra.services.crew import find_astronaut
from astra.services.ingestion import IncomingReading, ingest_batch
from astra.services.reports import report_new_alerts
from astra.sync.engine import SyncEngine, status_counts
from astra.sync.envelope import DELIVER_AT_HEADER, NODE_HEADER, SIGNATURE_HEADER, verify
from astra.sync.link import deliver_at, get_link, horizons_light_minutes, link_dict
from astra.sync.merge import MergeResult

node_router = APIRouter(prefix="/node/sync", tags=["sync (node-to-node)"], include_in_schema=False)
router = APIRouter(prefix="/api", tags=["sync"])

Admin = Annotated[TokenClaims, Depends(require_role(Role.ADMIN))]


def _cfg(request: Request) -> Settings:
    cfg: Settings = request.app.state.settings
    return cfg


async def _verified_body(request: Request) -> bytes:
    body = await request.body()
    if not verify(_cfg(request).sync_key, body, request.headers.get(SIGNATURE_HEADER)):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Bad node signature")
    return body


def _delivery_time(request: Request, session: Session) -> datetime:
    """Habitat: the link decides (503 while Down). Ground: the Habitat stamped it on the request."""
    cfg = _cfg(request)
    if cfg.node_role == NodeRole.HABITAT:
        link = get_link(session, cfg.link_compression_seconds_per_minute)
        if link.status != "Up":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Deep-space link is down")
        return deliver_at(link)
    stamped = request.headers.get(DELIVER_AT_HEADER)
    return datetime.fromisoformat(stamped) if stamped else datetime.now(UTC)


# --- node-to-node ---------------------------------------------------------------------------------


@node_router.post("/envelopes", status_code=status.HTTP_202_ACCEPTED)
async def receive_envelope(request: Request) -> dict[str, Any]:
    body = await _verified_body(request)
    envelope = json.loads(body)
    engine = request.app.state.engine
    with Session(engine) as session:
        when = _delivery_time(request, session)
        if session.get(SyncInbox, envelope["envelopeId"]) is not None:
            return {"accepted": True, "duplicate": True}  # T-S-01: re-sent envelope, already held/applied
        session.add(
            SyncInbox(
                envelope_id=envelope["envelopeId"],
                from_node_id=request.headers.get(NODE_HEADER, envelope.get("fromNodeId", "?")),
                body_json=body.decode(),
                item_count=int(envelope.get("itemCount", 0)),
                deliver_at=when,
            )
        )
        session.commit()
    return {"accepted": True, "duplicate": False, "deliverAt": when.isoformat()}


@node_router.post("/acks", status_code=status.HTTP_202_ACCEPTED)
async def receive_acks(request: Request) -> dict[str, Any]:
    body = await _verified_body(request)
    ids: list[str] = json.loads(body)["envelopeIds"]
    with Session(request.app.state.engine) as session:
        when = _delivery_time(request, session)
        new = 0
        for envelope_id in ids:
            if session.get(SyncAck, envelope_id) is None:
                session.add(SyncAck(envelope_id=envelope_id, deliver_at=when))
                new += 1
        session.commit()
    return {"accepted": new}


@node_router.get("/link")
async def peer_link_state(request: Request) -> dict[str, object]:
    await _verified_body(request)
    if _cfg(request).node_role != NodeRole.HABITAT:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "The link is owned by the Habitat node")
    with Session(request.app.state.engine) as session:
        return link_dict(get_link(session, _cfg(request).link_compression_seconds_per_minute))


# --- publishing what a sync pass merged ------------------------------------------------------------


def publish_merge(session: Session, merged: MergeResult) -> None:
    by_astronaut: dict[str, AlertChanges] = {}
    for a in merged.alerts_created:
        by_astronaut.setdefault(a.astronaut_id, AlertChanges()).created.append(a)
    for a in merged.alerts_updated:
        by_astronaut.setdefault(a.astronaut_id, AlertChanges()).updated.append(a)
    for astronaut_id, changes in by_astronaut.items():
        astronaut = session.get(Astronaut, astronaut_id)
        if astronaut is not None:
            publish_alert_changes(changes, astronaut)
    for kind, astronaut_id, payload in merged.events:
        groups = [f"astronaut:{astronaut_id}", "medical"] if astronaut_id else ["all"]
        if kind in ("InstructionReceived", "InstructionAcknowledged"):
            latest = session.exec(
                select(MedicalInstruction)
                .where(MedicalInstruction.astronaut_id == astronaut_id)
                .order_by(MedicalInstruction.created_at.desc())  # type: ignore[attr-defined]
            ).first()
            astronaut = session.get(Astronaut, astronaut_id)
            if latest is not None and astronaut is not None:
                payload = {"id": latest.id, "astronautCode": astronaut.code, "fromName": latest.from_name,
                           "text": latest.text}  # fmt: skip
        hub.publish_from_thread(groups, kind, payload)


def close_alert_tasks(session: Session, alert: Any) -> None:
    _close_tasks(session, alert, datetime.now(UTC))


# --- user-facing ----------------------------------------------------------------------------------


class LinkOut(ApiModel):
    status: Literal["Up", "Down"]
    real_delay_minutes: float
    delay_source: str
    compression_seconds_per_minute: float
    one_way_seconds: float
    horizons_delay_minutes: float | None = None


class SyncStatus(ApiModel):
    node_id: str
    node_role: str
    link: LinkOut | None
    pending: int
    in_flight: int
    acked: int
    last_received_at: datetime | None
    last_ack_at: datetime | None


def _link_out(link: LinkState | dict[str, Any] | None) -> LinkOut | None:
    if link is None:
        return None
    data = link_dict(link) if isinstance(link, LinkState) else link
    return LinkOut(
        status="Up" if data["status"] == "Up" else "Down",
        real_delay_minutes=float(data["realDelayMinutes"]),
        delay_source=str(data["delaySource"]),
        compression_seconds_per_minute=float(data["compressionSecondsPerMinute"]),
        one_way_seconds=float(data["oneWaySeconds"]),
        horizons_delay_minutes=horizons_light_minutes(datetime.now(UTC).date()),
    )


@router.get("/sync/status", response_model=SyncStatus)
def sync_status(request: Request, session: SessionDep, user: CurrentUser) -> SyncStatus:
    cfg = _cfg(request)
    sync: SyncEngine | None = getattr(request.app.state, "sync", None)
    if cfg.node_role == NodeRole.HABITAT:
        link = _link_out(get_link(session, cfg.link_compression_seconds_per_minute))
    else:
        link = _link_out(sync.peer_link if sync else None)
    counts = status_counts(session)
    return SyncStatus(
        node_id=cfg.node_id,
        node_role=cfg.node_role.value,
        link=link,
        pending=counts["Pending"],
        in_flight=counts["InFlight"],
        acked=counts["Acked"],
        last_received_at=sync.last_received_at if sync else None,
        last_ack_at=sync.last_ack_at if sync else None,
    )


class LinkIn(ApiModel):
    status: Literal["Up", "Down"] | None = None
    real_delay_minutes: float | None = Field(default=None, ge=0, le=60)
    use_horizons: bool = False  # reset the delay to today's JPL Horizons light time
    compression_seconds_per_minute: float | None = Field(default=None, ge=0, le=60)


def _habitat_only(request: Request) -> None:
    if _cfg(request).node_role != NodeRole.HABITAT:
        raise HTTPException(status.HTTP_409_CONFLICT, "The link is controlled on the Habitat node")


@router.get("/admin/link", response_model=LinkOut)
def get_admin_link(request: Request, session: SessionDep, user: Admin) -> LinkOut:
    _habitat_only(request)
    out = _link_out(get_link(session, _cfg(request).link_compression_seconds_per_minute))
    assert out is not None
    return out


@router.put("/admin/link", response_model=LinkOut)
def put_admin_link(body: LinkIn, request: Request, session: SessionDep, user: Admin) -> LinkOut:
    _habitat_only(request)
    link = get_link(session, _cfg(request).link_compression_seconds_per_minute)
    if body.status is not None:
        link.status = body.status
    if body.use_horizons:
        minutes = horizons_light_minutes(datetime.now(UTC).date())
        if minutes is not None:
            link.real_delay_minutes, link.delay_source = round(minutes, 2), "horizons"
    elif body.real_delay_minutes is not None:
        link.real_delay_minutes, link.delay_source = body.real_delay_minutes, "manual"
    if body.compression_seconds_per_minute is not None:
        link.compression_seconds_per_minute = body.compression_seconds_per_minute
    link.updated_at = datetime.now(UTC)
    session.add(link)
    session.commit()
    session.refresh(link)
    out = _link_out(link)
    assert out is not None
    hub.publish_from_thread(["all"], "LinkChanged", out.model_dump(mode="json", by_alias=True))
    return out


class ScenarioIn(ApiModel):
    scenario: Literal["fatigue", "solar-storm"]
    astronaut_id: str = "AST-001"


class ScenarioOut(ApiModel):
    scenario: str
    readings: int
    new_alerts: list[str]


def _reading(code: str, value: float, unit: str, t: datetime, **kw: Any) -> IncomingReading:
    return IncomingReading(indicator=code, value=value, unit=unit, measured_at=t, source="Simulated",
                           is_simulated=True, device_id=kw.pop("device", "SIM"), **kw)  # fmt: skip


@router.post("/admin/sim/scenario", response_model=ScenarioOut)
def inject_scenario(body: ScenarioIn, request: Request, session: SessionDep, user: Admin) -> ScenarioOut:
    """Demo Control Panel: start a scenario *now* through the normal intake (rules, alerts, sync)."""
    _habitat_only(request)
    bundle = request.app.state.protocols
    node_id = _cfg(request).node_id
    now = datetime.now(UTC).replace(microsecond=0) - timedelta(seconds=5)
    created: list[str] = []
    total = 0
    if body.scenario == "fatigue":
        targets = [find_astronaut(session, body.astronaut_id)]
        readings = [
            _reading("sleep_hours", 4.2, "h", now), _reading("sleep_quality", 3, "score", now),
            _reading("fatigue", 8, "score", now), _reading("mood", 3, "score", now),
            _reading("stress", 8, "score", now), _reading("resting_hr", 91, "bpm", now, device="WR"),
        ]  # fmt: skip
    else:  # replay the May 2024 storm's peak: ~30× the habitat's normal daily dose, for everyone
        targets = list(session.exec(select(Astronaut).order_by(Astronaut.code)).all())
        readings = [_reading("radiation_dose", 18.8, "mSv", now, channel="Total", device="DOS")]
    for astronaut in targets:
        if astronaut is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Astronaut not found")
        outcome = ingest_batch(session, bundle, astronaut, readings, node_id=node_id, user_id=user.user_id)
        publish_alert_changes(outcome.alerts, astronaut)
        report = report_new_alerts(session, bundle, astronaut, outcome.alerts.created, node_id=node_id)
        if report is not None:
            publish_report(report)
        created += [a.rule_id for a in outcome.alerts.created]
        total += len(outcome.accepted)
    return ScenarioOut(scenario=body.scenario, readings=total, new_alerts=created)
