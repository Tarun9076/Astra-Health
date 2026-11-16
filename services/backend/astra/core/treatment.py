"""Treatment at check-in (Step 21; LLD §15.10): how serious it is, and exactly what to do now.
Pure functions over protocols/treatments/ and protocols/medications.json, no I/O.

Design rules (TDD ADR-16):
- One source of truth: every step, medicine, dose and threshold comes from the protocol files.
- Same input, same answer: fixed rules, no AI anywhere in the decision.
- Every decision explains itself: what matched, which medicine was chosen and why the others were not.
- Act first, tell Earth after: nothing here waits for the ground.

Tiers: 1 mild and 2 needs treatment → the Medication Guide (`routine.json` links symptoms and rules to
its conditions; the CMO confirms); 3 critical → an Act Now protocol (`TX-*.json`): ordered steps with
exact doses, questions, rechecks with timers and repeat limits, "do not give" rules and an escalation.

Several problems at once are merged into one plan: the most urgent protocol first; a "do not give"
rule from any matched protocol applies to every step; each medicine is planned only once; medicines
planned earlier count for interaction checks of later ones.
"""

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from pydantic import Field, model_validator

from astra.core.base import CoreModel
from astra.core.medication import (
    Check,
    Formulary,
    Medicine,
    Profile,
    TakenDose,
    check_medicine,
    units_for,
)
from astra.core.rules.models import SEMVER_PATTERN

Op = Literal["lt", "lte", "gt", "gte"]
END_TARGETS = ("done", "escalate")
STEP_ID = r"^[a-z0-9-]+$"


def compare(value: float, op: Op, limit: float) -> bool:
    return {"lt": value < limit, "lte": value <= limit, "gt": value > limit, "gte": value >= limit}[op]


# --- protocol files -------------------------------------------------------------------------------


class SymptomTrigger(CoreModel):
    code: str
    min_severity: int = Field(default=1, ge=1, le=10)


class VitalTrigger(CoreModel):
    indicator: str
    op: Op
    value: float


class Triggers(CoreModel):
    rules: list[str] = []
    symptoms: list[SymptomTrigger] = []
    vitals: list[VitalTrigger] = []

    @model_validator(mode="after")
    def _any(self) -> "Triggers":
        if not (self.rules or self.symptoms or self.vitals):
            raise ValueError("a protocol needs at least one trigger")
        return self


class DoNotGive(CoreModel):
    target: str  # a medicine id, a medicine group ("NSAID") or a route ("swallow", "chew")
    reason: str


class MedicineChoice(CoreModel):
    medicine: str
    dose_units: int | None = Field(default=None, ge=1, le=10)


class Step(CoreModel):
    id: str = Field(pattern=STEP_ID)
    kind: Literal["action", "medicine", "question", "recheck", "measure"]
    text: str  # the instruction, in plain words
    detail: str | None = None
    given_by: Literal["self", "crewmate", "any"] = "any"
    emergency: str | None = None  # an EMG procedure to show with this step
    # medicine: alternatives in order; the first that is safe now is used
    medicines: list[MedicineChoice] = []
    override: list[str] = []  # check codes pre-approved for this emergency (block → caution, relabelled)
    if_none: str | None = None  # where to go when no medicine is safe (default: the next step)
    # question (and question-style recheck)
    question: str | None = None
    yes: str | None = None
    no: str | None = None
    # recheck / measure
    after_minutes: float | None = Field(default=None, gt=0, le=240)
    indicator: str | None = None
    op: Op | None = None
    value: float | None = None
    passed: str | None = None
    failed: str | None = None
    max_repeats: int | None = Field(default=None, ge=1, le=5)
    failed_after_max: str | None = None
    next: str | None = None  # default: the following step; "done" or "escalate" end the protocol

    @model_validator(mode="after")
    def _shape(self) -> "Step":
        problems = []
        if self.kind == "medicine" and not self.medicines:
            problems.append("a medicine step needs medicines")
        if self.kind != "medicine" and (self.medicines or self.override):
            problems.append("only a medicine step has medicines")
        if self.kind == "question" and not (self.question and self.yes and self.no):
            problems.append("a question step needs question, yes and no")
        if self.kind == "recheck":
            by_value = self.indicator and self.op and self.value is not None
            by_question = self.question is not None
            if not self.after_minutes or not (by_value or by_question) or not (self.passed and self.failed):
                problems.append(
                    "a recheck needs afterMinutes, a target (indicator/op/value or a question), "
                    "passed and failed"
                )
            if self.max_repeats and not self.failed_after_max:
                problems.append("maxRepeats needs failedAfterMax")
        if self.kind == "measure" and not self.indicator:
            problems.append("a measure step needs an indicator")
        if problems:
            raise ValueError(f"step '{self.id}': " + "; ".join(problems))
        return self

    def targets(self) -> list[tuple[str, str]]:
        """(edge kind, target) pairs; 'next' is resolved by the protocol."""
        out = [(k, t) for k, t in (("yes", self.yes), ("no", self.no), ("passed", self.passed),
                                    ("failed", self.failed), ("failed_after_max", self.failed_after_max),
                                    ("if_none", self.if_none), ("next", self.next)) if t]  # fmt: skip
        return out


