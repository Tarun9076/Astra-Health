"""Medical reports for the flight surgeon (Step 8; LLD §3.3, §13.3).

A report = a structured summary of a period (values vs the personal normal, alerts, AI insights,
wellness, adherence, radiation, red-flag symptoms, instructions) + a plain-language narrative.
The narrative comes from Claude when configured (facts from the summary only, guarded), else
from a deterministic template. Reports are queued for the ground in the sync outbox.

Automatic reports (from the routine loop, idempotent):
- Daily: yesterday, once there is data for it.
- Weekly: the last complete Monday–Sunday week.
- AlertTriggered: every active Urgent or escalated alert that has no report yet.
"""

import json
import logging
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from statistics import mean
from typing import Any, Literal

from sqlmodel import Session, col, select

from astra.core.alerts import ACTIVE_STATUSES
from astra.core.ids import uuid7
from astra.core.protocols import ProtocolBundle
from astra.db.models import (
    Astronaut,
    HealthAlert,
    HealthMeasurement,
    Insight,
    MedicalInstruction,
    MedicalReport,
    Mission,
    RecommendationTask,
    Symptom,
    SyncOutbox,
    WellnessCheckin,
    WellnessScore,
)
from astra.services.assessment import HISTORY_MARGIN, load_assessor

logger = logging.getLogger(__name__)

ReportType = Literal["Daily", "Weekly", "AlertTriggered", "OnDemand"]
REPORT_INDICATORS = [
    "resting_hr", "bp_sys", "bp_dia", "body_temp", "spo2", "glucose", "sleep_hours", "sleep_quality",
    "mood", "stress", "fatigue", "activity_min", "exercise_sessions", "strength_index", "body_weight",
]  # fmt: skip
NOTABLE_Z = 2.0
ALERT_REPORT_DAYS = 7

# (summary dict) -> (narrative, provider); None = template only
Narrator = Callable[[dict[str, Any]], tuple[str, str]]


def _day_bounds(start: date, end: date) -> tuple[datetime, datetime]:
    return (
        datetime.combine(start, time.min, tzinfo=UTC),
        datetime.combine(end, time.max, tzinfo=UTC),
    )


def _r(v: float | None, nd: int = 2) -> float | None:
    return None if v is None else round(v, nd)


