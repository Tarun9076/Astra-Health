"""Medical reports, surgeon instructions and the crew summary (Step 8; LLD §13.3, §17).

- Reports: list / read / generate on demand (astronaut for themselves, flight surgeon for anyone).
- Instructions: the flight surgeon sends; the astronaut sees it live and acknowledges.
- Crew summary: one row per astronaut for the surgeon's crew grid (mission control gets status only).
"""

import json
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import Field, model_validator
from sqlmodel import Session, col, func, select

from astra.api.base import ApiModel
from astra.assistant.service import Assistant
from astra.core.alerts import ACTIVE_STATUSES
from astra.core.enums import NodeRole, Role
from astra.core.ids import uuid7
from astra.db.models import (
    Astronaut,
    AuditLog,
    HealthAlert,
    HealthMeasurement,
    MedicalInstruction,
    MedicalReport,
    SyncOutbox,
)
from astra.db.session import SessionDep
from astra.realtime.hub import hub
from astra.security.deps import CurrentUser, ViewableAstronaut, can_view_astronaut, require_role
from astra.security.jwt import TokenClaims
from astra.services.assessment import HISTORY_MARGIN, load_assessor
from astra.services.crew import find_astronaut
from astra.services.reports import generate_report
from astra.services.wellness import compute_wellness

router = APIRouter(prefix="/api", tags=["reports"])

Surgeon = Annotated[TokenClaims, Depends(require_role(Role.FLIGHT_SURGEON))]
AstronautUser = Annotated[TokenClaims, Depends(require_role(Role.ASTRONAUT))]
MAX_REPORT_DAYS = 31


class ReportListItem(ApiModel):
    id: str
    astronaut_code: str
    type: Literal["Daily", "Weekly", "AlertTriggered", "OnDemand"]
    period_start: date
    period_end: date
    alert_id: str | None
    headline: str
    narrative_provider: str
    generated_at: datetime
    transmission_status: Literal["Queued", "Sent", "Delivered"]


class ReportOut(ReportListItem):
    narrative: str
    summary: dict[str, Any]
    disclaimer: str = "Decision support only — not a diagnosis. All data is simulated."


class ReportIn(ApiModel):
    start: date
    end: date

    @model_validator(mode="after")
    def _range(self) -> "ReportIn":
        if self.end < self.start:
            raise ValueError("end must not be before start")
        if (self.end - self.start).days + 1 > MAX_REPORT_DAYS:
            raise ValueError(f"a report covers at most {MAX_REPORT_DAYS} days")
        return self


class InstructionIn(ApiModel):
    astronaut_id: str
    alert_id: str | None = None
    text: str = Field(min_length=3, max_length=2000)


class InstructionOut(ApiModel):
    id: str
    astronaut_code: str
    alert_id: str | None
    from_name: str
    text: str
    created_at: datetime
    delivered_at: datetime | None
    acknowledged_at: datetime | None


class LatestReport(ApiModel):
    id: str
    type: str
    generated_at: datetime
    transmission_status: str


class CrewStatus(ApiModel):
    code: str
    display_name: str
    role_title: str
    status: Literal["GREEN", "YELLOW", "RED"]
    urgent_alerts: int
    attention_alerts: int
    last_reading_at: datetime | None
    # flight surgeon only (None for mission control: status only, LLD §17)
    wellness_index: int | None = None
    top_alert: str | None = None
    alerts_awaiting_review: int | None = None
    unacknowledged_instructions: int | None = None
    latest_report: LatestReport | None = None


def _headline(text: str) -> str:
    first = text.split(". ")[0]
    return first if first.endswith(".") else first + "."


def _item(r: MedicalReport, code: str) -> ReportListItem:
    return ReportListItem(
        id=r.id,
        astronaut_code=code,
        type=r.type,  # type: ignore[arg-type]
        period_start=r.period_start,
        period_end=r.period_end,
        alert_id=r.alert_id,
        headline=_headline(r.narrative_text),
        narrative_provider=r.narrative_provider,
        generated_at=r.generated_at,
        transmission_status=r.transmission_status,  # type: ignore[arg-type]
    )


def _instruction_out(i: MedicalInstruction, code: str) -> InstructionOut:
    return InstructionOut(
        id=i.id, astronaut_code=code, alert_id=i.alert_id, from_name=i.from_name, text=i.text,
        created_at=i.created_at, delivered_at=i.delivered_at, acknowledged_at=i.acknowledged_at,
    )  # fmt: skip


