"""Medication Guide (Step 20; LLD §15.9).

- GET  /api/medication/formulary                     — conditions, kit medicines (stock, expiry), vocabulary.
- GET  /api/astronauts/{id}/medical-profile          — allergies, conditions, regular medicines.
- PUT  /api/astronauts/{id}/medical-profile          — the CMO or the flight surgeon edits it.
- POST /api/astronauts/{id}/medication/advice        — safety questions answered → the safe options.
- GET  /api/astronauts/{id}/medication/doses         — this astronaut's doses, newest first.
- GET  /api/medication/doses                         — every crew dose (CMO and flight surgeon).
- POST /api/medication/doses                         — the astronaut asks for a dose (or confirms alone).
- POST /api/medication/doses/{id}/confirm            — the CMO confirms or declines.
- POST /api/medication/doses/{id}/taken | cancel | outcome — the astronaut.
- POST /api/medication/doses/{id}/review             — the flight surgeon's review (usually on the ground).

The medicine and the dose always come from protocols/medications.json; every request is checked
again on the server (allergy, conditions, interactions, interval, 24-hour limit, days, stock) at
request, confirmation and intake time. Doses and profiles sync to the other node.
"""

import json
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import AwareDatetime, Field
from sqlalchemy import func
from sqlmodel import Session, col, select

from astra.api.base import ApiModel
from astra.core.enums import NodeRole, Role
from astra.core.medication import (
    Check,
    Formulary,
    Medicine,
    Profile,
    TakenDose,
    advise,
    check_medicine,
)
from astra.db.models import Astronaut, MedicalProfile, MedicationDose, SyncOutbox, UserAccount
from astra.db.session import SessionDep
from astra.realtime.hub import hub
from astra.security.deps import CurrentUser
from astra.security.jwt import TokenClaims
from astra.services.crew import find_astronaut

router = APIRouter(prefix="/api", tags=["medication guide"])

CMO_TITLE = "Crew Medical Officer"
OPEN_STATUSES = ("Requested", "Confirmed")


# --- access -------------------------------------------------------------------------------------


def _formulary(request: Request) -> Formulary:
    formulary: Formulary | None = request.app.state.protocols.formulary
    if formulary is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No medicine list (protocols/medications.json)")
    return formulary


def is_cmo(session: Session, user: TokenClaims) -> bool:
    if user.role != Role.ASTRONAUT or not user.astronaut_id:
        return False
    me = session.get(Astronaut, user.astronaut_id)
    return me is not None and me.role_title == CMO_TITLE


def _can_see(session: Session, user: TokenClaims, astronaut: Astronaut) -> bool:
    """The astronaut themself, the crew medical officer, the flight surgeon."""
    return (
        user.role == Role.FLIGHT_SURGEON
        or (user.role == Role.ASTRONAUT and user.astronaut_id == astronaut.id)
        or is_cmo(session, user)
    )


def _astronaut(session: Session, user: TokenClaims, code: str) -> Astronaut:
    found = find_astronaut(session, code)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Astronaut '{code}' not found")
    if not _can_see(session, user, found):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only you, the CMO and the flight surgeon see this")
    return found


def _onboard(request: Request) -> None:
    if request.app.state.settings.node_role == NodeRole.GROUND:
        raise HTTPException(status.HTTP_409_CONFLICT, "Medicines are given onboard: use the Habitat node")


def _name(session: Session, user: TokenClaims) -> str:
    account = session.get(UserAccount, user.user_id)
    return (account.display_name if account else "") or user.display_name or user.username


# --- formulary ----------------------------------------------------------------------------------


class RedFlagOut(ApiModel):
    id: str
    question: str
    action: Literal["emergency", "cmo"]
    protocol: str | None


class OptionRefOut(ApiModel):
    medicine: str
    when: str


class ConditionOut(ApiModel):
    id: str
    title: str
    plain: str
    red_flags: list[RedFlagOut]
    non_drug: list[str]
    options: list[OptionRefOut]
    follow_up_hours: float


