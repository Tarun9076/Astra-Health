"""ML insights inside the assessment (LLD §10.4).

At each evaluation moment, before the rules run:
  1. anomaly: score today's feature vector with the astronaut's weekly Isolation Forest;
  2. trend: test whether recovery strain has been rising over the last 10 days;
  3. store notable findings as `Insight` rows, so rule ML-ANOMALY-CORROBORATED can see them.

Running here (not in a background task) means the corroboration rule sees the same day's
score, live and in replayed history alike. It is guarded: any exception is logged and the
insight skipped, and a time budget stops ML work for the rest of a long batch, so ML can
never block or break the rule alerts (test T-ML-02).
"""

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from sqlmodel import Session

from astra.core.ids import uuid7
from astra.db.models import Insight, SyncOutbox
from astra.ml import isolation
from astra.ml.features import FEATURES, FILL_LIMIT_DAYS, STRAIN, feature_frame, strain
from astra.ml.trend import STRAIN_WINDOW_DAYS, strain_trend

if TYPE_CHECKING:
    from astra.services.assessment import Assessor

logger = logging.getLogger(__name__)

TIME_BUDGET_S = 10.0  # per assessment call (one live batch, or one replayed batch of history)
TRAIN_WINDOW_DAYS = 56
RETRAIN_EVERY_DAYS = 7

_models: dict[tuple[str, date], isolation.AnomalyModel] = {}  # (astronaut, valid_from) → model
_models_dir: Path | None = None


def configure(models_dir: Path | None) -> None:
    """Also keep each astronaut's latest model on disk (`models/{astronautId}.joblib`)."""
    global _models_dir
    _models_dir = models_dir


@dataclass(frozen=True)
class Found:
    kind: str  # Anomaly | Trend
    day: date
    score: float
    direction: str | None
    contributors: list[tuple[str, float]]
    explanation: str
    window_start: date
    window_end: date
    model_version: str


def retrain_date(day: date) -> date:
    return day - timedelta(days=day.toordinal() % RETRAIN_EVERY_DAYS)


def _model_for(assessor: "Assessor", astronaut_id: str, day: date) -> isolation.AnomalyModel | None:
    """This week's model, trained on the last 8 weeks of ordinary days (alert days left out).

    Cached in memory and on disk by version (a hash of the training rows), so a model is only
    refitted when its training data actually differs.
    """
    valid_from = retrain_date(day)
    abnormal = set().union(*assessor.abnormal_days.values()) if assessor.abnormal_days else set()
    days = [valid_from - timedelta(days=i) for i in range(TRAIN_WINDOW_DAYS, 0, -1)]
    rows = feature_frame(
        {d: {f: assessor.daily_z(f, d) for f in FEATURES} for d in days if d not in abnormal}
    )
    if len(rows) < isolation.MIN_TRAIN_DAYS:
        return None
    version = isolation.version_for(rows)
    key = (astronaut_id, valid_from)
    model = _models.get(key)
    if model is not None and model.version == version:
        return model
    path = _models_dir / f"{astronaut_id}.joblib" if _models_dir else None
    model = isolation.load(path) if path else None
    if model is None or model.version != version or model.valid_from != valid_from:
        model = isolation.train(rows, valid_from)
        if model is None:
            return None
        if path is not None:
            isolation.save(model, path)
    for old in [k for k in _models if k[0] == astronaut_id]:
        del _models[old]  # keep only the current week's model in memory
    _models[key] = model
    return model


def _name(assessor: "Assessor", code: str) -> str:
    return assessor.bundle.catalog.get(code).name.lower()


def _p(p: float) -> str:
    return "p < 0.001" if p < 0.001 else f"p = {p:.3f}"


def _sigma(z: float) -> str:
    return f"{z:+.1f}σ".replace("-", "−")


def anomaly_score(
    assessor: "Assessor", astronaut_id: str, day: date
) -> tuple[isolation.AnomalyScore, isolation.AnomalyModel] | None:
    """The day's anomaly score with this week's model; None without a model or enough readings."""
    model = _model_for(assessor, astronaut_id, day)
    if model is None:
        return None
    recent = [day - timedelta(days=i) for i in range(FILL_LIMIT_DAYS, -1, -1)]
    rows = feature_frame({d: {f: assessor.daily_z(f, d) for f in FEATURES} for d in recent})
    if day not in rows.index:
        return None
    (s,) = isolation.score(model, rows.loc[[day]])
    return s, model


