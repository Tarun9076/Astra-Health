"""Ground node: solar particle events from NASA DONKI (LLD §20; HLD §5.3a).

New events are stored as `SpaceWeatherEvent` and queued in the sync outbox, so they reach the
Habitat as space-weather notices after the link delay. Needs `ASTRA_NASA_API_KEY`; the key is
never logged (fetch errors redact it).
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import Engine
from sqlmodel import Session

from astra.config import Settings
from astra.db.models import SpaceWeatherEvent, SyncOutbox
from astra.integrations.nasa_donki import SepEvent, fetch_sep, parse_sep

LOOKBACK_DAYS = 30


def store_events(session: Session, events: list[SepEvent], source: str) -> int:
    added = 0
    for e in events:
        if session.get(SpaceWeatherEvent, e.sep_id) is not None:
            continue
        row = SpaceWeatherEvent(
            id=e.sep_id, event_time=e.event_time, instruments=", ".join(e.instruments), source=source
        )
        session.add(row)
        session.flush()
        session.add(SyncOutbox(entity_type="SpaceWeatherEvent", entity_id=row.id,
                               payload_json=row.model_dump_json(), priority=1))  # fmt: skip
        added += 1
    session.commit()
    return added


def refresh_space_weather(engine: Engine, cfg: Settings) -> int:
    if not cfg.nasa_api_key:
        return 0
    today = datetime.now(UTC).date()
    events = parse_sep(fetch_sep(today - timedelta(days=LOOKBACK_DAYS), today, cfg.nasa_api_key))
    with Session(engine) as session:
        return store_events(session, events, "donki-live")
