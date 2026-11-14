"""AI Health Assistant API (LLD §11, §13.4).

POST /api/assistant/chat builds the findings from the database, calls `Assistant.answer()`,
stores both turns, and, when an astronaut reports a red-flag symptom, records the symptom and
raises an Urgent alert (pushed live over the WebSocket like any other alert).
"""

import json
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import Field
from sqlmodel import Session, col, select

from astra.api.alerts import publish_alert_changes
from astra.api.base import ApiModel
from astra.api.dashboard import get_dashboard
from astra.assistant.models import (
    AssistantRequest,
    AssistantResponse,
    FindingAlert,
    FindingInsight,
    Findings,
    LatestValue,
    Turn,
)
from astra.assistant.service import Assistant
from astra.core.enums import Role
from astra.core.ids import uuid7
from astra.core.protocols import ProtocolBundle
from astra.db.models import Astronaut, AuditLog, ChatMessage, Insight, Mission, Symptom
from astra.db.session import SessionDep
from astra.security.deps import CurrentUser, can_view_astronaut
from astra.security.jwt import TokenClaims
from astra.services.alerts import raise_symptom_alert
from astra.services.crew import find_astronaut

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

HISTORY_TURNS = 6
DISCLAIMER = (
    "Health information, not a diagnosis. All data is simulated. In an emergency, follow the protocol."
)


class ChatIn(ApiModel):
    question: str = Field(min_length=1, max_length=2000)
    astronaut_id: str | None = None  # flight surgeons choose whose data to discuss; astronauts get their own
    provider: Literal["auto", "claude", "template"] = "auto"


class CitationOut(ApiModel):
    chunk_id: str
    title: str
    source: str


class ChatOut(ApiModel):
    message_id: str
    question_id: str
    answer: str
    citations: list[CitationOut]
    suggested_actions: list[str]
    safety_flags: list[str]
    mode: Literal["llm", "template", "emergency"]
    provider: Literal["claude", "template", "redflag"]
    emergency_protocol_id: str | None
    alert_id: str | None = None  # Urgent alert raised from this message
    created_at: datetime
    disclaimer: str = DISCLAIMER


class HistoryItem(ApiModel):
    id: str
    role: Literal["user", "assistant"]
    text: str
    mode: str | None
    provider: str | None
    citations: list[CitationOut]
    suggested_actions: list[str]
    emergency_protocol_id: str | None
    alert_id: str | None
    created_at: datetime


class AssistantStatus(ApiModel):
    default_provider: Literal["claude", "template"]
    claude_configured: bool
    model: str | None
    knowledge_notes: int
    knowledge_chunks: int
    red_flags: int


def _assistant(request: Request) -> Assistant:
    assistant: Assistant = request.app.state.assistant
    return assistant


def _target(session: Session, user: TokenClaims, astronaut_id: str | None) -> Astronaut:
    if user.role == Role.ASTRONAUT:
        astronaut = session.get(Astronaut, user.astronaut_id) if user.astronaut_id else None
        if astronaut_id and astronaut and astronaut_id not in (astronaut.id, astronaut.code):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only ask about your own health data")
    elif user.role == Role.FLIGHT_SURGEON:
        astronaut = find_astronaut(session, astronaut_id) if astronaut_id else None
        if astronaut is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose an astronaut (astronautId)")
    else:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "The assistant is for astronauts and flight surgeons")
    if astronaut is None or not can_view_astronaut(user, astronaut):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Astronaut not found")
    return astronaut


def build_findings(session: Session, request: Request, astronaut: Astronaut) -> Findings:
    bundle: ProtocolBundle = request.app.state.protocols
    dash = get_dashboard(astronaut, request, session)
    mission = session.get(Mission, astronaut.mission_id)
    profile = bundle.mission_profiles.get(mission.profile_code) if mission else None
    since = datetime.now(UTC).date() - timedelta(days=3)
    insights = session.exec(
        select(Insight)
        .where(Insight.astronaut_id == astronaut.id, col(Insight.insight_date) >= since)
        .order_by(col(Insight.insight_date).desc())
    ).all()
    return Findings(
        astronaut_code=astronaut.code,
        mission_day=dash.mission_day,
        gravity=f"{profile.name}, {profile.gravity_g:g} g" if profile else None,
        latest={
            v.indicator: LatestValue(
                name=v.name, value=v.value, unit=v.unit, baseline=v.baseline, sigma=v.sigma, z=v.z
            )
            for v in dash.vitals
        },
        active_alerts=[
            FindingAlert(
                rule_id=a.rule_id,
                title=a.title,
                severity="Urgent" if a.severity == "Urgent" else "Attention",
                reason=a.reason,
                escalation_required=a.escalation_required,
            )
            for a in dash.active_alerts
        ],
        insights=[
            FindingInsight(
                kind="Trend" if i.kind == "Trend" else "Anomaly",
                day=i.insight_date.isoformat(),
                explanation=i.explanation,
            )
            for i in insights[:3]
        ],  # fmt: skip
        tasks=[t.title for t in dash.tasks],
        wellness_index=dash.wellness_index,
    )


def _history(session: Session, astronaut: Astronaut) -> list[Turn]:
    rows = session.exec(
        select(ChatMessage)
        .where(ChatMessage.astronaut_id == astronaut.id)
        .order_by(col(ChatMessage.created_at).desc())
        .limit(HISTORY_TURNS)
    ).all()
    return [Turn(role="user" if r.role == "user" else "assistant", text=r.text) for r in reversed(rows)]


