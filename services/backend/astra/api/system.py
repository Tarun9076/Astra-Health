from datetime import UTC, datetime

from fastapi import APIRouter

from astra.api.base import ApiModel
from astra.config import settings

router = APIRouter(prefix="/api/system", tags=["system"])

DISCLAIMER = (
    "Prototype decision support only. Not a diagnosis. Thresholds are illustrative; data is simulated."
)


class SystemStatus(ApiModel):
    service: str
    node_role: str
    node_id: str
    mission_code: str
    utc_now: datetime
    simulated_data: bool
    disclaimer: str


@router.get("/status", response_model=SystemStatus)
def get_status() -> SystemStatus:
    """Which node this is and whether it is up. Used by the web app's status bar."""
    return SystemStatus(
        service="astra-health-backend",
        node_role=settings.node_role.value,
        node_id=settings.node_id,
        mission_code=settings.mission_code,
        utc_now=datetime.now(UTC),
        simulated_data=True,
        disclaimer=DISCLAIMER,
    )
