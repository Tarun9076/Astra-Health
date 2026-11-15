"""ASTRA HEALTH backend entry point: `uvicorn astra.main:app --port 8000`.

The same app runs as the Habitat node (onboard) or the Ground node (Earth), selected by
ASTRA_NODE_ROLE. Module layout and build order: docs/03-Low-Level-Design.md §1 and
docs/04-Implementation-Plan.md.
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Literal

import anyio.to_thread
import httpx
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import Engine
from sqlmodel import Session

from astra.api import (
    alerts,
    analytics,
    assistant,
    auth,
    body,
    catalog,
    checkins,
    crew,
    dashboard,
    environment,
    exercise,
    history,
    measurements,
    medication,
    mission,
    photos,
    progress,
    realtime,
    reports,
    sync,
    system,
)
from astra.api import (
    insights as insights_api,
)
from astra.api.base import ApiModel
from astra.api.reports import publish_report
from astra.api.sync import close_alert_tasks, publish_merge
from astra.assistant.service import Assistant
from astra.config import Settings, settings
from astra.core.enums import NodeRole
from astra.core.protocols import ProtocolBundle, ProtocolCounts, load_protocol_bundle
from astra.db.session import init_db, make_engine
from astra.integrations.noaa_swpc import fetch_protons, latest_10mev
from astra.realtime.hub import hub
from astra.security.ratelimit import LoginLimiter
from astra.services import insights
from astra.services.reports import ensure_reports
from astra.services.routine import ensure_routine_tasks
from astra.services.space_weather import refresh_space_weather
from astra.sync.engine import SyncEngine

logger = logging.getLogger("astra")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    cfg: Settings = app.state.settings
    for name, value, default in (("ASTRA_JWT_SECRET", cfg.jwt_secret, "dev-only-change-me"),
                                 ("ASTRA_SYNC_KEY", cfg.sync_key, "dev-only-sync-key")):  # fmt: skip
        if value == default:
            logger.warning("%s is the development default; set a random value in services/backend/.env", name)
    # Fail fast: a broken rule or protocol file raises ProtocolError and the app does not start.
    bundle = load_protocol_bundle(cfg.protocols_path)
    app.state.protocols = bundle
    logger.info("Loaded protocols: %s", bundle.counts().model_dump(by_alias=True))
    engine = make_engine(cfg.database_url)
    init_db(engine)
    app.state.engine = engine
    insights.configure(cfg.models_path)
    # Knowledge base + red flags; a broken note or an unknown protocol id stops startup too.
    app.state.assistant = Assistant.load(
        cfg.kb_path, bundle, cfg.protocols_path,
        api_key=cfg.anthropic_api_key or None, model=cfg.llm_model, provider=cfg.llm_provider,
        gemini_api_key=cfg.gemini_api_key or None, gemini_model=cfg.gemini_model,
    )  # fmt: skip
    routine = None
    if cfg.node_role == NodeRole.HABITAT and cfg.routine_interval_minutes > 0:
        routine = asyncio.create_task(
            _routine_loop(engine, bundle, app.state.assistant, cfg.node_id, cfg.routine_interval_minutes)
        )
    sync_task = None
    if cfg.sync_interval_seconds > 0 and cfg.peer_url:
        app.state.sync = SyncEngine(engine, cfg, publish_merge, close_alert_tasks)
        sync_task = asyncio.create_task(_sync_loop(app.state.sync, cfg))
    weather = noaa = None
    if cfg.node_role == NodeRole.GROUND and cfg.space_weather_interval_minutes > 0:
        if cfg.nasa_api_key:
            weather = asyncio.create_task(_space_weather_loop(engine, cfg))
        noaa = asyncio.create_task(_proton_flux_loop(app))
    yield
    for task in (routine, sync_task, weather, noaa):
        if task:
            task.cancel()
    engine.dispose()


async def _sync_loop(sync: SyncEngine, cfg: Settings) -> None:
    """Habitat ↔ Ground sync over the simulated link (LLD §12.2), every few seconds."""
    assert cfg.peer_url
    with httpx.Client(base_url=cfg.peer_url, timeout=10) as http:
        while True:
            try:
                await anyio.to_thread.run_sync(sync.run_once, http)
            except Exception:  # the peer may be down; never let the loop die
                logger.exception("Sync pass failed")
            await asyncio.sleep(cfg.sync_interval_seconds)


async def _proton_flux_loop(app: FastAPI) -> None:
    """Ground node: NOAA SWPC ≥10 MeV proton flux every 15 min, for the "space weather now" card."""
    while True:
        try:
            payload = await anyio.to_thread.run_sync(fetch_protons)
            app.state.proton_flux = latest_10mev(payload)
        except Exception:  # offline: the endpoint falls back to the cached fixture, labelled as such
            logger.warning("NOAA proton flux fetch failed; using the cached sample")
        await asyncio.sleep(15 * 60)


async def _space_weather_loop(engine: Engine, cfg: Settings) -> None:
    """Ground node: new NASA DONKI solar particle events → stored and sent to the Habitat (LLD §20)."""
    while True:
        try:
            added = await anyio.to_thread.run_sync(refresh_space_weather, engine, cfg)
            if added:
                logger.info("Space weather: %s new SEP event(s)", added)
        except Exception:
            logger.exception("Space weather refresh failed")
        await asyncio.sleep(cfg.space_weather_interval_minutes * 60)


async def _routine_loop(
    engine: Engine, bundle: ProtocolBundle, assistant: Assistant, node_id: str, minutes: int
) -> None:
    """Keep daily routine tasks (LLD §8) and automatic medical reports (Step 8) up to date."""
    narrator = assistant.narrate_report if assistant.llm_configured else None

    def run_once() -> tuple[int, int]:
        with Session(engine) as session:
            tasks = ensure_routine_tasks(session, bundle)
            reports = ensure_reports(session, bundle, node_id=node_id, narrator=narrator)
            for r in reports:
                publish_report(r)
            return tasks, len(reports)

    while True:
        try:
            tasks, reports = await anyio.to_thread.run_sync(run_once)
            if tasks or reports:
                logger.info("Routine run: %s task(s), %s report(s) created", tasks, reports)
        except Exception:  # never let the scheduler take the app down
            logger.exception("Routine run failed")
        await asyncio.sleep(minutes * 60)


class Health(ApiModel):
    status: str
    node_role: str
    llm_provider: str
    anthropic_key_configured: bool
    nasa_api: Literal["enabled", "disabled"]
    kb_path_exists: bool
    protocols: ProtocolCounts | None
    websocket_clients: int


def create_app(cfg: Settings | None = None) -> FastAPI:
    cfg = cfg or settings
    app = FastAPI(
        title="ASTRA HEALTH API",
        version="0.1.0",
        description="Astronaut health decision support (prototype). Rules decide severity, "
        "ML corroborates, the LLM only explains. Not a medical device.",
        lifespan=lifespan,
    )
    app.state.settings = cfg
    app.state.login_limiter = LoginLimiter()

    @app.middleware("http")
    async def security_headers(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path.startswith(("/api/", "/node/")):
            response.headers.setdefault(
                "Cache-Control", "no-store"
            )  # health data must not sit in shared caches
        return response

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(system.router)
    app.include_router(auth.router)
    app.include_router(catalog.router)
    app.include_router(crew.router)
    app.include_router(dashboard.router)
    app.include_router(analytics.router)
    app.include_router(insights_api.router)
    app.include_router(alerts.router)
    app.include_router(assistant.router)
    app.include_router(reports.router)
    app.include_router(body.router)
    app.include_router(environment.router)
    app.include_router(sync.router)
    app.include_router(sync.node_router)
    app.include_router(checkins.router)
    app.include_router(history.router)
    app.include_router(progress.router)
    app.include_router(mission.router)
    app.include_router(photos.router)
    app.include_router(exercise.router)
    app.include_router(medication.router)
    app.include_router(measurements.router)
    app.include_router(realtime.router)

    @app.get("/health", response_model=Health, tags=["system"])
    def health(request: Request) -> Health:
        bundle: ProtocolBundle | None = getattr(request.app.state, "protocols", None)
        return Health(
            status="ok",
            node_role=cfg.node_role.value,
            llm_provider=cfg.llm_provider,
            anthropic_key_configured=bool(cfg.anthropic_api_key),
            nasa_api="enabled" if cfg.nasa_api_key else "disabled",
            kb_path_exists=cfg.kb_path.is_dir(),
            protocols=bundle.counts() if bundle else None,
            websocket_clients=hub.connection_count(),
        )

    return app


app = create_app()
