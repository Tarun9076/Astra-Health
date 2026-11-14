"""Compute and store the wellness index from an astronaut's in-memory history (LLD §9)."""

from datetime import UTC, date, datetime, timedelta
from statistics import mean
from typing import TYPE_CHECKING

from sqlmodel import Session, col, select

from astra.core.alerts import ACTIVE_STATUSES
from astra.core.protocols import ProtocolBundle
from astra.core.wellness import DOMAINS, ActiveAlert, Reading, WellnessResult, wellness_index
from astra.db.models import HealthAlert, WellnessScore

if TYPE_CHECKING:
    from astra.services.assessment import Assessor

WELLNESS_INDICATORS: frozenset[str] = frozenset(i for members in DOMAINS.values() for i in members)
WEEKLY = frozenset({"exercise_sessions", "strength_index", "body_weight"})


def _readings(assessor: "Assessor", as_of: datetime) -> tuple[dict[str, Reading], float | None]:
    catalog = assessor.bundle.catalog
    readings: dict[str, Reading] = {}
    for indicator in WELLNESS_INDICATORS:
        window = timedelta(days=8 if indicator in WEEKLY else 2)
        recent = [p for p in assessor.series.get(indicator, []) if as_of - window < p.t <= as_of]
        if not recent:
            continue
        meta = catalog.get(indicator)
        value = recent[-1].value
        base = assessor.baseline(indicator, as_of.date())
        readings[indicator] = Reading(
            indicator=indicator,
            value=value,
            z=base.z(value) if base is not None and meta.has_baseline else None,
            worse_when=meta.worse_when,
            ratio=base.ratio(value) if base is not None and indicator == "radiation_dose" else None,
            name=meta.name,
        )
    sleep = [
        p.value for p in assessor.series.get("sleep_hours", []) if as_of - timedelta(days=3) < p.t <= as_of
    ]
    return readings, (mean(sleep) if sleep else None)


def active_alerts(session: Session, bundle: ProtocolBundle, astronaut_id: str) -> list[ActiveAlert]:
    rules = {r.id: r for r in bundle.rules}
    rows = session.exec(
        select(HealthAlert).where(
            HealthAlert.astronaut_id == astronaut_id,
            col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]),
        )
    ).all()
    return [
        ActiveAlert(
            severity="Urgent" if a.severity == "Urgent" else "Attention",
            title=a.title,
            indicators=frozenset(leaf.indicator for leaf in rules[a.rule_id].leaves())
            if a.rule_id in rules
            else frozenset(),
        )
        for a in rows
    ]


def compute_wellness(
    session: Session, assessor: "Assessor", astronaut_id: str, as_of: datetime
) -> WellnessResult:
    readings, sleep_3d = _readings(assessor, as_of)
    return wellness_index(
        readings, sleep_3d_mean=sleep_3d, alerts=active_alerts(session, assessor.bundle, astronaut_id)
    )


def store_wellness(session: Session, astronaut_id: str, day: date, result: WellnessResult) -> None:
    row = session.get(WellnessScore, (astronaut_id, day)) or WellnessScore(
        astronaut_id=astronaut_id, score_date=day
    )
    by_domain = {d.domain: d.score for d in result.domains}
    row.overall = result.overall
    row.cardiovascular = by_domain["Cardiovascular"]
    row.sleep = by_domain["Sleep"]
    row.behavioral = by_domain["Behavioral"]
    row.activity = by_domain["Activity"]
    row.metabolic = by_domain["Metabolic"]
    row.environment = by_domain["Environment"]
    row.cap_reason = result.cap_reason
    row.indicators_seen = result.indicators_seen
    row.computed_at = datetime.now(UTC)
    session.add(row)
