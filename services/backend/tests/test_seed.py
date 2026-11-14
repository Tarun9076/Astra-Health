from sqlmodel import Session, select

from astra.config import BACKEND_ROOT
from astra.db.models import Astronaut, UserAccount
from astra.db.session import init_db, make_engine
from astra.security.passwords import verify_password
from astra.seed import load_seed, seed_database


def test_seed_is_idempotent_and_hashes_passwords() -> None:
    engine = make_engine("sqlite://")
    init_db(engine)
    data = load_seed(BACKEND_ROOT / "seed.example.json")
    with Session(engine) as session:
        seed_database(session, data)
        seed_database(session, data)  # second run updates, never duplicates
        assert len(session.exec(select(Astronaut)).all()) == 3
        users = {u.username: u for u in session.exec(select(UserAccount)).all()}
    assert set(users) == {"ast1", "ast2", "ast3", "surgeon1", "mission1", "admin"}
    assert users["ast1"].password_hash != "astra-demo-ast1"
    assert verify_password("astra-demo-ast1", users["ast1"].password_hash)
    assert users["surgeon1"].astronaut_id is None and users["ast1"].astronaut_id is not None
