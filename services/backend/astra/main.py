"""ASTRA HEALTH backend entry point: `uvicorn astra.main:app --port 8000`.

The same app runs as the Habitat node (onboard) or the Ground node (Earth), selected by
ASTRA_NODE_ROLE. Module layout and build order: docs/03-Low-Level-Design.md §1 and
docs/04-Implementation-Plan.md.
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from astra.api import crew, measurements, realtime, system
from astra.api.base import ApiModel
from astra.config import Settings, settings
from astra.core.protocols import ProtocolBundle, ProtocolCounts, load_protocol_bundle
from astra.db.session import init_db, make_engine
from astra.realtime.hub import hub

logger = logging.getLogger("astra")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    cfg: Settings = app.state.settings
    # Fail fast: a broken rule or protocol file raises ProtocolError and the app does not start.
    bundle = load_protocol_bundle(cfg.protocols_path)
    app.state.protocols = bundle
    logger.info("Loaded protocols: %s", bundle.counts().model_dump(by_alias=True))
    engine = make_engine(cfg.database_url)
    init_db(engine)
    app.state.engine = engine
    # Step 5 starts the routine scheduler here; Step 9 the sync loop and external-data fetchers.
    yield
    engine.dispose()


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
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(system.router)
    app.include_router(crew.router)
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
