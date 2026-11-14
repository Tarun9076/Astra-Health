from datetime import date

from fastapi import APIRouter
from sqlmodel import col, select

from astra.api.base import ApiModel
from astra.db.models import Astronaut, Mission
from astra.db.session import SessionDep

router = APIRouter(prefix="/api", tags=["crew"])


class AstronautOut(ApiModel):
    id: str
    code: str
    display_name: str
    role_title: str
    mission_code: str
    mission_start: date


@router.get("/astronauts", response_model=list[AstronautOut])
def list_astronauts(session: SessionDep) -> list[AstronautOut]:
    """Crew list (auth and role-based filtering arrive in Step 3)."""
    rows = session.exec(
        select(Astronaut, Mission).join(Mission, col(Astronaut.mission_id) == Mission.id).order_by(Astronaut.code)
    ).all()
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
