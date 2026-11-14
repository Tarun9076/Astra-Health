"""AI insights (LLD §10, §13.2): unusual days and rising recovery strain found by the ML module.

Advisory only. Insights never set alert severity; the alert detail shows the ones related to
an alert so the surgeon can see what the models noticed and when.
"""

import json
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from sqlmodel import Session, col, select

from astra.api.base import ApiModel
from astra.core.protocols import ProtocolBundle
from astra.core.rules.models import INSIGHT_SOURCES
from astra.db.models import HealthAlert, Insight, Mission
from astra.db.session import SessionDep
from astra.security.deps import ViewableAstronaut

router = APIRouter(prefix="/api", tags=["insights"])

RELATED_LOOKBACK = timedelta(days=3)


class Contributor(ApiModel):
    indicator: str
    name: str
    value: float  # Anomaly: z-score that day; Trend: rise over the window, in σ toward unhealthy


class InsightOut(ApiModel):
    id: str
    kind: Literal["Anomaly", "Trend"]
    day: date
    score: float
    direction: str | None
    explanation: str
    contributors: list[Contributor]
    window_start: date
    window_end: date
    model_version: str


def insight_out(row: Insight, bundle: ProtocolBundle) -> InsightOut:
    contributors = []
    for c in json.loads(row.contributors_json):
        code = c["indicator"]
        name = bundle.catalog.get(code).name if code in bundle.catalog else code
        contributors.append(Contributor(indicator=code, name=name, value=c["value"]))
    return InsightOut(
        id=row.id,
        kind="Trend" if row.kind == "Trend" else "Anomaly",
        day=row.insight_date,
        score=round(row.score, 3),
        direction=row.direction,
        explanation=row.explanation,
        contributors=contributors,
        window_start=row.window_start,
        window_end=row.window_end,
        model_version=row.model_version,
    )


def related_insights(session: Session, bundle: ProtocolBundle, alert: HealthAlert) -> list[InsightOut]:
    """Insights around an alert's active period that involve the indicators its rule reads."""
    rule = next((r for r in bundle.rules if r.id == alert.rule_id), None)
    if rule is None:
        return []
    leaves = {leaf.indicator for leaf in rule.leaves()}
    uses_ml = bool(leaves & INSIGHT_SOURCES.keys())
    rows = session.exec(
        select(Insight)
        .where(
            Insight.astronaut_id == alert.astronaut_id,
            col(Insight.insight_date) >= (alert.first_triggered_at - RELATED_LOOKBACK).date(),
            col(Insight.insight_date) <= alert.last_triggered_at.date(),
        )
        .order_by(col(Insight.insight_date).desc())
    ).all()
    related = [r for r in rows if uses_ml or leaves & set(r.indicator_codes.split(","))]
    return [insight_out(r, bundle) for r in related[:5]]


@router.get("/astronauts/{astronaut}/insights", response_model=list[InsightOut])
def list_insights(
    astronaut: ViewableAstronaut,
    request: Request,
    session: SessionDep,
    range_: Annotated[Literal["7d", "30d", "mission"], Query(alias="range")] = "7d",
) -> list[InsightOut]:
    """Newest first."""
    bundle: ProtocolBundle = request.app.state.protocols
    today = datetime.now(UTC).date()
    mission = session.get(Mission, astronaut.mission_id)
    if range_ == "mission" and mission:
        start = mission.start_date
    else:
        start = today - timedelta(days=6 if range_ == "7d" else 29)
    rows = session.exec(
        select(Insight)
        .where(Insight.astronaut_id == astronaut.id, col(Insight.insight_date) >= start)
        .order_by(col(Insight.insight_date).desc(), col(Insight.kind).desc())
    ).all()
    return [insight_out(r, bundle) for r in rows]
