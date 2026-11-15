"""The mission and its environment (protocols/mission-profiles/*.json).

- GET /api/mission                 — anyone signed in: the mission, its environment profile and the options.
- PUT /api/admin/mission/profile   — Admin, Habitat: switch the environment (space station, Mars transit,
  Moon rover, Mars base). The radiation limit, exercise and fluid targets, assistant context and link
  delay all follow the profile. The change reaches the Ground node over the simulated link.
"""

from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlmodel import Session, select

from astra.api.base import ApiModel
from astra.core.enums import NodeRole, Role
from astra.core.protocols import HealthFocus, MissionProfile, ProtocolBundle
from astra.db.models import Mission, SyncOutbox
from astra.db.session import SessionDep
from astra.realtime.hub import hub
from astra.security.deps import CurrentUser, require_role
from astra.security.jwt import TokenClaims
from astra.sync.link import get_link, horizons_light_minutes

router = APIRouter(prefix="/api", tags=["mission"])

Admin = Annotated[TokenClaims, Depends(require_role(Role.ADMIN))]


class ProfileOut(ApiModel):
    code: str
    name: str
    environment: str
    location: str
    gravity_g: float
    day_name: str
    day_length_hours: float
    comms_delay_min_minutes: float
    comms_delay_max_minutes: float
    evacuation: str
    radiation_limit_msv: float
    exercise_target_sessions_per_week: int
    hydration_target_ml_per_day: int
    health_focus: list[HealthFocus]
    disclaimer: str


class ProfileOption(ApiModel):
    code: str
    name: str
    environment: str


class MissionOut(ApiModel):
    code: str
    name: str
    start_date: date
    profile: ProfileOut | None
    options: list[ProfileOption]


class ProfileIn(ApiModel):
    profile_code: str


class MissionSync(ApiModel):
    """What travels to the Ground node when the environment changes."""

    code: str
    profile_code: str


def _profile_out(p: MissionProfile) -> ProfileOut:
    return ProfileOut(
        code=p.code,
        name=p.name,
        environment=p.environment,
        location=p.location,
        gravity_g=p.gravity_g,
        day_name=p.day_name,
        day_length_hours=p.sol_length_hours,
        comms_delay_min_minutes=p.comms_delay_minutes.min,
        comms_delay_max_minutes=p.comms_delay_minutes.max,
        evacuation=p.evacuation,
        radiation_limit_msv=p.radiation_limit_msv,
        exercise_target_sessions_per_week=p.exercise_target_sessions_per_week,
        hydration_target_ml_per_day=p.hydration_target_ml_per_day,
        health_focus=p.health_focus,
        disclaimer=p.disclaimer,
    )


def current_mission(session: Session, request: Request) -> Mission:
    mission = (
        session.exec(select(Mission).where(Mission.code == request.app.state.settings.mission_code)).first()
        or session.exec(select(Mission)).first()
    )
    if mission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No mission yet: run `python -m astra.seed`")
    return mission


def _mission_out(mission: Mission, bundle: ProtocolBundle) -> MissionOut:
    profile = bundle.mission_profiles.get(mission.profile_code)
    order = ["Space station", "Spacecraft", "Pressurized rover", "Planetary base"]
    options = sorted(bundle.mission_profiles.values(), key=lambda p: (order.index(p.environment), p.name))
    return MissionOut(
        code=mission.code,
        name=mission.name,
        start_date=mission.start_date,
        profile=_profile_out(profile) if profile else None,
        options=[ProfileOption(code=p.code, name=p.name, environment=p.environment) for p in options],
    )


def link_delay_minutes(profile: MissionProfile, day: date) -> tuple[float, str]:
    """One-way light time for the environment: the real Earth–Mars value for Mars, else the profile's."""
    if profile.light_time == "horizons-mars":
        minutes = horizons_light_minutes(day)
        if minutes is not None:
            return round(minutes, 2), "horizons"
    delay = profile.comms_delay_minutes
    return round((delay.min + delay.max) / 2, 3), "profile"


@router.get("/mission", response_model=MissionOut)
def get_mission(request: Request, session: SessionDep, user: CurrentUser) -> MissionOut:
    return _mission_out(current_mission(session, request), request.app.state.protocols)


@router.put("/admin/mission/profile", response_model=MissionOut)
def put_mission_profile(body: ProfileIn, request: Request, session: SessionDep, user: Admin) -> MissionOut:
    if request.app.state.settings.node_role != NodeRole.HABITAT:
        raise HTTPException(status.HTTP_409_CONFLICT, "The mission environment is set on the Habitat node")
    bundle: ProtocolBundle = request.app.state.protocols
    profile = bundle.mission_profiles.get(body.profile_code)
    if profile is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown profile {body.profile_code}")
    mission = current_mission(session, request)
    mission.profile_code = profile.code
    session.add(mission)

    now = datetime.now(UTC)
    link = get_link(session, request.app.state.settings.link_compression_seconds_per_minute)
    link.real_delay_minutes, link.delay_source = link_delay_minutes(profile, now.date())
    link.updated_at = now
    session.add(link)
    # tell Earth: the Ground node shows the same environment once this arrives
    session.add(
        SyncOutbox(
            entity_type="Mission",
            entity_id=mission.id,
            payload_json=MissionSync(code=mission.code, profile_code=profile.code).model_dump_json(),
            priority=2,
        )
    )
    session.commit()
    out = _mission_out(mission, bundle)
    hub.publish_from_thread(["all"], "MissionChanged", {"profileCode": profile.code})
    return out
