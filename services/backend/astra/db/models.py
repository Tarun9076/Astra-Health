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


class HealthPhoto(SQLModel, table=True):
    """A photo taken by the astronaut (skin, eye, wound, a device's display) for the flight surgeon.

    Stored as base64 text so it can travel inside a JSON sync envelope; the web app shrinks photos
    to about 1280 px (a few hundred kB) before sending.
    """

    id: str = Field(primary_key=True)  # from the client (offline outbox), so a re-send is a no-op
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    kind: str  # Skin | Eye | Wound | DeviceReading | Other
    note: str | None = None
    content_type: str  # image/jpeg | image/png | image/webp
    size_bytes: int
    data_b64: str
    checkin_id: str | None = None
    taken_at: datetime = Field(sa_type=UTCDateTime)
    node_id: str = ""


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
    sent_at: datetime | None = Field(
        default=None, sa_type=UTCDateTime
    )  # when the envelope left (retry timer)


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


class ChatMessage(SQLModel, table=True):
    """AI Health Assistant conversation (LLD §3.4). Private to the astronaut and medical staff."""

    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    user_id: str  # who asked (the astronaut, or a flight surgeon asking about them)
    role: str  # user | assistant
    text: str
    mode: str | None = None  # llm | template | emergency (assistant turns)
    provider: str | None = None  # claude | template | redflag
    citations_json: str = "[]"
    suggested_actions_json: str = "[]"
    safety_flags_json: str = "[]"
    emergency_protocol_id: str | None = None
    alert_id: str | None = None  # Urgent alert raised from a red-flag report
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


class MedicalReport(SQLModel, table=True):
    """Health report for the flight surgeon (LLD §3.3, Step 8): structured summary + plain-language narrative.

    Generated on the Habitat node and queued for the ground (`TransmissionStatus` moves to Sent /
    Delivered once the deep-space link exists, Step 9).
    """

    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    type: str  # Daily | Weekly | AlertTriggered | OnDemand
    period_start: date
    period_end: date
    alert_id: str | None = None  # AlertTriggered: the alert that caused it
    summary_json: str
    narrative_text: str
    narrative_provider: str  # claude | template
    generated_by: str | None = None  # user id for OnDemand; None = system
    generated_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    transmission_status: str = "Queued"  # Queued | Sent | Delivered
    origin_node_id: str


class MedicalInstruction(SQLModel, table=True):
    """A flight surgeon's instruction to an astronaut (LLD §3.3); delivered live, then acknowledged."""

    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    alert_id: str | None = None
    from_user_id: str
    from_name: str
    text: str
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    delivered_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    acknowledged_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    origin_node_id: str


class SyncInbox(SQLModel, table=True):
    """Envelopes received from the peer (LLD §12.3). The simulated link holds each one until `deliver_at`;
    `envelope_id` as primary key makes a re-sent envelope a no-op (T-S-01)."""

    envelope_id: str = Field(primary_key=True)
    from_node_id: str
    body_json: str
    item_count: int
    received_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    deliver_at: datetime = Field(sa_type=UTCDateTime, index=True)
    applied_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    ack_sent_at: datetime | None = Field(default=None, sa_type=UTCDateTime)


class SyncAck(SQLModel, table=True):
    """ACKs from the peer for envelopes we sent; also delayed by the link."""

    envelope_id: str = Field(primary_key=True)
    deliver_at: datetime = Field(sa_type=UTCDateTime)
    processed_at: datetime | None = Field(default=None, sa_type=UTCDateTime)


class LinkState(SQLModel, table=True):
    """The simulated deep-space link (LLD §12.5). One row, owned by the Habitat node."""

    id: int = Field(default=1, primary_key=True)
    status: str = "Up"  # Up | Down
    real_delay_minutes: float = 0.0  # one-way light time (JPL Horizons for the mission date, or manual)
    delay_source: str = "horizons"  # horizons | manual
    compression_seconds_per_minute: float = 2.0  # demo time: 1 light-minute → 2 s
    updated_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)

    @property
    def one_way_seconds(self) -> float:
        return self.real_delay_minutes * self.compression_seconds_per_minute


class SpaceWeatherEvent(SQLModel, table=True):
    """Solar energetic particle events from NASA DONKI (LLD §20), fetched on the Ground node and sent to
    the Habitat as notices."""

    id: str = Field(primary_key=True)  # DONKI sepID
    event_time: datetime = Field(sa_type=UTCDateTime)
    instruments: str
    source: str  # donki-live | donki-fixture
    fetched_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


class EnvironmentReading(SQLModel, table=True):
    """Habitat-wide cabin sensor readings (Step 10): temperature, humidity, CO₂. Shared by the whole crew,
    so they live outside HealthMeasurement; the rule engine sees them as series for every astronaut."""

    id: str = Field(primary_key=True)
    indicator_code: str = Field(index=True)
    value: float
    unit: str
    measured_at: datetime = Field(sa_type=UTCDateTime, index=True)
    module: str = "HAB"  # habitat module / sensor location
    source: str = "Sensor"  # Sensor | Simulated | Manual
    is_simulated: bool = False
    received_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    origin_node_id: str


class WellnessActivity(SQLModel, table=True):
    """Wellness Center log (Step 10): fluid intake (mL) and breathing exercises (seconds)."""

    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    kind: str  # fluid | breathing
    amount: float
    at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime, index=True)


