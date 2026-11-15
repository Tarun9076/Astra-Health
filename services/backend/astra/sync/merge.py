"""Apply received items, entity by entity (LLD §12.4). Never re-queues what it applies (no ping-pong).

| Entity              | Strategy                                                                  |
|---------------------|---------------------------------------------------------------------------|
| HealthMeasurement   | insert-if-absent (immutable evidence)                                     |
| HealthAlert         | state-order merge: Open < Acknowledged < InReview < Resolved/Dismissed;   |
|                     | trigger fields follow the newest trigger                                  |
| MedicalReport       | insert-if-absent; the Ground copy is marked Delivered                     |
| MedicalInstruction  | insert-if-absent; DeliveredAt / AcknowledgedAt: first non-null wins       |
| Insight             | upsert (derived, last writer wins)                                        |
| SpaceWeatherEvent   | insert-if-absent                                                          |
| HealthPhoto         | insert-if-absent (immutable evidence)                                     |
| Mission             | last writer wins on the environment profile (set on the Habitat)          |
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlmodel import Session, SQLModel, select

from astra.core.enums import NodeRole
from astra.db.models import (
    Astronaut,
    EnvironmentReading,
    HealthAlert,
    HealthMeasurement,
    HealthPhoto,
    Insight,
    MedicalInstruction,
    MedicalReport,
    Mission,
    SpaceWeatherEvent,
    SyncOutbox,
)

STATE_RANK = {"Open": 0, "Acknowledged": 1, "InReview": 2, "Resolved": 3, "Dismissed": 3}
ALERT_STATE_FIELDS = (
    "status",
    "acknowledged_at",
    "acknowledged_by",
    "reviewed_by",
    "resolved_at",
    "resolution_note",
)
ALERT_TRIGGER_FIELDS = (
    "last_triggered_at", "trigger_count", "reason", "evidence_json", "escalation_required", "rule_version",
    "consecutive_clear",
)  # fmt: skip

Event = tuple[str, str, dict[str, Any]]  # (kind, astronaut_id, payload)


@dataclass
class MergeResult:
    applied: int = 0
    skipped: int = 0
    alerts_created: list[HealthAlert] = field(default_factory=list)
    alerts_updated: list[HealthAlert] = field(default_factory=list)
    events: list[Event] = field(default_factory=list)


def _insert_if_absent(
    session: Session, model: type[SQLModel], payload: dict[str, Any], key: Any
) -> SQLModel | None:
    if session.get(model, key) is not None:
        return None
    row = model.model_validate(payload)
    session.add(row)
    return row


def _merge_alert(
    session: Session, incoming: HealthAlert, result: MergeResult, on_closed: Callable[[HealthAlert], None]
) -> None:
    current = session.get(HealthAlert, incoming.id)
    if current is None:
        session.add(incoming)
        result.alerts_created.append(incoming)
        return
    changed = False
    was_active = STATE_RANK[current.status] < 3
    if STATE_RANK[incoming.status] > STATE_RANK[current.status]:
        for f in ALERT_STATE_FIELDS:
            setattr(current, f, getattr(incoming, f))
        changed = True
    else:
        for f in ("acknowledged_at", "acknowledged_by", "reviewed_by"):
            if getattr(current, f) is None and getattr(incoming, f) is not None:
                setattr(current, f, getattr(incoming, f))
                changed = True
    if incoming.last_triggered_at > current.last_triggered_at:
        for f in ALERT_TRIGGER_FIELDS:
            setattr(current, f, getattr(incoming, f))
        changed = True
    if changed:
        current.version = max(current.version, incoming.version) + 1
        current.updated_at = datetime.now(UTC)
        session.add(current)
        result.alerts_updated.append(current)
        if was_active and STATE_RANK[current.status] == 3:
            on_closed(current)


def apply_items(
    session: Session,
    items: list[dict[str, Any]],
    *,
    role: NodeRole,
    on_alert_closed: Callable[[HealthAlert], None],
) -> MergeResult:
    result = MergeResult()
    now = datetime.now(UTC)
    for item in items:
        kind, payload = item["entityType"], item["payload"]
        if kind == "HealthMeasurement":
            row = _insert_if_absent(session, HealthMeasurement, payload, payload["id"])
        elif kind == "HealthAlert":
            _merge_alert(session, HealthAlert.model_validate(payload), result, on_alert_closed)
            row = True  # type: ignore[assignment]
        elif kind == "MedicalReport":
            row = _insert_if_absent(session, MedicalReport, payload, payload["id"])
            if isinstance(row, MedicalReport):
                if role == NodeRole.GROUND:
                    row.transmission_status = "Delivered"
                result.events.append(("ReportGenerated", row.astronaut_id, {"id": row.id, "type": row.type}))
        elif kind == "MedicalInstruction":
            row = _merge_instruction(session, MedicalInstruction.model_validate(payload), role, now, result)
        elif kind == "Insight":
            incoming = Insight.model_validate(payload)
            session.merge(incoming)
            row = incoming
        elif kind == "EnvironmentReading":
            row = _insert_if_absent(session, EnvironmentReading, payload, payload["id"])
        elif kind == "SpaceWeatherEvent":
            row = _insert_if_absent(session, SpaceWeatherEvent, payload, payload["id"])
            if isinstance(row, SpaceWeatherEvent):
                result.events.append(
                    ("SpaceWeatherNotice", "", {"id": row.id, "eventTime": payload["event_time"]})
                )
        elif kind == "HealthPhoto":
            row = _insert_if_absent(session, HealthPhoto, payload, payload["id"])
            if isinstance(row, HealthPhoto):
                who = session.get(Astronaut, row.astronaut_id)
                payload = {"id": row.id, "astronautCode": who.code if who else None}
                result.events.append(("PhotoAdded", row.astronaut_id, payload))
        elif kind == "Mission":
            mission = session.exec(select(Mission).where(Mission.code == payload["code"])).first()
            if mission is not None and mission.profile_code != payload["profile_code"]:
                mission.profile_code = payload["profile_code"]
                session.add(mission)
                result.events.append(("MissionChanged", "", {"profileCode": mission.profile_code}))
                row = mission
            else:
                row = None
        else:
            row = None
        if row is None:
            result.skipped += 1
        else:
            result.applied += 1
    return result


def _merge_instruction(
    session: Session, incoming: MedicalInstruction, role: NodeRole, now: datetime, result: MergeResult
) -> MedicalInstruction | None:
    current = session.get(MedicalInstruction, incoming.id)
    if current is None:
        if role == NodeRole.HABITAT:
            # Arrived onboard: delivered now. Tell the ground (an update that originates here).
            incoming.delivered_at = now
            session.add(incoming)
            session.flush()
            session.add(SyncOutbox(entity_type="MedicalInstruction", entity_id=incoming.id,
                                   payload_json=incoming.model_dump_json(), priority=2))  # fmt: skip
            result.events.append(("InstructionReceived", incoming.astronaut_id, {}))
        else:
            session.add(incoming)
        return incoming
    changed = False
    for f in ("delivered_at", "acknowledged_at"):
        if getattr(current, f) is None and getattr(incoming, f) is not None:
            setattr(current, f, getattr(incoming, f))
            changed = True
    if not changed:
        return None
    session.add(current)
    if current.acknowledged_at is not None:
        result.events.append(("InstructionAcknowledged", current.astronaut_id, {}))
    return current


def astronaut_of(session: Session, astronaut_id: str) -> Astronaut | None:
    return session.get(Astronaut, astronaut_id) if astronaut_id else None
