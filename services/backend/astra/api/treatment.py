"""Treatment at check-in and Act Now (Step 21; LLD §15.10).

- GET  /api/treatment/protocols                  — the critical protocols (for Help now) and the crew.
- POST /api/astronauts/{id}/treatment/assess     — the decision for this astronaut now (or for one
                                                   protocol the crew opened: Help now).
- POST /api/treatment/episodes                   — start an Act Now treatment (plan snapshot).
- POST /api/treatment/episodes/{id}/events       — log a step, an answer, a recheck, a dose, the end.
- GET  /api/treatment/episodes[?active=true]     — episodes the caller may see.
- GET  /api/treatment/episodes/{id}              — one episode with its log.
- POST /api/treatment/episodes/{id}/review       — the flight surgeon's review (usually on Earth).
- POST /api/treatment/protocols                  — the flight surgeon sends a corrected protocol (21f):
                                                   validated, signed with the sync key, synced; the
                                                   Habitat checks the signature and uses it for new
                                                   treatments only.

The decision is `core.treatment.assess` over the protocol files: no AI. Nothing here waits for Earth;
episodes and events are synced with urgent priority. Every dose given is also recorded as a
Medication Guide dose (Taken), so intervals, 24-hour limits and kit stock include it.

Access: the astronaut, the crew medical officer and the flight surgeon see an astronaut's episodes;
in an emergency any crewmate can open Help now for anyone and log steps of an active critical episode.
"""

import json
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import AwareDatetime, Field
from sqlmodel import Session, col, select

from astra.api.alerts import publish_alert_changes
from astra.api.base import ApiModel
from astra.api.medication import (
    CheckOut,
    is_cmo,
    load_profile,
    open_medicines,
    stock_left,
    taken_history,
)
from astra.core.alerts import ACTIVE_STATUSES
from astra.core.enums import MeasurementQuality, MeasurementSource, NodeRole, Role
from astra.core.medication import check_medicine
from astra.core.protocols import ProtocolBundle
from astra.core.symptoms import CHECKIN_SYMPTOMS
from astra.core.treatment import (
    Assessment,
    ProtocolPlan,
    Situation,
    StepPlan,
    TreatmentProtocol,
    Treatments,
    assess,
)
from astra.db.models import (
    Astronaut,
    HealthAlert,
    HealthMeasurement,
    MedicationDose,
    ProtocolUpdate,
    Symptom,
    SyncOutbox,
    TreatmentEpisode,
    TreatmentEvent,
    UserAccount,
)
from astra.db.session import SessionDep
from astra.realtime.hub import hub
from astra.security.deps import CurrentUser
from astra.security.jwt import TokenClaims
from astra.services.crew import find_astronaut
from astra.services.ingestion import IncomingReading, ingest_batch
from astra.sync.envelope import canonical, sign, verify

router = APIRouter(prefix="/api", tags=["treatment"])

TIER_WORD = {0: "Nothing to treat", 1: "Mild", 2: "Needs treatment", 3: "Critical: act now"}
VITALS_WINDOW = timedelta(hours=6)
SYMPTOMS_WINDOW = timedelta(hours=24)
END_KINDS = {"resolved": "Resolved", "escalated": "Escalated", "cancelled": "Cancelled"}