def _audit(session: Session, request: Request, user: TokenClaims, action: str, entity: str, entity_id: str,
           details: dict[str, Any] | None = None) -> None:  # fmt: skip
    session.add(
        AuditLog(
            user_id=user.user_id,
            action=action,
            entity_type=entity,
            entity_id=entity_id,
            node_id=request.app.state.settings.node_id,
            details=json.dumps(details or {}),
        )  # fmt: skip
    )


def publish_report(report: MedicalReport) -> None:
    """Tell the astronaut's screens and the medical team that a report exists (no content in the event)."""
    payload = {"id": report.id, "type": report.type, "astronautId": report.astronaut_id}
    hub.publish_from_thread([f"astronaut:{report.astronaut_id}", "medical"], "ReportGenerated", payload)


# --- reports --------------------------------------------------------------------------------------


@router.get("/astronauts/{astronaut}/reports", response_model=list[ReportListItem])
def list_reports(astronaut: ViewableAstronaut, session: SessionDep) -> list[ReportListItem]:
    """Newest first."""
    rows = session.exec(
        select(MedicalReport)
        .where(MedicalReport.astronaut_id == astronaut.id)
        .order_by(col(MedicalReport.generated_at).desc())
        .limit(100)
    ).all()
    return [_item(r, astronaut.code) for r in rows]


@router.get("/reports/{report_id}", response_model=ReportOut)
def get_report(report_id: str, request: Request, session: SessionDep, user: CurrentUser) -> ReportOut:
    report = session.get(MedicalReport, report_id)
    astronaut = session.get(Astronaut, report.astronaut_id) if report else None
    if report is None or astronaut is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Report not found")
    if not can_view_astronaut(user, astronaut):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only view your own reports")
    if user.role == Role.FLIGHT_SURGEON:
        _audit(
            session, request, user, "ReportRead", "MedicalReport", report.id, {"astronaut": astronaut.code}
        )
        session.commit()
    return ReportOut(
        **_item(report, astronaut.code).model_dump(),
        narrative=report.narrative_text,
        summary=json.loads(report.summary_json),
    )


@router.post("/astronauts/{astronaut}/reports", response_model=ReportOut, status_code=status.HTTP_201_CREATED)
def create_report(
    astronaut: ViewableAstronaut, body: ReportIn, request: Request, session: SessionDep, user: CurrentUser
) -> ReportOut:
    """On-demand report for any period up to 31 days (Claude narrative when configured, else template)."""
    if user.role not in (Role.ASTRONAUT, Role.FLIGHT_SURGEON):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role can't create reports")
    assistant: Assistant = request.app.state.assistant
    report = generate_report(
        session, request.app.state.protocols, astronaut, "OnDemand", body.start, body.end,
        node_id=request.app.state.settings.node_id,
        narrator=assistant.narrate_report if assistant.llm_configured else None,
        generated_by=user.user_id,
    )  # fmt: skip
    _audit(
        session, request, user, "ReportGenerated", "MedicalReport", report.id, {"astronaut": astronaut.code}
    )
    session.commit()
    publish_report(report)
    return ReportOut(
        **_item(report, astronaut.code).model_dump(),
        narrative=report.narrative_text,
        summary=json.loads(report.summary_json),
    )


# --- instructions ---------------------------------------------------------------------------------


@router.post("/instructions", response_model=InstructionOut, status_code=status.HTTP_201_CREATED)
def send_instruction(
    body: InstructionIn, request: Request, session: SessionDep, user: Surgeon
) -> InstructionOut:
    astronaut = find_astronaut(session, body.astronaut_id)
    if astronaut is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Astronaut not found")
    if body.alert_id:
        alert = session.get(HealthAlert, body.alert_id)
        if alert is None or alert.astronaut_id != astronaut.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Alert not found for this astronaut")
    now = datetime.now(UTC)
    instruction = MedicalInstruction(
        id=str(uuid7(int(now.timestamp() * 1000))),
        astronaut_id=astronaut.id,
        alert_id=body.alert_id,
        from_user_id=user.user_id,
        from_name=user.display_name,
        text=body.text,
        created_at=now,
        # On the Habitat (same node as the astronaut) it is delivered at once; from the Ground node it is
        # delivered when the envelope reaches the Habitat, which reports the time back (Step 9).
        delivered_at=now if request.app.state.settings.node_role == NodeRole.HABITAT else None,
        origin_node_id=request.app.state.settings.node_id,
    )
    session.add(instruction)
    session.add(SyncOutbox(entity_type="MedicalInstruction", entity_id=instruction.id,
                           payload_json=instruction.model_dump_json(), priority=2))  # fmt: skip
    _audit(session, request, user, "InstructionSent", "MedicalInstruction", instruction.id,
           {"astronaut": astronaut.code, "alertId": body.alert_id})  # fmt: skip
    session.commit()
    out = _instruction_out(instruction, astronaut.code)
    hub.publish_from_thread(
        [f"astronaut:{astronaut.id}", "medical"],
        "InstructionReceived",
        out.model_dump(mode="json", by_alias=True),
    )
    return out