def build_summary(
    session: Session, bundle: ProtocolBundle, astronaut: Astronaut, start: date, end: date
) -> dict[str, Any]:
    """Everything the report says, as plain data (also stored as SummaryJson)."""
    since, until = _day_bounds(start, end)
    mission = session.get(Mission, astronaut.mission_id)
    profile = bundle.mission_profiles.get(mission.profile_code) if mission else None
    assessor = load_assessor(session, bundle, astronaut, since - HISTORY_MARGIN)

    indicators = []
    for code in REPORT_INDICATORS:
        pts = [p for p in assessor.series.get(code, []) if since <= p.t <= until]
        if not pts:
            continue
        meta = bundle.catalog.get(code)
        base = assessor.baseline(code, end)
        latest = pts[-1].value
        avg = mean(p.value for p in pts)
        z_avg = base.z(avg) if base is not None and meta.has_baseline else None
        z_latest = base.z(latest) if base is not None and meta.has_baseline else None
        flag = "unknown"
        if z_avg is not None:
            flag = "above" if z_avg >= NOTABLE_Z else "below" if z_avg <= -NOTABLE_Z else "normal"
        indicators.append({
            "indicator": code, "name": meta.name, "unit": meta.unit, "n": len(pts),
            "mean": _r(avg), "min": _r(min(p.value for p in pts)), "max": _r(max(p.value for p in pts)),
            "latest": _r(latest), "baseline": _r(base.median) if base else None,
            "sigma": _r(base.sigma, 3) if base else None, "zMean": _r(z_avg), "zLatest": _r(z_latest),
            "flag": flag,
        })  # fmt: skip

    alerts = session.exec(
        select(HealthAlert)
        .where(
            HealthAlert.astronaut_id == astronaut.id,
            col(HealthAlert.first_triggered_at) <= until,
            col(HealthAlert.last_triggered_at) >= since,
            HealthAlert.status != "Dismissed",
        )
        .order_by(col(HealthAlert.first_triggered_at))
    ).all()
    insights = session.exec(
        select(Insight)
        .where(
            Insight.astronaut_id == astronaut.id,
            col(Insight.insight_date) >= start,
            col(Insight.insight_date) <= end,
        )
        .order_by(col(Insight.insight_date))
    ).all()
    wellness = [
        w.overall
        for w in session.exec(
            select(WellnessScore).where(
                WellnessScore.astronaut_id == astronaut.id,
                col(WellnessScore.score_date) >= start,
                col(WellnessScore.score_date) <= end,
            )
        ).all()
        if w.overall is not None
    ]
    checkins = session.exec(
        select(WellnessCheckin).where(
            WellnessCheckin.astronaut_id == astronaut.id,
            col(WellnessCheckin.checkin_date) >= start,
            col(WellnessCheckin.checkin_date) <= end,
        )
    ).all()
    tasks = session.exec(
        select(RecommendationTask).where(
            RecommendationTask.astronaut_id == astronaut.id,
            col(RecommendationTask.created_at) >= since,
            col(RecommendationTask.created_at) <= until,
        )
    ).all()
    symptoms = session.exec(
        select(Symptom).where(
            Symptom.astronaut_id == astronaut.id,
            col(Symptom.onset_at) >= since,
            col(Symptom.onset_at) <= until,
        )
    ).all()
    instructions = session.exec(
        select(MedicalInstruction).where(
            MedicalInstruction.astronaut_id == astronaut.id,
            col(MedicalInstruction.created_at) >= since,
            col(MedicalInstruction.created_at) <= until,
        )
    ).all()
    dose = session.exec(
        select(HealthMeasurement).where(
            HealthMeasurement.astronaut_id == astronaut.id,
            HealthMeasurement.indicator_code == "radiation_dose",
            HealthMeasurement.channel == "Total",
            HealthMeasurement.quality == "Valid",
            col(HealthMeasurement.measured_at) <= until,
        )
    ).all()
    period_dose = sum(m.value or 0 for m in dose if m.measured_at >= since)
    mission_dose = sum(
        m.value or 0 for m in dose if mission is None or m.measured_at.date() >= mission.start_date
    )

    days = (end - start).days + 1
    return {
        "astronautCode": astronaut.code,
        "displayName": astronaut.display_name,
        "periodStart": start.isoformat(),
        "periodEnd": end.isoformat(),
        "days": days,
        "missionDays": [
            (start - mission.start_date).days + 1,
            (end - mission.start_date).days + 1,
        ]
        if mission
        else None,
        "indicators": indicators,
        "alerts": [
            {
                "id": a.id,
                "ruleId": a.rule_id,
                "title": a.title,
                "severity": a.severity,
                "status": a.status,
                "firstDay": a.first_triggered_at.date().isoformat(),
                "lastDay": a.last_triggered_at.date().isoformat(),
                "reason": a.reason,
                "escalationRequired": a.escalation_required,
                "resolutionNote": a.resolution_note,
            }
            for a in alerts
        ],  # fmt: skip
        "insights": [
            {"kind": i.kind, "day": i.insight_date.isoformat(), "explanation": i.explanation}
            for i in insights
        ],
        "wellness": {
            "mean": _r(mean(wellness), 0) if wellness else None,
            "min": min(wellness) if wellness else None,
            "latest": wellness[-1] if wellness else None,
        },
        "adherence": {
            "checkins": len({c.checkin_date for c in checkins}),
            "days": days,
            "tasksDone": sum(t.status == "Done" for t in tasks),
            "tasksPending": sum(t.status == "Pending" for t in tasks),
            "tasksSkipped": sum(t.status == "Skipped" for t in tasks),
        },
        "radiation": {
            "periodMsv": round(period_dose, 3),
            "missionMsv": round(mission_dose, 2),
            "limitMsv": profile.radiation_limit_msv if profile else None,
            "pctOfLimit": round(100 * mission_dose / profile.radiation_limit_msv, 1) if profile else None,
        },
        "redFlagSymptoms": [
            {"symptom": s.symptom_code, "at": s.onset_at.isoformat()} for s in symptoms if s.red_flag
        ],
        "instructions": [
            {"from": i.from_name, "text": i.text, "acknowledged": i.acknowledged_at is not None}
            for i in instructions
        ],
    }


