"""The simulated deep-space link (LLD §12.5). State lives on the Habitat node.

- Up/Down (blackouts, solar conjunction…).
- One-way delay = real light time × compression: by default the JPL Horizons Earth–Mars light time
  for today (≈ 11 min in Nov 2026), shown as ≈ 22 s in the demo (2 s per light-minute).
- Envelopes and ACKs are held by the receiving node until `now + delay`; when the link is Down the
  Habitat refuses traffic in both directions, so senders keep their outbox items Pending.
"""

from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlmodel import Session

from astra.db.models import LinkState
from astra.integrations.fixtures import HORIZONS_MARS_MISSION, load_fixture
from astra.integrations.horizons import parse_light_time

_light_time_cache: list[tuple[date, float]] | None = None


def horizons_light_minutes(day: date) -> float | None:
    """One-way Earth–Mars light time for `day` from the cached Horizons table (nearest day)."""
    global _light_time_cache
    if _light_time_cache is None:
        try:
            _light_time_cache = [
                (r.day, r.one_way_minutes) for r in parse_light_time(load_fixture(HORIZONS_MARS_MISSION))
            ]
        except (OSError, ValueError, KeyError, IndexError):
            _light_time_cache = []
    if not _light_time_cache:
        return None
    return min(_light_time_cache, key=lambda r: abs((r[0] - day).days))[1]


def get_link(session: Session, compression: float = 2.0) -> LinkState:
    link = session.get(LinkState, 1)
    if link is None:
        minutes = horizons_light_minutes(datetime.now(UTC).date()) or 12.5
        link = LinkState(
            id=1, real_delay_minutes=round(minutes, 2), compression_seconds_per_minute=compression
        )
        session.add(link)
        session.commit()
        session.refresh(link)
    return link


def deliver_at(link: LinkState, now: datetime | None = None) -> datetime:
    return (now or datetime.now(UTC)) + timedelta(seconds=link.one_way_seconds)


def link_dict(link: LinkState) -> dict[str, Any]:
    return {
        "status": link.status,
        "realDelayMinutes": link.real_delay_minutes,
        "delaySource": link.delay_source,
        "compressionSecondsPerMinute": link.compression_seconds_per_minute,
        "oneWaySeconds": round(link.one_way_seconds, 1),
        "updatedAt": link.updated_at.isoformat(),
    }