def _version(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def _protocol_problems(bundle: ProtocolBundle, protocol: TreatmentProtocol) -> list[str]:
    return protocol.problems(
        bundle.formulary, {r.id for r in bundle.rules}, set(bundle.emergency_protocols),
        {i.code for i in bundle.catalog.indicators}, set(CHECKIN_SYMPTOMS),
    )  # fmt: skip


def effective_treatments(session: Session, request: Request) -> tuple[Treatments, ProtocolBundle]:
    """The protocol files plus every protocol update from Earth that is signed with our sync key,
    valid against this node's files and newer than the file. Used for new decisions only."""
    bundle: ProtocolBundle = request.app.state.protocols
    if bundle.treatments is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No treatment protocols (protocols/treatments/)")
    protocols = dict(bundle.treatments.protocols)
    key = request.app.state.settings.sync_key
    for row in session.exec(select(ProtocolUpdate)).all():
        if not verify(key, row.protocol_json.encode(), row.signature):
            continue
        try:
            protocol = TreatmentProtocol.model_validate_json(row.protocol_json)
        except ValueError:
            continue
        current = protocols.get(protocol.id)
        if _protocol_problems(bundle, protocol) or (
            current and _version(protocol.version) <= _version(current.version)
        ):
            continue
        protocols[protocol.id] = protocol
    return Treatments(protocols, bundle.treatments.routine), bundle


def _name(session: Session, user: TokenClaims) -> str:
    account = session.get(UserAccount, user.user_id)
    return (account.display_name if account else "") or user.display_name or user.username


def _onboard(request: Request) -> None:
    if request.app.state.settings.node_role == NodeRole.GROUND:
        raise HTTPException(status.HTTP_409_CONFLICT, "Treatment happens onboard: use the Habitat node")


# --- the situation from the database ---------------------------------------------------------------


def treated_at(session: Session, astronaut: Astronaut) -> dict[str, datetime]:
    """When each protocol last finished for this astronaut (resolved or escalated, not cancelled)."""
    out: dict[str, datetime] = {}
    rows = session.exec(
        select(TreatmentEpisode).where(
            TreatmentEpisode.astronaut_id == astronaut.id,
            col(TreatmentEpisode.status).in_(["Resolved", "Escalated"]),
        )
    ).all()
    for row in rows:
        end = row.ended_at or row.updated_at
        for pid in json.loads(row.protocol_ids_json):
            out[pid] = max(out.get(pid, end), end)
    return out


def situation_for(
    session: Session,
    bundle: ProtocolBundle,
    astronaut: Astronaut,
    now: datetime,
    treatments: Treatments | None = None,
    checkin_id: str | None = None,
) -> Situation:
    """Active alerts, symptoms of the last 24 h (highest severity), the latest readings of the last 6 h
    (a doubtful one counts, marked for re-measuring), the medical profile, doses taken, kit stock.

    Evidence already treated is left out: an alert, symptom or reading from before a finished
    treatment of a protocol it triggers does not open that protocol again (Urgent alerts stay open
    until the flight surgeon closes them; the check-in after a treatment must not restart it).
    At check-in, the symptoms are the ones answered in that check-in: "no symptoms today" wins over an
    earlier report (which already showed its emergency procedure)."""
    done = treated_at(session, astronaut)

    def treated(kind: str, key: str, at: datetime) -> bool:
        if treatments is None:
            return False
        for p in treatments.protocols.values():
            t = p.triggers
            uses = (
                (kind == "rule" and key in t.rules)
                or (kind == "symptom" and any(x.code == key for x in t.symptoms))
                or (kind == "vital" and any(v.indicator == key for v in t.vitals))
            )
            # strictly before the end, at whole seconds (check-in times are stored to the second)
            if uses and p.id in done and at < done[p.id].replace(microsecond=0):
                return True
        return False

    alerts = session.exec(
        select(HealthAlert).where(
            HealthAlert.astronaut_id == astronaut.id,
            col(HealthAlert.status).in_([s.value for s in ACTIVE_STATUSES]),
        )
    ).all()
    symptoms: dict[str, int] = {}
    for sym in session.exec(
        select(Symptom).where(
            Symptom.astronaut_id == astronaut.id, col(Symptom.onset_at) >= now - SYMPTOMS_WINDOW
        )
    ).all():
        if treated("symptom", sym.symptom_code, sym.onset_at):
            continue
        if checkin_id is not None and not sym.id.startswith(f"{checkin_id}-"):
            continue
        symptoms[sym.symptom_code] = max(symptoms.get(sym.symptom_code, 0), sym.severity or 1)
    vitals: dict[str, float] = {}
    questionable: set[str] = set()
    rows = session.exec(
        select(HealthMeasurement)
        .where(
            HealthMeasurement.astronaut_id == astronaut.id,
            col(HealthMeasurement.measured_at) >= now - VITALS_WINDOW,
            col(HealthMeasurement.quality).in_(
                [MeasurementQuality.VALID.value, MeasurementQuality.QUESTIONABLE.value]
            ),
        )
        .order_by(col(HealthMeasurement.measured_at).desc())
    ).all()
    for m in rows:
        if m.indicator_code in vitals or m.value is None or treated("vital", m.indicator_code, m.measured_at):
            continue
        vitals[m.indicator_code] = m.value
        if m.quality == MeasurementQuality.QUESTIONABLE.value:
            questionable.add(m.indicator_code)
    stock = stock_left(session, bundle.formulary) if bundle.formulary else {}
    return Situation(
        rules=frozenset(a.rule_id for a in alerts if not treated("rule", a.rule_id, a.last_triggered_at)),
        symptoms=symptoms,
        vitals=vitals,
        questionable=frozenset(questionable),
        profile=load_profile(session, astronaut),
        history=tuple(taken_history(session, astronaut.id, now)),
        stock=stock,
        pending=tuple(open_medicines(session, astronaut.id)),
        now=now,
    )


# --- output -------------------------------------------------------------------------------------------


class PickOut(ApiModel):
    medicine_id: str
    name: str
    strength: str
    units: int
    dose_text: str
    route: str
    appearance: str | None
    how: str
    kit_location: str
    rx_only: bool
    status: Literal["ok", "caution"]
    checks: list[CheckOut]


class RejectedOut(ApiModel):
    medicine_id: str
    name: str
    codes: list[str]
    reasons: list[str]


class StepOut(ApiModel):
    id: str
    kind: Literal["action", "medicine", "question", "recheck", "measure"]
    text: str
    detail: str | None
    given_by: Literal["self", "crewmate", "any"]
    emergency: str | None
    question: str | None
    yes: str | None
    no: str | None
    after_minutes: float | None
    indicator: str | None
    op: str | None
    value: float | None
    passed: str | None
    failed: str | None
    max_repeats: int | None
    failed_after_max: str | None
    if_none: str | None
    next: str  # resolved: the following step, "done" or "escalate" (questions and rechecks branch instead)
    pick: PickOut | None
    rejected: list[RejectedOut]
    withheld: str | None


class ProtocolPlanOut(ApiModel):
    id: str
    version: str
    title: str
    plain: str
    priority: int
    matched_by: list[str]
    remeasure: list[str]
    act_first: bool
    emergency_protocol: str | None
    escalation: str
    follow_up_hours: float
    do_not_give: list[str]
    approval_status: Literal["demo", "approved"]
    steps: list[StepOut]


class RoutineOut(ApiModel):
    condition: str
    title: str
    tier: Literal[1, 2]
    matched_by: list[str]


class AssessmentOut(ApiModel):
    astronaut_code: str
    tier: int
    tier_word: str
    critical: list[ProtocolPlanOut]
    routine: list[RoutineOut]
    generated_at: datetime


def _step_out(plan: ProtocolPlan, sp: StepPlan) -> StepOut:
    s, p = sp.step, sp.pick
    return StepOut(
        id=s.id, kind=s.kind, text=s.text, detail=s.detail, given_by=s.given_by, emergency=s.emergency,
        question=s.question, yes=s.yes, no=s.no, after_minutes=s.after_minutes, indicator=s.indicator,
        op=s.op,
        value=s.value, passed=s.passed, failed=s.failed, max_repeats=s.max_repeats,
        failed_after_max=s.failed_after_max, if_none=s.if_none, next=plan.protocol.next_of(s),
        pick=PickOut(
            medicine_id=p.medicine.id, name=p.medicine.name, strength=p.medicine.strength, units=p.units,
            dose_text=p.dose_text, route=p.medicine.route, appearance=p.medicine.appearance,
            how=p.medicine.how,
            kit_location=p.medicine.kit_location, rx_only=p.medicine.rx_only, status=p.status,
            checks=[CheckOut(level=c.level, code=c.code, text=c.text) for c in p.checks],
        ) if p else None,
        rejected=[
            RejectedOut(medicine_id=r.medicine_id, name=r.name, codes=list(r.codes), reasons=list(r.reasons))
            for r in sp.rejected
        ],
        withheld=sp.withheld,
    )  # fmt: skip


def assessment_out(astronaut: Astronaut, a: Assessment, now: datetime) -> AssessmentOut:
    return AssessmentOut(
        astronaut_code=astronaut.code, tier=a.tier, tier_word=TIER_WORD[a.tier], generated_at=now,
        critical=[
            ProtocolPlanOut(
                id=p.protocol.id, version=p.protocol.version, title=p.protocol.title, plain=p.protocol.plain,
                priority=p.protocol.priority, matched_by=list(p.matched_by), remeasure=list(p.remeasure),
                act_first=p.protocol.act_first, emergency_protocol=p.protocol.emergency_protocol,
                escalation=p.protocol.escalation, follow_up_hours=p.protocol.follow_up_hours,
                do_not_give=list(p.do_not_give), approval_status=p.protocol.approval.status,
                steps=[_step_out(p, s) for s in p.steps],
            )
            for p in a.critical
        ],
        routine=[RoutineOut(condition=r.condition, title=r.title, tier=r.tier, matched_by=list(r.matched_by))
                 for r in a.routine],
    )  # fmt: skip


def assess_astronaut(
    session: Session,
    request: Request,
    astronaut: Astronaut,
    *,
    chosen: str | None = None,
    checkin_id: str | None = None,
) -> AssessmentOut:
    treatments, bundle = effective_treatments(session, request)
    now = datetime.now(UTC)
    a = assess(
        treatments,
        bundle.formulary,
        situation_for(session, bundle, astronaut, now, treatments, checkin_id),
        chosen=chosen,
    )
    return assessment_out(astronaut, a, now)


# --- protocols and assessment --------------------------------------------------------------------------


class ProtocolSummary(ApiModel):
    id: str
    title: str
    plain: str
    priority: int
    version: str
    approval_status: Literal["demo", "approved"]


class CrewMember(ApiModel):
    code: str
    name: str


class ProtocolsOut(ApiModel):
    protocols: list[ProtocolSummary]
    crew: list[CrewMember]
    disclaimer: str
    # the protocols in use (files + signed updates from Earth): devices keep them for server-down use
    files: list[dict[str, Any]] = []


@router.get("/treatment/protocols", response_model=ProtocolsOut)
def get_protocols(request: Request, session: SessionDep, user: CurrentUser) -> ProtocolsOut:
    treatments, _ = effective_treatments(session, request)
    crew = session.exec(select(Astronaut).order_by(col(Astronaut.code))).all()
    return ProtocolsOut(
        protocols=[
            ProtocolSummary(
                id=p.id,
                title=p.title,
                plain=p.plain,
                priority=p.priority,
                version=p.version,
                approval_status=p.approval.status,
            )  # fmt: skip
            for p in sorted(treatments.protocols.values(), key=lambda p: (p.priority, p.title))
        ],
        crew=[CrewMember(code=a.code, name=a.display_name) for a in crew],
        files=[p.model_dump(by_alias=True, mode="json") for p in treatments.protocols.values()],
        disclaimer=(
            "DEMO protocols: steps and doses come from public labels and first-aid guidance and have "
            "NOT been "
            "approved by a flight surgeon. A mission replaces protocols/treatments/ with approved protocols."
        ),
    )


class AssessIn(ApiModel):
    protocol_id: str | None = Field(default=None, description="Help now: the protocol the crew opened")


def _astronaut_for(session: Session, user: TokenClaims, code: str, *, emergency: bool) -> Astronaut:
    found = find_astronaut(session, code)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Astronaut '{code}' not found")
    allowed = (
        user.role == Role.FLIGHT_SURGEON
        or (user.role == Role.ASTRONAUT and user.astronaut_id == found.id)
        or is_cmo(session, user)
        or (emergency and user.role == Role.ASTRONAUT)  # any crewmate helps in an emergency
    )
    if not allowed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the astronaut, the CMO and the flight surgeon see this"
        )
    return found


