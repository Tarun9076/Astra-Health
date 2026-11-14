"""Wellness index, 0–100 (LLD §9). A transparent summary, NOT a clinical score.

Each domain starts at 100 and loses points for readings that are worse than the astronaut's
own normal (in the unhealthy direction only) and for active alerts on its indicators:

    z penalty      = clamp((|z_bad| − 1) × 15, 0, 40)     (no penalty within 1σ of normal)
    sleep          + 20 if sleep averaged < 6 h over the last 3 days
    radiation      + 15 if today's dose ≥ 1.5× normal, + 40 if ≥ 3×
    active alerts  + 25 (Attention) / + 50 (Urgent) to every domain the alert's rule reads

overall = weighted mean of the domains that have data (weights renormalised), then capped:
≤ 75 while any Attention alert is active, ≤ 40 while any Urgent alert is active.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

DOMAINS: dict[str, tuple[str, ...]] = {
    "Cardiovascular": ("resting_hr", "bp_sys", "bp_dia"),
    "Sleep": ("sleep_hours", "sleep_quality"),
    "Behavioral": ("mood", "stress", "fatigue"),
    "Activity": ("activity_min", "exercise_sessions", "strength_index"),
    "Metabolic": ("glucose", "body_weight", "hydration_ml"),
    "Environment": ("radiation_dose",),
}
WEIGHTS: dict[str, float] = {
    "Cardiovascular": 0.25,
    "Sleep": 0.20,
    "Behavioral": 0.20,
    "Activity": 0.15,
    "Metabolic": 0.10,
    "Environment": 0.10,
}
ATTENTION_CAP, URGENT_CAP = 75, 40
ALERT_PENALTY = {"Attention": 25.0, "Urgent": 50.0}


@dataclass(frozen=True)
class Reading:
    indicator: str
    value: float
    z: float | None
    worse_when: Literal["high", "low", "both"]
    ratio: float | None = None  # value / baseline median (radiation)


@dataclass(frozen=True)
class ActiveAlert:
    severity: Literal["Attention", "Urgent"]
    title: str
    indicators: frozenset[str]


@dataclass(frozen=True)
class Penalty:
    points: float
    reason: str


@dataclass(frozen=True)
class DomainScore:
    domain: str
    score: float | None  # None when the domain has no recent data
    penalties: tuple[Penalty, ...]


@dataclass(frozen=True)
class WellnessResult:
    overall: int | None
    domains: tuple[DomainScore, ...]
    cap_reason: str | None
    indicators_seen: int
    indicators_total: int


def z_penalty(z: float, worse_when: Literal["high", "low", "both"]) -> float:
    bad = z if worse_when == "high" else -z if worse_when == "low" else abs(z)
    return min(max((bad - 1.0) * 15.0, 0.0), 40.0)


def _domain(
    name: str, readings: Mapping[str, Reading], sleep_3d_mean: float | None, alerts: Sequence[ActiveAlert]
) -> DomainScore:
    members = DOMAINS[name]
    present = [readings[i] for i in members if i in readings]
    if not present:
        return DomainScore(name, None, ())
    penalties: list[Penalty] = []
    for r in present:
        if r.z is not None and (p := z_penalty(r.z, r.worse_when)) > 0:
            direction = "above" if r.z > 0 else "below"
            penalties.append(Penalty(round(p, 1), f"{r.indicator} {abs(r.z):.1f}σ {direction} your normal"))
        if r.indicator == "radiation_dose" and r.ratio is not None:
            if r.ratio >= 3:
                penalties.append(Penalty(40, f"radiation {r.ratio:.0f}× your normal daily dose"))
            elif r.ratio >= 1.5:
                penalties.append(Penalty(15, f"radiation {r.ratio:.1f}× your normal daily dose"))
    if name == "Sleep" and sleep_3d_mean is not None and sleep_3d_mean < 6:
        penalties.append(Penalty(20, f"sleep averaged {sleep_3d_mean:.1f} h over 3 days (under 6 h)"))
    for alert in alerts:
        if alert.indicators & set(members):
            penalties.append(Penalty(ALERT_PENALTY[alert.severity], f"active alert: {alert.title}"))
    score = max(0.0, 100.0 - sum(p.points for p in penalties))
    return DomainScore(name, round(score, 1), tuple(sorted(penalties, key=lambda p: -p.points)))


def wellness_index(
    readings: Mapping[str, Reading],
    *,
    sleep_3d_mean: float | None = None,
    alerts: Sequence[ActiveAlert] = (),
) -> WellnessResult:
    domains = tuple(_domain(name, readings, sleep_3d_mean, alerts) for name in DOMAINS)
    scored = [(d, WEIGHTS[d.domain]) for d in domains if d.score is not None]
    total_indicators = sum(len(v) for v in DOMAINS.values())
    seen = sum(1 for members in DOMAINS.values() for i in members if i in readings)
    if not scored:
        return WellnessResult(None, domains, None, seen, total_indicators)

    raw = sum((d.score or 0.0) * w for d, w in scored) / sum(w for _, w in scored)
    cap_reason = None
    if any(a.severity == "Urgent" for a in alerts):
        raw, cap_reason = min(raw, URGENT_CAP), f"capped at {URGENT_CAP} while an urgent alert is active"
    elif alerts:
        raw, cap_reason = min(raw, ATTENTION_CAP), f"capped at {ATTENTION_CAP} while an alert needs attention"
    return WellnessResult(int(round(raw)), domains, cap_reason, seen, total_indicators)
