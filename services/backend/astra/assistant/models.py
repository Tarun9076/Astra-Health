"""Contract of the AI Health Assistant (LLD §11.1). The router builds the request from the database."""

from typing import Literal

from astra.core.base import CoreModel


class LatestValue(CoreModel):
    name: str
    value: float
    unit: str
    baseline: float | None = None
    sigma: float | None = None
    z: float | None = None


class FindingAlert(CoreModel):
    rule_id: str
    title: str
    severity: Literal["Attention", "Urgent"]
    reason: str
    escalation_required: bool = False


class FindingInsight(CoreModel):
    kind: Literal["Anomaly", "Trend"]
    day: str
    explanation: str


class ApprovedMedication(CoreModel):
    """A dose the Medication Guide worked out (flight-surgeon list + safety checks) and the CMO (or the
    astronaut alone) confirmed. The only medicine and dose the assistant may mention (Step 20)."""

    condition: str
    medicine: str
    dose: str  # "2 tablets (1000 mg)"
    when: str
    status: Literal["Confirmed", "Taken"]


class Findings(CoreModel):
    """What the assistant may say about *this* astronaut. Personal statements come only from here."""

    astronaut_code: str
    mission_day: int | None = None
    gravity: str | None = None
    latest: dict[str, LatestValue] = {}
    active_alerts: list[FindingAlert] = []
    insights: list[FindingInsight] = []
    tasks: list[str] = []  # titles of pending recommendation tasks
    wellness_index: int | None = None
    approved_medication: ApprovedMedication | None = None


class Turn(CoreModel):
    role: Literal["user", "assistant"]
    text: str


Provider = Literal["auto", "claude", "gemini", "template"]


class AssistantRequest(CoreModel):
    question: str
    history: list[Turn] = []
    findings: Findings
    preferred_provider: Provider = "auto"
    medication_condition: str | None = None  # Medication Guide condition the question is about (title)


class Citation(CoreModel):
    chunk_id: str
    title: str
    source: str


class AssistantResponse(CoreModel):
    answer: str
    citations: list[Citation] = []
    suggested_actions: list[str] = []
    safety_flags: list[str] = []
    mode: Literal["llm", "template", "emergency"]
    provider: Literal["claude", "gemini", "template", "redflag"]
    emergency_protocol_id: str | None = None
    red_flag_id: str | None = None  # which red flag matched (emergency mode)
    report: bool = False  # emergency mode: True = the person is reporting it now → raise an alert