class MedicineOut(ApiModel):
    id: str
    name: str
    form: str
    strength: str
    how: str
    kit_location: str
    stock_units: int
    stock_left: int
    expires: str
    expired: bool
    drowsy: bool
    max_units_per_day: int
    min_interval_hours: float
    max_days: int | None
    cautions: list[str]
    source: str
    source_url: str


class VocabularyOut(ApiModel):
    allergies: dict[str, str]
    conditions: dict[str, str]
    regular_medicines: dict[str, str]


class FormularyOut(ApiModel):
    version: str
    status: Literal["demo", "approved"]
    approved_by: str | None
    disclaimer: str
    vocabulary: VocabularyOut
    medicines: list[MedicineOut]
    conditions: list[ConditionOut]
    viewer_is_cmo: bool  # the signed-in astronaut is the crew medical officer (confirms the crew's doses)


def stock_left(session: Session, formulary: Formulary) -> dict[str, int]:
    used = dict(
        session.exec(
            select(MedicationDose.medicine_id, func.sum(MedicationDose.units))
            .where(MedicationDose.status == "Taken")
            .group_by(col(MedicationDose.medicine_id))
        ).all()
    )
    return {m.id: max(0, m.stock_units - int(used.get(m.id) or 0)) for m in formulary.medicines}


@router.get("/medication/formulary", response_model=FormularyOut)
def get_formulary(request: Request, session: SessionDep, user: CurrentUser) -> FormularyOut:
    formulary = _formulary(request)
    stock = stock_left(session, formulary)
    today = datetime.now(UTC).date()
    return FormularyOut(
        viewer_is_cmo=is_cmo(session, user),
        version=formulary.version,
        status=formulary.status,
        approved_by=formulary.approved_by,
        disclaimer=formulary.disclaimer,
        vocabulary=VocabularyOut(**formulary.vocabulary.model_dump()),
        medicines=[
            MedicineOut(
                id=m.id,
                name=m.name,
                form=m.form,
                strength=m.strength,
                how=m.how,
                kit_location=m.kit_location,
                stock_units=m.stock_units,
                stock_left=stock[m.id],
                expires=m.expires,
                expired=m.expired(today),
                drowsy=m.drowsy,
                max_units_per_day=m.max_units_per_24h,
                min_interval_hours=m.min_interval_hours,
                max_days=m.max_days,
                cautions=m.cautions,
                source=m.source,
                source_url=m.source_url,
            )  # fmt: skip
            for m in formulary.medicines
        ],
        conditions=[
            ConditionOut(
                id=c.id,
                title=c.title,
                plain=c.plain,
                red_flags=[
                    RedFlagOut(id=f.id, question=f.question, action=f.action, protocol=f.protocol)
                    for f in c.red_flags
                ],
                non_drug=c.non_drug,
                options=[OptionRefOut(medicine=o.medicine, when=o.when) for o in c.options],
                follow_up_hours=c.follow_up_hours,
            )  # fmt: skip
            for c in formulary.conditions
        ],
    )


# --- medical profile ----------------------------------------------------------------------------


class MedicalProfileOut(ApiModel):
    astronaut_code: str
    allergies: list[str]
    conditions: list[str]
    regular_medicines: list[str]
    note: str
    updated_at: datetime | None
    updated_by: str | None
    can_edit: bool


class MedicalProfileIn(ApiModel):
    allergies: list[str] = Field(default_factory=list, max_length=20)
    conditions: list[str] = Field(default_factory=list, max_length=20)
    regular_medicines: list[str] = Field(default_factory=list, max_length=20)
    note: str = Field(default="", max_length=500)


def load_profile(session: Session, astronaut: Astronaut) -> Profile:
    row = session.get(MedicalProfile, astronaut.id)
    if row is None:
        return Profile()
    return Profile(
        frozenset(json.loads(row.allergies_json)),
        frozenset(json.loads(row.conditions_json)),
        frozenset(json.loads(row.medicines_json)),
    )