@router.get("/astronauts/{astronaut}/instructions", response_model=list[InstructionOut])
def list_instructions(astronaut: ViewableAstronaut, session: SessionDep) -> list[InstructionOut]:
    """Newest first."""
    rows = session.exec(
        select(MedicalInstruction)
        .where(MedicalInstruction.astronaut_id == astronaut.id)
        .order_by(col(MedicalInstruction.created_at).desc())
        .limit(100)
    ).all()
    return [_instruction_out(i, astronaut.code) for i in rows]


@router.post("/instructions/{instruction_id}/acknowledge", response_model=InstructionOut)
def acknowledge_instruction(
    instruction_id: str, request: Request, session: SessionDep, user: AstronautUser
) -> InstructionOut:
    instruction = session.get(MedicalInstruction, instruction_id)
    if instruction is None or instruction.astronaut_id != user.astronaut_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Instruction not found")
    astronaut = session.get(Astronaut, instruction.astronaut_id)
    assert astronaut is not None
    if instruction.acknowledged_at is None:
        instruction.acknowledged_at = datetime.now(UTC)
        session.add(instruction)
        session.add(SyncOutbox(entity_type="MedicalInstruction", entity_id=instruction.id,
                               payload_json=instruction.model_dump_json(), priority=3))  # fmt: skip
        _audit(session, request, user, "InstructionAcknowledged", "MedicalInstruction", instruction.id)
        session.commit()
    out = _instruction_out(instruction, astronaut.code)
    hub.publish_from_thread(
        [f"astronaut:{astronaut.id}", "medical"],
        "InstructionAcknowledged",
        out.model_dump(mode="json", by_alias=True),
    )
    return out


# --- crew grid ------------------------------------------------------------------------------------


@router.get("/crew/summary", response_model=list[CrewStatus])
def crew_summary(request: Request, session: SessionDep, user: CurrentUser) -> list[CrewStatus]:
    if user.role not in (Role.FLIGHT_SURGEON, Role.MISSION_CONTROL, Role.ADMIN):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Crew overview is for flight surgeons and mission control"
        )
    medical = user.role == Role.FLIGHT_SURGEON
    out = []
    for a in session.exec(select(Astronaut).order_by(Astronaut.code)).all():
        alerts = session.exec(
            select(HealthAlert)
            .where(
                HealthAlert.astronaut_id == a.id,
                col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]),
            )
            .order_by(col(HealthAlert.last_triggered_at).desc())
        ).all()
        urgent = [x for x in alerts if x.severity == "Urgent"]
        last = session.exec(
            select(func.max(HealthMeasurement.measured_at)).where(HealthMeasurement.astronaut_id == a.id)
        ).one()
        row = CrewStatus(
            code=a.code,
            display_name=a.display_name,
            role_title=a.role_title,
            status="RED" if urgent else "YELLOW" if alerts else "GREEN",
            urgent_alerts=len(urgent),
            attention_alerts=len(alerts) - len(urgent),
            last_reading_at=last.replace(tzinfo=UTC) if last is not None and last.tzinfo is None else last,
        )
        if medical:
            now = datetime.now(UTC)  # live, like the dashboard (stored daily scores lag behind)
            assessor = load_assessor(session, request.app.state.protocols, a, now - HISTORY_MARGIN)
            score = compute_wellness(session, assessor, a.id, now)
            report = session.exec(
                select(MedicalReport)
                .where(MedicalReport.astronaut_id == a.id)
                .order_by(col(MedicalReport.generated_at).desc())
            ).first()
            pending = session.exec(
                select(func.count())
                .select_from(MedicalInstruction)
                .where(
                    MedicalInstruction.astronaut_id == a.id, col(MedicalInstruction.acknowledged_at).is_(None)
                )
            ).one()
            row.wellness_index = score.overall
            row.top_alert = (urgent or list(alerts))[0].title if alerts else None
            row.alerts_awaiting_review = sum(x.status in ("Open", "Acknowledged") for x in alerts)
            row.unacknowledged_instructions = int(pending)
            row.latest_report = (
                LatestReport(id=report.id, type=report.type, generated_at=report.generated_at,
                             transmission_status=report.transmission_status)
                if report else None
            )  # fmt: skip
        out.append(row)
    return out
