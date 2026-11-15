"""Create the mission, crew and demo accounts: `python -m astra.seed`.

Reads services/backend/seed.local.json if it exists (git-ignored), else seed.example.json.
Safe to run repeatedly: existing rows are updated, not duplicated.
"""

import argparse
import json
from datetime import date, timedelta
from pathlib import Path

from pydantic import Field
from sqlmodel import Session, select

from astra.config import BACKEND_ROOT, settings
from astra.core.base import CoreModel
from astra.core.enums import Role
from astra.core.ids import stable_id
from astra.db.models import Astronaut, MedicalProfile, Mission, UserAccount
from astra.db.session import init_db, make_engine
from astra.security.passwords import hash_password, verify_password


class MissionSeed(CoreModel):
    code: str
    name: str
    profile_code: str
    start_date: date


class MedicalProfileSeed(CoreModel):
    allergies: list[str] = []
    conditions: list[str] = []
    regular_medicines: list[str] = []
    note: str = ""


class AstronautSeed(CoreModel):
    code: str
    display_name: str
    role_title: str
    medical_profile: MedicalProfileSeed | None = None


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


def seed_database(session: Session, data: SeedData, *, bcrypt_rounds: int = 12) -> dict[str, int]:
    m = data.mission
    # Stable ids (same on the Habitat and the Ground node), so synced records refer to the same rows.
    mission = session.exec(select(Mission).where(Mission.code == m.code)).first() or Mission(
        id=stable_id("mission", m.code), code=m.code, name=m.name, profile_code=m.profile_code,
        start_date=m.start_date,
    )  # fmt: skip
    mission.name, mission.profile_code, mission.start_date = m.name, m.profile_code, m.start_date
    session.add(mission)
    session.flush()

    crew: dict[str, Astronaut] = {}
    for a in data.astronauts:
        astronaut = session.exec(select(Astronaut).where(Astronaut.code == a.code)).first() or Astronaut(
            id=stable_id("astronaut", a.code), code=a.code, display_name=a.display_name,
            role_title=a.role_title, mission_id=mission.id,
        )  # fmt: skip
        astronaut.display_name, astronaut.role_title, astronaut.mission_id = (
            a.display_name,
            a.role_title,
            mission.id,
        )
        session.add(astronaut)
        crew[a.code] = astronaut
    session.flush()

    # Medication Guide profiles: created once; later edits by the CMO or flight surgeon are kept.
    for a in data.astronauts:
        if a.medical_profile and session.get(MedicalProfile, crew[a.code].id) is None:
            mp = a.medical_profile
            session.add(MedicalProfile(
                astronaut_id=crew[a.code].id, allergies_json=json.dumps(mp.allergies),
                conditions_json=json.dumps(mp.conditions), medicines_json=json.dumps(mp.regular_medicines),
                note=mp.note,
            ))  # fmt: skip
    session.flush()

    for u in data.users:
        if u.role == Role.ASTRONAUT and u.astronaut_code not in crew:
            raise ValueError(f"user '{u.username}' refers to unknown astronaut '{u.astronaut_code}'")
        astronaut_id = crew[u.astronaut_code].id if u.astronaut_code else None
        user = session.exec(select(UserAccount).where(UserAccount.username == u.username)).first()
        if user is None:
            user = UserAccount(
                id=stable_id("user", u.username),
                username=u.username,
                password_hash=hash_password(u.password, bcrypt_rounds),
                role=u.role.value,
                display_name="",
            )
        elif not verify_password(u.password, user.password_hash):
            user.password_hash = hash_password(u.password, bcrypt_rounds)
        user.role, user.astronaut_id, user.display_name = u.role.value, astronaut_id, u.display_name
        session.add(user)
    session.commit()
    return {"missions": 1, "astronauts": len(crew), "users": len(data.users)}


def with_mission_day_today(data: SeedData, mission_day_today: int, today: date | None = None) -> SeedData:
    """Move the mission start so that today is `mission_day_today` (demos work on any date)."""
    today = today or date.today()
    start = today - timedelta(days=mission_day_today - 1)
    return data.model_copy(update={"mission": data.mission.model_copy(update={"start_date": start})})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--file", type=Path, default=None, help="seed JSON (default: seed.local.json or example)"
    )
    parser.add_argument(
        "--mission-day-today",
        type=int,
        default=None,
        metavar="N",
        help="set the mission start so that today is mission day N (e.g. 121); use on a fresh database",
    )
    args = parser.parse_args()
    path = args.file or default_seed_file()
    data = load_seed(path)
    if args.mission_day_today:
        data = with_mission_day_today(data, args.mission_day_today)
    engine = make_engine(settings.database_url)
    init_db(engine)
    with Session(engine) as session:
        counts = seed_database(session, data, bcrypt_rounds=settings.bcrypt_rounds)
    print(
        f"Seeded {settings.database_url} from {path.name}: {counts}; mission start {data.mission.start_date}"
    )


if __name__ == "__main__":
    main()
