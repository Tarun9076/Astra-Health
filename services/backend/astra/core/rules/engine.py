"""Deterministic rule evaluation (LLD §6.3). Pure: all data comes through an EvaluationContext.

    evaluate(rules, ctx) -> [RuleOutcome(rule, matched, evidence, reason)]

`all` / `any` evaluate EVERY child (no short-circuit), so the evidence for every leaf is
available to the reason template and the UI. Missing data or a missing baseline makes a
leaf false and is recorded as `missing=True` in its evidence.
"""

import bisect
import string
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, time, timedelta
from statistics import mean, median
from typing import Any, Protocol

from astra.core.baselines import Baseline
from astra.core.rules.models import AllNode, AnyNode, LeafNode, NotNode, Rule


@dataclass(frozen=True)
class Point:
    t: datetime
    value: float


class EvaluationContext(Protocol):
    """What the engine needs to know about one astronaut at one moment."""

    @property
    def as_of(self) -> datetime: ...

    @property
    def mission_start(self) -> date | None: ...

    def points(self, indicator: str) -> Sequence[Point]:
        """All valid readings for the indicator, oldest first (the engine applies the window)."""
        ...

    def baseline(self, indicator: str) -> Baseline | None: ...

    def limit(self, indicator: str) -> float | None:
        """Mission limit for pct_of_limit_gte (e.g. career radiation dose)."""
        ...

    def has_insight(self, indicator: str, since: datetime) -> bool: ...


@dataclass(frozen=True)
class Evidence:
    indicator: str
    agg: str
    window: str
    value: float | None = None
    baseline: float | None = None
    sigma: float | None = None
    z: float | None = None
    ratio: float | None = None
    n: int = 0
    missing: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in asdict(self).items()}


@dataclass(frozen=True)
class RuleOutcome:
    rule: Rule
    matched: bool
    evidence: dict[str, Evidence]
    reason: str

    def evidence_json(self) -> dict[str, dict[str, Any]]:
        return {key: ev.as_dict() for key, ev in self.evidence.items()}


# --- windows & aggregations ----------------------------------------------------------------------


def window_points(
    points: Sequence[Point], window: str, as_of: datetime, mission_start: date | None
) -> list[Point]:
    times = [p.t for p in points]
    end = bisect.bisect_right(times, as_of)
    if window == "mission":
        since = (
            datetime.combine(mission_start, time.min, tzinfo=UTC)
            if mission_start
            else datetime.min.replace(tzinfo=UTC)
        )
        return [p for p in points[:end] if p.t >= since]
    size, unit = int(window[:-1]), window[-1]
    if unit == "r":
        return list(points[max(0, end - size) : end])
    start = bisect.bisect_right(times, as_of - timedelta(days=size))
    return list(points[start:end])


def _theil_sen_slope_per_day(pts: Sequence[Point]) -> float | None:
    slopes = [
        (b.value - a.value) / ((b.t - a.t).total_seconds() / 86400)
        for i, a in enumerate(pts)
        for b in pts[i + 1 :]
        if b.t > a.t
    ]
    return float(median(slopes)) if slopes else None


def _aggregate(leaf: LeafNode, pts: Sequence[Point], base: Baseline | None) -> float | None:
    values = [p.value for p in pts]
    match leaf.agg:
        case "latest":
            return values[-1]
        case "mean":
            return float(mean(values))
        case "min":
            return min(values)
        case "max":
            return max(values)
        case "sum":
            return float(sum(values))
        case "count":
            return float(len(values))
        case "slope":
            return _theil_sen_slope_per_day(pts)
        case "count_z_gte":
            if base is None or leaf.agg_arg is None:
                return None
            zs = [base.z(v) for v in values]
            return float(sum(1 for z in zs if z is not None and z >= leaf.agg_arg))
    return None


# --- evaluation ----------------------------------------------------------------------------------