@router.post("/astronauts/{astronaut}/treatment/assess", response_model=AssessmentOut)
def post_assess(
    astronaut: str, body: AssessIn, request: Request, session: SessionDep, user: CurrentUser
) -> AssessmentOut:
    treatments, _ = effective_treatments(session, request)
    if body.protocol_id and body.protocol_id not in treatments.protocols:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown protocol '{body.protocol_id}'")
    found = _astronaut_for(session, user, astronaut, emergency=bool(body.protocol_id))
    return assess_astronaut(session, request, found, chosen=body.protocol_id)


# --- episodes -----------------------------------------------------------------------------------------


class EventOut(ApiModel):
    id: str
    at: datetime
    device_time: bool
    kind: str
    protocol_id: str | None
    step_id: str | None
    data: dict[str, Any]
    by_name: str
    flags: list[str]


class EpisodeOut(ApiModel):
    id: str
    astronaut_code: str
    astronaut_name: str
    protocol_ids: list[str]
    title: str
    tier: int
    source: str
    status: Literal["Active", "Resolved", "Escalated", "Cancelled"]
    started_at: datetime
    started_by: str
    ended_at: datetime | None
    outcome_note: str | None
    reviewed_at: datetime | None
    reviewed_by: str | None
    review_note: str | None
    plan: dict[str, Any]
    events: list[EventOut]