def _profile_out(session: Session, user: TokenClaims, astronaut: Astronaut) -> MedicalProfileOut:
    row = session.get(MedicalProfile, astronaut.id)
    can_edit = user.role == Role.FLIGHT_SURGEON or is_cmo(session, user)
    if row is None:
        return MedicalProfileOut(
            astronaut_code=astronaut.code, allergies=[], conditions=[], regular_medicines=[],
            note="", updated_at=None, updated_by=None, can_edit=can_edit,
        )  # fmt: skip
    return MedicalProfileOut(
        astronaut_code=astronaut.code,
        allergies=json.loads(row.allergies_json),
        conditions=json.loads(row.conditions_json),
        regular_medicines=json.loads(row.medicines_json),
        note=row.note,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
        can_edit=can_edit,
    )


@router.get("/astronauts/{astronaut}/medical-profile", response_model=MedicalProfileOut)
def get_medical_profile(astronaut: str, session: SessionDep, user: CurrentUser) -> MedicalProfileOut:
    return _profile_out(session, user, _astronaut(session, user, astronaut))


@router.put("/astronauts/{astronaut}/medical-profile", response_model=MedicalProfileOut)
def put_medical_profile(
    astronaut: str, body: MedicalProfileIn, request: Request, session: SessionDep, user: CurrentUser
) -> MedicalProfileOut:
    found = _astronaut(session, user, astronaut)
    if not (user.role == Role.FLIGHT_SURGEON or is_cmo(session, user)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the CMO or the flight surgeon edits this")
    vocab = _formulary(request).vocabulary
    unknown = (
        [a for a in body.allergies if a not in vocab.allergies]
        + [c for c in body.conditions if c not in vocab.conditions]
        + [m for m in body.regular_medicines if m not in vocab.regular_medicines]
    )
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown code: {', '.join(unknown)}")
    row = session.get(MedicalProfile, found.id) or MedicalProfile(astronaut_id=found.id)
    row.allergies_json = json.dumps(sorted(set(body.allergies)))
    row.conditions_json = json.dumps(sorted(set(body.conditions)))
    row.medicines_json = json.dumps(sorted(set(body.regular_medicines)))
    row.note = body.note.strip()
    row.updated_at, row.updated_by = datetime.now(UTC), _name(session, user)
    session.add(row)
    session.add(SyncOutbox(entity_type="MedicalProfile", entity_id=found.id,
                           payload_json=row.model_dump_json(), priority=3))  # fmt: skip
    session.commit()
    hub.publish_from_thread(["all"], "MedicalProfileUpdated", {"astronautCode": found.code})
    return _profile_out(session, user, found)


# --- advice -------------------------------------------------------------------------------------


class CheckOut(ApiModel):
    level: Literal["block", "caution"]
    code: str
    text: str


class OptionOut(ApiModel):
    medicine_id: str
    name: str
    strength: str
    units: int
    dose_text: str
    when: str
    how: str
    kit_location: str
    status: Literal["ok", "caution", "blocked"]
    checks: list[CheckOut]
    next_allowed_at: datetime | None
    cautions: list[str]
    source: str
    source_url: str


class StopOut(ApiModel):
    action: Literal["emergency", "cmo"]
    protocol: str | None
    question: str


class AdviceOut(ApiModel):
    condition_id: str
    title: str
    stop: StopOut | None
    non_drug: list[str]
    options: list[OptionOut]
    recommended: str | None
    follow_up_hours: float
    formulary_version: str
    formulary_status: Literal["demo", "approved"]
    disclaimer: str


class AdviceIn(ApiModel):
    condition_id: str
    answers: dict[str, bool] = Field(description="Every safety question of the condition: true = yes")


def _history(session: Session, astronaut_id: str, now: datetime) -> list[TakenDose]:
    rows = session.exec(
        select(MedicationDose).where(
            MedicationDose.astronaut_id == astronaut_id,
            MedicationDose.status == "Taken",
            col(MedicationDose.taken_at) >= now - timedelta(days=62),
        )
    ).all()
    return [TakenDose(r.medicine_id, r.units, r.taken_at) for r in rows if r.taken_at]


def _pending(session: Session, astronaut_id: str, *, except_id: str | None = None) -> list[str]:
    rows = session.exec(
        select(MedicationDose).where(
            MedicationDose.astronaut_id == astronaut_id, col(MedicationDose.status).in_(OPEN_STATUSES)
        )
    ).all()
    return [r.medicine_id for r in rows if r.id != except_id]


def _checks_out(checks: tuple[Check, ...] | list[Check]) -> list[CheckOut]:
    return [CheckOut(level=c.level, code=c.code, text=c.text) for c in checks]


def advice_for(
    session: Session, formulary: Formulary, astronaut: Astronaut, body: AdviceIn, now: datetime
) -> AdviceOut:
    condition = formulary.condition(body.condition_id)
    if condition is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown condition '{body.condition_id}'")
    missing = [f.id for f in condition.red_flags if f.id not in body.answers]
    if missing:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Answer every safety question first")
    profile, history = load_profile(session, astronaut), _history(session, astronaut.id, now)
    result = advise(
        formulary, condition, body.answers, profile, history,
        stock=stock_left(session, formulary), pending=_pending(session, astronaut.id), now=now,
    )  # fmt: skip
    return AdviceOut(
        condition_id=condition.id,
        title=condition.title,
        stop=StopOut(action=result.stop.action, protocol=result.stop.protocol, question=result.stop.question)
        if result.stop
        else None,
        non_drug=condition.non_drug,
        options=[
            OptionOut(
                medicine_id=o.medicine.id,
                name=o.medicine.name,
                strength=o.medicine.strength,
                units=o.units,
                dose_text=o.dose_text,
                when=o.when,
                how=o.medicine.how,
                kit_location=o.medicine.kit_location,
                status=o.status,
                checks=_checks_out(o.checks),
                next_allowed_at=o.next_allowed_at,
                cautions=o.medicine.cautions,
                source=o.medicine.source,
                source_url=o.medicine.source_url,
            )  # fmt: skip
            for o in result.options
        ],
        recommended=result.recommended.medicine.id if result.recommended else None,
        follow_up_hours=condition.follow_up_hours,
        formulary_version=formulary.version,
        formulary_status=formulary.status,
        disclaimer=formulary.disclaimer,
    )


@router.post("/astronauts/{astronaut}/medication/advice", response_model=AdviceOut)
def post_advice(
    astronaut: str, body: AdviceIn, request: Request, session: SessionDep, user: CurrentUser
) -> AdviceOut:
    found = _astronaut(session, user, astronaut)
    return advice_for(session, _formulary(request), found, body, datetime.now(UTC))


# --- doses --------------------------------------------------------------------------------------


class DoseOut(ApiModel):
    id: str
    astronaut_code: str
    astronaut_name: str
    condition_id: str
    condition_title: str
    medicine_id: str
    medicine_name: str
    units: int
    dose_text: str
    when_text: str
    how: str
    kit_location: str
    status: Literal["Requested", "Confirmed", "Declined", "Cancelled", "Taken"]
    self_confirmed: bool
    self_confirm_reason: str | None
    checks: list[CheckOut]
    requested_at: datetime
    confirmed_at: datetime | None
    confirmed_by: str | None
    decline_reason: str | None
    taken_at: datetime | None
    follow_up_at: datetime | None
    follow_up_due: bool
    outcome: Literal["better", "same", "worse"] | None
    outcome_at: datetime | None
    reviewed_at: datetime | None
    reviewed_by: str | None
    review_note: str | None
    formulary_version: str


def _follow_up_due(row: MedicationDose, now: datetime) -> bool:
    due = row.follow_up_at is not None and row.follow_up_at <= now
    return row.status == "Taken" and row.outcome is None and due


def _dose_out(session: Session, formulary: Formulary | None, row: MedicationDose) -> DoseOut:
    who = session.get(Astronaut, row.astronaut_id)
    med = formulary.medicine(row.medicine_id) if formulary else None
    condition = formulary.condition(row.condition_id) if formulary else None
    now = datetime.now(UTC)
    return DoseOut(
        id=row.id, astronaut_code=who.code if who else "?", astronaut_name=who.display_name if who else "?",
        condition_id=row.condition_id, condition_title=condition.title if condition else row.condition_id,
        medicine_id=row.medicine_id, medicine_name=med.name if med else row.medicine_id, units=row.units,
        dose_text=row.dose_text, when_text=row.when_text, how=med.how if med else "",
        kit_location=med.kit_location if med else "", status=row.status,  # type: ignore[arg-type]
        self_confirmed=row.self_confirmed, self_confirm_reason=row.self_confirm_reason,
        checks=[CheckOut.model_validate(c) for c in json.loads(row.checks_json)],
        requested_at=row.requested_at, confirmed_at=row.confirmed_at, confirmed_by=row.confirmed_by,
        decline_reason=row.decline_reason, taken_at=row.taken_at, follow_up_at=row.follow_up_at,
        follow_up_due=_follow_up_due(row, now),
        outcome=row.outcome, outcome_at=row.outcome_at,  # type: ignore[arg-type]
        reviewed_at=row.reviewed_at, reviewed_by=row.reviewed_by, review_note=row.review_note,
        formulary_version=row.formulary_version,
    )  # fmt: skip


def _save(session: Session, row: MedicationDose, astronaut: Astronaut) -> None:
    row.updated_at = datetime.now(UTC)
    session.add(row)
    session.add(SyncOutbox(entity_type="MedicationDose", entity_id=row.id,
                           payload_json=row.model_dump_json(), priority=2))  # fmt: skip
    session.commit()
    session.refresh(row)
    hub.publish_from_thread(
        ["all"], "MedicationUpdated", {"id": row.id, "status": row.status, "astronautCode": astronaut.code}
    )


@router.get("/astronauts/{astronaut}/medication/doses", response_model=list[DoseOut])
def get_astronaut_doses(
    astronaut: str, request: Request, session: SessionDep, user: CurrentUser
) -> list[DoseOut]:
    found = _astronaut(session, user, astronaut)
    rows = session.exec(
        select(MedicationDose)
        .where(MedicationDose.astronaut_id == found.id)
        .order_by(col(MedicationDose.requested_at).desc())
        .limit(50)
    ).all()
    return [_dose_out(session, request.app.state.protocols.formulary, r) for r in rows]


@router.get("/medication/doses", response_model=list[DoseOut])
def get_crew_doses(request: Request, session: SessionDep, user: CurrentUser) -> list[DoseOut]:
    if not (user.role == Role.FLIGHT_SURGEON or is_cmo(session, user)):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only the CMO and the flight surgeon see the crew's doses"
        )
    rows = session.exec(
        select(MedicationDose).order_by(col(MedicationDose.requested_at).desc()).limit(100)
    ).all()
    return [_dose_out(session, request.app.state.protocols.formulary, r) for r in rows]