def _fmt(v: float | None) -> str:
    if v is None:
        return "n/a"
    return f"{v:.0f}" if abs(v) >= 20 else f"{v:.1f}"


STATUS_TEXT = {"Open": "open", "Acknowledged": "acknowledged", "InReview": "in review"}


def _unit(unit: str) -> str:
    return "/10" if unit == "score" else f" {unit}"


def template_narrative(s: dict[str, Any]) -> str:
    """Deterministic plain-language summary for the flight surgeon. Facts from the summary only."""
    days = s["missionDays"]
    when = f"mission days {days[0]}–{days[1]}" if days else f"{s['periodStart']} to {s['periodEnd']}"
    parts = [f"{s['displayName']} ({s['astronautCode']}), {when}."]
    w = s["wellness"]
    if w["mean"] is not None:
        parts[0] += f" Wellness index averaged {w['mean']:.0f} (lowest {w['min']}, latest {w['latest']})."

    notable = [i for i in s["indicators"] if i["flag"] in ("above", "below")]
    if notable:
        items = "; ".join(
            f"{i['name'].lower()} {_fmt(i['mean'])}{_unit(i['unit'])} vs normal {_fmt(i['baseline'])} "
            f"({i['zMean']:+.1f}σ, latest {_fmt(i['latest'])})"
            for i in notable
        )
        parts.append(f"Outside the personal normal (period average, ≥ 2σ): {items}.")
    else:
        parts.append("All tracked indicators averaged within the personal normal range.")

    active = [a for a in s["alerts"] if a["status"] in ("Open", "Acknowledged", "InReview")]
    closed = [a for a in s["alerts"] if a not in active]
    if active:
        parts.append(
            "Active alerts: "
            + "; ".join(
                f"{a['title']} ({a['severity']}, {STATUS_TEXT.get(a['status'], a['status'])}, "
                f"since {a['firstDay']})"
                for a in active
            )
            + "."
        )
    if closed:
        parts.append(f"{len(closed)} alert(s) in the period are closed.")
    if not s["alerts"]:
        parts.append("No alerts in the period.")
    if s["redFlagSymptoms"]:
        parts.append(
            "Red-flag symptoms reported: "
            + ", ".join(r["symptom"].replace("_", " ") for r in s["redFlagSymptoms"])
            + "."
        )

    trends = [i for i in s["insights"] if i["kind"] == "Trend"]
    anomalies = [i for i in s["insights"] if i["kind"] == "Anomaly"]
    if trends or anomalies:
        text = []
        if trends:
            text.append(f"rising recovery strain on {len(trends)} day(s) from {trends[0]['day']}")
        if anomalies:
            text.append(f"{len(anomalies)} unusual day(s)")
        parts.append("AI insights (advisory): " + " and ".join(text) + ".")

    a = s["adherence"]
    parts.append(
        f"Check-ins on {a['checkins']} of {a['days']} day(s); tasks done {a['tasksDone']}, "
        f"pending {a['tasksPending']}, skipped {a['tasksSkipped']}."
    )
    r = s["radiation"]
    if r["pctOfLimit"] is not None:
        parts.append(
            f"Radiation {r['periodMsv']:.2f} mSv in the period; mission total {r['missionMsv']:.1f} mSv "
            f"({r['pctOfLimit']:.0f} % of the {r['limitMsv']:.0f} mSv limit)."
        )
    if s["instructions"]:
        acked = sum(i["acknowledged"] for i in s["instructions"])
        parts.append(
            f"{len(s['instructions'])} instruction(s) from the flight surgeon, {acked} acknowledged."
        )
    parts.append("Decision support only; simulated data; not a diagnosis.")
    return " ".join(parts)


