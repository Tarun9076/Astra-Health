"""Database tables (LLD §3). SQLModel = SQLAlchemy tables with Pydantic-style fields.

Conventions:
- ids are UUIDv7 strings generated at the edge (astra.core.ids)
- timestamps are timezone-aware UTC (UTCDateTime)
- enum-like columns store the StrEnum *value* (e.g. "Valid"), so the DB is readable
- raw measurements are append-only evidence; derived tables (alerts, baselines, …) can be rebuilt
"""

from datetime import UTC, date, datetime

from sqlalchemy import Index, UniqueConstraint
from sqlmodel import Field, SQLModel

from astra.core.ids import new_id
from astra.db.types import UTCDateTime


def utcnow() -> datetime:
    return datetime.now(UTC)


# --- Identity & crew ---------------------------------------------------------------------------


class UserAccount(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    username: str = Field(unique=True, index=True)
    password_hash: str
    role: str  # astra.core.enums.Role value
    astronaut_id: str | None = Field(default=None, foreign_key="astronaut.id")
    display_name: str
    is_active: bool = True


class Mission(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    code: str = Field(unique=True, index=True)
    name: str
    profile_code: str
    start_date: date


class Astronaut(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    code: str = Field(unique=True, index=True)
    display_name: str
    role_title: str
    mission_id: str = Field(foreign_key="mission.id")


# --- Raw evidence (append-only) ------------------------------------------------------------------


class HealthMeasurement(SQLModel, table=True):
    """One reading. Radiation is stored here too, one row per dosimeter channel."""

    __table_args__ = (
        Index("ix_measurement_series", "astronaut_id", "indicator_code", "measured_at"),
        UniqueConstraint(
            "astronaut_id",
            "indicator_code",
            "channel",
            "measured_at",
            "device_id",
            name="uq_measurement_reading",
        ),
    )

    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id")
    indicator_code: str
    channel: str = ""  # "" for non-radiation; "Total" | "Charged" | "Neutron" for radiation_dose
    value: float | None = None  # canonical unit; None when it could not be converted
    unit: str | None = None
    original_value: float
    original_unit: str
    measured_at: datetime = Field(sa_type=UTCDateTime)
    received_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    source: str  # MeasurementSource value
    device_id: str = ""  # "" for manual entry
    panel_id: str | None = None
    quality: str  # MeasurementQuality value
    quality_reason: str | None = None
    supersedes_id: str | None = None
    is_simulated: bool = False
    origin_node_id: str


class WellnessCheckin(SQLModel, table=True):
    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    checkin_date: date
    sleep_hours: float
    sleep_quality: int
    mood: int
    stress: int
    fatigue: int
    private_note: str | None = None  # visible to the astronaut only (encrypted in P2)
    completed_in_seconds: int | None = None
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


class Symptom(SQLModel, table=True):
    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    symptom_code: str
    free_text: str | None = None
    severity: int  # 1–10
    onset_at: datetime = Field(sa_type=UTCDateTime)
    resolved_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    body_region: str | None = None
    red_flag: bool = False
    source: str = "Form"


# --- Derived (re-computable) ---------------------------------------------------------------------


class HealthBaseline(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("astronaut_id", "indicator_code", "source", name="uq_baseline"),)

    id: str = Field(default_factory=new_id, primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id")
    indicator_code: str
    method: str = "robust_median_mad"
    median: float
    mad: float
    sigma: float
    sample_count: int
    window_start: datetime | None = Field(default=None, sa_type=UTCDateTime)
    window_end: datetime | None = Field(default=None, sa_type=UTCDateTime)
    source: str  # Preflight | Rolling | Manual
    provisional: bool = False
    computed_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


class HealthAlert(SQLModel, table=True):
    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    rule_id: str
    rule_version: str
    category: str
    hazard: str
    severity: str  # Attention | Urgent
    status: str  # AlertStatus value
    title: str
    reason: str
    evidence_json: str
    first_triggered_at: datetime = Field(sa_type=UTCDateTime)
    last_triggered_at: datetime = Field(sa_type=UTCDateTime)
    trigger_count: int = 1
    acknowledged_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    acknowledged_by: str | None = None
    reviewed_by: str | None = None
    resolved_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    resolution_note: str | None = None
    escalation_required: bool = False
    protocol: str | None = None  # emergency protocol id for Urgent rules
    consecutive_clear: int = 0  # evaluations in a row where the rule no longer matched
    version: int = 1
    origin_node_id: str
    updated_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


class RecommendationTask(SQLModel, table=True):
    id: str = Field(default_factory=new_id, primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    alert_id: str | None = Field(default=None, foreign_key="healthalert.id")
    code: str  # REC-… from protocols/recommendations.json
    status: str = "Pending"  # Pending | Done | Skipped | Closed (its alert was resolved)
    due_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    completed_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    source: str = "Rule"  # Rule | Routine | Surgeon
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


# --- Audit & sync --------------------------------------------------------------------------------


class AuditLog(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    user_id: str | None = None
    action: str
    entity_type: str
    entity_id: str | None = None
    at_utc: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    details: str | None = None
    node_id: str


class SyncOutbox(SQLModel, table=True):
    seq: int | None = Field(default=None, primary_key=True)
    entity_type: str
    entity_id: str
    operation: str = "Upsert"
    payload_json: str
    priority: int = 5  # lower = sent first (Urgent alerts/reports use 1)
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    status: str = Field(default="Pending", index=True)  # Pending | InFlight | Sent | Acked
    envelope_id: str | None = None
    attempts: int = 0


class WellnessScore(SQLModel, table=True):
    """Daily wellness index (LLD §9), stored at each assessment for the trend chart. Not a clinical score."""

    astronaut_id: str = Field(foreign_key="astronaut.id", primary_key=True)
    score_date: date = Field(primary_key=True)
    overall: int | None = None
    cardiovascular: float | None = None
    sleep: float | None = None
    behavioral: float | None = None
    activity: float | None = None
    metabolic: float | None = None
    environment: float | None = None
    cap_reason: str | None = None
    indicators_seen: int = 0
    computed_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


class Insight(SQLModel, table=True):
    """ML insight (LLD §3.3, §10): an unusual day (Anomaly) or rising recovery strain (Trend).

    Advisory only: insights never set alert severity (TDD ADR-03). Derived data, re-computable
    from the measurements, so it is not sent through the sync outbox.
    """

    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    kind: str  # Anomaly | Trend
    insight_date: date = Field(index=True)
    score: float  # Anomaly: 0–1 anomaly score; Trend: recovery strain today, in σ
    direction: str | None = None
    indicator_codes: str  # comma-separated, biggest contributor first
    contributors_json: str
    explanation: str
    window_start: date
    window_end: date
    model_version: str
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
