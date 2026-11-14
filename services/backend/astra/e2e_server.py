"""Backend for the browser end-to-end tests (Step 11): `python -m astra.e2e_server`.

Builds a fresh `e2e.db` (mission day 122 today, 150 days of simulated history ingested in-process,
past alerts closed as the simulated flight surgeon does), then serves the Habitat API on port 8100.
Nothing here touches the demo database.
"""

import argparse
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import uvicorn
from sqlmodel import Session, col, select

from astra.config import BACKEND_ROOT, REPO_ROOT, Settings
from astra.core.alerts import ACTIVE_STATUSES
from astra.core.protocols import load_protocol_bundle
from astra.db.models import HealthAlert
from astra.db.session import init_db, make_engine
from astra.evaluate import _incoming
from astra.main import create_app
from astra.seed import load_seed, seed_database, with_mission_day_today
from astra.services.crew import find_astronaut
from astra.services.ingestion import ingest_batch
from astra.simulation.generator import generate
from astra.simulation.scenario import load_scenario

MISSION_DAY_TODAY = 122


def build(db: Path) -> None:
    for suffix in ("", "-shm", "-wal"):
        Path(f"{db}{suffix}").unlink(missing_ok=True)
    engine = make_engine(f"sqlite:///{db.as_posix()}")
    init_db(engine)
    seed = with_mission_day_today(load_seed(BACKEND_ROOT / "seed.example.json"), MISSION_DAY_TODAY)
    start: date = seed.mission.start_date
    scenario = load_scenario()
    days = min(scenario.mission.days, MISSION_DAY_TODAY - 1)
    scenario = scenario.model_copy(
        update={"mission": scenario.mission.model_copy(update={"start": start, "days": days})}
    )
    bundle = load_protocol_bundle(REPO_ROOT / "protocols")
    now = datetime.now(UTC)
    with Session(engine) as session:
        seed_database(session, seed, bcrypt_rounds=4)
        readings = generate(scenario, seed=42)
        for code in sorted({r.astronaut for r in readings}):
            astronaut = find_astronaut(session, code)
            assert astronaut is not None
            mine = [_incoming(r) for r in readings if r.astronaut == code]
            for i in range(0, len(mine), 500):
                ingest_batch(
                    session, bundle, astronaut, mine[i : i + 500], node_id="E2E", backfill=True, now=now
                )
        for alert in session.exec(
            select(HealthAlert).where(col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]))
        ).all():
            alert.status, alert.resolved_at = "Resolved", now - timedelta(minutes=1)
            alert.resolution_note = "Past episode closed for the end-to-end test (simulated)."
            session.add(alert)
        session.commit()
    engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8100)
    parser.add_argument("--db", type=Path, default=BACKEND_ROOT / "e2e.db")
    args = parser.parse_args()
    print(f"Building {args.db} (mission history)...", flush=True)
    build(args.db)
    cfg = Settings(
        database_url=f"sqlite:///{args.db.as_posix()}", bcrypt_rounds=4, routine_interval_minutes=0,
        sync_interval_seconds=0, space_weather_interval_minutes=0, anthropic_api_key=None, peer_url=None,
        cors_origins=["http://localhost:5174"], models_path=args.db.parent / "models-e2e",
    )  # fmt: skip
    uvicorn.run(create_app(cfg), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