class DoseIn(ApiModel):
    id: str = Field(
        min_length=8, max_length=64, pattern=r"^[A-Za-z0-9-]+$", description="Client id (idempotent)"
    )
    condition_id: str
    medicine_id: str
    units: int | None = Field(default=None, ge=1, le=10, description="Default: the guide's dose")
    answers: dict[str, bool]
    self_confirm_reason: str | None = Field(
        default=None, min_length=3, max_length=300,
        description="Confirm alone (no CMO available, or you are the CMO); flagged for the flight surgeon",
    )  # fmt: skip
    requested_at: AwareDatetime | None = None


def _checks_now(
    session: Session,
    formulary: Formulary,
    medicine: Medicine,
    units: int,
    astronaut: Astronaut,
    now: datetime,
    *,
    except_id: str | None = None,
) -> list[Check]:
    checks, _ = check_medicine(
        formulary,
        medicine,
        units,
        load_profile(session, astronaut),
        _history(session, astronaut.id, now),
        stock_left=stock_left(session, formulary)[medicine.id],
        pending=_pending(session, astronaut.id, except_id=except_id),
        now=now,
    )
    return checks


def _blocked(checks: list[Check]) -> None:
    reasons = [c.text for c in checks if c.level == "block"]
    if reasons:
        raise HTTPException(status.HTTP_409_CONFLICT, "Not safe now: " + " ".join(reasons))


