"""Health History timeline and My Guidance (UI redesign).

Both are read-only views over data that already exists: measurements, check-ins, symptoms, alerts,
recommendation tasks, ML trend insights, flight-surgeon instructions and medical reports.
"""

from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, Query, Request
from sqlmodel import col, or_, select

from astra.api.base import ApiModel
from astra.api.checkins import CHECKIN_SYMPTOMS
from astra.api.photos import KIND_LABEL
from astra.core.alerts import ACTIVE_STATUSES
from astra.core.enums import MeasurementQuality
from astra.core.protocols import ProtocolBundle
from astra.db.models import (
    HealthAlert,
    HealthMeasurement,
    HealthPhoto,
    Insight,
    MedicalInstruction,
    MedicalReport,
    RecommendationTask,
    Symptom,
    WellnessCheckin,
)
from astra.db.session import SessionDep
from astra.security.deps import ViewableAstronaut

router = APIRouter(prefix="/api", tags=["history"])

EventKind = Literal[
    "Readings", "Checkin", "Symptom", "Alert", "AlertClosed", "Recommendation", "RecommendationDone",
    "Insight", "Instruction", "Report", "Photo",
]  # fmt: skip

# Daily summary of the indicators an astronaut cares about most, in display order.
DAILY = [
    ("resting_hr", "Resting HR", "bpm", 0),
    ("bp_sys", "BP", "mmHg", 0),
    ("body_temp", "Temp", "°C", 1),
    ("spo2", "SpO₂", "%", 0),
    ("glucose", "Glucose", "mg/dL", 0),
    ("sleep_hours", "Sleep", "h", 1),
    ("mood", "Mood", "/10", 0),
    ("stress", "Stress", "/10", 0),
    ("fatigue", "Fatigue", "/10", 0),
]


class TimelineEvent(ApiModel):
    id: str
    at: datetime
    kind: EventKind
    title: str
    detail: str | None = None
    severity: Literal["Attention", "Urgent"] | None = None
    ref_id: str | None = None  # alert / report / task id for a link


class TimelineOut(ApiModel):
    astronaut_code: str
    since: date
    events: list[TimelineEvent]


def _fmt(value: float, decimals: int) -> str:
    return f"{value:.{decimals}f}" if decimals else f"{round(value):d}"


def _daily_readings(session: SessionDep, astronaut_id: str, since: datetime) -> list[TimelineEvent]:
    rows = session.exec(
        select(HealthMeasurement)
        .where(
            HealthMeasurement.astronaut_id == astronaut_id,
            col(HealthMeasurement.indicator_code).in_([d[0] for d in DAILY] + ["bp_dia"]),
            col(HealthMeasurement.measured_at) >= since,
            HealthMeasurement.quality != MeasurementQuality.REJECTED.value,
            col(HealthMeasurement.value).is_not(None),
        )
        .order_by(col(HealthMeasurement.measured_at))
    ).all()
    days: dict[date, dict[str, HealthMeasurement]] = defaultdict(dict)
    for r in rows:
        days[r.measured_at.date()][r.indicator_code] = r  # last reading of the day wins
    events = []
    for day, latest in days.items():
        parts = []
        for code, label, unit, dec in DAILY:
            m = latest.get(code)
            if m is None or m.value is None:
                continue
            if code == "bp_sys":
                dia = latest.get("bp_dia")
                if dia is None or dia.value is None:
                    continue
                parts.append(f"{label} {_fmt(m.value, 0)}/{_fmt(dia.value, 0)} {unit}")
            else:
                parts.append(f"{label} {_fmt(m.value, dec)}{'' if unit.startswith('/') else ' '}{unit}")
        if parts:
            at = max(m.measured_at for m in latest.values())
            events.append(
                TimelineEvent(
                    id=f"R-{day.isoformat()}",
                    at=at,
                    kind="Readings",
                    title="Daily readings",
                    detail=" · ".join(parts),
                )  # fmt: skip
            )
    return events


