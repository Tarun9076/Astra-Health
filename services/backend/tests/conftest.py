import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from astra.config import BACKEND_ROOT, REPO_ROOT, Settings
from astra.core.protocols import ProtocolBundle, load_protocol_bundle
from astra.main import create_app
from astra.seed import load_seed, seed_database

PROTOCOLS_DIR = REPO_ROOT / "protocols"


@pytest.fixture
def test_settings(tmp_path: Path) -> Settings:
    """Settings pointing at a throwaway SQLite file, so tests never touch habitat.db."""
    return Settings(
        database_url=f"sqlite:///{(tmp_path / 'test.db').as_posix()}",
        bcrypt_rounds=4,
        routine_interval_minutes=0,
        models_path=tmp_path / "models",
    )


@pytest.fixture
def client(test_settings: Settings) -> Iterator[TestClient]:
    """App with an empty database. Used as a context manager so the lifespan runs."""
    with TestClient(create_app(test_settings)) as c:
        yield c


@pytest.fixture
def seeded_client(client: TestClient) -> TestClient:
    """App whose database holds the ARES-1 mission, AST-001..003 and the demo users."""
    engine = client.app.state.engine  # type: ignore[attr-defined]
    with Session(engine) as session:
        seed_database(session, load_seed(BACKEND_ROOT / "seed.example.json"), bcrypt_rounds=4)
    return client


@pytest.fixture(scope="session")
def bundle() -> ProtocolBundle:
    """The real protocol files from the repo."""
    return load_protocol_bundle(PROTOCOLS_DIR)


@pytest.fixture
def protocols_copy(tmp_path: Path) -> Path:
    """A writable copy of protocols/ for tests that break files on purpose."""
    target = tmp_path / "protocols"
    shutil.copytree(PROTOCOLS_DIR, target)
    return target


DEMO_PASSWORDS = {
    "ast1": "astra-demo-ast1",
    "ast2": "astra-demo-ast2",
    "ast3": "astra-demo-ast3",
    "surgeon1": "astra-demo-surgeon",
    "mission1": "astra-demo-mission",
    "admin": "astra-demo-admin",
}


def auth(client: TestClient, username: str) -> dict[str, str]:
    """Sign in as a demo user and return the Authorization header."""
    response = client.post(
        "/api/auth/login", json={"username": username, "password": DEMO_PASSWORDS[username]}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['accessToken']}"}