@router.post("/medication/doses", response_model=DoseOut, status_code=status.HTTP_201_CREATED)
def post_dose(body: DoseIn, request: Request, session: SessionDep, user: CurrentUser) -> DoseOut:
    _onboard(request)
    if user.role != Role.ASTRONAUT or not user.astronaut_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only astronauts ask for their own medicine")
    astronaut = session.get(Astronaut, user.astronaut_id)
    assert astronaut is not None
    formulary = _formulary(request)
    existing = session.get(MedicationDose, body.id)
    if existing is not None:  # sent again (offline outbox, lost reply): same answer
        if existing.astronaut_id != astronaut.id:
            raise HTTPException(status.HTTP_409_CONFLICT, "Dose id already used")
        return _dose_out(session, formulary, existing)
    if is_cmo(session, user) and not body.self_confirm_reason:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "You are the CMO: confirm your own dose (give a reason)"
        )
    now = datetime.now(UTC)
    advice = advice_for(
        session, formulary, astronaut, AdviceIn(condition_id=body.condition_id, answers=body.answers), now
    )
    if advice.stop is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "A safety question was answered yes: follow the emergency steps or call the CMO",
        )
    option = next((o for o in advice.options if o.medicine_id == body.medicine_id), None)
    if option is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "This medicine is not in the guide for this problem"
        )
    medicine = formulary.medicine(body.medicine_id)
    assert medicine is not None
    units = body.units or option.units
    if units > medicine.max_per_dose:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"At most {medicine.max_per_dose} per dose"
        )
    checks = _checks_now(session, formulary, medicine, units, astronaut, now)
    _blocked(checks)
    alone = body.self_confirm_reason is not None
    row = MedicationDose(
        id=body.id, astronaut_id=astronaut.id, condition_id=body.condition_id, medicine_id=medicine.id,
        units=units, dose_text=medicine.dose_text(units), when_text=option.when,
        formulary_version=formulary.version, answers_json=json.dumps(body.answers),
        checks_json=json.dumps([{"level": c.level, "code": c.code, "text": c.text} for c in checks]),
        status="Confirmed" if alone else "Requested", self_confirmed=alone,
        self_confirm_reason=body.self_confirm_reason.strip() if body.self_confirm_reason else None,
        requested_at=min(body.requested_at.astimezone(UTC), now) if body.requested_at else now,
        confirmed_at=now if alone else None, confirmed_by=_name(session, user) if alone else None,
        node_id=request.app.state.settings.node_id,
    )  # fmt: skip
    _save(session, row, astronaut)
    return _dose_out(session, formulary, row)