@router.get("/astronauts/{astronaut}/timeline", response_model=TimelineOut)
def get_timeline(
    astronaut: ViewableAstronaut,
    request: Request,
    session: SessionDep,
    days: int = Query(default=14, ge=1, le=400),
) -> TimelineOut:
    """Chronological health history (newest first): readings, check-ins, symptoms, alerts, guidance, care."""
    bundle: ProtocolBundle = request.app.state.protocols
    since_day = datetime.now(UTC).date() - timedelta(days=days - 1)
    since = datetime.combine(since_day, time.min, tzinfo=UTC)
    aid = astronaut.id
    events = _daily_readings(session, aid, since)

    for c in session.exec(
        select(WellnessCheckin).where(
            WellnessCheckin.astronaut_id == aid, col(WellnessCheckin.created_at) >= since
        )
    ).all():
        took = f" · completed in {c.completed_in_seconds} s" if c.completed_in_seconds is not None else ""
        events.append(TimelineEvent(
            id=f"C-{c.id}", at=c.created_at, kind="Checkin", title="Daily check-in completed",
            detail=f"Sleep {c.sleep_hours:g} h (quality {c.sleep_quality}/10) · Mood {c.mood}/10 · "
                   f"Stress {c.stress}/10 · Fatigue {c.fatigue}/10{took}",
        ))  # fmt: skip

    for s in session.exec(
        select(Symptom).where(Symptom.astronaut_id == aid, col(Symptom.onset_at) >= since)
    ).all():
        label = CHECKIN_SYMPTOMS.get(s.symptom_code, s.symptom_code.replace("_", " ").capitalize())
        where = {"Assistant": "told the AI assistant", "Checkin": "daily check-in"}.get(s.source, s.source)
        events.append(TimelineEvent(
            id=f"S-{s.id}", at=s.onset_at, kind="Symptom", title=f"Symptom reported: {label}",
            detail=f"Severity {s.severity}/10 · {where}" + (f" · “{s.free_text[:120]}”" if s.free_text else ""),
            severity="Urgent" if s.red_flag else None,
        ))  # fmt: skip

    photos = session.exec(  # metadata only: the image data stays in the database
        select(HealthPhoto.id, HealthPhoto.taken_at, HealthPhoto.kind, HealthPhoto.note).where(
            HealthPhoto.astronaut_id == aid, col(HealthPhoto.taken_at) >= since
        )
    ).all()
    for pid, taken_at, photo_kind, note in photos:
        events.append(TimelineEvent(
            id=f"F-{pid}", at=taken_at, kind="Photo", title=f"Photo added: {KIND_LABEL.get(photo_kind, photo_kind)}",
            detail=note, ref_id=pid,
        ))  # fmt: skip

    for a in session.exec(
        select(HealthAlert).where(
            HealthAlert.astronaut_id == aid,
            (col(HealthAlert.first_triggered_at) >= since) | (col(HealthAlert.resolved_at) >= since),
        )
    ).all():
        sev: Literal["Attention", "Urgent"] = "Urgent" if a.severity == "Urgent" else "Attention"
        if a.first_triggered_at >= since:
            events.append(TimelineEvent(id=f"A-{a.id}", at=a.first_triggered_at, kind="Alert", title=a.title,
                                        detail=a.reason, severity=sev, ref_id=a.id))  # fmt: skip
        if a.resolved_at is not None and a.resolved_at >= since:
            events.append(TimelineEvent(
                id=f"AC-{a.id}", at=a.resolved_at, kind="AlertClosed", title=f"Alert closed: {a.title}",
                detail=a.resolution_note or f"Marked {a.status.lower()}.", ref_id=a.id,
            ))  # fmt: skip

    for t in session.exec(
        select(RecommendationTask).where(
            RecommendationTask.astronaut_id == aid,
            (col(RecommendationTask.created_at) >= since) | (col(RecommendationTask.completed_at) >= since),
        )
    ).all():
        rec = bundle.recommendations.get(t.code)
        title = rec.title if rec else t.code
        if t.created_at >= since:
            events.append(TimelineEvent(id=f"T-{t.id}", at=t.created_at, kind="Recommendation", title=title,
                                        detail=rec.body if rec else None, ref_id=t.id))  # fmt: skip
        if t.completed_at is not None and t.completed_at >= since and t.status == "Done":
            events.append(TimelineEvent(id=f"TD-{t.id}", at=t.completed_at, kind="RecommendationDone",
                                        title=f"Done: {title}", ref_id=t.id))  # fmt: skip

    for i in session.exec(
        select(Insight).where(
            Insight.astronaut_id == aid, Insight.kind == "Trend", col(Insight.insight_date) >= since_day
        )
    ).all():
        events.append(TimelineEvent(
            id=f"I-{i.id}", at=datetime.combine(i.insight_date, time(12), tzinfo=UTC), kind="Insight",
            title="Pattern noticed by the ML model (supporting information)", detail=i.explanation,
        ))  # fmt: skip

    for n in session.exec(
        select(MedicalInstruction).where(
            MedicalInstruction.astronaut_id == aid, col(MedicalInstruction.created_at) >= since
        )
    ).all():
        ack = " · acknowledged" if n.acknowledged_at else ""
        events.append(TimelineEvent(id=f"N-{n.id}", at=n.created_at, kind="Instruction",
                                    title=f"Instruction from {n.from_name}", detail=f"{n.text}{ack}"))  # fmt: skip

    for r in session.exec(
        select(MedicalReport).where(
            MedicalReport.astronaut_id == aid, col(MedicalReport.generated_at) >= since
        )
    ).all():
        kind = {"AlertTriggered": "after a new alert", "OnDemand": "on request"}.get(r.type, r.type.lower())
        events.append(TimelineEvent(
            id=f"P-{r.id}", at=r.generated_at, kind="Report", title=f"Medical report for the flight surgeon ({kind})",
            detail=f"Covers {r.period_start.isoformat()} to {r.period_end.isoformat()} · {r.transmission_status}",
            ref_id=r.id,
        ))  # fmt: skip

    events.sort(key=lambda e: e.at, reverse=True)
    return TimelineOut(astronaut_code=astronaut.code, since=since_day, events=events)


