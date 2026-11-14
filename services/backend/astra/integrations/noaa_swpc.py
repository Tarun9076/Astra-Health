"""NOAA SWPC: GOES integral proton flux, ≥ 10 MeV (LLD §20). Public JSON, no key.

The NOAA S-scale (solar radiation storms) is defined on the ≥ 10 MeV flux in particle flux units
(pfu): S1 ≥ 10, S2 ≥ 100, S3 ≥ 1 000, S4 ≥ 10 000, S5 ≥ 100 000.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

NOAA_PROTONS_URL = "https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json"
S1_THRESHOLD_PFU = 10.0
S_SCALE = ((100_000.0, "S5"), (10_000.0, "S4"), (1_000.0, "S3"), (100.0, "S2"), (10.0, "S1"))


@dataclass(frozen=True)
class ProtonFlux:
    time: datetime
    flux_pfu: float
    satellite: int | None

    @property
    def s_scale(self) -> str | None:
        return next((s for threshold, s in S_SCALE if self.flux_pfu >= threshold), None)


def fetch_protons(client: httpx.Client | None = None) -> list[dict[str, Any]]:
    http = client or httpx.Client(timeout=30)
    try:
        response = http.get(NOAA_PROTONS_URL)
    finally:
        if client is None:
            http.close()
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise RuntimeError("NOAA proton response is not a list")
    return payload


def latest_10mev(payload: list[dict[str, Any]]) -> ProtonFlux | None:
    rows = [r for r in payload if r.get("energy") == ">=10 MeV" and r.get("flux") is not None]
    if not rows:
        return None
    last = max(rows, key=lambda r: str(r["time_tag"]))
    when = datetime.fromisoformat(str(last["time_tag"]).replace("Z", "+00:00"))
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return ProtonFlux(time=when, flux_pfu=float(last["flux"]), satellite=last.get("satellite"))