class ExerciseSession(SQLModel, table=True):
    """A session done with the camera exercise coach (Step 13). Only results are kept, never video.
    The id comes from the client, so a session sent twice is stored once. Synced to Ground."""

    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    started_at: datetime = Field(sa_type=UTCDateTime)
    finished_at: datetime = Field(sa_type=UTCDateTime, index=True)
    source: str  # camera | demo (the simulated person used for rehearsals)
    plan_level: str  # rest | lighter | standard | more | adjusted (the plan it followed)
    results_json: str  # [{exercise, name, sets: [{reps, target, formScore}], tips: [{tip, count}]}]
    total_reps: int
    form_score: int | None = None
    summary: str
    node_id: str
    created_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


# --- Medication Guide (Step 20) ------------------------------------------------------------------


class MedicalProfile(SQLModel, table=True):
    """What the Medication Guide must know about one astronaut: allergies, health conditions and
    regular medicines, as codes from the formulary vocabulary. Edited by the CMO or the flight surgeon;
    synced both ways (the newest edit wins)."""

    astronaut_id: str = Field(foreign_key="astronaut.id", primary_key=True)
    allergies_json: str = "[]"
    conditions_json: str = "[]"
    medicines_json: str = "[]"
    note: str = ""
    updated_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    updated_by: str = "seed"


class MedicationDose(SQLModel, table=True):
    """One medicine dose from the Medication Guide, from request to follow-up. The id comes from the
    client (a request sent twice is stored once). Synced both ways: the crew writes it onboard, the
    flight surgeon adds the review on the ground.

    Requested → Confirmed (by the CMO, or the astronaut alone: `self_confirmed`) → Taken → outcome;
    or Requested → Declined / Cancelled."""

    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    condition_id: str
    medicine_id: str = Field(index=True)
    units: int
    dose_text: str  # "2 tablets (1000 mg)"
    when_text: str  # "Now. If still needed, every 6 hours."
    formulary_version: str
    answers_json: str  # red-flag answers: {"worst": false, ...}
    checks_json: str  # [{level, code, text}] at the time of the request
    status: str = "Requested"  # Requested | Confirmed | Declined | Cancelled | Taken
    self_confirmed: bool = False
    self_confirm_reason: str | None = None
    requested_at: datetime = Field(sa_type=UTCDateTime, index=True)
    confirmed_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    confirmed_by: str | None = None
    decline_reason: str | None = None
    taken_at: datetime | None = Field(default=None, sa_type=UTCDateTime, index=True)
    follow_up_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    outcome: str | None = None  # better | same | worse
    outcome_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    reviewed_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    reviewed_by: str | None = None
    review_note: str | None = None
    node_id: str
    updated_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


# --- Treatment at check-in (Step 21) ------------------------------------------------------------------


class TreatmentEpisode(SQLModel, table=True):
    """One Act Now treatment: the plan the crew saw (a snapshot, so a protocol update never changes a
    treatment in progress) and its outcome. The id comes from the device, so an episode started with
    the server down is stored once when it is sent. Synced both ways (Earth adds the review)."""

    id: str = Field(primary_key=True)
    astronaut_id: str = Field(foreign_key="astronaut.id", index=True)
    protocol_ids_json: str  # ["TX-CHEST-PAIN", ...] in plan order
    title: str
    tier: int
    source: str  # checkin | help-now | device (planned on the device while the server was down)
    plan_json: str  # the plan exactly as shown
    status: str = "Active"  # Active | Resolved | Escalated | Cancelled
    started_at: datetime = Field(sa_type=UTCDateTime, index=True)
    started_by: str
    ended_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    outcome_note: str | None = None
    reviewed_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    reviewed_by: str | None = None
    review_note: str | None = None
    node_id: str
    updated_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)


class TreatmentEvent(SQLModel, table=True):
    """Append-only log of what was done in an episode: steps, answers, rechecks, doses (who gave
    them, who read the dose back), notes, the end. Ids come from the device; synced insert-if-absent."""

    id: str = Field(primary_key=True)
    episode_id: str = Field(foreign_key="treatmentepisode.id", index=True)
    at: datetime = Field(sa_type=UTCDateTime, index=True)
    device_time: bool = False  # the time came from the device (server unreachable at that moment)
    # step_done | step_skipped | answer | recheck | dose_given | note | resolved | escalated | cancelled
    kind: str
    protocol_id: str | None = None
    step_id: str | None = None
    data_json: str = "{}"
    by_name: str
    flags_json: str = "[]"  # server checks that disagreed (e.g. a dose recorded although too soon)
    node_id: str


class ProtocolUpdate(SQLModel, table=True):
    """A treatment protocol sent up from Earth by the flight surgeon (Step 21f). Signed with the shared
    sync key; the Habitat checks the signature and the protocol before using it, and only for new
    treatments (a treatment in progress keeps its snapshot). Synced insert-if-absent."""

    id: str = Field(primary_key=True)  # "<protocol id>@<version>"
    protocol_id: str = Field(index=True)
    version: str
    protocol_json: str
    signature: str  # HMAC-SHA256 over the canonical JSON, base64
    uploaded_by: str
    uploaded_at: datetime = Field(default_factory=utcnow, sa_type=UTCDateTime)
    node_id: str