def _report_symptom(
    session: Session,
    request: Request,
    astronaut: Astronaut,
    reply: AssistantResponse,
    question: str,
    at: datetime,
) -> str | None:
    assistant = _assistant(request)
    flag = next(f for f in assistant.redflags.flags if f.id == reply.red_flag_id)
    session.add(
        Symptom(
            id=str(uuid7(int(at.timestamp() * 1000))),
            astronaut_id=astronaut.id,
            symptom_code=flag.symptom,
            free_text=question,
            severity=8,
            onset_at=at,
            red_flag=True,
            source="Assistant",
        )
    )
    changes = raise_symptom_alert(
        session,
        request.app.state.protocols,
        astronaut,
        rule_id=f"SYM-{flag.id}",
        rule_version=assistant.redflags.version,
        title=flag.title,
        reason=f'Reported to the AI assistant: "{question[:200]}". Follow the emergency protocol.',
        protocol=flag.protocol,
        evidence={"symptom": {"indicator": flag.symptom, "agg": "reported", "window": "now", "n": 1}},
        at=at,
        node_id=request.app.state.settings.node_id,
    )
    session.flush()
    publish_alert_changes(changes, astronaut)
    alert = (changes.created or changes.updated)[0]
    return alert.id


@router.post("/chat", response_model=ChatOut)
def chat(body: ChatIn, request: Request, session: SessionDep, user: CurrentUser) -> ChatOut:
    astronaut = _target(session, user, body.astronaut_id)
    now = datetime.now(UTC)
    findings = build_findings(session, request, astronaut)
    query = AssistantRequest(
        question=body.question,
        history=_history(session, astronaut),
        findings=findings,
        preferred_provider=body.provider,
    )
    reply = _assistant(request).answer(query)

    alert_id = None
    if reply.mode == "emergency" and reply.report and user.role == Role.ASTRONAUT:
        alert_id = _report_symptom(session, request, astronaut, reply, body.question, now)

    question = ChatMessage(
        id=str(uuid7(int(now.timestamp() * 1000))), astronaut_id=astronaut.id, user_id=user.user_id,
        role="user", text=body.question, created_at=now,
    )  # fmt: skip
    answer = ChatMessage(
        id=str(uuid7(int(now.timestamp() * 1000) + 1)),
        astronaut_id=astronaut.id,
        user_id=user.user_id,
        role="assistant",
        text=reply.answer,
        mode=reply.mode,
        provider=reply.provider,
        citations_json=json.dumps([c.model_dump(by_alias=True) for c in reply.citations]),
        suggested_actions_json=json.dumps(reply.suggested_actions),
        safety_flags_json=json.dumps(reply.safety_flags),
        emergency_protocol_id=reply.emergency_protocol_id,
        alert_id=alert_id,
        created_at=now + timedelta(milliseconds=1),
    )
    session.add(question)
    session.add(answer)
    session.add(
        AuditLog(
            user_id=user.user_id,
            action="AssistantChat",
            entity_type="ChatMessage",
            entity_id=answer.id,
            node_id=request.app.state.settings.node_id,
            details=json.dumps(  # the question text stays out of the audit log (privacy)
                {
                    "astronaut": astronaut.code,
                    "mode": reply.mode,
                    "provider": reply.provider,
                    "redFlag": reply.red_flag_id,
                    "alertId": alert_id,
                    "safetyFlags": reply.safety_flags,
                }
            ),  # fmt: skip
        )
    )
    session.commit()
    return ChatOut(
        message_id=answer.id,
        question_id=question.id,
        answer=reply.answer,
        citations=[CitationOut(chunk_id=c.chunk_id, title=c.title, source=c.source) for c in reply.citations],
        suggested_actions=reply.suggested_actions,
        safety_flags=reply.safety_flags,
        mode=reply.mode,
        provider=reply.provider,
        emergency_protocol_id=reply.emergency_protocol_id,
        alert_id=alert_id,
        created_at=answer.created_at,
    )


@router.get("/history", response_model=list[HistoryItem])
def history(
    request: Request,
    session: SessionDep,
    user: CurrentUser,
    astronaut_id: Annotated[str | None, Query(alias="astronautId")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[HistoryItem]:
    """Oldest first, the latest `limit` messages."""
    astronaut = _target(session, user, astronaut_id)
    rows = session.exec(
        select(ChatMessage)
        .where(ChatMessage.astronaut_id == astronaut.id)
        .order_by(col(ChatMessage.created_at).desc())
        .limit(limit)
    ).all()
    return [
        HistoryItem(
            id=r.id,
            role="user" if r.role == "user" else "assistant",
            text=r.text,
            mode=r.mode,
            provider=r.provider,
            citations=[CitationOut.model_validate(c) for c in json.loads(r.citations_json)],
            suggested_actions=json.loads(r.suggested_actions_json),
            emergency_protocol_id=r.emergency_protocol_id,
            alert_id=r.alert_id,
            created_at=r.created_at,
        )
        for r in reversed(rows)
    ]


@router.get("/status", response_model=AssistantStatus)
def assistant_status(request: Request, user: CurrentUser) -> AssistantStatus:
    assistant = _assistant(request)
    claude = assistant.provider_for("auto") == "claude"
    return AssistantStatus(
        default_provider="claude" if claude else "template",
        claude_configured=assistant.claude_configured,
        model=assistant.model if assistant.claude_configured else None,
        knowledge_notes=assistant.retriever.note_count,
        knowledge_chunks=len(assistant.retriever.chunks),
        red_flags=len(assistant.redflags.flags),
    )