def _event_out(e: TreatmentEvent) -> EventOut:
    return EventOut(id=e.id, at=e.at, device_time=e.device_time, kind=e.kind, protocol_id=e.protocol_id,
                    step_id=e.step_id, data=json.loads(e.data_json), by_name=e.by_name,
                    flags=json.loads(e.flags_json))  # fmt: skip


def episode_out(session: Session, row: TreatmentEpisode, *, with_plan: bool = True) -> EpisodeOut:
    who = session.get(Astronaut, row.astronaut_id)
    events = session.exec(
        select(TreatmentEvent).where(TreatmentEvent.episode_id == row.id).order_by(col(TreatmentEvent.at))
    ).all()
    return EpisodeOut(
        id=row.id, astronaut_code=who.code if who else "?", astronaut_name=who.display_name if who else "?",
        protocol_ids=json.loads(row.protocol_ids_json), title=row.title, tier=row.tier, source=row.source,
        status=row.status, started_at=row.started_at, started_by=row.started_by,  # type: ignore[arg-type]
        ended_at=row.ended_at, outcome_note=row.outcome_note, reviewed_at=row.reviewed_at,
        reviewed_by=row.reviewed_by, review_note=row.review_note,
        plan=json.loads(row.plan_json) if with_plan else {}, events=[_event_out(e) for e in events],
    )  # fmt: skip


