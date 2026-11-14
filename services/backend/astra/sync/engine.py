"""Sync engine (LLD §12.2–12.3): one pass of the sender/receiver loop, run every few seconds on both nodes.

Each pass:
1. apply received envelopes whose simulated delivery time has come (idempotent per envelope);
2. send ACKs for applied envelopes back to the peer;
3. process ACKs whose delivery time has come → outbox items Acked (reports → Delivered);
4. put InFlight items that were never ACKed back to Pending (after 2 × delay + 30 s);
5. send the next batch of Pending outbox items (Urgent first) — the Habitat only while the link is Up.

Node-to-node HTTP goes to the peer's `/node/sync/...` routes, signed with the shared sync key.
The Habitat owns the link: it stamps the delivery time on what it sends, and refuses (503)
envelopes and ACKs from the Ground while the link is Down.
"""

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import Engine
from sqlmodel import Session, col, select

from astra.config import Settings
from astra.core.enums import NodeRole
from astra.core.ids import uuid7
from astra.db.models import (
    Astronaut,
    HealthAlert,
    MedicalReport,
    SyncAck,
    SyncInbox,
    SyncOutbox,
)
from astra.sync.envelope import (
    DELIVER_AT_HEADER,
    NODE_HEADER,
    SIGNATURE_HEADER,
    build_envelope,
    canonical,
    items_valid,
    sign,
)
from astra.sync.link import get_link
from astra.sync.merge import MergeResult, apply_items

logger = logging.getLogger(__name__)

BATCH_SIZE = 500
RETRY_GRACE = timedelta(seconds=30)


@dataclass
class PassResult:
    delivered: int = 0
    acks_sent: int = 0
    acked: int = 0
    retried: int = 0
    sent_envelopes: int = 0
    sent_items: int = 0
    link_status: str = "Up"
    errors: list[str] = field(default_factory=list)


Publisher = Callable[[Session, MergeResult], None]
AlertCloser = Callable[[Session, HealthAlert], None]


def signed_headers(cfg: Settings, body: bytes, deliver: datetime | None = None) -> dict[str, str]:
    headers = {
        NODE_HEADER: cfg.node_id,
        SIGNATURE_HEADER: sign(cfg.sync_key, body),
        "Content-Type": "application/json",
    }
    if deliver is not None:
        headers[DELIVER_AT_HEADER] = deliver.isoformat()
    return headers


def peer_link(cfg: Settings, http: httpx.Client) -> dict[str, Any] | None:
    """Ground node: read the link state from the Habitat (control plane, not subject to the link)."""
    try:
        r = http.get("/node/sync/link", headers=signed_headers(cfg, b""))
        r.raise_for_status()
        data: dict[str, Any] = r.json()
        return data
    except httpx.HTTPError:
        return None