class Approval(CoreModel):
    status: Literal["demo", "approved"]
    author: str
    approved_by: str | None = None
    date: str


class TreatmentProtocol(CoreModel):
    id: str = Field(pattern=r"^TX-[A-Z0-9-]+$")
    version: str = Field(pattern=SEMVER_PATTERN)
    title: str
    plain: str  # what is happening, in everyday words
    tier: Literal[3]
    priority: int = Field(ge=1, le=9)  # 1 = most urgent when several match
    triggers: Triggers
    act_first: bool = False  # a doubtful reading is re-measured while starting, not before
    emergency_protocol: str | None = None
    do_not_give: list[DoNotGive]  # required (may be empty): every critical protocol states it
    steps: list[Step] = Field(min_length=1)
    escalation: str = Field(min_length=10)
    follow_up_hours: float = Field(gt=0, le=72)
    approval: Approval

    def step(self, step_id: str) -> Step | None:
        return next((s for s in self.steps if s.id == step_id), None)

    def next_of(self, step: Step) -> str:
        if step.next:
            return step.next
        i = self.steps.index(step)
        return self.steps[i + 1].id if i + 1 < len(self.steps) else "done"

    def edges(self) -> list[tuple[str, str, str]]:
        """(from, kind, to) for every step, with the default 'next' filled in."""
        out = []
        for s in self.steps:
            pairs = s.targets()
            if s.kind not in ("question", "recheck") and not s.next:
                pairs.append(("next", self.next_of(s)))
            out += [(s.id, k, t) for k, t in pairs]
        return out

    def problems(
        self, formulary: Formulary | None, rule_ids: set[str], emergency_ids: set[str],
        indicators: set[str], symptoms: set[str],
    ) -> list[str]:  # fmt: skip
        out: list[str] = []
        ids = [s.id for s in self.steps]
        out += [f"duplicate step '{i}'" for i in sorted({i for i in ids if ids.count(i) > 1})]
        known = set(ids) | set(END_TARGETS)
        out += [f"step '{a}': {k} → unknown step '{b}'" for a, k, b in self.edges() if b not in known]
        out += [f"unknown rule '{r}'" for r in self.triggers.rules if r not in rule_ids]
        out += [f"unknown symptom '{s.code}'" for s in self.triggers.symptoms if s.code not in symptoms]
        out += [
            f"unknown indicator '{v.indicator}'"
            for v in self.triggers.vitals
            if v.indicator not in indicators
        ]
        for s in self.steps:
            if s.indicator and s.indicator not in indicators:
                out.append(f"step '{s.id}': unknown indicator '{s.indicator}'")
            if s.emergency and s.emergency not in emergency_ids:
                out.append(f"step '{s.id}': unknown emergency procedure '{s.emergency}'")
        if self.emergency_protocol and self.emergency_protocol not in emergency_ids:
            out.append(f"unknown emergency procedure '{self.emergency_protocol}'")
        if formulary is None:
            if any(s.kind == "medicine" for s in self.steps):
                out.append("medicine steps need protocols/medications.json")
            return out
        groups = {g for m in formulary.medicines for g in m.groups}
        routes = {"swallow", "chew", "injection", "spray", "skin", "drink"}
        for d in self.do_not_give:
            if formulary.medicine(d.target) is None and d.target not in groups and d.target not in routes:
                out.append(f"do-not-give: unknown medicine, group or route '{d.target}'")
        for s in self.steps:
            for c in s.medicines:
                med = formulary.medicine(c.medicine)
                if med is None:
                    out.append(f"step '{s.id}': unknown medicine '{c.medicine}'")
                elif c.dose_units and c.dose_units > med.max_per_dose:
                    out.append(f"step '{s.id}': {c.medicine} dose above its largest single dose")
                elif (c.dose_units or med.dose_units) > med.max_units_per_24h:
                    out.append(f"step '{s.id}': {c.medicine} dose above its 24-hour limit")
        out += [f"loop without a limit through step '{s}'" for s in self._unbounded_loops()]
        return out  # fmt: skip

    def _unbounded_loops(self) -> list[str]:
        """Every loop must pass through a recheck 'failed' edge that has maxRepeats, so a protocol
        always ends (done or escalate)."""
        bounded = {(s.id, "failed") for s in self.steps if s.kind == "recheck" and s.max_repeats}
        graph: dict[str, list[str]] = {s.id: [] for s in self.steps}
        for a, k, b in self.edges():
            if (a, k) not in bounded and b in graph:
                graph[a].append(b)
        state: dict[str, int] = {}
        loops: list[str] = []

        def visit(n: str) -> None:
            state[n] = 1
            for m in graph[n]:
                if state.get(m) == 1:
                    loops.append(m)
                elif m not in state:
                    visit(m)
            state[n] = 2

        for n in graph:
            if n not in state:
                visit(n)
        return sorted(set(loops))


