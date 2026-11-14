"""Body Explorer data (Step 10; LLD §15.3): each body region with its readings vs the personal normal,
active alerts, pending tasks and "what changes in space" from the knowledge base.

Status per region: RED = an Urgent alert, YELLOW = an Attention alert or a reading ≥ 2σ from normal,
GREEN = readings within normal, GREY = no data. Advisory display only; alerts stay the source of truth.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlmodel import Session, col, select

from astra.assistant.knowledge import Retriever
from astra.core.alerts import ACTIVE_STATUSES
from astra.core.protocols import ProtocolBundle
from astra.db.models import Astronaut, HealthAlert, RecommendationTask
from astra.services.assessment import HISTORY_MARGIN, load_assessor


@dataclass(frozen=True)
class Region:
    id: str
    title: str
    indicators: tuple[str, ...]
    notes: tuple[str, ...]  # knowledge-base note ids, most relevant first
    symptom_flags: tuple[str, ...] = ()  # red-flag symptom alerts (SYM-<flag>) shown here


REGIONS: tuple[Region, ...] = (
    Region(
        "brain",
        "Brain & behaviour",
        ("mood", "stress", "fatigue", "sleep_hours", "sleep_quality"),
        ("kb-sleep-circadian", "kb-stress-coping"),
        ("NEURO", "SELF-HARM"),
    ),
    Region("eyes", "Eyes & vision (SANS)", (), ("kb-sans-vision",)),
    Region(
        "heart",
        "Heart & circulation",
        ("resting_hr", "heart_rate", "bp_sys", "bp_dia"),
        ("kb-cardio-reduced-gravity", "kb-orthostatic-dizziness"),
        ("CHEST-PAIN", "SYNCOPE"),
    ),
    Region("lungs", "Lungs & breathing", ("spo2", "cabin_co2"), ("kb-oxygen-hypoxia",), ("BREATHING",)),
    Region(
        "digestive",
        "Metabolism & digestion",
        ("glucose", "body_weight", "hydration_ml"),
        ("kb-nutrition-food", "kb-hydration"),
    ),
    Region("immune", "Immune system", ("body_temp",), ("kb-immune-infection-fever",), ("BLEEDING",)),
    Region(
        "muscles",
        "Muscles",
        ("strength_index", "activity_min", "exercise_sessions"),
        ("kb-muscle-fitness", "kb-exercise-countermeasures"),
    ),
    Region("bones", "Bones", ("exercise_sessions",), ("kb-bone-loss",)),
    Region(
        "whole_body",
        "Whole body: radiation",
        ("radiation_dose",),
        ("kb-hazard-radiation", "kb-neutron-radiation"),
    ),
)
NOTABLE_Z = 2.0
SPARK_DAYS = 14


def _status(alerts: list[HealthAlert], metrics: list[dict[str, Any]]) -> str:
    if any(a.severity == "Urgent" for a in alerts):
        return "RED"
    if alerts or any(m["z"] is not None and abs(m["z"]) >= NOTABLE_Z for m in metrics):
        return "YELLOW"
    return "GREEN" if metrics else "GREY"


def body_systems(
    session: Session,
    bundle: ProtocolBundle,
    retriever: Retriever,
    astronaut: Astronaut,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    now = now or datetime.now(UTC)
    assessor = load_assessor(session, bundle, astronaut, now - HISTORY_MARGIN)
    rules = {r.id: r for r in bundle.rules}
    alerts = session.exec(
        select(HealthAlert).where(
            HealthAlert.astronaut_id == astronaut.id,
            col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]),
        )
    ).all()
    tasks = session.exec(
        select(RecommendationTask).where(
            RecommendationTask.astronaut_id == astronaut.id, RecommendationTask.status == "Pending"
        )
    ).all()
    today = now.date()
    out = []
    for region in REGIONS:
        metrics = []
        for code in region.indicators:
            points = [p for p in assessor.series.get(code, []) if p.t <= now]
            if not points or code not in bundle.catalog:
                continue
            meta = bundle.catalog.get(code)
            latest = points[-1]
            base = assessor.baseline(code, today)
            z = base.z(latest.value) if base is not None and meta.has_baseline else None
            since = now - timedelta(days=SPARK_DAYS)
            by_day: dict[str, list[float]] = {}
            for p in points:
                if p.t >= since:
                    by_day.setdefault(p.t.date().isoformat(), []).append(p.value)
            metrics.append({
                "indicator": code, "name": meta.name, "unit": meta.unit, "value": latest.value,
                "measuredAt": latest.t.isoformat(), "baseline": round(base.median, 3) if base else None,
                "sigma": round(base.sigma, 3) if base else None, "z": round(z, 2) if z is not None else None,
                "worseWhen": meta.worse_when,
                "spark": [{"day": d, "value": round(sum(v) / len(v), 3)} for d, v in sorted(by_day.items())],
            })  # fmt: skip
        mine = []
        for a in alerts:
            rule = rules.get(a.rule_id)
            leaves = {leaf.indicator for leaf in rule.leaves()} if rule else set()
            symptom = a.rule_id.removeprefix("SYM-") if a.rule_id.startswith("SYM-") else None
            if leaves & set(region.indicators) or (symptom and symptom in region.symptom_flags):
                mine.append(a)
        mine.sort(key=lambda a: (a.severity != "Urgent", a.first_triggered_at))
        alert_ids = {a.id for a in mine}
        knowledge = []
        for note_id in region.notes:
            sections = [c for c in retriever.chunks if c.note_id == note_id]
            if sections:
                what = next(
                    (c for c in sections if c.section.lower().startswith("what happens")), sections[0]
                )
                todo = next(
                    (c for c in sections if c.section.lower().startswith("what astronauts can do")), None
                )
                knowledge.append({
                    "noteId": note_id, "title": sections[0].note_title, "whatHappens": what.text,
                    "whatYouCanDo": todo.text if todo else None, "source": sections[0].source,
                })  # fmt: skip
        out.append({
            "id": region.id,
            "title": region.title,
            "status": _status(mine, metrics),
            "metrics": metrics,
            "alerts": [{"id": a.id, "ruleId": a.rule_id, "title": a.title, "severity": a.severity,
                        "status": a.status, "reason": a.reason} for a in mine],
            "tasks": [{"id": t.id, "code": t.code, "title": bundle.recommendations[t.code].title}
                      for t in tasks if t.alert_id in alert_ids and t.code in bundle.recommendations],
            "knowledge": knowledge,
        })  # fmt: skip
    return out