def detect(assessor: "Assessor", astronaut_id: str, at: datetime) -> list[Found]:
    day = at.date()
    found: list[Found] = []

    scored = anomaly_score(assessor, astronaut_id, day)
    if scored is not None:
        s, model = scored
        if s.score >= isolation.ANOMALY_THRESHOLD:
            parts = ", ".join(f"{_name(assessor, f)} {_sigma(z)}" for f, z in s.contributors)
            found.append(Found(
                "Anomaly", day, s.score, None, s.contributors,
                f"This combination of readings was unusual for you (anomaly score {s.score:.2f}). "
                f"Furthest from your normal: {parts}.",
                day, day, model.version,
            ))  # fmt: skip

    days = [day - timedelta(days=i) for i in range(STRAIN_WINDOW_DAYS - 1, -1, -1)]
    z = {code: [assessor.daily_z(code, d) for d in days] for code in STRAIN}
    series = [strain({code: z[code][i] for code in STRAIN}) for i in range(len(days))]
    trend = strain_trend(series, z, STRAIN)
    if trend is not None:
        names = ", ".join(_name(assessor, code) for code, _ in trend.contributors)
        found.append(Found(
            "Trend", day, trend.level, "increasing", trend.contributors,
            f"Sleep, heart rate and how you feel drifted away from your normal together over "
            f"{STRAIN_WINDOW_DAYS} days (recovery strain {_sigma(trend.level)}, up {trend.rise:.1f}σ; "
            f"Mann–Kendall {_p(trend.p)}). Biggest moves: {names}.",
            days[0], day, f"mann-kendall:{STRAIN_WINDOW_DAYS}d",
        ))  # fmt: skip
    return found


def _insight_id(astronaut_id: str, kind: str, day: date) -> str:
    digest = hashlib.sha256(f"{astronaut_id}|{kind}|{day.isoformat()}".encode()).digest()
    ms = int(datetime.combine(day, datetime.min.time(), tzinfo=UTC).timestamp() * 1000)
    return str(uuid7(ms, digest))


def _store(session: Session, astronaut_id: str, f: Found) -> None:
    iid = _insight_id(astronaut_id, f.kind, f.day)
    row = session.get(Insight, iid)
    if row is None:
        row = Insight(
            id=iid, astronaut_id=astronaut_id, kind=f.kind, insight_date=f.day, score=f.score,
            indicator_codes="", contributors_json="[]", explanation="",
            window_start=f.window_start, window_end=f.window_end, model_version=f.model_version,
        )  # fmt: skip
    elif row.score > f.score:
        return  # keep the day's strongest finding
    row.score, row.direction = f.score, f.direction
    row.indicator_codes = ",".join(code for code, _ in f.contributors)
    row.contributors_json = json.dumps([{"indicator": c, "value": v} for c, v in f.contributors])
    row.explanation, row.model_version = f.explanation, f.model_version
    row.window_start, row.window_end = f.window_start, f.window_end
    row.created_at = datetime.now(UTC)
    session.add(row)
    session.add(SyncOutbox(entity_type="Insight", entity_id=iid, payload_json=row.model_dump_json()))


@dataclass
class InsightRunner:
    """One per assessment call: holds the time budget across its evaluation moments."""

    deadline: float

    @classmethod
    def start(cls) -> "InsightRunner":
        return cls(time.monotonic() + TIME_BUDGET_S)

    def run(self, session: Session, assessor: "Assessor", astronaut_id: str, at: datetime) -> list[Found]:
        if time.monotonic() > self.deadline:
            return []
        try:
            found = detect(assessor, astronaut_id, at)
        except Exception:
            logger.exception("ML insights failed for %s at %s; skipped (rules unaffected)", astronaut_id, at)
            return []
        if time.monotonic() > self.deadline:
            logger.warning("ML insights hit the %.0f s budget at %s; skipping the rest of this batch",
                           TIME_BUDGET_S, at)  # fmt: skip
        for f in found:
            _store(session, astronaut_id, f)
            key = (f.kind, f.day)
            assessor.insights[key] = max(f.score, assessor.insights.get(key, f.score))
        return found