def generate_report(
    session: Session,
    bundle: ProtocolBundle,
    astronaut: Astronaut,
    type_: ReportType,
    start: date,
    end: date,
    *,
    node_id: str,
    narrator: Narrator | None = None,
    alert_id: str | None = None,
    generated_by: str | None = None,
    urgent: bool = False,
) -> MedicalReport:
    summary = build_summary(session, bundle, astronaut, start, end)
    narrative, provider = template_narrative(summary), "template"
    if narrator is not None:
        try:
            narrative, provider = narrator(summary)
        except Exception:  # the template is always there
            logger.exception("Report narrative failed; using the template")
    now = datetime.now(UTC)
    report = MedicalReport(
        id=str(uuid7(int(now.timestamp() * 1000))),
        astronaut_id=astronaut.id,
        type=type_,
        period_start=start,
        period_end=end,
        alert_id=alert_id,
        summary_json=json.dumps(summary, ensure_ascii=False),
        narrative_text=narrative,
        narrative_provider=provider,
        generated_by=generated_by,
        generated_at=now,
        origin_node_id=node_id,
    )
    session.add(report)
    session.add(
        SyncOutbox(
            entity_type="MedicalReport",
            entity_id=report.id,
            payload_json=report.model_dump_json(),
            priority=1 if urgent else 4,
        )
    )
    return report


def _exists(session: Session, astronaut_id: str, type_: str, start: date, end: date) -> bool:
    return (
        session.exec(
            select(MedicalReport.id).where(
                MedicalReport.astronaut_id == astronaut_id,
                MedicalReport.type == type_,
                MedicalReport.period_start == start,
                MedicalReport.period_end == end,
            )
        ).first()
        is not None
    )


def _has_data(session: Session, astronaut_id: str, start: date, end: date) -> bool:
    since, until = _day_bounds(start, end)
    return (
        session.exec(
            select(HealthMeasurement.id).where(
                HealthMeasurement.astronaut_id == astronaut_id,
                col(HealthMeasurement.measured_at) >= since,
                col(HealthMeasurement.measured_at) <= until,
            )
        ).first()
        is not None
    )


def ensure_reports(
    session: Session,
    bundle: ProtocolBundle,
    *,
    node_id: str,
    narrator: Narrator | None = None,
    now: datetime | None = None,
) -> list[MedicalReport]:
    """Create any missing automatic reports (idempotent). Commits."""
    now = now or datetime.now(UTC)
    yesterday = now.date() - timedelta(days=1)
    week_end = now.date() - timedelta(days=now.date().isoweekday())  # last Sunday
    week_start = week_end - timedelta(days=6)
    created: list[MedicalReport] = []
    for astronaut in session.exec(select(Astronaut).order_by(Astronaut.code)).all():
        wanted: list[tuple[ReportType, date, date]] = [
            ("Daily", yesterday, yesterday),
            ("Weekly", week_start, week_end),
        ]
        for type_, start, end in wanted:
            if not _exists(session, astronaut.id, type_, start, end) and _has_data(
                session, astronaut.id, start, end
            ):
                created.append(
                    generate_report(
                        session, bundle, astronaut, type_, start, end, node_id=node_id, narrator=narrator
                    )
                )
        alerts = session.exec(
            select(HealthAlert).where(
                HealthAlert.astronaut_id == astronaut.id,
                col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]),
            )
        ).all()
        for alert in alerts:
            if not (alert.severity == "Urgent" or alert.escalation_required):
                continue
            done = session.exec(select(MedicalReport.id).where(MedicalReport.alert_id == alert.id)).first()
            if done is None:
                created.append(
                    generate_report(
                        session,
                        bundle,
                        astronaut,
                        "AlertTriggered",
                        now.date() - timedelta(days=ALERT_REPORT_DAYS - 1),
                        now.date(),
                        node_id=node_id,
                        narrator=narrator,
                        alert_id=alert.id,
                        urgent=alert.severity == "Urgent",
                    )  # fmt: skip
                )
    session.commit()
    return created


def report_new_alerts(
    session: Session,
    bundle: ProtocolBundle,
    astronaut: Astronaut,
    created: list[HealthAlert],
    *,
    node_id: str,
    narrator: Narrator | None = None,
) -> MedicalReport | None:
    """A live batch (check-in, readings, scenario) raised new alerts: one AlertTriggered report for the
    last 7 days, about the most severe of them, queued for the ground with the alerts. Commits."""
    if not created:
        return None
    lead = sorted(created, key=lambda a: (a.severity != "Urgent", a.first_triggered_at))[0]
    today = datetime.now(UTC).date()
    report = generate_report(
        session, bundle, astronaut, "AlertTriggered", today - timedelta(days=ALERT_REPORT_DAYS - 1), today,
        node_id=node_id, narrator=narrator, alert_id=lead.id, urgent=lead.severity == "Urgent",
    )  # fmt: skip
    session.commit()
    return report