def _dose(session: Session, dose_id: str) -> tuple[MedicationDose, Astronaut]:
    row = session.get(MedicationDose, dose_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dose not found")
    astronaut = session.get(Astronaut, row.astronaut_id)
    assert astronaut is not None
    return row, astronaut


def _recheck(
    session: Session, formulary: Formulary, row: MedicationDose, astronaut: Astronaut
) -> list[Check]:
    medicine = formulary.medicine(row.medicine_id)
    if medicine is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This medicine is no longer in the medicine list")
    return _checks_now(
        session, formulary, medicine, row.units, astronaut, datetime.now(UTC), except_id=row.id
    )


class ConfirmIn(ApiModel):
    approve: bool
    reason: str | None = Field(default=None, max_length=300)


@router.post("/medication/doses/{dose_id}/confirm", response_model=DoseOut)
def confirm_dose(
    dose_id: str, body: ConfirmIn, request: Request, session: SessionDep, user: CurrentUser
) -> DoseOut:
    _onboard(request)
    if not is_cmo(session, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the crew medical officer confirms doses")
    row, astronaut = _dose(session, dose_id)
    if astronaut.id == user.astronaut_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Confirm your own dose with a reason when you ask for it"
        )
    if row.status != "Requested":
        raise HTTPException(status.HTTP_409_CONFLICT, f"This dose is already {row.status.lower()}")
    formulary = _formulary(request)
    now = datetime.now(UTC)
    if body.approve:
        _blocked(_recheck(session, formulary, row, astronaut))
        row.status = "Confirmed"
    else:
        if not body.reason or len(body.reason.strip()) < 3:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Say why you decline")
        row.status, row.decline_reason = "Declined", body.reason.strip()
    row.confirmed_at, row.confirmed_by = now, _name(session, user)
    _save(session, row, astronaut)
    return _dose_out(session, formulary, row)


def _own(session: Session, user: TokenClaims, dose_id: str) -> tuple[MedicationDose, Astronaut]:
    row, astronaut = _dose(session, dose_id)
    if user.role != Role.ASTRONAUT or user.astronaut_id != astronaut.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the astronaut who asked for it can do this")
    return row, astronaut


@router.post("/medication/doses/{dose_id}/taken", response_model=DoseOut)
def dose_taken(dose_id: str, request: Request, session: SessionDep, user: CurrentUser) -> DoseOut:
    _onboard(request)
    row, astronaut = _own(session, user, dose_id)
    formulary = _formulary(request)
    if row.status == "Taken":
        return _dose_out(session, formulary, row)
    if row.status != "Confirmed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Wait until the CMO confirms this dose")
    _blocked(_recheck(session, formulary, row, astronaut))
    condition = formulary.condition(row.condition_id)
    now = datetime.now(UTC)
    row.status, row.taken_at = "Taken", now
    row.follow_up_at = now + timedelta(hours=condition.follow_up_hours if condition else 4)
    _save(session, row, astronaut)
    return _dose_out(session, formulary, row)


