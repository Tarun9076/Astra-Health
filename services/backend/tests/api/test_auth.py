"""Login, tokens, and T-SEC-01 (every /api route requires sign-in)."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from astra.main import create_app
from tests.conftest import auth

PUBLIC_ROUTES = {"/api/auth/login", "/api/system/status"}


def test_every_api_route_requires_sign_in() -> None:
    # T-SEC-01: the bearer scheme is only reachable through security.deps.current_user, so an
    # operation without it in the OpenAPI schema is an unprotected route.
    paths = create_app().openapi()["paths"]
    operations = [
        (f"{method.upper()} {path}", op)
        for path, ops in paths.items()
        if path.startswith("/api") and path not in PUBLIC_ROUTES
        for method, op in ops.items()
    ]
    unprotected = [name for name, op in operations if {"HTTPBearer": []} not in op.get("security", [])]
    assert len(operations) >= 10 and unprotected == []


def test_login_returns_token_and_profile(seeded_client: TestClient) -> None:
    body = seeded_client.post(
        "/api/auth/login", json={"username": "ast1", "password": "astra-demo-ast1"}
    ).json()
    assert body["tokenType"] == "bearer" and body["expiresIn"] > 0
    assert body["user"]["role"] == "Astronaut" and body["user"]["astronautCode"] == "AST-001"
    me = seeded_client.get("/api/me", headers={"Authorization": f"Bearer {body['accessToken']}"}).json()
    assert me["username"] == "ast1"


@pytest.mark.parametrize(
    ("username", "password"), [("ast1", "wrong-password"), ("nobody", "astra-demo-ast1")]
)
def test_wrong_credentials_are_rejected_the_same_way(
    seeded_client: TestClient, username: str, password: str
) -> None:
    response = seeded_client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 401 and response.json()["detail"] == "Wrong username or password"


def test_missing_or_bad_token_is_401(seeded_client: TestClient) -> None:
    assert seeded_client.get("/api/me").status_code == 401
    assert seeded_client.get("/api/me", headers={"Authorization": "Bearer not-a-token"}).status_code == 401


@pytest.fixture
def ws_token(seeded_client: TestClient) -> Iterator[str]:
    yield auth(seeded_client, "surgeon1")["Authorization"].removeprefix("Bearer ")


def test_websocket_needs_a_token(seeded_client: TestClient, ws_token: str) -> None:
    with pytest.raises(WebSocketDisconnect), seeded_client.websocket_connect("/ws") as ws:
        ws.receive_json()
    with seeded_client.websocket_connect(f"/ws?token={ws_token}") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "Connected" and "medical" in hello["payload"]["groups"]
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"
