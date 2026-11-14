"""Habitat environment, radiation and space weather (Step 10; LLD §13.2, §13.4, §20).

- POST /api/environment/readings — cabin sensors (Admin / device feed; Habitat only). Live readings
  evaluate the environment rules for every astronaut (cabin air is shared).
- GET  /api/environment/current  — latest cabin values with illustrative ranges and the last 48 h.
- GET  /api/astronauts/{id}/radiation — daily dose per channel, mission total vs the limit, solar events.
- GET  /api/space-weather/now    — NOAA ≥10 MeV proton flux (live on the Ground node, cached fixture
  otherwise), recent DONKI SEP events and today's Earth–Mars light time (JPL Horizons).
"""

import hashlib
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import AwareDatetime, Field
from sqlmodel import col, select

from astra.api.alerts import publish_alert_changes
from astra.api.base import ApiModel
from astra.core.alerts import ACTIVE_STATUSES
from astra.core.enums import MeasurementQuality, NodeRole, Role
from astra.core.ids import uuid7
from astra.core.validation import RawReading, validate_reading
from astra.db.models import (
    Astronaut,
    EnvironmentReading,
    HealthAlert,
    HealthMeasurement,
    Mission,
    SpaceWeatherEvent,
    SyncOutbox,
)
from astra.db.session import SessionDep
from astra.integrations.fixtures import DONKI_SEP_MAY_2024, FIXTURES_DIR, load_fixture
from astra.integrations.nasa_donki import parse_sep
from astra.integrations.noaa_swpc import S1_THRESHOLD_PFU, ProtonFlux, latest_10mev
from astra.security.deps import CurrentUser, ViewableAstronaut, require_role
from astra.security.jwt import TokenClaims
from astra.services.assessment import assess
from astra.sync.link import horizons_light_minutes

router = APIRouter(prefix="/api", tags=["environment"])
Admin = Annotated[TokenClaims, Depends(require_role(Role.ADMIN))]

CABIN = ("cabin_temp", "cabin_humidity", "cabin_co2")
# Illustrative comfort / action ranges for the panel (not mission requirements)
RANGES: dict[str, tuple[float, float]] = {"cabin_temp": (18.0, 27.0), "cabin_humidity": (25.0, 70.0),
                                          "cabin_co2": (0.0, 4.0)}  # fmt: skip
NOAA_FIXTURE = FIXTURES_DIR / "noaa-protons-1-day.json"


class EnvItem(ApiModel):
    id: str | None = None
    indicator: Literal["cabin_temp", "cabin_humidity", "cabin_co2"]
    value: float
    unit: str
    measured_at: AwareDatetime
    module: str = "HAB"


class EnvBatchIn(ApiModel):
    items: list[EnvItem] = Field(min_length=1, max_length=5000)


class EnvBatchOut(ApiModel):
    accepted: int
    duplicates: int
    rejected: list[str]
    new_alerts: list[str]


def _env_id(item: EnvItem, measured_at: datetime) -> str:
    digest = hashlib.sha256(f"{item.indicator}|{item.module}|{measured_at.isoformat()}".encode()).digest()
    return item.id or str(uuid7(int(measured_at.timestamp() * 1000), digest))


