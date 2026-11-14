"""Per-astronaut Isolation Forest anomaly scoring (LLD §10.2).

The model learns what an ordinary day looks like *for this astronaut* (all features are
personal z-scores) and scores how unusual a new day's combination of readings is.

Score scale (0–1, explainable): 0.5 = as unusual as the astronaut's 1-in-20 ordinary day,
0.6 = 1.5× as far out; 0 = an ordinary day. Isolation Forest measures how *isolated* a day
is, not how far: scores level off around 0.6–0.7 even for very large deviations, which is why
the score only ever corroborates the deterministic rules. Contributors are the features furthest
from normal that day. ML never sets alert severity; it only corroborates (TDD ADR-03).
"""

import hashlib
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

from astra.ml.features import FEATURES

MODEL_FAMILY = "iforest-1"
MIN_TRAIN_DAYS = 21
ANOMALY_THRESHOLD = 0.6  # stored as an insight at or above this score
N_TOP_CONTRIBUTORS = 3


@dataclass(frozen=True)
class AnomalyModel:
    model: IsolationForest
    q50: float  # median raw anomaly of the training days
    q95: float  # 95th percentile raw anomaly of the training days
    version: str
    n_train: int
    train_start: date
    train_end: date
    valid_from: date  # first day this model scores (its weekly retrain date)


@dataclass(frozen=True)
class AnomalyScore:
    day: date
    score: float
    contributors: list[tuple[str, float]]  # (feature, z), largest |z| first


def version_for(rows: pd.DataFrame) -> str:
    """Model version = hash of the training window, so the same days always give the same model."""
    x = np.round(rows[list(FEATURES)].to_numpy(dtype=float), 3)
    digest = hashlib.sha256(x.tobytes() + str(list(rows.index)).encode()).hexdigest()[:12]
    return f"{MODEL_FAMILY}:{digest}"


def train(rows: pd.DataFrame, valid_from: date) -> AnomalyModel | None:
    """Fit on ordinary days (the caller leaves out alert days). None if there are too few days."""
    if len(rows) < MIN_TRAIN_DAYS:
        return None
    x = rows[list(FEATURES)].to_numpy(dtype=float)
    model = IsolationForest(n_estimators=200, contamination="auto", random_state=42).fit(x)
    raw = -model.score_samples(x)
    q50, q95 = (float(q) for q in np.percentile(raw, [50, 95]))
    days = list(rows.index)
    return AnomalyModel(
        model, q50, max(q95, q50 + 1e-6), version_for(rows), len(rows), days[0], days[-1], valid_from
    )


def normalise(raw: float, q50: float, q95: float) -> float:
    """Map the raw Isolation Forest anomaly to 0–1 relative to the astronaut's own training days."""
    a = max(0.0, (raw - q50) / (q95 - q50))
    return a / (1.0 + a)


def score(model: AnomalyModel, rows: pd.DataFrame) -> list[AnomalyScore]:
    if rows.empty:
        return []
    x = rows[list(FEATURES)].to_numpy(dtype=float)
    raw = -model.model.score_samples(x)
    out = []
    for day, r, values in zip(rows.index, raw, x, strict=True):
        ranked = sorted(zip(FEATURES, values, strict=True), key=lambda fv: -abs(fv[1]))
        top = [(f, round(float(v), 2)) for f, v in ranked[:N_TOP_CONTRIBUTORS] if abs(v) > 0]
        out.append(AnomalyScore(day, round(normalise(float(r), model.q50, model.q95), 2), top))
    return out


def save(model: AnomalyModel, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, path)


def load(path: Path) -> AnomalyModel | None:
    if not path.exists():
        return None
    loaded = joblib.load(path)  # our own file in the git-ignored models/ directory
    return loaded if isinstance(loaded, AnomalyModel) else None
