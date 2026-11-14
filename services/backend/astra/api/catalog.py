from typing import Literal

from fastapi import APIRouter, Request

from astra.api.base import ApiModel
from astra.core.protocols import ProtocolBundle
from astra.security.deps import CurrentUser

router = APIRouter(prefix="/api", tags=["catalog"])


class IndicatorOut(ApiModel):
    code: str
    name: str
    unit: str
    units: list[str]
    decimals: int
    worse_when: Literal["high", "low", "both"]
    hazard: str
    body_system: str | None
    has_baseline: bool


@router.get("/catalog/indicators", response_model=list[IndicatorOut])
def list_indicators(request: Request, user: CurrentUser) -> list[IndicatorOut]:
    """Names, units and precision for every indicator (from protocols/indicators.json)."""
    bundle: ProtocolBundle = request.app.state.protocols
    return [
        IndicatorOut(
            code=i.code,
            name=i.name,
            unit=i.unit,
            units=list(i.units),
            decimals=i.decimals,
            worse_when=i.worse_when,
            hazard=i.hazard.value,
            body_system=i.body_system,
            has_baseline=i.has_baseline,
        )
        for i in bundle.catalog.indicators
    ]