def _compare(op: str, x: float | None, value: float, value2: float | None) -> bool:
    if x is None:
        return False
    match op:
        case "gt" | "z_gt":
            return x > value
        case "gte" | "z_gte" | "ratio_gte" | "pct_of_limit_gte":
            return x >= value
        case "lt" | "z_lt":
            return x < value
        case "lte" | "z_lte":
            return x <= value
        case "eq":
            return x == value
        case "between":
            return value2 is not None and value <= x <= value2
        case "outside":
            return value2 is not None and (x <= value or x >= value2)
    return False


def _eval_leaf(leaf: LeafNode, ctx: EvaluationContext) -> tuple[bool, Evidence]:
    pts = window_points(ctx.points(leaf.indicator), leaf.window, ctx.as_of, ctx.mission_start)
    base = ctx.baseline(leaf.indicator)
    common: dict[str, Any] = {
        "indicator": leaf.indicator,
        "agg": leaf.agg,
        "window": leaf.window,
        "n": len(pts),
    }
    if base is not None:
        common |= {"baseline": base.median, "sigma": base.sigma}

    if leaf.op == "insight":
        since = ctx.as_of - timedelta(days=int(leaf.window[:-1])) if leaf.window.endswith("d") else ctx.as_of
        found = ctx.has_insight(leaf.indicator, since)
        return found, Evidence(**common, value=1.0 if found else 0.0)

    if not pts:
        return False, Evidence(**common, missing=True)
    value = _aggregate(leaf, pts, base)
    if value is None:
        return False, Evidence(**common, missing=True)

    level_agg = leaf.agg in {"latest", "mean", "min", "max"}
    z = base.z(value) if base is not None and level_agg else None
    ratio = base.ratio(value) if base is not None and level_agg else None
    if leaf.op == "pct_of_limit_gte":
        limit = ctx.limit(leaf.indicator)
        ratio = value / limit if limit else None
        tested = ratio * 100 if ratio is not None else None
    elif leaf.op.startswith("z_"):
        tested = z
    elif leaf.op == "ratio_gte":
        tested = ratio
    else:
        tested = value

    missing = tested is None
    matched = _compare(leaf.op, tested, leaf.value, leaf.value2)
    return matched, Evidence(**common, value=value, z=z, ratio=ratio, missing=missing)


def _eval(
    node: LeafNode | AllNode | AnyNode | NotNode, ctx: EvaluationContext, evidence: dict[str, Evidence]
) -> bool:
    if isinstance(node, LeafNode):
        matched, ev = _eval_leaf(node, ctx)
        evidence[node.evidence_key] = ev
        return matched
    if isinstance(node, AllNode):
        return all([_eval(child, ctx, evidence) for child in node.all_])  # list: evaluate every child
    if isinstance(node, AnyNode):
        return any([_eval(child, ctx, evidence) for child in node.any_])
    return not _eval(node.not_, ctx, evidence)


class _SafeFormatter(string.Formatter):
    """Renders missing values as 'n/a' instead of crashing the alert."""

    def format_field(self, value: Any, format_spec: str) -> str:
        if value is None:
            return "n/a"
        return format(value, format_spec)


def render_reason(template: str, evidence: Mapping[str, Evidence]) -> str:
    return str(_SafeFormatter().vformat(template, (), dict(evidence)))


def evaluate_rule(rule: Rule, ctx: EvaluationContext) -> RuleOutcome:
    evidence: dict[str, Evidence] = {}
    matched = _eval(rule.when, ctx, evidence)
    reason = render_reason(rule.reason_template, evidence) if matched else ""
    return RuleOutcome(rule, matched, evidence, reason)


def evaluate(rules: Sequence[Rule], ctx: EvaluationContext) -> list[RuleOutcome]:
    return [evaluate_rule(rule, ctx) for rule in rules]


def indicators_used(rules: Sequence[Rule]) -> set[str]:
    return {leaf.indicator for rule in rules for leaf in rule.leaves()}
