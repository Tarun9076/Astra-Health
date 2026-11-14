"""Load rules/*.json and cross-check them against the catalog, recommendations and protocols.

Returns problems instead of raising, so one run reports every broken file (test T-R-07).
"""

import string
from pathlib import Path

from pydantic import ValidationError

from astra.core.errors import describe_validation_error
from astra.core.indicators import IndicatorCatalog
from astra.core.rules.models import EVIDENCE_ATTRIBUTES, INSIGHT_SOURCES, Z_OPS, Rule


def check_rule(
    rule: Rule,
    catalog: IndicatorCatalog,
    recommendation_codes: set[str],
    protocol_ids: set[str],
) -> list[str]:
    problems: list[str] = []
    keys: list[str] = []
    for leaf in rule.leaves():
        keys.append(leaf.evidence_key)
        if leaf.op == "insight" or leaf.indicator in INSIGHT_SOURCES:
            if leaf.op != "insight" or leaf.indicator not in INSIGHT_SOURCES:
                problems.append(
                    f"op 'insight' needs one of {sorted(INSIGHT_SOURCES)} as its source "
                    f"(got '{leaf.indicator}' with op '{leaf.op}')"
                )
            if rule.severity == "Urgent":
                problems.append("Urgent rules may not depend on ML insights (TDD ADR-03)")
            continue
        if leaf.indicator not in catalog:
            problems.append(f"unknown indicator '{leaf.indicator}'")
            continue
        indicator = catalog.get(leaf.indicator)
        needs_baseline = leaf.op in Z_OPS or leaf.agg == "count_z_gte"
        if needs_baseline and not indicator.has_baseline:
            problems.append(
                f"'{leaf.indicator}' has no personal baseline (sigmaFloor is null), "
                f"so it can't use op '{leaf.op}' / agg '{leaf.agg}'"
            )

    duplicates = sorted({k for k in keys if keys.count(k) > 1})
    if duplicates:
        problems.append(f'evidence key used twice: {", ".join(duplicates)} (give one leaf an "as" name)')

    problems += [
        f"unknown recommendation '{c}'" for c in rule.recommendations if c not in recommendation_codes
    ]
    if rule.protocol is not None and rule.protocol not in protocol_ids:
        problems.append(f"unknown emergency protocol '{rule.protocol}'")

    if rule.persistence.min_triggers != 1:
        problems.append(
            "persistence.minTriggers > 1 is not supported yet; express repetition in the rule "
            "itself (e.g. agg 'count_z_gte' over a '3r' window)"
        )
    if rule.severity == "Urgent" and rule.protocol is None:
        problems.append("Urgent rules must name an emergency protocol")

    problems += _check_template(rule.reason_template, set(keys))
    return problems


def _check_template(template: str, keys: set[str]) -> list[str]:
    problems: list[str] = []
    try:
        fields = [(f, spec) for _, f, spec, _ in string.Formatter().parse(template) if f is not None]
    except ValueError as exc:
        return [f"reasonTemplate is not a valid format string: {exc}"]
    for field, spec in fields:
        key, _, attr = field.partition(".")
        if key not in keys:
            problems.append(f"reasonTemplate uses '{{{field}}}' but the rule has no evidence key '{key}'")
        elif attr not in EVIDENCE_ATTRIBUTES:
            problems.append(
                f"reasonTemplate uses '{{{field}}}'; attribute must be one of {sorted(EVIDENCE_ATTRIBUTES)}"
            )
        try:
            format(1.0, spec or "")
        except ValueError:
            problems.append(f"reasonTemplate format spec ':{spec}' in '{{{field}}}' is invalid")
    return problems


def load_rules(
    rules_dir: Path,
    catalog: IndicatorCatalog,
    recommendation_codes: set[str],
    protocol_ids: set[str],
) -> tuple[list[Rule], list[str]]:
    rules: list[Rule] = []
    problems: list[str] = []
    files = sorted(rules_dir.glob("*.json"))
    if not files:
        return [], [f"{rules_dir.name}/: no rule files found"]

    seen: dict[str, str] = {}
    for file in files:
        label = f"rules/{file.name}"
        try:
            rule = Rule.model_validate_json(file.read_text(encoding="utf-8"))
        except ValidationError as exc:
            problems.append(f"{label}: {describe_validation_error(exc)}")
            continue
        if file.stem != rule.id:
            problems.append(f"{label}: file name must match the rule id '{rule.id}'")
        if rule.id in seen:
            problems.append(f"{label}: duplicate rule id '{rule.id}' (also in {seen[rule.id]})")
        seen[rule.id] = label
        problems += [f"{label}: {p}" for p in check_rule(rule, catalog, recommendation_codes, protocol_ids)]
        rules.append(rule)
    return rules, problems
