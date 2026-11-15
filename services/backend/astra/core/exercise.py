"""Exercise coach (Step 13; LLD §15.6): today's plan from the astronaut's condition, and the summary
of a finished session. Pure functions over protocols/exercise-plans.json, no I/O.

The plan starts from the base plan and applies every adjustment whose alerts are open:
- any "rest" adjustment wins: rest day, no exercises;
- otherwise set changes add up ("lighter" -1 set, "more" +1 set of some exercises), never below
  1 set, and the longest rest asked for is used.
"""

from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Literal

from pydantic import Field, model_validator

from astra.core.base import CoreModel

Effect = Literal["rest", "lighter", "more"]


class ExerciseDef(CoreModel):
    id: str = Field(pattern=r"^[a-z_]+$")
    name: str
    device: str
    camera: Literal["side", "front"]  # the view in which the coach checks it best
    how_to: str
    loads: str


class PlanItem(CoreModel):
    exercise: str
    sets: int = Field(ge=1, le=10)
    reps: int = Field(ge=1, le=50)


class BasePlan(CoreModel):
    items: list[PlanItem] = Field(min_length=1)
    rest_seconds: int = Field(ge=15, le=600)


class Adjustment(CoreModel):
    id: str
    effect: Effect
    when_alerts: list[str] = Field(default_factory=list)
    when_severity: Literal["Urgent"] | None = None
    sets_change: int = Field(default=0, ge=-5, le=0)
    extra_sets: dict[str, int] = Field(default_factory=dict)
    rest_seconds: int | None = Field(default=None, ge=15, le=600)
    reason: str

    @model_validator(mode="after")
    def _has_trigger(self) -> "Adjustment":
        if not self.when_alerts and self.when_severity is None:
            raise ValueError(f"adjustment '{self.id}' needs whenAlerts or whenSeverity")
        return self


class ExerciseProgramme(CoreModel):
    version: str
    exercises: list[ExerciseDef] = Field(min_length=1)
    base_plan: BasePlan
    adjustments: list[Adjustment]
    disclaimer: str

    def problems(self, rule_ids: set[str]) -> list[str]:
        """References to exercises or rules that do not exist."""
        known = {e.id for e in self.exercises}
        out = [
            f"basePlan: unknown exercise '{i.exercise}'"
            for i in self.base_plan.items
            if i.exercise not in known
        ]
        for a in self.adjustments:
            out += [f"adjustment '{a.id}': unknown rule '{r}'" for r in a.when_alerts if r not in rule_ids]
            out += [f"adjustment '{a.id}': unknown exercise '{e}'" for e in a.extra_sets if e not in known]
        return out


@dataclass(frozen=True)
class OpenAlert:
    rule_id: str
    severity: str  # Attention | Urgent
    title: str


@dataclass(frozen=True)
class AppliedAdjustment:
    id: str
    effect: Effect
    reason: str
    because: tuple[str, ...]  # titles of the alerts that triggered it


@dataclass(frozen=True)
class PlannedExercise:
    exercise: ExerciseDef
    sets: int
    reps: int


@dataclass(frozen=True)
class ExercisePlan:
    level: Literal["rest", "lighter", "standard", "more", "adjusted"]
    items: tuple[PlannedExercise, ...]
    rest_seconds: int
    adjustments: tuple[AppliedAdjustment, ...]

    @property
    def rest_day(self) -> bool:
        return self.level == "rest"


def plan_for(programme: ExerciseProgramme, alerts: Iterable[OpenAlert]) -> ExercisePlan:
    alerts = list(alerts)
    applied: list[tuple[Adjustment, tuple[str, ...]]] = []
    for adj in programme.adjustments:
        hits = [a for a in alerts if a.rule_id in adj.when_alerts or a.severity == adj.when_severity]
        if hits:
            applied.append((adj, tuple(dict.fromkeys(a.title for a in hits))))
    out = tuple(AppliedAdjustment(a.id, a.effect, a.reason, because) for a, because in applied)
    if any(a.effect == "rest" for a, _ in applied):
        rest_only = tuple(x for x in out if x.effect == "rest")
        return ExercisePlan("rest", (), programme.base_plan.rest_seconds, rest_only)

    defs = {e.id: e for e in programme.exercises}
    change = sum(a.sets_change for a, _ in applied)
    items = []
    for item in programme.base_plan.items:
        extra = sum(a.extra_sets.get(item.exercise, 0) for a, _ in applied)
        items.append(PlannedExercise(defs[item.exercise], max(1, item.sets + change + extra), item.reps))
    rest = max([programme.base_plan.rest_seconds] + [a.rest_seconds for a, _ in applied if a.rest_seconds])
    effects = {a.effect for a, _ in applied}
    level: Literal["lighter", "standard", "more", "adjusted"] = "standard"
    if effects == {"lighter"}:
        level = "lighter"
    elif effects == {"more"}:
        level = "more"
    elif effects:
        level = "adjusted"
    return ExercisePlan(level, tuple(items), rest, out)


# --- results ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SetResult:
    reps: int
    target: int
    form_score: int | None  # 0-100, None when no rep was counted


@dataclass(frozen=True)
class ExerciseResult:
    exercise: str
    name: str
    sets: tuple[SetResult, ...]
    tips: tuple[tuple[str, int], ...]  # (tip shown to the astronaut, times)


def form_score(results: Sequence[ExerciseResult]) -> int | None:
    """Rep-weighted mean of the set scores."""
    scored = [(s.form_score, s.reps) for r in results for s in r.sets if s.form_score is not None and s.reps]
    reps = sum(n for _, n in scored)
    return round(sum(score * n for score, n in scored) / reps) if reps else None


def session_summary(results: Sequence[ExerciseResult], minutes: float) -> str:
    """Plain-language summary of a finished session, from the counts only."""
    sets = sum(len(r.sets) for r in results)
    reps = sum(s.reps for r in results for s in r.sets)
    if not reps:
        return "No repetitions were counted in this session."
    planned = sum(s.target for r in results for s in r.sets)
    exercises = f"{len(results)} exercise{'s' if len(results) != 1 else ''}"
    parts = [f"{exercises}, {sets} sets, {reps} reps in {minutes:.0f} min"]
    if planned and reps < planned:
        parts[0] += f" ({reps} of {planned} planned)"
    score = form_score(results)
    if score is not None:
        word = (
            "very good" if score >= 90 else "good" if score >= 75 else "needs work" if score >= 50 else "poor"
        )
        parts.append(f"Form {score}% ({word})")
    tips: Counter[tuple[str, str]] = Counter()
    for r in results:
        for tip, n in r.tips:
            tips[(tip, r.name)] += n
    if tips:
        (tip, name), n = tips.most_common(1)[0]
        parts.append(f"Most frequent tip: “{tip}” ({n}× in {name.lower()})")
    else:
        parts.append("No posture tips were needed")
    return ". ".join(parts) + "."
