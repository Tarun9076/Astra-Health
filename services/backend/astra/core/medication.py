"""Medication Guide (Step 20; LLD §15.9): which medicine from the onboard kit, how much, and whether it
is safe for *this* astronaut *now*. Pure functions over protocols/medications.json, no I/O.

The AI never chooses a medicine or a dose. They come from the formulary (in a real mission: written
and approved by the flight surgeons before launch). Each option goes through fixed checks:

1. allergy (the astronaut's allergy groups vs the medicine's)        → block
2. health conditions (the medicine's `avoidIf`)                      → block or caution
3. interactions with regular medicines and with medicines taken in the last 24 h → block or caution
4. a dose of the same medicine already waiting for confirmation       → block
5. too soon after the last dose (`minIntervalHours`)                 → block, with the next time
6. the 24-hour limit (`maxUnitsPer24h`)                               → block, with the next time
7. used for too many days in a row (`maxDays`)                        → block
8. kit stock (none left → block; 5 or fewer → caution) and expiry (past it → caution: may be weaker)
9. drowsy medicines                                                   → caution (no EVA / rover driving)

Red-flag questions come first: any "yes" stops the guide (emergency procedure or "call the CMO now").
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal

from pydantic import Field, model_validator

from astra.core.base import CoreModel
from astra.core.rules.models import SEMVER_PATTERN

Level = Literal["block", "caution"]
LOW_STOCK_UNITS = 5


class AvoidIf(CoreModel):
    condition: str
    level: Level
    reason: str


class Interaction(CoreModel):
    with_: str = Field(alias="with")  # a regular-medicine code or a medicine group
    level: Level
    reason: str


class Medicine(CoreModel):
    id: str = Field(pattern=r"^[a-z0-9]+$")
    name: str
    form: str
    strength: str
    strength_mg: float | None = None
    unit: str
    unit_plural: str
    per_unit: str | None = None  # "2 or 3 sprays in each nostril"
    how: str
    kit_location: str
    stock_units: int = Field(ge=0)
    expires: str = Field(pattern=r"^\d{4}-\d{2}$")  # YYYY-MM
    groups: list[str] = Field(min_length=1)
    allergy_groups: list[str] = []  # empty for emergency medicines that no allergy rules out
    first_dose_units: int | None = Field(default=None, ge=1, le=10)
    dose_units: int = Field(ge=1, le=10)
    dose_units_max: int | None = Field(default=None, ge=1, le=10)
    min_interval_hours: float = Field(ge=0, le=48)
    max_units_per_24h: int = Field(alias="maxUnitsPer24h", ge=1, le=40)
    max_days: int | None = Field(default=None, ge=1, le=60)
    drowsy: bool
    avoid_if: list[AvoidIf]
    interactions: list[Interaction]
    cautions: list[str]
    source: str
    source_url: str
    # Step 21: the emergency kit, and what makes a dose unmistakable under stress
    kit: Literal["routine", "emergency"] = "routine"
    route: Literal["swallow", "chew", "injection", "spray", "skin", "drink"] = "swallow"
    appearance: str | None = None  # "white round chewable tablet"
    amount_per_unit: float | None = None  # when the strength is not in mg (e.g. 4 g of glucose)
    amount_unit: str | None = None  # "g"
    rx_only: bool = False  # prescription medicine (emergency kit), given by the crew as the protocol says

    @property
    def max_per_dose(self) -> int:
        return max(self.dose_units_max or 0, self.dose_units, self.first_dose_units or 0)

    def dose_text(self, units: int) -> str:
        text = f"{units} {self.unit if units == 1 else self.unit_plural}"
        if self.strength_mg:
            text += f" ({units * self.strength_mg:g} mg)"
        elif self.amount_per_unit and self.amount_unit:
            text += f" ({units * self.amount_per_unit:g} {self.amount_unit})"
        if self.per_unit:
            text += f": {self.per_unit}"
        return text

    def expired(self, today: date) -> bool:
        year, month = (int(p) for p in self.expires.split("-"))
        return (today.year, today.month) > (year, month)


class RedFlag(CoreModel):
    id: str = Field(pattern=r"^[a-z0-9-]+$")
    question: str
    action: Literal["emergency", "cmo"]
    protocol: str | None = None

    @model_validator(mode="after")
    def _protocol_for_emergency(self) -> "RedFlag":
        if self.action == "emergency" and not self.protocol:
            raise ValueError(f"red flag '{self.id}': an emergency needs a protocol")
        return self


class Option(CoreModel):
    medicine: str
    dose_units: int | None = Field(default=None, ge=1, le=10)  # overrides the medicine's usual dose
    when: str


class Condition(CoreModel):
    id: str = Field(pattern=r"^[a-z0-9-]+$")
    title: str
    plain: str
    keywords: list[str] = Field(min_length=1)
    red_flags: list[RedFlag] = Field(min_length=1)
    non_drug: list[str]
    options: list[Option] = Field(min_length=1)
    follow_up_hours: float = Field(gt=0, le=48)


class Vocabulary(CoreModel):
    allergies: dict[str, str]
    conditions: dict[str, str]
    regular_medicines: dict[str, str]


class Formulary(CoreModel):
    version: str = Field(pattern=SEMVER_PATTERN)
    status: Literal["demo", "approved"]
    approved_by: str | None = None
    disclaimer: str
    vocabulary: Vocabulary
    medicines: list[Medicine] = Field(min_length=1)
    conditions: list[Condition] = Field(min_length=1)

    def medicine(self, medicine_id: str) -> Medicine | None:
        return next((m for m in self.medicines if m.id == medicine_id), None)

    def condition(self, condition_id: str) -> Condition | None:
        return next((c for c in self.conditions if c.id == condition_id), None)

    def problems(self, emergency_ids: set[str]) -> list[str]:
        """Broken references: unknown medicines, groups, conditions or emergency procedures."""
        out: list[str] = []
        meds = {m.id: m for m in self.medicines}
        groups = {g for m in self.medicines for g in m.groups}
        vocab = self.vocabulary
        out += [f"duplicate medicine '{i}'" for i in meds if [m.id for m in self.medicines].count(i) > 1]
        for m in self.medicines:
            out += [
                f"{m.id}: unknown allergy group '{g}'" for g in m.allergy_groups if g not in vocab.allergies
            ]
            out += [
                f"{m.id}: unknown condition '{a.condition}'"
                for a in m.avoid_if
                if a.condition not in vocab.conditions
            ]
            out += [
                f"{m.id}: interaction with unknown '{i.with_}'"
                for i in m.interactions
                if i.with_ not in vocab.regular_medicines and i.with_ not in groups
            ]
            if m.dose_units > m.max_units_per_24h:
                out.append(f"{m.id}: one dose is more than the 24-hour limit")
        for c in self.conditions:
            for o in c.options:
                med = meds.get(o.medicine)
                if med is None:
                    out.append(f"condition '{c.id}': unknown medicine '{o.medicine}'")
                elif o.dose_units and o.dose_units > med.max_per_dose:
                    out.append(f"condition '{c.id}': dose of {o.medicine} above its largest single dose")
            out += [
                f"condition '{c.id}': unknown emergency procedure '{f.protocol}'"
                for f in c.red_flags
                if f.protocol and f.protocol not in emergency_ids
            ]
        return out  # fmt: skip


# --- the astronaut's situation ------------------------------------------------------------------


@dataclass(frozen=True)
class Profile:
    allergies: frozenset[str] = frozenset()
    conditions: frozenset[str] = frozenset()
    regular_medicines: frozenset[str] = frozenset()


@dataclass(frozen=True)
class TakenDose:
    medicine_id: str
    units: int
    at: datetime


@dataclass(frozen=True)
class Check:
    level: Level
    # allergy | condition | interaction | pending | interval | limit24h | days | stock | expired | drowsy
    code: str
    text: str


@dataclass(frozen=True)
class OptionResult:
    medicine: Medicine
    when: str
    units: int
    dose_text: str
    status: Literal["ok", "caution", "blocked"]
    checks: tuple[Check, ...]
    next_allowed_at: datetime | None  # when a blocked-for-now dose becomes possible

    @property
    def blocked(self) -> bool:
        return self.status == "blocked"


@dataclass(frozen=True)
class Stop:
    action: Literal["emergency", "cmo"]
    protocol: str | None
    question: str


@dataclass(frozen=True)
class Advice:
    condition: Condition
    stop: Stop | None
    options: tuple[OptionResult, ...]

    @property
    def recommended(self) -> OptionResult | None:
        return None if self.stop else next((o for o in self.options if not o.blocked), None)


def units_for(medicine: Medicine, option: Option | None, history: Sequence[TakenDose], now: datetime) -> int:
    """The dose to suggest: the option's, else the medicine's; a larger first dose when none in 24 h."""
    if option and option.dose_units:
        return option.dose_units
    recent = [d for d in history if d.medicine_id == medicine.id and now - d.at < timedelta(hours=24)]
    return medicine.first_dose_units if medicine.first_dose_units and not recent else medicine.dose_units


def check_medicine(
    formulary: Formulary,
    medicine: Medicine,
    units: int,
    profile: Profile,
    history: Sequence[TakenDose],
    *,
    stock_left: int,
    pending: Iterable[str] = (),
    now: datetime,
) -> tuple[list[Check], datetime | None]:
    """Every check for one dose of `medicine` (see the module docstring). `history` = this astronaut's
    taken doses; `pending` = medicine ids with a dose waiting for confirmation."""
    checks: list[Check] = []
    next_at: list[datetime] = []
    vocab = formulary.vocabulary
    for group in medicine.allergy_groups:
        if group in profile.allergies:
            checks.append(Check("block", "allergy", f"Allergy on record: {vocab.allergies[group]}."))
    for avoid in medicine.avoid_if:
        if avoid.condition in profile.conditions:
            checks.append(Check(avoid.level, "condition", avoid.reason))

    day = [d for d in history if now - d.at < timedelta(hours=24) and d.at <= now]
    groups_24h: set[str] = set()
    for d in day:
        other = formulary.medicine(d.medicine_id)
        if other is not None and other.id != medicine.id:
            groups_24h |= set(other.groups)
    for i in medicine.interactions:
        if i.with_ in profile.regular_medicines or i.with_ in groups_24h:
            checks.append(Check(i.level, "interaction", i.reason))

    if medicine.id in set(pending):
        checks.append(
            Check("block", "pending", "A dose of this medicine is already waiting for confirmation.")
        )

    same = sorted((d for d in day if d.medicine_id == medicine.id), key=lambda d: d.at)
    if same and medicine.min_interval_hours:
        after = same[-1].at + timedelta(hours=medicine.min_interval_hours)
        if after > now:
            gap = f"{medicine.min_interval_hours:g}"
            text = f"Too soon after the last dose (at least {gap} hours between doses)."
            checks.append(Check("block", "interval", text))
            next_at.append(after)
    used = sum(d.units for d in same)
    if used + units > medicine.max_units_per_24h:
        # the dose becomes possible when enough of the last 24 h's doses are older than 24 h
        excess = used + units - medicine.max_units_per_24h
        ready: datetime | None = None
        for d in same:
            excess -= d.units
            if excess <= 0:
                ready = d.at + timedelta(hours=24)
                break
        text = f"The 24-hour limit is {medicine.dose_text(medicine.max_units_per_24h).split(':')[0]}"
        text += f"; {used} already taken."
        checks.append(Check("block", "limit24h", text))
        if ready:
            next_at.append(ready)
    if medicine.max_days:
        today = now.date()
        days = {
            d.at.date()
            for d in history
            if d.medicine_id == medicine.id
            and today - timedelta(days=medicine.max_days) <= d.at.date() < today
        }
        if len(days) >= medicine.max_days:
            text = f"Already used on {len(days)} days in a row: the limit is {medicine.max_days} days."
            checks.append(Check("block", "days", text + " Ask the flight surgeon."))

    if stock_left < units:
        checks.append(Check("block", "stock", "Not enough left in the medical kit."))
    elif stock_left - units <= LOW_STOCK_UNITS:
        checks.append(
            Check("caution", "stock", f"Only {stock_left} left in the kit: tell the flight surgeon.")
        )
    if medicine.expired(now.date()):
        text = f"Past its expiry date ({medicine.expires}): it may be weaker. The CMO decides."
        checks.append(Check("caution", "expired", text))
    if medicine.drowsy:
        text = "Makes you drowsy: no EVA, rover driving or machine work until you are fully alert."
        checks.append(Check("caution", "drowsy", text))
    blocked = any(c.level == "block" for c in checks)
    hard = {"allergy", "condition", "interaction", "days", "stock"}
    permanent = any(c.level == "block" and c.code in hard for c in checks)
    return checks, (max(next_at) if blocked and next_at and not permanent else None)


def evaluate(
    formulary: Formulary,
    medicine: Medicine,
    option: Option | None,
    profile: Profile,
    history: Sequence[TakenDose],
    *,
    stock_left: int,
    pending: Iterable[str] = (),
    now: datetime,
    units: int | None = None,
) -> OptionResult:
    units = units or units_for(medicine, option, history, now)
    checks, next_at = check_medicine(
        formulary, medicine, units, profile, history, stock_left=stock_left, pending=pending, now=now
    )
    status: Literal["ok", "caution", "blocked"] = (
        "blocked" if any(c.level == "block" for c in checks) else "caution" if checks else "ok"
    )
    when = option.when if option else ""
    return OptionResult(medicine, when, units, medicine.dose_text(units), status, tuple(checks), next_at)


def advise(
    formulary: Formulary,
    condition: Condition,
    answers: dict[str, bool],
    profile: Profile,
    history: Sequence[TakenDose],
    *,
    stock: dict[str, int],
    pending: Iterable[str] = (),
    now: datetime,
) -> Advice:
    """Red flags first (an unanswered question counts as not answered: the caller must send them all),
    then every option of the condition in protocol order."""
    for flag in condition.red_flags:
        if answers.get(flag.id):
            return Advice(condition, Stop(flag.action, flag.protocol, flag.question), ())
    pending = tuple(pending)
    options = []
    for option in condition.options:
        medicine = formulary.medicine(option.medicine)
        assert medicine is not None  # checked at load time
        options.append(
            evaluate(
                formulary,
                medicine,
                option,
                profile,
                history,
                stock_left=stock.get(medicine.id, 0),
                pending=pending,
                now=now,
            )  # fmt: skip
        )
    return Advice(condition, None, tuple(options))


def match_condition(formulary: Formulary, text: str) -> Condition | None:
    """The condition whose keyword appears in the text (longest keyword wins), for the AI assistant."""
    low = " ".join(text.lower().replace("’", "'").split())
    best: tuple[int, Condition] | None = None
    for c in formulary.conditions:
        for k in c.keywords:
            if k in low and (best is None or len(k) > best[0]):
                best = (len(k), c)
    return best[1] if best else None
