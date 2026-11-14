"""The rule DSL as Pydantic models (LLD §6.1, §6.4).

A rule's `when` is a tree of conditions:
  {"all": [...]}, {"any": [...]}, {"not": {...}}  or a leaf
  {"indicator": "resting_hr", "agg": "latest", "window": "1d", "op": "z_gte", "value": 2.0}

Evaluation (Step 3) evaluates every child of all/any, so evidence for every leaf is
available to the reason template and the UI. Evidence is keyed by the leaf's `as` name,
or by its indicator code when `as` is absent.
"""

from collections.abc import Iterator
from typing import Annotated, Any, Literal, Self

from pydantic import Discriminator, Field, Tag, model_validator

from astra.core.base import CoreModel
from astra.core.enums import AlertCategory, Hazard, Severity

Agg = Literal["latest", "mean", "min", "max", "sum", "count", "slope", "count_z_gte"]
Op = Literal[
    "gt",
    "gte",
    "lt",
    "lte",
    "eq",
    "between",  # value <= x <= value2
    "outside",  # x <= value or x >= value2
    "z_gt",
    "z_gte",
    "z_lt",
    "z_lte",  # robust z-score vs the personal baseline
    "ratio_gte",  # x / baseline median >= value
    "pct_of_limit_gte",  # x as % of the mission limit >= value
    "insight",  # an ML insight in the window scored >= value (Attention rules only)
]

# Leaves with op "insight" name an insight kind instead of an indicator (LLD §10).
INSIGHT_SOURCES: dict[str, str] = {"ml_anomaly": "Anomaly", "ml_trend": "Trend"}

Z_OPS: frozenset[str] = frozenset({"z_gt", "z_gte", "z_lt", "z_lte"})
RANGE_OPS: frozenset[str] = frozenset({"between", "outside"})
EVIDENCE_ATTRIBUTES: frozenset[str] = frozenset({"value", "baseline", "sigma", "z", "ratio"})
WINDOW_PATTERN = r"^(\d+[dr]|mission)$"  # "4d" = 4 days, "3r" = last 3 readings
SEMVER_PATTERN = r"^\d+\.\d+\.\d+$"


class LeafNode(CoreModel):
    indicator: str
    as_: str | None = Field(default=None, alias="as", pattern=r"^[a-z][a-z0-9_]*$")
    agg: Agg
    agg_arg: float | None = None
    window: str = Field(default="1d", pattern=WINDOW_PATTERN)
    op: Op
    value: float
    value2: float | None = None

    @model_validator(mode="after")
    def _arguments(self) -> Self:
        if self.op in RANGE_OPS and (self.value2 is None or self.value2 <= self.value):
            raise ValueError(f"op '{self.op}' needs value2 greater than value")
        if self.op not in RANGE_OPS and self.value2 is not None:
            raise ValueError(f"value2 is only used by {sorted(RANGE_OPS)}")
        if self.agg == "count_z_gte" and self.agg_arg is None:
            raise ValueError("agg 'count_z_gte' needs aggArg (the z threshold to count)")
        return self

    @property
    def evidence_key(self) -> str:
        return self.as_ or self.indicator


class AllNode(CoreModel):
    all_: list["Condition"] = Field(alias="all", min_length=1)


class AnyNode(CoreModel):
    any_: list["Condition"] = Field(alias="any", min_length=1)


class NotNode(CoreModel):
    not_: "Condition" = Field(alias="not")


def _condition_kind(v: Any) -> str | None:
    if isinstance(v, dict):
        for key in ("all", "any", "not"):
            if key in v:
                return key
        return "leaf"
    kinds: dict[type, str] = {AllNode: "all", AnyNode: "any", NotNode: "not", LeafNode: "leaf"}
    return kinds.get(type(v))


Condition = Annotated[
    Annotated[LeafNode, Tag("leaf")]
    | Annotated[AllNode, Tag("all")]
    | Annotated[AnyNode, Tag("any")]
    | Annotated[NotNode, Tag("not")],
    Discriminator(_condition_kind),
]

for _model in (AllNode, AnyNode, NotNode):
    _model.model_rebuild()


def iter_leaves(node: LeafNode | AllNode | AnyNode | NotNode) -> Iterator[LeafNode]:
    if isinstance(node, LeafNode):
        yield node
    elif isinstance(node, AllNode):
        for child in node.all_:
            yield from iter_leaves(child)
    elif isinstance(node, AnyNode):
        for child in node.any_:
            yield from iter_leaves(child)
    else:
        yield from iter_leaves(node.not_)


class Persistence(CoreModel):
    min_triggers: int = Field(default=1, ge=1)


class Escalation(CoreModel):
    when_trigger_count_gte: int | None = Field(default=None, ge=1)


class Rule(CoreModel):
    id: str = Field(pattern=r"^[A-Z]{2,5}(-[A-Z0-9]+)+$")
    version: str = Field(pattern=SEMVER_PATTERN)
    title: str
    category: AlertCategory
    hazard: Hazard
    severity: Literal["Attention", "Urgent"]
    when: Condition
    persistence: Persistence = Persistence()
    reason_template: str
    recommendations: list[str] = []
    protocol: str | None = None
    escalation: Escalation = Escalation()
    disclaimer: str

    @property
    def severity_level(self) -> Severity:
        return Severity.URGENT if self.severity == "Urgent" else Severity.ATTENTION

    def leaves(self) -> list[LeafNode]:
        return list(iter_leaves(self.when))