class RoutineLink(CoreModel):
    """Tier 1–2: a symptom or rule → a Medication Guide condition (the CMO confirms there)."""

    condition: str
    rules: list[str] = []
    symptoms: list[str] = []
    moderate_from_severity: int = Field(default=7, ge=1, le=10)  # symptom severity for tier 2
    covered_by: list[str] = []  # critical protocols that already handle it


class RoutineMap(CoreModel):
    version: str = Field(pattern=SEMVER_PATTERN)
    links: list[RoutineLink]


@dataclass(frozen=True)
class Treatments:
    protocols: dict[str, TreatmentProtocol]
    routine: RoutineMap

    def problems(self, formulary: Formulary | None, rule_ids: set[str]) -> list[str]:
        out: list[str] = []
        for link in self.routine.links:
            if formulary is None or formulary.condition(link.condition) is None:
                out.append(f"routine.json: unknown Medication Guide condition '{link.condition}'")
            out += [f"routine.json: unknown rule '{r}'" for r in link.rules if r not in rule_ids]
            out += [
                f"routine.json: unknown protocol '{p}'" for p in link.covered_by if p not in self.protocols
            ]
        return out


# --- the situation and the plan -------------------------------------------------------------------


@dataclass(frozen=True)
class Situation:
    """Everything the decision may use about this astronaut, now."""

    rules: frozenset[str] = frozenset()  # active alerts' rule ids
    symptoms: dict[str, int] = field(default_factory=dict)  # code → severity 1-10 (last 24 h, highest)
    vitals: dict[str, float] = field(default_factory=dict)  # latest accepted reading per indicator
    questionable: frozenset[str] = frozenset()  # indicators whose latest reading was doubtful
    profile: Profile = Profile()
    history: tuple[TakenDose, ...] = ()
    stock: dict[str, int] = field(default_factory=dict)
    pending: tuple[str, ...] = ()
    now: datetime = datetime.min


@dataclass(frozen=True)
class Rejected:
    medicine_id: str
    name: str
    codes: tuple[str, ...]
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class Pick:
    medicine: Medicine
    units: int
    dose_text: str
    status: Literal["ok", "caution"]
    checks: tuple[Check, ...]


@dataclass(frozen=True)
class StepPlan:
    step: Step
    pick: Pick | None = None
    rejected: tuple[Rejected, ...] = ()
    withheld: str | None = None  # why this medicine step gives nothing


@dataclass(frozen=True)
class ProtocolPlan:
    protocol: TreatmentProtocol
    matched_by: tuple[str, ...]
    steps: tuple[StepPlan, ...]
    remeasure: tuple[str, ...]  # doubtful readings to re-measure (before, or while starting if actFirst)
    do_not_give: tuple[str, ...]  # every rule that applies, with the protocol it comes from


@dataclass(frozen=True)
class RoutineHit:
    condition: str
    title: str
    tier: Literal[1, 2]
    matched_by: tuple[str, ...]


@dataclass(frozen=True)
class Assessment:
    tier: int  # 0 none, 1 mild, 2 needs treatment, 3 critical
    critical: tuple[ProtocolPlan, ...]
    routine: tuple[RoutineHit, ...]


def matched_by(protocol: TreatmentProtocol, s: Situation) -> list[str]:
    t = protocol.triggers
    out = [f"alert {r}" for r in t.rules if r in s.rules]
    out += [
        f"symptom {x.code} {s.symptoms[x.code]}/10"
        for x in t.symptoms
        if x.code in s.symptoms and s.symptoms[x.code] >= x.min_severity
    ]
    out += [
        f"{v.indicator} {s.vitals[v.indicator]:g} ({v.op} {v.value:g})"
        for v in t.vitals
        if v.indicator in s.vitals and compare(s.vitals[v.indicator], v.op, v.value)
    ]
    return out


def _forbidden(medicine: Medicine, rules: Iterable[tuple[DoNotGive, str]]) -> list[str]:
    hits = []
    for rule, source in rules:
        if rule.target in (medicine.id, medicine.route) or rule.target in medicine.groups:
            hits.append(f"Do not give: {rule.reason} ({source})")
    return hits


