"""Health Analytics data (LLD §13.2): daily values with the personal-baseline band, flagged readings,
alert markers, and the wellness trend."""

from datetime import UTC, date, datetime, time, timedelta
from statistics import mean
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlmodel import col, select

from astra.api.base import ApiModel
from astra.core.enums import MeasurementQuality
from astra.core.protocols import ProtocolBundle
from astra.db.models import HealthAlert, HealthMeasurement, Mission, WellnessScore
from astra.db.session import SessionDep
from astra.security.deps import ViewableAstronaut
from astra.services.assessment import HISTORY_MARGIN, load_assessor

router = APIRouter(prefix="/api", tags=["analytics"])

Range = Literal["7d", "30d", "90d", "mission"]
BAND_SIGMAS = 2.0


class DayPoint(ApiModel):
    day: date
    value: float | None
    min: float | None
    max: float | None
    n: int
    median: float | None = None  # personal baseline that day
    sigma: float | None = None
    low: float | None = None  # median − 2σ
    high: float | None = None  # median + 2σ
    z: float | None = None


class FlaggedReading(ApiModel):
    t: datetime
    value: float | None
    reason: str | None


class AlertMarker(ApiModel):
    id: str
    rule_id: str
    severity: str
    title: str
    first_day: date
    last_day: date
    status: str


class Reference(ApiModel):
    median: float
    sigma: float


class AnalyticsOut(ApiModel):
    astronaut_code: str
    indicator: str
    name: str
    unit: str
    decimals: int
    worse_when: Literal["high", "low", "both"]
    has_baseline: bool
    start: date
    end: date
    days: list[DayPoint]
    questionable: list[FlaggedReading]
    preflight: Reference | None
    alerts: list[AlertMarker]


class WellnessDay(ApiModel):
    day: date
    overall: int | None
    cardiovascular: float | None
    sleep: float | None
    behavioral: float | None
    activity: float | None
    metabolic: float | None
    environment: float | None


def _window(rng: Range, today: date, mission_start: date | None) -> date:
    if rng == "mission" and mission_start:
        return mission_start
    return today - timedelta(days={"7d": 6, "30d": 29, "90d": 89, "mission": 119}[rng])


@router.get("/astronauts/{astronaut}/analytics", response_model=AnalyticsOut)
def get_analytics(
    astronaut: ViewableAstronaut,
    request: Request,
    session: SessionDep,
    indicator: Annotated[str, Query(examples=["resting_hr"])],
    range_: Annotated[Range, Query(alias="range")] = "30d",
) -> AnalyticsOut:
    bundle: ProtocolBundle = request.app.state.protocols
    if indicator not in bundle.catalog:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown indicator '{indicator}'")
    meta = bundle.catalog.get(indicator)
    mission = session.get(Mission, astronaut.mission_id)
    today = datetime.now(UTC).date()
    start = _window(range_, today, mission.start_date if mission else None)
    since = datetime.combine(start, time.min, tzinfo=UTC)

    assessor = load_assessor(session, bundle, astronaut, since - HISTORY_MARGIN)
    by_day: dict[date, list[float]] = {}
    for p in assessor.series.get(indicator, []):
        if p.t >= since:
            by_day.setdefault(p.t.date(), []).append(p.value)

    days: list[DayPoint] = []
    d = start
    while d <= today:
        values = by_day.get(d, [])
        value = round(mean(values), max(meta.decimals, 1)) if values else None
        base = assessor.baseline(indicator, d)
        point = DayPoint(
            day=d, value=value, min=min(values, default=None), max=max(values, default=None), n=len(values)
        )
        if base is not None:
            point.median, point.sigma = round(base.median, 3), round(base.sigma, 3)
            point.low = round(base.median - BAND_SIGMAS * base.sigma, 3)
            point.high = round(base.median + BAND_SIGMAS * base.sigma, 3)
            if value is not None and meta.has_baseline:
                z = base.z(value)
                point.z = round(z, 2) if z is not None else None
        days.append(point)
        d += timedelta(days=1)

    flagged = session.exec(
        select(HealthMeasurement)
        .where(
            HealthMeasurement.astronaut_id == astronaut.id,
            HealthMeasurement.indicator_code == indicator,
            HealthMeasurement.quality == MeasurementQuality.QUESTIONABLE.value,
            col(HealthMeasurement.measured_at) >= since,
        )
        .order_by(col(HealthMeasurement.measured_at))
    ).all()

    rule_ids = [r.id for r in bundle.rules if any(leaf.indicator == indicator for leaf in r.leaves())]
    alerts = session.exec(
        select(HealthAlert).where(
            HealthAlert.astronaut_id == astronaut.id,
            col(HealthAlert.rule_id).in_(rule_ids),
            col(HealthAlert.last_triggered_at) >= since,
            HealthAlert.status != "Dismissed",
        )
    ).all()

    pre = assessor.preflight(indicator) if meta.has_baseline else None
    return AnalyticsOut(
        astronaut_code=astronaut.code,
        indicator=indicator,
        name=meta.name,
        unit=meta.unit,
        decimals=meta.decimals,
        worse_when=meta.worse_when,
        has_baseline=meta.has_baseline,
        start=start,
        end=today,
        days=days,
        questionable=[
            FlaggedReading(t=m.measured_at, value=m.value, reason=m.quality_reason) for m in flagged
        ],
        preflight=Reference(median=round(pre.median, 3), sigma=round(pre.sigma, 3)) if pre else None,
        alerts=[
            AlertMarker(
                id=a.id,
                rule_id=a.rule_id,
                severity=a.severity,
                title=a.title,
                first_day=a.first_triggered_at.date(),
                last_day=a.last_triggered_at.date(),
                status=a.status,
            )
            for a in sorted(alerts, key=lambda a: a.first_triggered_at)
        ],
    )


@router.get("/astronauts/{astronaut}/wellness", response_model=list[WellnessDay])
def get_wellness_trend(
    astronaut: ViewableAstronaut,
    session: SessionDep,
    range_: Annotated[Range, Query(alias="range")] = "30d",
) -> list[WellnessDay]:
    """Daily wellness index (stored at each assessment)."""
    mission = session.get(Mission, astronaut.mission_id)
    start = _window(range_, datetime.now(UTC).date(), mission.start_date if mission else None)
    rows = session.exec(
        select(WellnessScore)
        .where(WellnessScore.astronaut_id == astronaut.id, col(WellnessScore.score_date) >= start)
        .order_by(col(WellnessScore.score_date))
    ).all()
    return [
        WellnessDay(
            day=r.score_date,
            overall=r.overall,
            cardiovascular=r.cardiovascular,
            sleep=r.sleep,
            behavioral=r.behavioral,
            activity=r.activity,
            metabolic=r.metabolic,
            environment=r.environment,
        )
        for r in rows
    ]