def _sync_episode(session: Session, row: TreatmentEpisode) -> None:
    row.updated_at = datetime.now(UTC)
    session.add(row)
    payload = row.model_dump_json()
    session.add(SyncOutbox(entity_type="TreatmentEpisode", entity_id=row.id, payload_json=payload,
                           priority=1 if row.tier >= 3 else 2))  # fmt: skip


class EpisodeIn(ApiModel):
    id: str = Field(
        min_length=8, max_length=64, pattern=r"^[A-Za-z0-9-]+$", description="Device id (idempotent)"
    )
    astronaut_code: str
    protocol_ids: list[str] = Field(min_length=1, max_length=10)
    tier: int = Field(ge=1, le=3)
    source: Literal["checkin", "help-now", "device"]
    plan: dict[str, Any] = Field(description="The plan exactly as shown to the crew")
    started_at: AwareDatetime | None = None


def _can_see_episode(session: Session, user: TokenClaims, row: TreatmentEpisode) -> bool:
    return (
        user.role == Role.FLIGHT_SURGEON
        or is_cmo(session, user)
        or (user.role == Role.ASTRONAUT and user.astronaut_id == row.astronaut_id)
        or (user.role == Role.ASTRONAUT and row.status == "Active" and row.tier >= 3)
    )


@router.post("/treatment/episodes", response_model=EpisodeOut, status_code=status.HTTP_201_CREATED)
def post_episode(body: EpisodeIn, request: Request, session: SessionDep, user: CurrentUser) -> EpisodeOut:
    _onboard(request)
    if user.role != Role.ASTRONAUT:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Treatments are started by the crew")
    treatments, _ = effective_treatments(session, request)
    astronaut = _astronaut_for(session, user, body.astronaut_code, emergency=body.tier >= 3)
    existing = session.get(TreatmentEpisode, body.id)
    if existing is not None:  # sent again (offline outbox, lost reply)
        return episode_out(session, existing)
    unknown = [p for p in body.protocol_ids if p not in treatments.protocols]
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown protocol: {', '.join(unknown)}")
    now = datetime.now(UTC)
    row = TreatmentEpisode(
        id=body.id, astronaut_id=astronaut.id, protocol_ids_json=json.dumps(body.protocol_ids),
        title=" + ".join(treatments.protocols[p].title for p in body.protocol_ids), tier=body.tier,
        source=body.source, plan_json=json.dumps(body.plan),
        started_at=min(body.started_at.astimezone(UTC), now) if body.started_at else now,
        started_by=_name(session, user), node_id=request.app.state.settings.node_id,
    )  # fmt: skip
    _sync_episode(session, row)
    session.commit()
    hub.publish_from_thread(["all"], "TreatmentStarted", {
        "episodeId": row.id, "astronautCode": astronaut.code, "astronautName": astronaut.display_name,
        "title": row.title, "tier": row.tier,
    })  # fmt: skip
    return episode_out(session, row)