@router.post("/medication/doses/{dose_id}/cancel", response_model=DoseOut)
def dose_cancel(dose_id: str, request: Request, session: SessionDep, user: CurrentUser) -> DoseOut:
    _onboard(request)
    row, astronaut = _own(session, user, dose_id)
    if row.status not in OPEN_STATUSES:
        raise HTTPException(status.HTTP_409_CONFLICT, f"This dose is already {row.status.lower()}")
    row.status = "Cancelled"
    _save(session, row, astronaut)
    return _dose_out(session, request.app.state.protocols.formulary, row)


class OutcomeIn(ApiModel):
    outcome: Literal["better", "same", "worse"]


@router.post("/medication/doses/{dose_id}/outcome", response_model=DoseOut)
def dose_outcome(
    dose_id: str, body: OutcomeIn, request: Request, session: SessionDep, user: CurrentUser
) -> DoseOut:
    _onboard(request)
    row, astronaut = _own(session, user, dose_id)
    if row.status != "Taken":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a dose you took can be followed up")
    if row.outcome is None:
        row.outcome, row.outcome_at = body.outcome, datetime.now(UTC)
        _save(session, row, astronaut)
        if body.outcome == "worse":
            hub.publish_from_thread(["medical", "all"], "MedicationWorse",
                                    {"id": row.id, "astronautCode": astronaut.code})  # fmt: skip
    return _dose_out(session, request.app.state.protocols.formulary, row)


class ReviewIn(ApiModel):
    note: str = Field(default="", max_length=500)


@router.post("/medication/doses/{dose_id}/review", response_model=DoseOut)
def dose_review(
    dose_id: str, body: ReviewIn, request: Request, session: SessionDep, user: CurrentUser
) -> DoseOut:
    if user.role != Role.FLIGHT_SURGEON:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the flight surgeon reviews doses")
    row, astronaut = _dose(session, dose_id)
    if row.reviewed_at is None:
        row.reviewed_at, row.reviewed_by = datetime.now(UTC), _name(session, user)
        row.review_note = body.note.strip() or None
        _save(session, row, astronaut)
    return _dose_out(session, request.app.state.protocols.formulary, row)