@router.post("/environment/readings", response_model=EnvBatchOut, status_code=status.HTTP_201_CREATED)
def post_environment(
    body: EnvBatchIn,
    request: Request,
    session: SessionDep,
    user: Admin,
    x_backfill: Annotated[bool, Header(description="true for history imports (no rule evaluation)")] = False,
) -> EnvBatchOut:
    cfg = request.app.state.settings
    if cfg.node_role != NodeRole.HABITAT:
        raise HTTPException(status.HTTP_409_CONFLICT, "Cabin sensors report to the Habitat node")
    bundle = request.app.state.protocols
    now = datetime.now(UTC)
    accepted, duplicates, rejected = 0, 0, []
    latest: datetime | None = None
    for item in body.items:
        at = item.measured_at.astimezone(UTC)
        raw = RawReading(indicator=item.indicator, value=item.value, unit=item.unit, measured_at=at)
        result = validate_reading(raw, bundle.catalog, now=now, backfill=x_backfill)
        if result.quality != MeasurementQuality.VALID or result.value is None:
            rejected.append(f"{item.indicator}@{at.isoformat()}: {result.reason}")
            continue
        rid = _env_id(item, at)
        if session.get(EnvironmentReading, rid) is not None:
            duplicates += 1
            continue
        row = EnvironmentReading(
            id=rid, indicator_code=item.indicator, value=result.value, unit=result.unit or item.unit,
            measured_at=at, module=item.module, source="Simulated" if x_backfill else "Sensor",
            is_simulated=x_backfill, origin_node_id=cfg.node_id,
        )  # fmt: skip
        session.add(row)
        session.add(
            SyncOutbox(entity_type="EnvironmentReading", entity_id=rid, payload_json=row.model_dump_json())
        )
        accepted += 1
        latest = max(latest, at) if latest else at
    session.commit()

    new_alerts: list[str] = []
    if accepted and not x_backfill and latest is not None:
        for astronaut in session.exec(select(Astronaut).order_by(Astronaut.code)).all():
            result_ = assess(session, bundle, astronaut, [min(latest, now)], node_id=cfg.node_id)
            session.commit()
            publish_alert_changes(result_.changes, astronaut)
            new_alerts += [f"{astronaut.code}:{a.rule_id}" for a in result_.changes.created]
    return EnvBatchOut(accepted=accepted, duplicates=duplicates, rejected=rejected, new_alerts=new_alerts)


class CabinPoint(ApiModel):
    t: datetime
    value: float


class CabinValue(ApiModel):
    indicator: str
    name: str
    unit: str
    value: float | None
    measured_at: datetime | None
    low: float
    high: float
    status: Literal["normal", "out_of_range", "no_data"]
    series: list[CabinPoint]


@router.get("/environment/current", response_model=list[CabinValue])
def environment_current(request: Request, session: SessionDep, user: CurrentUser) -> list[CabinValue]:
    bundle = request.app.state.protocols
    out = []
    for code in CABIN:
        rows = session.exec(
            select(EnvironmentReading)
            .where(EnvironmentReading.indicator_code == code)
            .order_by(col(EnvironmentReading.measured_at).desc())
            .limit(8)
        ).all()
        low, high = RANGES[code]
        meta = bundle.catalog.get(code)
        last = rows[0] if rows else None
        state: Literal["normal", "out_of_range", "no_data"] = (
            "no_data" if last is None else "normal" if low <= last.value <= high else "out_of_range"
        )
        out.append(CabinValue(
            indicator=code, name=meta.name, unit=meta.unit, value=last.value if last else None,
            measured_at=last.measured_at if last else None, low=low, high=high, status=state,
            series=[CabinPoint(t=r.measured_at, value=r.value) for r in reversed(rows)],
        ))  # fmt: skip
    return out


class DoseDay(ApiModel):
    day: date
    total: float
    neutron: float
    charged: float


class SepEventOut(ApiModel):
    id: str
    event_time: datetime
    instruments: str
    source: str


class RadiationOut(ApiModel):
    astronaut_code: str
    days: list[DoseDay]
    mission_total_msv: float
    limit_msv: float | None
    pct_of_limit: float | None
    neutron_share: float | None
    active_sep_alert: dict[str, Any] | None
    replayed_storm: str  # the real NASA DONKI event the simulator replays
    space_weather_events: list[SepEventOut]
    light_time_minutes: float | None


