"""Store a batch of readings: validate, de-duplicate, persist, audit, queue for sync (HLD §5.1).

Step 3 adds: update baselines → evaluate rules → alerts → recommendations → WebSocket events.
"""

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlmodel import Session, col, select

from astra.core.enums import MeasurementQuality
from astra.core.ids import uuid7
from astra.core.indicators import IndicatorCatalog
from astra.core.validation import (
    JUMP_CHECK_INDICATORS,
    JUMP_WINDOW,
    PreviousValid,
    RawReading,
    ValidationResult,
    check_panels,
    validate_reading,
)
from astra.db.models import Astronaut, AuditLog, HealthMeasurement, SyncOutbox


@dataclass(frozen=True)
class IncomingReading:
    indicator: str
    value: float
    unit: str
    measured_at: datetime
    source: str
    id: str | None = None
    device_id: str | None = None
    channel: str | None = None
    panel_id: str | None = None
    signal_quality: float | None = None
    motion_artifact: bool = False
    is_simulated: bool = False

    def raw(self) -> RawReading:
        channel = self.channel or ("Total" if self.indicator == "radiation_dose" else None)
        return RawReading(
            indicator=self.indicator,
            value=self.value,
            unit=self.unit,
            measured_at=self.measured_at,
            channel=channel,
            panel_id=self.panel_id,
            signal_quality=self.signal_quality,
            motion_artifact=self.motion_artifact,
        )


@dataclass
class BatchOutcome:
    accepted: list[str] = field(default_factory=list)
    questionable: list[tuple[str, str]] = field(default_factory=list)
    rejected: list[tuple[str, str]] = field(default_factory=list)
    duplicates: list[str] = field(default_factory=list)


ReadingKey = tuple[str, str, datetime, str]  # indicator, channel, measured_at, device


def _key(reading: RawReading, device_id: str) -> ReadingKey:
    return (reading.indicator, reading.channel or "", reading.measured_at.astimezone(UTC), device_id)


def _reading_id(item: IncomingReading, raw: RawReading, astronaut_id: str) -> str:
    if item.id:
        return item.id
    # Deterministic: the same reading posted twice gets the same id (idempotent).
    digest = hashlib.sha256(f"{astronaut_id}|{_key(raw, item.device_id or '')}".encode()).digest()
    return str(uuid7(int(raw.measured_at.timestamp() * 1000), digest))


def _previous_valid(
    session: Session, astronaut_id: str, raw: RawReading, in_batch: dict[str, PreviousValid]
) -> PreviousValid | None:
    if raw.indicator not in JUMP_CHECK_INDICATORS:
        return None
    candidate = in_batch.get(raw.indicator)
    if candidate and candidate.measured_at <= raw.measured_at:
        return candidate
    row = session.exec(
        select(HealthMeasurement)
        .where(
            HealthMeasurement.astronaut_id == astronaut_id,
            HealthMeasurement.indicator_code == raw.indicator,
            HealthMeasurement.quality == MeasurementQuality.VALID.value,
            col(HealthMeasurement.measured_at) >= raw.measured_at - JUMP_WINDOW,
            col(HealthMeasurement.measured_at) <= raw.measured_at,
        )
        .order_by(col(HealthMeasurement.measured_at).desc())
    ).first()
    if row is None or row.value is None:
        return None
    return PreviousValid(row.value, row.measured_at)


def ingest_batch(
    session: Session,
    catalog: IndicatorCatalog,
    astronaut: Astronaut,
    items: Sequence[IncomingReading],
    *,
    node_id: str,
    backfill: bool = False,
    now: datetime | None = None,
    user_id: str | None = None,
) -> BatchOutcome:
    now = now or datetime.now(UTC)
    outcome = BatchOutcome()
    ordered = sorted(items, key=lambda i: i.measured_at)
    raws = [i.raw() for i in ordered]
    ids = [_reading_id(i, r, astronaut.id) for i, r in zip(ordered, raws, strict=True)]

    existing_ids = set(session.exec(select(HealthMeasurement.id).where(col(HealthMeasurement.id).in_(ids))).all())
    existing_keys: set[ReadingKey] = set()
    if raws:
        rows = session.exec(
            select(HealthMeasurement).where(
                HealthMeasurement.astronaut_id == astronaut.id,
                col(HealthMeasurement.measured_at) >= raws[0].measured_at,
                col(HealthMeasurement.measured_at) <= raws[-1].measured_at,
            )
        ).all()
        existing_keys = {(r.indicator_code, r.channel, r.measured_at, r.device_id) for r in rows}

    # 1. per-reading validation (skipping duplicates)
    pending: list[tuple[IncomingReading, RawReading, str, ValidationResult]] = []
    seen_keys: set[ReadingKey] = set()
    last_valid: dict[str, PreviousValid] = {}
    for item, raw, reading_id in zip(ordered, raws, ids, strict=True):
        key = _key(raw, item.device_id or "")
        if reading_id in existing_ids or key in existing_keys or key in seen_keys:
            outcome.duplicates.append(reading_id)  # T-V-04: idempotent, nothing stored twice
            continue
        seen_keys.add(key)
        previous = _previous_valid(session, astronaut.id, raw, last_valid)
        result = validate_reading(raw, catalog, now=now, backfill=backfill, previous=previous)
        if result.quality == MeasurementQuality.VALID and result.value is not None:
            last_valid[raw.indicator] = PreviousValid(result.value, raw.measured_at)
        pending.append((item, raw, reading_id, result))

    # 2. cross-field checks (blood-pressure panels)
    results = check_panels([(raw, result) for _, raw, _, result in pending])

    # 3. persist everything, including rejected readings (kept as evidence, excluded from analytics)
    for (item, raw, reading_id, _), result in zip(pending, results, strict=True):
        measurement = HealthMeasurement(
            id=reading_id,
            astronaut_id=astronaut.id,
            indicator_code=raw.indicator,
            channel=raw.channel or "",
            value=result.value,
            unit=result.unit,
            original_value=raw.value,
            original_unit=raw.unit,
            measured_at=raw.measured_at,
            received_at=now,
            source=item.source,
            device_id=item.device_id or "",
            panel_id=raw.panel_id,
            quality=result.quality.value,
            quality_reason=result.reason,
            is_simulated=item.is_simulated,
            origin_node_id=node_id,
        )
        session.add(measurement)
        session.add(
            SyncOutbox(
                entity_type="HealthMeasurement",
                entity_id=reading_id,
                payload_json=measurement.model_dump_json(),
            )
        )
        if result.quality == MeasurementQuality.VALID:
            outcome.accepted.append(reading_id)
        elif result.quality == MeasurementQuality.QUESTIONABLE:
            outcome.questionable.append((reading_id, result.reason or ""))
        else:
            outcome.rejected.append((reading_id, result.reason or ""))

    session.add(
        AuditLog(
            user_id=user_id,
            action="IngestBatch",
            entity_type="HealthMeasurement",
            entity_id=astronaut.code,
            node_id=node_id,
            details=json.dumps(
                {
                    "accepted": len(outcome.accepted),
                    "questionable": len(outcome.questionable),
                    "rejected": len(outcome.rejected),
                    "duplicates": len(outcome.duplicates),
                    "backfill": backfill,
                }
            ),
        )
    )
    session.commit()
    return outcome