# --- My Guidance ---------------------------------------------------------------------------------


class GuidanceAlert(ApiModel):
    id: str
    title: str
    reason: str
    severity: Literal["Attention", "Urgent"]
    status: str
    escalation_required: bool


class GuidanceItem(ApiModel):
    id: str
    code: str
    title: str
    body: str
    category: str
    priority: int
    status: str
    due_at: datetime | None
    created_at: datetime
    completed_at: datetime | None
    alert: GuidanceAlert | None
    medical_review: bool
    source: str


class LibraryItem(ApiModel):
    code: str
    title: str
    body: str
    category: str
    source: str


class GuidanceOut(ApiModel):
    astronaut_code: str
    items: list[GuidanceItem]
    library: list[LibraryItem]


@router.get("/astronauts/{astronaut}/guidance", response_model=GuidanceOut)
def get_guidance(astronaut: ViewableAstronaut, request: Request, session: SessionDep) -> GuidanceOut:
    """Recommended actions (open, plus those finished in the last 7 days) and the approved guidance library."""
    bundle: ProtocolBundle = request.app.state.protocols
    recent = datetime.now(UTC) - timedelta(days=7)
    tasks = session.exec(
        select(RecommendationTask)
        .where(
            RecommendationTask.astronaut_id == astronaut.id,
            or_(col(RecommendationTask.status) == "Pending", col(RecommendationTask.completed_at) >= recent),
        )
        .order_by(col(RecommendationTask.due_at))
    ).all()
    alert_ids = {t.alert_id for t in tasks if t.alert_id}
    alerts = (
        {a.id: a for a in session.exec(select(HealthAlert).where(col(HealthAlert.id).in_(alert_ids))).all()}
        if alert_ids
        else {}
    )
    active = {s.value for s in ACTIVE_STATUSES}
    items = []
    for t in tasks:
        rec = bundle.recommendations.get(t.code)
        a = alerts.get(t.alert_id) if t.alert_id else None
        open_alert = a is not None and a.status in active
        items.append(
            GuidanceItem(
                id=t.id,
                code=t.code,
                title=rec.title if rec else t.code,
                body=rec.body if rec else "",
                category=rec.category if rec else "General",
                priority=rec.priority if rec else 3,
                status=t.status,
                due_at=t.due_at,
                created_at=t.created_at,
                completed_at=t.completed_at,
                alert=GuidanceAlert(
                    id=a.id,
                    title=a.title,
                    reason=a.reason,
                    severity="Urgent" if a.severity == "Urgent" else "Attention",
                    status=a.status,
                    escalation_required=a.escalation_required,
                )
                if a
                else None,
                medical_review=bool(open_alert and a and (a.severity == "Urgent" or a.escalation_required)),
                source=rec.source if rec else "",
            )  # fmt: skip
        )
    library = [
        LibraryItem(code=r.code, title=r.title, body=r.body, category=r.category, source=r.source)
        for r in sorted(bundle.recommendations.values(), key=lambda r: (r.category, r.priority, r.code))
    ]
    return GuidanceOut(astronaut_code=astronaut.code, items=items, library=library)