@router.get("/astronauts/{astronaut}/radiation", response_model=RadiationOut)
def radiation(
    astronaut: ViewableAstronaut,
    request: Request,
    session: SessionDep,
    range_: Annotated[Literal["30d", "mission"], Query(alias="range")] = "30d",
) -> RadiationOut:
    bundle = request.app.state.protocols
    mission = session.get(Mission, astronaut.mission_id)
    profile = bundle.mission_profiles.get(mission.profile_code) if mission else None
    today = datetime.now(UTC).date()
    start = mission.start_date if (range_ == "mission" and mission) else today - timedelta(days=29)
    rows = session.exec(
        select(HealthMeasurement).where(
            HealthMeasurement.astronaut_id == astronaut.id,
            HealthMeasurement.indicator_code == "radiation_dose",
            HealthMeasurement.quality == MeasurementQuality.VALID.value,
        )
    ).all()
    by_day: dict[date, dict[str, float]] = {}
    mission_total, mission_neutron = 0.0, 0.0
    for r in rows:
        if r.value is None:
            continue
        d = r.measured_at.date()
        if mission is None or d >= mission.start_date:
            if r.channel == "Total":
                mission_total += r.value
            elif r.channel == "Neutron":
                mission_neutron += r.value
        if d >= start:
            by_day.setdefault(d, {})[r.channel or "Total"] = r.value
    days = [
        DoseDay(day=d, total=round(v.get("Total", 0.0), 3), neutron=round(v.get("Neutron", 0.0), 3),
                charged=round(max(v.get("Total", 0.0) - v.get("Neutron", 0.0), 0.0), 3))
        for d, v in sorted(by_day.items())
    ]  # fmt: skip
    sep = session.exec(
        select(HealthAlert)
        .where(
            HealthAlert.astronaut_id == astronaut.id,
            HealthAlert.rule_id == "RAD-SPE-EVENT",
            col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]),
        )
        .order_by(col(HealthAlert.last_triggered_at).desc())
    ).first()
    events = session.exec(
        select(SpaceWeatherEvent).order_by(col(SpaceWeatherEvent.event_time).desc()).limit(5)
    ).all()
    storm = parse_sep(load_fixture(DONKI_SEP_MAY_2024))
    limit = profile.radiation_limit_msv if profile else None
    return RadiationOut(
        astronaut_code=astronaut.code,
        days=days,
        mission_total_msv=round(mission_total, 2),
        limit_msv=limit,
        pct_of_limit=round(100 * mission_total / limit, 1) if limit else None,
        neutron_share=round(mission_neutron / mission_total, 3) if mission_total else None,
        active_sep_alert={
            "id": sep.id,
            "title": sep.title,
            "protocol": sep.protocol,
            "since": sep.first_triggered_at,
        }
        if sep
        else None,
        replayed_storm=f"Real NASA DONKI solar particle events, {storm[0].event_time:%d %b %Y}"
        + (f" – {storm[-1].event_time:%d %b %Y}" if len(storm) > 1 else ""),
        space_weather_events=[
            SepEventOut(id=e.id, event_time=e.event_time, instruments=e.instruments, source=e.source)
            for e in events
        ],  # fmt: skip
        light_time_minutes=horizons_light_minutes(today),
    )


class SpaceWeatherNow(ApiModel):
    proton_flux_pfu: float | None
    flux_time: datetime | None
    s_scale: str | None
    threshold_pfu: float = S1_THRESHOLD_PFU
    source: Literal["noaa-live", "noaa-fixture", "none"]
    recent_sep_events: list[SepEventOut]
    light_time_minutes: float | None


def _fixture_flux() -> ProtonFlux | None:
    try:
        return latest_10mev(load_fixture(NOAA_FIXTURE))
    except (OSError, ValueError):
        return None


@router.get("/space-weather/now", response_model=SpaceWeatherNow)
def space_weather_now(request: Request, session: SessionDep, user: CurrentUser) -> SpaceWeatherNow:
    live: ProtonFlux | None = getattr(request.app.state, "proton_flux", None)
    flux, source = (live, "noaa-live") if live else (_fixture_flux(), "noaa-fixture")
    events = session.exec(
        select(SpaceWeatherEvent).order_by(col(SpaceWeatherEvent.event_time).desc()).limit(5)
    ).all()
    return SpaceWeatherNow(
        proton_flux_pfu=round(flux.flux_pfu, 3) if flux else None,
        flux_time=flux.time if flux else None,
        s_scale=flux.s_scale if flux else None,
        source=source if flux else "none",  # type: ignore[arg-type]
        recent_sep_events=[
            SepEventOut(id=e.id, event_time=e.event_time, instruments=e.instruments, source=e.source)
            for e in events
        ],  # fmt: skip
        light_time_minutes=horizons_light_minutes(datetime.now(UTC).date()),
    )