class EventIn(ApiModel):
    id: str = Field(
        min_length=8, max_length=64, pattern=r"^[A-Za-z0-9-]+$", description="Device id (idempotent)"
    )
    kind: Literal[
        "step_done", "step_skipped", "answer", "recheck", "dose_given", "note", "resolved", "escalated",
        "cancelled",
    ]  # fmt: skip
    protocol_id: str | None = None
    step_id: str | None = None
    at: AwareDatetime | None = None
    device_time: bool = False
    by_name: str | None = Field(
        default=None, max_length=80, description="Who did it (default: the signed-in user)"
    )
    data: dict[str, Any] = Field(default_factory=dict)


def _dose_flags(session: Session, bundle: ProtocolBundle, astronaut: Astronaut, data: dict[str, Any],
                at: datetime, override: list[str]) -> tuple[list[str], dict[str, Any] | None]:  # fmt: skip
    """A dose is a fact once given: it is always recorded. Checks that would have blocked it at that time
    are kept as flags for the CMO and the flight surgeon (e.g. given twice by two crewmates)."""
    formulary = bundle.formulary
    med = formulary.medicine(str(data.get("medicineId", ""))) if formulary else None
    if formulary is None or med is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "dose_given needs a known medicineId")
    units = int(data.get("units") or 0)
    if not 1 <= units <= med.max_per_dose:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"units must be 1 to {med.max_per_dose}")
    history = [d for d in taken_history(session, astronaut.id, at) if d.at < at]
    checks, _ = check_medicine(
        formulary, med, units, load_profile(session, astronaut), history,
        stock_left=stock_left(session, formulary)[med.id], now=at,
    )  # fmt: skip
    flags = [c.text for c in checks if c.level == "block" and c.code not in override]
    return flags, {"medicine": med, "units": units}


ACT_NOW_DEVICE = "ACT-NOW"  # device id of readings measured during a treatment


def _reading(bundle: ProtocolBundle, body: "EventIn", at: datetime) -> IncomingReading | None:
    indicator, value = body.data.get("indicator"), body.data.get("value")
    if (
        body.kind not in ("recheck", "step_done")
        or not isinstance(indicator, str)
        or indicator not in bundle.catalog
    ):
        return None
    if not isinstance(value, int | float) or isinstance(value, bool):
        return None
    unit = bundle.catalog.get(indicator).unit
    return IncomingReading(
        id=f"{body.id}-r", indicator=indicator, value=float(value), unit=unit, measured_at=at,
        source=MeasurementSource.MANUAL.value, device_id=ACT_NOW_DEVICE,
    )  # fmt: skip


