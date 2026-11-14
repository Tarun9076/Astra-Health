"""Run the rules over an astronaut's history (HLD §5.1).

The whole relevant history is loaded once into memory, then the rules are evaluated at
each requested moment in time order. Backfilled history is evaluated once per day, so past
episodes (e.g. the day-87 solar storm) raise alerts just as they would have live.
"""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from sqlmodel import Session, col, select

from astra.core.baselines import (
    Baseline,
    DailyValue,
    compute_baseline,
    compute_preflight_baseline,
    daily_values,
)
from astra.core.enums import AlertStatus, MeasurementQuality
from astra.core.protocols import ProtocolBundle
from astra.core.rules.engine import Point, RuleOutcome, evaluate, indicators_used
from astra.db.models import Astronaut, HealthAlert, HealthBaseline, HealthMeasurement, Insight, Mission
from astra.ml.features import FEATURES
from astra.services.alerts import AlertChanges, apply_outcomes
from astra.services.insights import InsightRunner
from astra.services.wellness import WELLNESS_INDICATORS, compute_wellness, store_wellness

HISTORY_MARGIN = timedelta(days=45)  # 28-day window + 3 skipped days + slack


@dataclass
class _Context:
    """EvaluationContext backed by the in-memory history."""

    assessor: "Assessor"
    as_of: datetime

    @property
    def mission_start(self) -> date | None:
        return self.assessor.mission_start

    def points(self, indicator: str) -> Sequence[Point]:
        return self.assessor.series.get(indicator, [])

    def baseline(self, indicator: str) -> Baseline | None:
        return self.assessor.baseline(indicator, self.as_of.date())

    def limit(self, indicator: str) -> float | None:
        return self.assessor.limits.get(indicator)

    def insight_score(self, kind: str, since: datetime) -> float | None:
        lo, hi = since.date(), self.as_of.date()
        scores = [s for (k, day), s in self.assessor.insights.items() if k == kind and lo <= day <= hi]
        return max(scores) if scores else None


@dataclass
class Assessor:
    bundle: ProtocolBundle
    mission_start: date | None
    series: dict[str, list[Point]]
    limits: dict[str, float] = field(default_factory=dict)
    abnormal_days: dict[str, set[date]] = field(default_factory=lambda: defaultdict(set))
    insights: dict[tuple[str, date], float] = field(default_factory=dict)  # (kind, day) → best score

    def __post_init__(self) -> None:
        self._daily: dict[str, list[DailyValue]] = {
            ind: daily_values((p.t, p.value) for p in pts) for ind, pts in self.series.items()
        }
        self._daily_map = {ind: {dv.day: dv.value for dv in dvs} for ind, dvs in self._daily.items()}
        self._preflight: dict[str, Baseline | None] = {}
        self._z: dict[tuple[str, date], float | None] = {}

    def daily_z(self, indicator: str, day: date) -> float | None:
        """That day's value as a robust z-score vs the baseline the rules used that day (ML features)."""
        key = (indicator, day)
        if key not in self._z:
            value = self._daily_map.get(indicator, {}).get(day)
            base = self.baseline(indicator, day) if value is not None else None
            self._z[key] = base.z(value) if base is not None and value is not None else None
        return self._z[key]

    def preflight(self, indicator: str) -> Baseline | None:
        if self.mission_start is None:
            return None
        if indicator not in self._preflight:
            meta = self.bundle.catalog.get(indicator)
            self._preflight[indicator] = compute_preflight_baseline(
                indicator, self._daily.get(indicator, []), self.mission_start, sigma_floor=meta.sigma_floor
            )
        return self._preflight[indicator]

    def baseline(self, indicator: str, as_of: date) -> Baseline | None:
        meta = self.bundle.catalog.get(indicator)
        on_mission = self.mission_start is not None and as_of >= self.mission_start
        return compute_baseline(
            indicator,
            self._daily.get(indicator, []),
            as_of,
            sigma_floor=meta.sigma_floor,
            excluded_days=self.abnormal_days[indicator],
            not_before=self.mission_start if on_mission else None,
            # Physiology falls back to the pre-flight normal early in the mission. Environment-driven
            # indicators (no sigmaFloor, e.g. radiation) don't: Earth's normal isn't Mars's.
            preflight=self.preflight(indicator) if on_mission and meta.has_baseline else None,
        )

    def evaluate_at(self, as_of: datetime) -> list[RuleOutcome]:
        outcomes = evaluate(self.bundle.rules, _Context(self, as_of))
        for outcome in outcomes:
            if outcome.matched:  # don't learn abnormal days as "normal"
                for leaf in outcome.rule.leaves():
                    self.abnormal_days[leaf.indicator].add(as_of.date())
        return outcomes


@dataclass
class AssessmentResult:
    changes: AlertChanges = field(default_factory=AlertChanges)
    evaluations: int = 0