def _approved(check: Check) -> Check:
    """A check the protocol pre-approves for this emergency: shown, but never blocking."""
    base = check.text.split(": ")[0].rstrip(".")
    return Check("caution", check.code, f"{base}: pre-approved for this emergency, give it anyway.")


def plan_protocols(
    protocols: list[tuple[TreatmentProtocol, list[str]]], formulary: Formulary | None, s: Situation
) -> tuple[ProtocolPlan, ...]:
    """Merge the matched critical protocols into one plan (see the module docstring)."""
    ordered = sorted(protocols, key=lambda p: (p[0].priority, p[0].id))
    rules = [(d, p.title) for p, _ in ordered for d in p.do_not_give]
    history = list(s.history)
    planned: dict[str, str] = {}  # medicine id → protocol title
    out = []
    for protocol, matched in ordered:
        steps = []
        for step in protocol.steps:
            if step.kind != "medicine" or formulary is None:
                steps.append(StepPlan(step))
                continue
            rejected: list[Rejected] = []
            pick: Pick | None = None
            withheld: str | None = None
            for choice in step.medicines:
                med = formulary.medicine(choice.medicine)
                assert med is not None  # checked at load time
                if med.id in planned:
                    withheld = f"{med.name} is already in this plan ({planned[med.id]}): don't give it twice."
                    break
                forbidden = _forbidden(med, rules)
                if forbidden:
                    rejected.append(Rejected(med.id, med.name, ("do-not-give",), tuple(forbidden)))
                    continue
                units = choice.dose_units or units_for(med, None, history, s.now)
                checks, _ = check_medicine(
                    formulary, med, units, s.profile, history,
                    stock_left=s.stock.get(med.id, 0), pending=s.pending, now=s.now,
                )  # fmt: skip
                checks = [_approved(c) if c.code in step.override else c for c in checks]
                blocks = [c for c in checks if c.level == "block"]
                if blocks:
                    rejected.append(Rejected(med.id, med.name, tuple(c.code for c in blocks),
                                             tuple(c.text for c in blocks)))  # fmt: skip
                    continue
                pick = Pick(med, units, med.dose_text(units), "caution" if checks else "ok", tuple(checks))
                planned[med.id] = protocol.title
                history.append(TakenDose(med.id, units, s.now))
                break
            if pick is None and withheld is None:
                why = " ".join(r for x in rejected for r in x.reasons)
                withheld = f"No safe medicine in the kit for this step. {why} Skip it and go on."
            steps.append(StepPlan(step, pick, tuple(rejected), withheld))
        doubtful = tuple(
            v.indicator for v in protocol.triggers.vitals if v.indicator in s.questionable and any(
                m.startswith(v.indicator) for m in matched)
        )  # fmt: skip
        out.append(ProtocolPlan(protocol, tuple(matched), tuple(steps), doubtful,
                                tuple(f"{d.reason} ({src})" for d, src in rules)))  # fmt: skip
    return tuple(out)


def assess(
    treatments: Treatments, formulary: Formulary | None, s: Situation, *, chosen: str | None = None
) -> Assessment:
    """The whole decision. `chosen`: a protocol the crew opened themselves (Help now); it is planned
    first, together with every protocol the situation matches (their "do not give" rules apply)."""
    matched: list[tuple[TreatmentProtocol, list[str]]] = []
    for p in treatments.protocols.values():
        why = matched_by(p, s)
        if p.id == chosen:
            why = ["opened by the crew (Help now)", *why]
        if why:
            matched.append((p, why))
    plans = plan_protocols(matched, formulary, s)
    if chosen:
        plans = tuple(sorted(plans, key=lambda p: p.protocol.id != chosen))
    critical_ids = {p.protocol.id for p in plans}

    routine: list[RoutineHit] = []
    for link in treatments.routine.links:
        if critical_ids & set(link.covered_by):
            continue
        rules = [f"alert {r}" for r in link.rules if r in s.rules]
        syms = [(c, s.symptoms[c]) for c in link.symptoms if c in s.symptoms]
        if not (rules or syms):
            continue
        tier: Literal[1, 2] = 2 if rules or any(sev >= link.moderate_from_severity for _, sev in syms) else 1
        condition = formulary.condition(link.condition) if formulary else None
        routine.append(RoutineHit(
            link.condition, condition.title if condition else link.condition, tier,
            tuple(rules + [f"symptom {c} {sev}/10" for c, sev in syms]),
        ))  # fmt: skip
    routine.sort(key=lambda r: -r.tier)
    overall = 3 if plans else max((int(r.tier) for r in routine), default=0)
    return Assessment(overall, plans, tuple(routine))
