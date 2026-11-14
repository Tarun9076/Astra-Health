"""Step 11 hardening: security pass and edge cases (missing days, unit mix-ups, long chats, no NASA key)."""

from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from astra.config import REPO_ROOT, Settings
from astra.core.baselines import DailyValue, compute_baseline
from tests.assistant.test_assistant import fake_claude, reply
from tests.conftest import DEMO_PASSWORDS, auth

NOW = datetime.now(UTC).replace(microsecond=0)


# --- security -----------------------------------------------------------------------------------


def test_login_is_throttled_after_repeated_failures(seeded_client: TestClient) -> None:
    wrong = {"username": "ast1", "password": "not-the-password"}
    for _ in range(5):
        assert seeded_client.post("/api/auth/login", json=wrong).status_code == 401
    locked = seeded_client.post(
        "/api/auth/login", json={"username": "ast1", "password": DEMO_PASSWORDS["ast1"]}
    )
    assert locked.status_code == 429 and int(locked.headers["Retry-After"]) > 0
    other = seeded_client.post(
        "/api/auth/login", json={"username": "ast2", "password": DEMO_PASSWORDS["ast2"]}
    )
    assert other.status_code == 200  # only that username is locked


def test_successful_login_resets_the_counter(seeded_client: TestClient) -> None:
    wrong = {"username": "ast3", "password": "nope-nope"}
    for _ in range(4):
        seeded_client.post("/api/auth/login", json=wrong)
    assert (
        seeded_client.post(
            "/api/auth/login", json={"username": "ast3", "password": DEMO_PASSWORDS["ast3"]}
        ).status_code
        == 200
    )
    for _ in range(4):
        assert seeded_client.post("/api/auth/login", json=wrong).status_code == 401  # counter started again


def test_security_headers_and_no_caching_of_health_data(seeded_client: TestClient) -> None:
    r = seeded_client.get("/api/astronauts/AST-001/dashboard", headers=auth(seeded_client, "ast1"))
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY" and r.headers["Referrer-Policy"] == "no-referrer"
    assert r.headers["Cache-Control"] == "no-store"


def test_cors_allows_only_the_configured_origin(seeded_client: TestClient) -> None:
    ok = seeded_client.options(
        "/api/system/status",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    evil = seeded_client.options(
        "/api/system/status",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert "access-control-allow-origin" not in evil.headers


def test_secrets_are_never_committed() -> None:
    ignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert ".env" in ignore.splitlines() and "*.db" in ignore.splitlines()
    example = (REPO_ROOT / "services" / "backend" / ".env.example").read_text(encoding="utf-8")
    for name in ("ASTRA_JWT_SECRET", "ANTHROPIC_API_KEY", "ASTRA_NASA_API_KEY", "ASTRA_SYNC_KEY"):
        line = next((ln for ln in example.splitlines() if ln.startswith(f"{name}=")), f"{name}=")
        assert line.split("=", 1)[1].strip() == "", f"{name} must be empty in .env.example"


# --- edge cases -----------------------------------------------------------------------------------


def test_baseline_tolerates_missing_days() -> None:
    # data only every third day: still 9 samples in the 28-day window → a baseline, not a crash
    start = date(2026, 10, 1)
    sparse = [DailyValue(start + timedelta(days=i), 60 + i % 3) for i in range(0, 30, 3)]
    base = compute_baseline("resting_hr", sparse, start + timedelta(days=33), sigma_floor=3)
    assert base is not None and base.samples >= 7 and base.sigma == 3
    # two readings only: no baseline (z unknown) instead of a misleading one
    assert compute_baseline("resting_hr", sparse[:2], start + timedelta(days=33), sigma_floor=3) is None


def test_new_astronaut_without_data_is_all_clear_not_an_error(seeded_client: TestClient) -> None:
    surgeon = auth(seeded_client, "surgeon1")
    for path in ("dashboard", "body-systems", "wellness-center", "radiation", "insights"):
        r = seeded_client.get(f"/api/astronauts/AST-003/{path}", headers=surgeon)
        assert r.status_code == 200, (path, r.text)
    assert seeded_client.get("/api/astronauts/AST-003/dashboard", headers=surgeon).json()["status"] == "GREEN"


def test_unit_mix_ups_are_converted_or_rejected(seeded_client: TestClient) -> None:
    t = (NOW - timedelta(minutes=5)).isoformat()
    items = [
        {"indicator": "radiation_dose", "value": 640, "unit": "µSv", "measuredAt": t, "channel": "Total"},
        {"indicator": "body_temp", "value": 98.6, "unit": "°F", "measuredAt": t},
        {"indicator": "spo2", "value": 0.97, "unit": "%", "measuredAt": t},  # a fraction typed as a percent
        {"indicator": "resting_hr", "value": 64, "unit": "mmHg", "measuredAt": t},  # wrong unit for HR
    ]
    r = seeded_client.post(
        "/api/measurements/batch",
        json={"astronautId": "AST-001", "items": items},
        headers=auth(seeded_client, "ast1"),
    ).json()
    assert len(r["accepted"]) == 2 and len(r["rejected"]) == 2
    series = seeded_client.get(
        "/api/astronauts/AST-001/measurements?indicator=radiation_dose&bucket=raw",
        headers=auth(seeded_client, "ast1"),
    ).json()
    assert series["points"][-1]["value"] == 0.64  # µSv → mSv
    temp = seeded_client.get(
        "/api/astronauts/AST-001/measurements?indicator=body_temp&bucket=raw",
        headers=auth(seeded_client, "ast1"),
    ).json()
    assert temp["points"][-1]["value"] == 37.0


def test_long_chats_are_bounded(seeded_client: TestClient) -> None:
    ast1 = auth(seeded_client, "ast1")
    assert (
        seeded_client.post("/api/assistant/chat", json={"question": "x" * 2001}, headers=ast1).status_code
        == 422
    )
    for i in range(8):  # 16 stored messages
        seeded_client.post(
            "/api/assistant/chat", json={"question": f"How can I sleep better? ({i})"}, headers=ast1
        )
    assistant = seeded_client.app.state.assistant  # type: ignore[attr-defined]
    assistant.claude = fake_claude(reply("Keep a fixed sleep time.", []))
    try:
        seeded_client.post("/api/assistant/chat", json={"question": "And tonight?"}, headers=ast1)
        sent = assistant.claude.beta.messages.calls[0]["messages"]
    finally:
        assistant.claude = None
    assert len(sent) <= 7  # ≤ 6 history turns (merged by role) + the question with findings
    assert "And tonight?" in sent[-1]["content"]


def test_space_weather_is_off_without_a_nasa_key(tmp_path: Path) -> None:
    # T-EXT-02: no key → no request, nothing stored, no error
    from astra.db.session import init_db, make_engine
    from astra.services.space_weather import refresh_space_weather

    engine = make_engine(f"sqlite:///{(tmp_path / 'g.db').as_posix()}")
    init_db(engine)
    assert refresh_space_weather(engine, Settings(nasa_api_key=None)) == 0


@pytest.mark.parametrize("path", ["/docs", "/openapi.json"])
def test_api_docs_stay_available_for_the_demo(seeded_client: TestClient, path: str) -> None:
    assert seeded_client.get(path).status_code == 200