def load_assessor(
    session: Session, bundle: ProtocolBundle, astronaut: Astronaut, since: datetime
) -> Assessor:
    mission = session.get(Mission, astronaut.mission_id)
    mission_start = mission.start_date if mission else None
    profile = bundle.mission_profiles.get(mission.profile_code) if mission else None
    limits = {"radiation_dose": profile.radiation_limit_msv} if profile else {}

    indicators = (
        indicators_used(bundle.rules)
        | WELLNESS_INDICATORS
        | set(FEATURES)
        | {
            "resting_hr",
            "bp_sys",
            "bp_dia",
            "body_temp",
            "spo2",
            "glucose",
            "sleep_hours",
            "mood",
            "stress",
            "fatigue",
            "activity_min",
            "radiation_dose",
        }
    )
    if mission_start is not None:
        since = min(
            since, datetime.combine(mission_start, datetime.min.time(), tzinfo=UTC) - timedelta(days=31)
        )
    rows = session.exec(
        select(HealthMeasurement)
        .where(
            HealthMeasurement.astronaut_id == astronaut.id,
            col(HealthMeasurement.indicator_code).in_(indicators),
            HealthMeasurement.quality == MeasurementQuality.VALID.value,
            col(HealthMeasurement.channel).in_(["", "Total"]),
            col(HealthMeasurement.measured_at) >= since,
        )
        .order_by(col(HealthMeasurement.measured_at))
    ).all()
    series: dict[str, list[Point]] = defaultdict(list)
    for r in rows:
        if r.value is not None:
            series[r.indicator_code].append(Point(r.measured_at, r.value))

    assessor = Assessor(bundle, mission_start, dict(series), limits)
    for ins in session.exec(
        select(Insight).where(Insight.astronaut_id == astronaut.id, col(Insight.insight_date) >= since.date())
    ).all():
        key = (ins.kind, ins.insight_date)
        assessor.insights[key] = max(ins.score, assessor.insights.get(key, ins.score))
    rules = {r.id: r for r in bundle.rules}
    alerts = session.exec(
        select(HealthAlert).where(
            HealthAlert.astronaut_id == astronaut.id, HealthAlert.status != AlertStatus.DISMISSED.value
        )
    ).all()
    for alert in alerts:  # days already flagged abnormal stay out of the baselines
        rule = rules.get(alert.rule_id)
        if rule is None:
            continue
        day = alert.first_triggered_at.date()
        while day <= alert.last_triggered_at.date():
            for leaf in rule.leaves():
                assessor.abnormal_days[leaf.indicator].add(day)
            day += timedelta(days=1)
    return assessor


def assess(
    session: Session,
    bundle: ProtocolBundle,
    astronaut: Astronaut,
    eval_times: Sequence[datetime],
    *,
    node_id: str,
) -> AssessmentResult:
    """Evaluate all rules at each moment in `eval_times` (oldest first) and apply alert changes."""
    result = AssessmentResult()
    if not eval_times:
        return result
    times = sorted(set(eval_times))
    assessor = load_assessor(session, bundle, astronaut, times[0] - HISTORY_MARGIN)
    ml = InsightRunner.start()
    for at in times:
        ml.run(session, assessor, astronaut.id, at)  # before the rules: ML-ANOMALY-CORROBORATED reads it
        outcomes = assessor.evaluate_at(at)
        result.changes.extend(apply_outcomes(session, bundle, astronaut, outcomes, at, node_id=node_id))
        result.evaluations += 1
        session.flush()  # so the wellness index sees alerts raised at this moment
        store_wellness(
            session, astronaut.id, at.date(), compute_wellness(session, assessor, astronaut.id, at)
        )
    _store_baselines(session, assessor, astronaut, times[-1].date())
    return result


def _store_baselines(session: Session, assessor: Assessor, astronaut: Astronaut, as_of: date) -> None:
    existing = {
        (b.indicator_code, b.source): b
        for b in session.exec(select(HealthBaseline).where(HealthBaseline.astronaut_id == astronaut.id)).all()
    }
    for indicator in assessor.series:
        for source, baseline in (
            ("Rolling", assessor.baseline(indicator, as_of)),
            ("Preflight", assessor.preflight(indicator)),
        ):
            if baseline is None or baseline.source != source:
                continue
            row = existing.get((indicator, source)) or HealthBaseline(
                astronaut_id=astronaut.id,
                indicator_code=indicator,
                source=source,
                median=0,
                mad=0,
                sigma=0,
                sample_count=0,
            )
            row.median, row.mad, row.sigma = baseline.median, baseline.mad, baseline.sigma
            row.sample_count, row.provisional = baseline.samples, baseline.provisional
            row.window_start = _dt(baseline.window_start)
            row.window_end = _dt(baseline.window_end)
            row.computed_at = datetime.now(UTC)
            session.add(row)


def _dt(d: date | None) -> datetime | None:
    return datetime.combine(d, datetime.min.time(), tzinfo=UTC) if d else None


def evaluation_times(stored: Sequence[HealthMeasurement], *, backfill: bool, now: datetime) -> list[datetime]:
    """When to evaluate after a batch: once per day touched (backfill) or at the newest reading (live)."""
    valid = [m.measured_at for m in stored if m.quality == MeasurementQuality.VALID.value]
    if not valid:
        return []
    if not backfill:
        return [min(max(valid), now)]
    end_of_days = {
        datetime.combine(t.date(), datetime.max.time().replace(microsecond=0), tzinfo=UTC) for t in valid
    }
    return sorted(min(t, now) for t in end_of_days)