def _dose_record(
    request: Request, bundle: ProtocolBundle, astronaut: Astronaut, body: "EventIn", title: str | None,
    dose: dict[str, Any], flags: list[str], at: datetime, by: str,
) -> MedicationDose:  # fmt: skip
    """The same dose as a Medication Guide record (Taken), so intervals, limits and stock include it."""
    med = dose["medicine"]
    read_back = str(body.data.get("readBackBy") or "").strip() or None
    row = MedicationDose(
        id=f"tx-{body.id}", astronaut_id=astronaut.id, condition_id=body.protocol_id or "treatment",
        medicine_id=med.id, units=dose["units"], dose_text=med.dose_text(dose["units"]),
        when_text=f"Act Now: {title or 'treatment'}",
        formulary_version=bundle.formulary.version if bundle.formulary else "",
        answers_json="{}",
        checks_json=json.dumps([{"level": "block", "code": "flag", "text": f} for f in flags]),
        status="Taken", requested_at=at, confirmed_at=at, confirmed_by=read_back or by, taken_at=at,
        self_confirmed=read_back is None,
        self_confirm_reason=None if read_back else "Act Now: given without a second person checking the dose",
        node_id=request.app.state.settings.node_id,
    )  # fmt: skip
    return row


@router.post("/treatment/episodes/{episode_id}/events", response_model=EpisodeOut)
def post_event(
    episode_id: str, body: EventIn, request: Request, session: SessionDep, user: CurrentUser
) -> EpisodeOut:
    _onboard(request)
    row = session.get(TreatmentEpisode, episode_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Treatment not found")
    if user.role != Role.ASTRONAUT or not _can_see_episode(session, user, row):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the crew logs treatment steps")
    if session.get(TreatmentEvent, body.id) is not None:  # sent again
        return episode_out(session, row)
    treatments, bundle = effective_treatments(session, request)
    astronaut = session.get(Astronaut, row.astronaut_id)
    assert astronaut is not None
    now = datetime.now(UTC)
    at = min(body.at.astimezone(UTC), now) if body.at else now
    by = (body.by_name or "").strip() or _name(session, user)
    flags: list[str] = []
    if body.kind == "dose_given":
        protocol = treatments.protocols.get(body.protocol_id or "")
        step = protocol.step(body.step_id or "") if protocol else None
        flags, dose = _dose_flags(session, bundle, astronaut, body.data, at, step.override if step else [])
        assert dose is not None
        record = _dose_record(request, bundle, astronaut, body, protocol.title if protocol else None,
                              dose, flags, at, by)  # fmt: skip
        session.add(record)
        session.add(SyncOutbox(entity_type="MedicationDose", entity_id=record.id,
                               payload_json=record.model_dump_json(), priority=1))  # fmt: skip
    event = TreatmentEvent(
        id=body.id, episode_id=row.id, at=at, device_time=body.device_time, kind=body.kind,
        protocol_id=body.protocol_id, step_id=body.step_id, data_json=json.dumps(body.data), by_name=by,
        flags_json=json.dumps(flags), node_id=request.app.state.settings.node_id,
    )  # fmt: skip
    session.add(event)
    payload = event.model_dump_json()
    session.add(SyncOutbox(entity_type="TreatmentEvent", entity_id=event.id, payload_json=payload,
                           priority=1 if row.tier >= 3 else 2))  # fmt: skip
    reading = _reading(bundle, body, at)
    if reading is not None:  # a recheck or a measurement: also a reading in the health record
        node = request.app.state.settings.node_id
        outcome = ingest_batch(session, bundle, astronaut, [reading], node_id=node, user_id=user.user_id)
        publish_alert_changes(outcome.alerts, astronaut)
    if body.kind in END_KINDS and row.status == "Active":
        row.status, row.ended_at = END_KINDS[body.kind], at
        row.outcome_note = str(body.data.get("note") or "") or None
        _sync_episode(session, row)
    session.commit()
    hub.publish_from_thread(["all"], "TreatmentUpdated", {
        "episodeId": row.id, "astronautCode": astronaut.code, "status": row.status, "kind": body.kind,
    })  # fmt: skip
    return episode_out(session, row)


@router.get("/treatment/episodes", response_model=list[EpisodeOut])
def get_episodes(
    request: Request,
    session: SessionDep,
    user: CurrentUser,
    active: bool = False,
    astronaut: str | None = None,
    limit: int = Query(default=30, ge=1, le=100),
) -> list[EpisodeOut]:
    query = select(TreatmentEpisode).order_by(col(TreatmentEpisode.started_at).desc())
    if active:
        query = query.where(TreatmentEpisode.status == "Active")
    if astronaut:
        found = find_astronaut(session, astronaut)
        if found is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Astronaut '{astronaut}' not found")
        query = query.where(TreatmentEpisode.astronaut_id == found.id)
    rows = [r for r in session.exec(query.limit(limit * 3)).all() if _can_see_episode(session, user, r)]
    return [episode_out(session, r) for r in rows[:limit]]


@router.get("/treatment/episodes/{episode_id}", response_model=EpisodeOut)
def get_episode(episode_id: str, session: SessionDep, user: CurrentUser) -> EpisodeOut:
    row = session.get(TreatmentEpisode, episode_id)
    if row is None or not _can_see_episode(session, user, row):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Treatment not found")
    return episode_out(session, row)


class EpisodeReviewIn(ApiModel):
    note: str = Field(default="", max_length=1000)


@router.post("/treatment/episodes/{episode_id}/review", response_model=EpisodeOut)
def review_episode(
    episode_id: str, body: EpisodeReviewIn, session: SessionDep, user: CurrentUser
) -> EpisodeOut:
    if user.role != Role.FLIGHT_SURGEON:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the flight surgeon reviews treatments")
    row = session.get(TreatmentEpisode, episode_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Treatment not found")
    if row.reviewed_at is None:
        row.reviewed_at, row.reviewed_by = datetime.now(UTC), _name(session, user)
        row.review_note = body.note.strip() or None
        _sync_episode(session, row)
        session.commit()
        hub.publish_from_thread(["all"], "TreatmentUpdated", {"episodeId": row.id, "status": row.status})
    return episode_out(session, row)


# --- protocol updates from Earth (21f) ---------------------------------------------------------------


class ProtocolUploadIn(ApiModel):
    protocol: dict[str, Any] = Field(description="A complete treatment protocol (the TX-*.json format)")


class ProtocolUploadOut(ApiModel):
    id: str
    version: str
    title: str
    signed: bool
    sent_by: str


@router.post("/treatment/protocols", response_model=ProtocolUploadOut, status_code=status.HTTP_201_CREATED)
def upload_protocol(
    body: ProtocolUploadIn, request: Request, session: SessionDep, user: CurrentUser
) -> ProtocolUploadOut:
    if user.role != Role.FLIGHT_SURGEON:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the flight surgeon updates treatment protocols")
    treatments, bundle = effective_treatments(session, request)
    try:
        protocol = TreatmentProtocol.model_validate(body.protocol)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Not a valid protocol: {exc}") from None
    problems = _protocol_problems(bundle, protocol)
    if problems:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Protocol problems: " + "; ".join(problems)
        )
    current = treatments.protocols.get(protocol.id)
    if current and _version(protocol.version) <= _version(current.version):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Version must be newer than {current.version}")
    text = canonical(protocol.model_dump(by_alias=True, mode="json")).decode()
    row = ProtocolUpdate(
        id=f"{protocol.id}@{protocol.version}", protocol_id=protocol.id, version=protocol.version,
        protocol_json=text, signature=sign(request.app.state.settings.sync_key, text.encode()),
        uploaded_by=_name(session, user), node_id=request.app.state.settings.node_id,
    )  # fmt: skip
    session.add(row)
    session.add(SyncOutbox(entity_type="ProtocolUpdate", entity_id=row.id, payload_json=row.model_dump_json(),
                           priority=1))  # fmt: skip
    session.commit()
    hub.publish_from_thread(["all"], "ProtocolUpdated", {"id": protocol.id, "version": protocol.version})
    return ProtocolUploadOut(id=protocol.id, version=protocol.version, title=protocol.title, signed=True,
                             sent_by=row.uploaded_by)  # fmt: skip
