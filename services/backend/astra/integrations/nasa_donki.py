"""NASA DONKI solar energetic particle (SEP) events (LLD §20.2).

GET https://api.nasa.gov/DONKI/SEP?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&api_key=...
The key is never logged; error messages redact it.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

import httpx

DONKI_SEP_URL = "https://api.nasa.gov/DONKI/SEP"


@dataclass(frozen=True)
class SepEvent:
    sep_id: str
    event_time: datetime
    instruments: tuple[str, ...]


def fetch_sep(start: date, end: date, api_key: str, client: httpx.Client | None = None) -> list[dict[str, Any]]:
    params = {"startDate": start.isoformat(), "endDate": end.isoformat(), "api_key": api_key}
    http = client or httpx.Client(timeout=30)
    try:
        response = http.get(DONKI_SEP_URL, params=params)
    finally:
        if client is None:
            http.close()
    if response.status_code != 200:
        body = response.text[:200].replace(api_key, "<key>")
        raise RuntimeError(f"DONKI SEP request failed: HTTP {response.status_code}: {body}")
    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError("DONKI SEP response is not a list")
    return payload


def parse_sep(payload: list[dict[str, Any]]) -> list[SepEvent]:
    events = [
        SepEvent(
            sep_id=str(item["sepID"]),
            # DONKI times look like "2024-05-10T13:35Z"
            event_time=datetime.strptime(item["eventTime"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=UTC),
            instruments=tuple(i.get("displayName", "") for i in item.get("instruments") or []),
        )
        for item in payload
    ]
    return sorted(events, key=lambda e: e.event_time)


def event_day_offsets(events: list[SepEvent]) -> list[int]:
    """Distinct days with SEP activity, as offsets from the first event day (0, 1, …)."""
    if not events:
        return []
    first = events[0].event_time.date()
    return sorted({(e.event_time.date() - first).days for e in events})
