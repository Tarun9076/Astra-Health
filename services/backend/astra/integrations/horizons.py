"""JPL Horizons: real Earth–Mars distance and one-way light time (LLD §20.2). No key needed."""

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

import httpx

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"


@dataclass(frozen=True)
class LightTime:
    day: date
    range_au: float
    one_way_minutes: float


def fetch_mars_light_time(
    start: date, stop: date, step: str = "1 d", client: httpx.Client | None = None
) -> dict[str, Any]:
    params = {
        "format": "json",
        "COMMAND": "'499'",  # Mars
        "CENTER": "'500@399'",  # observed from Earth's centre
        "EPHEM_TYPE": "'OBSERVER'",
        "START_TIME": f"'{start.isoformat()}'",
        "STOP_TIME": f"'{stop.isoformat()}'",
        "STEP_SIZE": f"'{step}'",
        "QUANTITIES": "'20,21'",  # 20 = range (delta), 21 = one-way light time
        "OBJ_DATA": "'NO'",
    }
    http = client or httpx.Client(timeout=60)
    try:
        response = http.get(HORIZONS_URL, params=params)
    finally:
        if client is None:
            http.close()
    response.raise_for_status()
    payload: dict[str, Any] = response.json()
    if "result" not in payload:
        raise RuntimeError(f"Horizons returned no result: {str(payload)[:200]}")
    return payload


def parse_light_time(payload: dict[str, Any]) -> list[LightTime]:
    """Rows between $$SOE and $$EOE: '2026-Nov-14 00:00  1.3243620  -14.7121700  11.01438304'."""
    text: str = payload["result"]
    body = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    rows: list[LightTime] = []
    for line in body.strip().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        rows.append(
            LightTime(
                day=datetime.strptime(parts[0], "%Y-%b-%d").date(),
                range_au=float(parts[2]),
                one_way_minutes=float(parts[4]),
            )
        )
    return rows