class SyncEngine:
    def __init__(self, engine: Engine, cfg: Settings, publish: Publisher, close_alert: AlertCloser) -> None:
        self.engine, self.cfg, self.publish, self.close_alert = engine, cfg, publish, close_alert
        self.is_habitat = cfg.node_role == NodeRole.HABITAT
        self.peer_link: dict[str, Any] | None = None  # Ground: last link state read from the Habitat
        self.last_received_at: datetime | None = None
        self.last_ack_at: datetime | None = None

    # -- helpers ------------------------------------------------------------------------------
    def _one_way(self, session: Session) -> timedelta:
        if self.is_habitat:
            return timedelta(
                seconds=get_link(session, self.cfg.link_compression_seconds_per_minute).one_way_seconds
            )
        seconds = float((self.peer_link or {}).get("oneWaySeconds", 0.0))
        return timedelta(seconds=seconds)

    def _link_up(self, session: Session) -> bool:
        if self.is_habitat:
            return get_link(session, self.cfg.link_compression_seconds_per_minute).status == "Up"
        return bool((self.peer_link or {}).get("status", "Up") == "Up")

    # -- one pass -----------------------------------------------------------------------------
    def run_once(self, http: httpx.Client, now: datetime | None = None) -> PassResult:
        now = now or datetime.now(UTC)
        result = PassResult()
        if not self.is_habitat:
            self.peer_link = peer_link(self.cfg, http) or self.peer_link
        with Session(self.engine) as session:
            result.link_status = "Up" if self._link_up(session) else "Down"
            self._deliver(session, now, result)
            self._send_acks(session, http, now, result)
            self._process_acks(session, now, result)
            self._retry(session, now, result)
            self._send(session, http, now, result)
        return result

    def _deliver(self, session: Session, now: datetime, result: PassResult) -> None:
        due = session.exec(
            select(SyncInbox)
            .where(col(SyncInbox.applied_at).is_(None), col(SyncInbox.deliver_at) <= now)
            .order_by(col(SyncInbox.deliver_at))
        ).all()
        for env in due:
            envelope = json.loads(env.body_json)
            if not items_valid(envelope, self.cfg.sync_key):
                logger.warning("Envelope %s failed the HMAC check; dropped", env.envelope_id)
                env.applied_at = now
                session.add(env)
                session.commit()
                continue
            merged = apply_items(
                session, envelope["items"], role=self.cfg.node_role,
                on_alert_closed=lambda a: self.close_alert(session, a),
            )  # fmt: skip
            env.applied_at = now
            session.add(env)
            session.commit()
            self.publish(session, merged)
            self.last_received_at = now
            result.delivered += 1

    def _send_acks(self, session: Session, http: httpx.Client, now: datetime, result: PassResult) -> None:
        pending = session.exec(
            select(SyncInbox).where(
                col(SyncInbox.applied_at).is_not(None), col(SyncInbox.ack_sent_at).is_(None)
            )
        ).all()
        if not pending or (self.is_habitat and not self._link_up(session)):
            return
        body = canonical({"envelopeIds": [env.envelope_id for env in pending]})
        deliver = now + self._one_way(session) if self.is_habitat else None
        try:
            r = http.post("/node/sync/acks", content=body, headers=signed_headers(self.cfg, body, deliver))
        except httpx.HTTPError as e:
            result.errors.append(f"ack: {e.__class__.__name__}")
            return
        if r.status_code != 202:
            result.errors.append(f"ack: HTTP {r.status_code}")
            return
        for env in pending:
            env.ack_sent_at = now
            session.add(env)
        session.commit()
        result.acks_sent += len(pending)

    def _process_acks(self, session: Session, now: datetime, result: PassResult) -> None:
        due = session.exec(
            select(SyncAck).where(col(SyncAck.processed_at).is_(None), col(SyncAck.deliver_at) <= now)
        ).all()
        if not due:
            return
        ids = [a.envelope_id for a in due]
        items = session.exec(select(SyncOutbox).where(col(SyncOutbox.envelope_id).in_(ids))).all()
        delivered_reports = []
        for item in items:
            item.status = "Acked"
            session.add(item)
            if item.entity_type == "MedicalReport":
                report = session.get(MedicalReport, item.entity_id)
                if report is not None and report.transmission_status != "Delivered":
                    report.transmission_status = "Delivered"
                    session.add(report)
                    delivered_reports.append(report)
        for a in due:
            a.processed_at = now
            session.add(a)
        session.commit()
        self.last_ack_at = now
        result.acked += len(items)
        if delivered_reports:
            merged = MergeResult(events=[("ReportGenerated", r.astronaut_id, {"id": r.id, "type": r.type})
                                         for r in delivered_reports])  # fmt: skip
            self.publish(session, merged)

    def _retry(self, session: Session, now: datetime, result: PassResult) -> None:
        cutoff = now - (2 * self._one_way(session) + RETRY_GRACE)
        stale = session.exec(
            select(SyncOutbox).where(SyncOutbox.status == "InFlight", col(SyncOutbox.sent_at) < cutoff)
        ).all()
        for item in stale:
            item.status, item.attempts = "Pending", item.attempts + 1
            session.add(item)
        if stale:
            session.commit()
            result.retried += len(stale)

    def _send(self, session: Session, http: httpx.Client, now: datetime, result: PassResult) -> None:
        if self.is_habitat and not self._link_up(session):
            return
        batch = session.exec(
            select(SyncOutbox)
            .where(SyncOutbox.status == "Pending")
            .order_by(col(SyncOutbox.priority), col(SyncOutbox.seq))
            .limit(BATCH_SIZE)
        ).all()
        if not batch:
            return
        envelope_id = str(uuid7())
        items = [
            {
                "entityType": o.entity_type,
                "entityId": o.entity_id,
                "seq": o.seq,
                "payload": json.loads(o.payload_json),
            }
            for o in batch
        ]
        seqs = [o.seq or 0 for o in batch]
        envelope = build_envelope(
            envelope_id,
            self.cfg.node_id,
            "peer",
            min(seqs),
            max(seqs),
            now.isoformat(),
            items,
            self.cfg.sync_key,
        )
        body = canonical(envelope)
        deliver = now + self._one_way(session) if self.is_habitat else None
        try:
            r = http.post(
                "/node/sync/envelopes", content=body, headers=signed_headers(self.cfg, body, deliver)
            )
        except httpx.HTTPError as e:
            result.errors.append(f"send: {e.__class__.__name__}")
            return
        if r.status_code != 202:
            result.errors.append(f"send: HTTP {r.status_code}")
            return
        for o in batch:
            o.status, o.envelope_id, o.sent_at = "InFlight", envelope_id, now
            session.add(o)
            if o.entity_type == "MedicalReport":
                report = session.get(MedicalReport, o.entity_id)
                if report is not None and report.transmission_status == "Queued":
                    report.transmission_status = "Sent"
                    session.add(report)
        session.commit()
        result.sent_envelopes += 1
        result.sent_items += len(batch)


def status_counts(session: Session) -> dict[str, int]:
    rows = session.exec(select(SyncOutbox.status)).all()
    return {s: rows.count(s) for s in ("Pending", "InFlight", "Acked")}


def astronaut_for(session: Session, astronaut_id: str) -> Astronaut | None:
    return session.get(Astronaut, astronaut_id) if astronaut_id else None
