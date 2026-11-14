"""Create the mission, crew and demo accounts: `python -m astra.seed`.

Reads services/backend/seed.local.json if it exists (git-ignored), else seed.example.json.
Safe to run repeatedly: existing rows are updated, not duplicated.
"""

import argparse
import json
from datetime import date
from pathlib import Path

from pydantic import Field
from sqlmodel import Session, select

from astra.config import BACKEND_ROOT, settings
from astra.core.base import CoreModel
from astra.core.enums import Role
from astra.db.models import Astronaut, Mission, UserAccount
from astra.db.session import init_db, make_engine
from astra.security.passwords import hash_password, verify_password


class MissionSeed(CoreModel):
    code: str
    name: str
    profile_code: str
    start_date: date


class AstronautSeed(CoreModel):
    code: str
    display_name: str
    role_title: str


class UserSeed(CoreModel):
    username: str
    password: str = Field(min_length=8)
    role: Role
    astronaut_code: str | None = None
    display_name: str


class SeedData(CoreModel):
    comment: str | None = Field(default=None, alias="_comment")
    mission: MissionSeed
    astronauts: list[AstronautSeed]
    users: list[UserSeed]


def default_seed_file() -> Path:
    local = BACKEND_ROOT / "seed.local.json"
    return local if local.exists() else BACKEND_ROOT / "seed.example.json"


def load_seed(path: Path) -> SeedData:
    return SeedData.model_validate(json.loads(path.read_text(encoding="utf-8")))


def seed_database(session: Session, data: SeedData) -> dict[str, int]:
    m = data.mission
    mission = session.exec(select(Mission).where(Mission.code == m.code)).first() or Mission(
        code=m.code, name=m.name, profile_code=m.profile_code, start_date=m.start_date
    )
    mission.name, mission.profile_code, mission.start_date = m.name, m.profile_code, m.start_date
    session.add(mission)
    session.flush()

    crew: dict[str, Astronaut] = {}
    for a in data.astronauts:
        astronaut = session.exec(select(Astronaut).where(Astronaut.code == a.code)).first() or Astronaut(
            code=a.code, display_name=a.display_name, role_title=a.role_title, mission_id=mission.id
        )
        astronaut.display_name, astronaut.role_title, astronaut.mission_id = (
            a.display_name,
            a.role_title,
            mission.id,
        )
        session.add(astronaut)
        crew[a.code] = astronaut
    session.flush()

    for u in data.users:
        if u.role == Role.ASTRONAUT and u.astronaut_code not in crew:
            raise ValueError(f"user '{u.username}' refers to unknown astronaut '{u.astronaut_code}'")
        astronaut_id = crew[u.astronaut_code].id if u.astronaut_code else None
        user = session.exec(select(UserAccount).where(UserAccount.username == u.username)).first()
        if user is None:
            user = UserAccount(
                username=u.username,
                password_hash=hash_password(u.password),
                role=u.role.value,
                display_name="",
            )
        elif not verify_password(u.password, user.password_hash):
            user.password_hash = hash_password(u.password)
        user.role, user.astronaut_id, user.display_name = u.role.value, astronaut_id, u.display_name
        session.add(user)
    session.commit()
    return {"missions": 1, "astronauts": len(crew), "users": len(data.users)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--file", type=Path, default=None, help="seed JSON (default: seed.local.json or example)"
    )
    args = parser.parse_args()
    path = args.file or default_seed_file()
    engine = make_engine(settings.database_url)
    init_db(engine)
    with Session(engine) as session:
        counts = seed_database(session, load_seed(path))
    print(f"Seeded {settings.database_url} from {path.name}: {counts}")


if __name__ == "__main__":
    main()
