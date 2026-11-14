"""Astronaut Overview data (LLD §13.2): status, vitals vs personal normal, active alerts, tasks."""

from datetime import UTC, date, datetime
from typing import Literal

from fastapi import APIRouter, Request
from sqlmodel import col, select

from astra.api.alerts import AlertSummary, TaskOut, summarize, task_out
from astra.api.base import ApiModel
from astra.core.alerts import ACTIVE_STATUSES
from astra.core.protocols import ProtocolBundle
from astra.db.models import HealthAlert, HealthMeasurement, Mission, RecommendationTask
from astra.db.session import SessionDep
from astra.security.deps import ViewableAstronaut
from astra.services.assessment import HISTORY_MARGIN, load_assessor
from astra.services.wellness import compute_wellness

router = APIRouter(prefix="/api", tags=["dashboard"])

DASHBOARD_INDICATORS = [
    "resting_hr",
    "bp_sys",
    "bp_dia",
    "body_temp",
    "spo2",
    "glucose",
    "sleep_hours",
    "mood",
    "stress",
    "fatigue",
    "activity_min",
    "radiation_dose",
]
NOTABLE_Z = 2.0


class Vital(ApiModel):
    indicator: str
    name: str
    value: float
    unit: str
    measured_at: datetime
    baseline: float | None
    sigma: float | None
    z: float | None
    deviation: Literal["normal", "above", "below", "unknown"]
    worse_when: Literal["high", "low", "both"]
    previous_value: float | None = None  # the reading before this one (any day)
    previous_at: datetime | None = None
    source: str | None = None  # Manual | Wearable | Device | Simulated …
    quality: str | None = None  # Valid | Questionable


class WellnessDomain(ApiModel):
    domain: str
    score: float | None
    reasons: list[str]


class WellnessOut(ApiModel):
    overall: int | None
    cap_reason: str | None
    indicators_seen: int
    indicators_total: int
    domains: list[WellnessDomain]
    note: str = "Wellness index — a summary of your readings vs your own normal, not a clinical score."


class DashboardOut(ApiModel):
    astronaut_code: str
    display_name: str
    mission_code: str | None
    mission_day: int | None
    status: Literal["GREEN", "YELLOW", "RED"]
    status_reason: str
    active_alerts: list[AlertSummary]
    vitals: list[Vital]
    tasks: list[TaskOut]
    last_reading_at: datetime | None
    wellness_index: int | None = None
    wellness: WellnessOut | None = None
    simulated_data: bool = True


def _deviation(z: float | None) -> Literal["normal", "above", "below", "unknown"]:
    if z is None:
        return "unknown"
    if z >= NOTABLE_Z:
        return "above"
    if z <= -NOTABLE_Z:
        return "below"
    return "normal"


@router.get("/astronauts/{astronaut}/dashboard", response_model=DashboardOut)
def get_dashboard(astronaut: ViewableAstronaut, request: Request, session: SessionDep) -> DashboardOut:
    bundle: ProtocolBundle = request.app.state.protocols
    now = datetime.now(UTC)
    mission = session.get(Mission, astronaut.mission_id)
    today: date = now.date()

    alerts = session.exec(
        select(HealthAlert)
        .where(
            HealthAlert.astronaut_id == astronaut.id,
            col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]),
        )
        .order_by(col(HealthAlert.last_triggered_at).desc())
    ).all()
    urgent = [a for a in alerts if a.severity == "Urgent"]
    status: Literal["GREEN", "YELLOW", "RED"]
    if urgent:
        status, reason = "RED", f"{len(urgent)} urgent alert(s): follow the emergency protocol"
    elif alerts:
        status, reason = "YELLOW", f"{len(alerts)} alert(s) need attention"
    else:
        status, reason = "GREEN", "No current concerning findings"

    assessor = load_assessor(session, bundle, astronaut, now - HISTORY_MARGIN)
    vitals: list[Vital] = []
    for indicator in DASHBOARD_INDICATORS:
        points = assessor.series.get(indicator)
        if not points:
            continue
        latest = points[-1]
        previous = points[-2] if len(points) > 1 else None
        row = session.exec(
            select(HealthMeasurement)
            .where(
                HealthMeasurement.astronaut_id == astronaut.id,
                HealthMeasurement.indicator_code == indicator,
                col(HealthMeasurement.channel).in_(["", "Total"]),
                HealthMeasurement.measured_at == latest.t,
            )
            .limit(1)
        ).first()
        meta = bundle.catalog.get(indicator)
        base = assessor.baseline(indicator, today)
        z = base.z(latest.value) if base else None
        vitals.append(
            Vital(
                indicator=indicator,
                name=meta.name,
                value=latest.value,
                unit=meta.unit,
                measured_at=latest.t,
                baseline=round(base.median, 3) if base else None,
                sigma=round(base.sigma, 3) if base else None,
                z=round(z, 2) if z is not None else None,
                deviation=_deviation(z) if meta.has_baseline else "unknown",
                worse_when=meta.worse_when,
                previous_value=previous.value if previous else None,
                previous_at=previous.t if previous else None,
                source=row.source if row else None,
                quality=row.quality if row else None,
            )
        )

    tasks = session.exec(
        select(RecommendationTask)
        .where(RecommendationTask.astronaut_id == astronaut.id, RecommendationTask.status == "Pending")
        .order_by(col(RecommendationTask.due_at))
    ).all()
    last = max((v.measured_at for v in vitals), default=None)
    well = compute_wellness(session, assessor, astronaut.id, now)
    wellness = WellnessOut(
        overall=well.overall,
        cap_reason=well.cap_reason,
        indicators_seen=well.indicators_seen,
        indicators_total=well.indicators_total,
        domains=[
            WellnessDomain(domain=d.domain, score=d.score, reasons=[p.reason for p in d.penalties[:3]])
            for d in well.domains
        ],
    )
    return DashboardOut(
        astronaut_code=astronaut.code,
        display_name=astronaut.display_name,
        mission_code=mission.code if mission else None,
        mission_day=(today - mission.start_date).days + 1 if mission else None,
        status=status,
        status_reason=reason,
        active_alerts=[summarize(a, astronaut.code) for a in alerts],
        vitals=vitals,
        tasks=[task_out(t, bundle) for t in tasks],
        last_reading_at=last,
        wellness_index=well.overall,
        wellness=wellness,
    )
