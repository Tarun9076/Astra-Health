"""Measurement intake and time-series query (LLD §13.2).

Posting: an astronaut may post only their own readings; the Admin (simulator / device gateway)
may post for anyone. Reading: the astronaut themself or a flight surgeon.
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Annotated, Literal

import pandas as pd
from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from pydantic import AwareDatetime, Field
from sqlmodel import col, select

from astra.api.alerts import AlertSummary, publish_alert_changes, summarize
from astra.api.base import ApiModel
from astra.api.reports import publish_report
from astra.core.enums import MeasurementQuality, MeasurementSource, NodeRole, Role
from astra.core.indicators import round_half_up
from astra.core.protocols import ProtocolBundle
from astra.db.models import Astronaut, HealthMeasurement
from astra.db.session import SessionDep
from astra.realtime.hub import hub
from astra.security.deps import CurrentUser, ViewableAstronaut
from astra.services.crew import find_astronaut
from astra.services.ingestion import IncomingReading, ingest_batch
from astra.services.reports import report_new_alerts

router = APIRouter(prefix="/api", tags=["measurements"])


class ReadingIn(ApiModel):
    id: str | None = Field(default=None, description="UUIDv7 from the client; generated if missing")
    indicator: str = Field(examples=["resting_hr"])
    value: float = Field(examples=[64])
    unit: str = Field(examples=["bpm"])
    measured_at: AwareDatetime
    source: MeasurementSource = MeasurementSource.MANUAL
    device_id: str | None = None
    channel: Literal["Total", "Charged", "Neutron"] | None = Field(
        default=None, description="Radiation dosimeter channel (radiation_dose only)"
    )
    panel_id: str | None = Field(
        default=None, description="Groups readings taken together, e.g. bp_sys + bp_dia"
    )
    signal_quality: float | None = Field(default=None, ge=0, le=1)
    motion_artifact: bool = False


class MeasurementBatchIn(ApiModel):
    astronaut_id: str = Field(description="Astronaut code (AST-001) or id", examples=["AST-001"])
    items: list[ReadingIn] = Field(min_length=1, max_length=2000)


class ItemProblem(ApiModel):
    id: str
    reason: str


class MeasurementBatchOut(ApiModel):
    accepted: list[str]
    questionable: list[ItemProblem]
    rejected: list[ItemProblem]
    duplicates: list[str]
    new_alerts: list[AlertSummary] = Field(default_factory=list)
    evaluations: int = Field(default=0, description="How many times the rules were evaluated")


class SeriesPoint(ApiModel):
    t: datetime
    value: float | None
    min: float | None = None
    max: float | None = None
    n: int = 1
    quality: str | None = None
    channel: str | None = None


class SeriesOut(ApiModel):
    astronaut_code: str
    indicator: str
    unit: str
    bucket: str
    points: list[SeriesPoint]


def _bundle(request: Request) -> ProtocolBundle:
    bundle: ProtocolBundle = request.app.state.protocols
    return bundle


def _astronaut_or_404(session: SessionDep, ref: str) -> Astronaut:
    astronaut = find_astronaut(session, ref)
    if astronaut is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Astronaut '{ref}' not found")
    return astronaut


@router.post("/measurements/batch", status_code=status.HTTP_201_CREATED, response_model=MeasurementBatchOut)
def post_measurements(
    body: MeasurementBatchIn,
    request: Request,
    session: SessionDep,
    user: CurrentUser,
    x_backfill: Annotated[bool, Header(description="true for historical/simulated imports")] = False,
) -> MeasurementBatchOut:
    if request.app.state.settings.node_role == NodeRole.GROUND:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Readings are taken onboard: send them to the Habitat node"
        )
    astronaut = _astronaut_or_404(session, body.astronaut_id)
    own = user.role == Role.ASTRONAUT and user.astronaut_id == astronaut.id
    if not (own or user.role == Role.ADMIN):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only post your own readings")
    items = [
        IncomingReading(
            id=r.id,
            indicator=r.indicator,
            value=r.value,
            unit=r.unit,
            measured_at=r.measured_at,
            source=r.source.value,
            device_id=r.device_id,
            channel=r.channel,
            panel_id=r.panel_id,
            signal_quality=r.signal_quality,
            motion_artifact=r.motion_artifact,
            is_simulated=r.source == MeasurementSource.SIMULATED,
        )
        for r in body.items
    ]
    outcome = ingest_batch(
        session,
        _bundle(request),
        astronaut,
        items,
        node_id=request.app.state.settings.node_id,
        backfill=x_backfill,
        user_id=user.user_id,
    )
    if outcome.accepted or outcome.questionable:
        hub.publish_from_thread(
            [f"astronaut:{astronaut.id}", "medical"],
            "MeasurementRecorded",
            {"astronautCode": astronaut.code, "count": len(outcome.accepted) + len(outcome.questionable)},
        )
    publish_alert_changes(outcome.alerts, astronaut)
    if not x_backfill:  # history imports don't send a report per historical alert
        report = report_new_alerts(
            session, _bundle(request), astronaut, outcome.alerts.created,
            node_id=request.app.state.settings.node_id,
        )  # fmt: skip
        if report is not None:
            publish_report(report)
    return MeasurementBatchOut(
        accepted=outcome.accepted,
        questionable=[ItemProblem(id=i, reason=r) for i, r in outcome.questionable],
        rejected=[ItemProblem(id=i, reason=r) for i, r in outcome.rejected],
        duplicates=outcome.duplicates,
        new_alerts=[summarize(a, astronaut.code) for a in outcome.alerts.created],
        evaluations=outcome.evaluations,
    )


@router.get("/astronauts/{astronaut}/measurements", response_model=SeriesOut)
def get_measurements(
    astronaut: ViewableAstronaut,
    request: Request,
    session: SessionDep,
    indicator: Annotated[str, Query(examples=["resting_hr"])],
    start: AwareDatetime | None = None,
    end: AwareDatetime | None = None,
    bucket: Literal["raw", "hour", "day"] = "raw",
    channel: Literal["Total", "Charged", "Neutron"] | None = None,
) -> SeriesOut:
    """Raw readings (Valid + Questionable, with their quality) or hourly/daily buckets of Valid readings."""
    crew = astronaut
    catalog = _bundle(request).catalog
    if indicator not in catalog:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown indicator '{indicator}'")
    meta = catalog.get(indicator)

    wanted = [MeasurementQuality.VALID.value]
    if bucket == "raw":
        wanted.append(MeasurementQuality.QUESTIONABLE.value)
    query = select(HealthMeasurement).where(
        HealthMeasurement.astronaut_id == crew.id,
        HealthMeasurement.indicator_code == indicator,
        col(HealthMeasurement.quality).in_(wanted),
    )
    if indicator == "radiation_dose":
        query = query.where(HealthMeasurement.channel == (channel or "Total"))
    if start:
        query = query.where(col(HealthMeasurement.measured_at) >= start)
    if end:
        query = query.where(col(HealthMeasurement.measured_at) <= end)
    rows = session.exec(query.order_by(col(HealthMeasurement.measured_at))).all()

    if bucket == "raw":
        points = [
            SeriesPoint(t=r.measured_at, value=r.value, quality=r.quality, channel=r.channel or None)
            for r in rows
        ]
    else:
        points = _bucketed(rows, "D" if bucket == "day" else "h", meta.decimals)
    return SeriesOut(
        astronaut_code=crew.code, indicator=indicator, unit=meta.unit, bucket=bucket, points=points
    )


def _bucketed(rows: Sequence[HealthMeasurement], freq: str, decimals: int) -> list[SeriesPoint]:
    data = [(r.measured_at, r.value) for r in rows if r.value is not None]
    if not data:
        return []
    frame = pd.DataFrame(data, columns=["t", "value"]).set_index("t")
    stats = frame["value"].resample(freq).agg(["mean", "min", "max", "count"])
    stats = stats[stats["count"] > 0]
    columns = zip(stats.index, stats["mean"], stats["min"], stats["max"], stats["count"], strict=True)
    return [
        SeriesPoint(
            t=pd.Timestamp(ts).to_pydatetime().astimezone(UTC),
            value=round_half_up(float(mean), decimals),
            min=float(low),
            max=float(high),
            n=int(count),
        )
        for ts, mean, low, high, count in columns
    ]
