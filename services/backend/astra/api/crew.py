from datetime import date

from fastapi import APIRouter
from sqlmodel import col, select

from astra.api.base import ApiModel
from astra.core.enums import Role
from astra.db.models import Astronaut, Mission
from astra.db.session import SessionDep
from astra.security.deps import CurrentUser

router = APIRouter(prefix="/api", tags=["crew"])


class AstronautOut(ApiModel):
    id: str
    code: str
    display_name: str
    role_title: str
    mission_code: str
    mission_start: date


@router.get("/astronauts", response_model=list[AstronautOut])
def list_astronauts(session: SessionDep, user: CurrentUser) -> list[AstronautOut]:
    """Crew list. Astronauts see only themselves; staff roles see the whole crew."""
    query = select(Astronaut, Mission).join(Mission, col(Astronaut.mission_id) == Mission.id)
    if user.role == Role.ASTRONAUT:
        query = query.where(Astronaut.id == user.astronaut_id)
    rows = session.exec(query.order_by(Astronaut.code)).all()
    return [
        AstronautOut(
            id=a.id,
            code=a.code,
            display_name=a.display_name,
            role_title=a.role_title,
            mission_code=m.code,
            mission_start=m.start_date,
        )
        for a, m in rows
    ]
