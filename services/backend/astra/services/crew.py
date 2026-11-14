from sqlmodel import Session, or_, select

from astra.db.models import Astronaut


def find_astronaut(session: Session, ref: str) -> Astronaut | None:
    """Look up an astronaut by code ("AST-001") or by id."""
    return session.exec(select(Astronaut).where(or_(Astronaut.code == ref, Astronaut.id == ref))).first()
