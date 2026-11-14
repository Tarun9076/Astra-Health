"""Template provider (LLD §11.2 step 7): deterministic, offline, always available.

Builds the answer from the astronaut's own findings (values vs their personal normal, active
alerts, AI insights) plus the opening sentences of the best-matching knowledge chunks.
"""

import re

from astra.assistant.knowledge import Chunk
from astra.assistant.models import AssistantRequest, AssistantResponse, Citation, LatestValue

TOPICS: dict[str, tuple[str, ...]] = {
    r"heart|pulse|\bhr\b|bpm|cardio": ("resting_hr",),
    r"sleep|insomnia|tired|rest\b": ("sleep_hours", "sleep_quality"),
    r"blood pressure|\bbp\b|hypertens": ("bp_sys", "bp_dia"),
    r"temperature|fever|\btemp\b": ("body_temp",),
    r"oxygen|spo2|saturation|breath": ("spo2",),
    r"glucose|sugar": ("glucose",),
    r"mood|sad|down|happy": ("mood",),
    r"stress|anxi|worr": ("stress",),
    r"fatigue|tired|exhaust|energy": ("fatigue",),
    r"radiation|dose|solar|storm": ("radiation_dose",),
    r"weight": ("body_weight",),
    r"exercis|strength|muscle|workout|train": ("strength_index", "exercise_sessions"),
    r"activity|steps|active": ("activity_min",),
    r"hydrat|water|drink|fluid": ("hydration_ml",),
}
ADVICE_SECTIONS = ("what astronauts can do", "when to contact")
NOTABLE_Z = 1.5
MAX_VALUES = 4


def _sentences(text: str, n: int) -> str:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return " ".join(parts[:n])


def _fmt(v: float) -> str:
    return f"{v:.0f}" if abs(v) >= 20 or v == int(v) else f"{v:.1f}"


def describe(code: str, v: LatestValue) -> str:
    unit = "/10" if v.unit == "score" else f" {v.unit}"
    text = f"Your {v.name.lower()} is {_fmt(v.value)}{unit}"
    if v.baseline is None or v.z is None:
        return text + " (no personal normal yet)."
    normal = f"your personal normal is {_fmt(v.baseline)}{unit}"
    if abs(v.z) < NOTABLE_Z:
        return f"{text}; {normal}, so this is within your usual range."
    direction = "above" if v.z > 0 else "below"
    sigma = f"{abs(v.z):.1f}σ".replace("-", "−")
    return f"{text}; {normal}, so this is {sigma} {direction} your normal."


def relevant_codes(request: AssistantRequest) -> list[str]:
    q = request.question.lower()
    latest = request.findings.latest
    codes = [c for pattern, cs in TOPICS.items() if re.search(pattern, q) for c in cs if c in latest]
    if not codes:  # general question: talk about what stands out
        notable = sorted(
            (c for c, v in latest.items() if v.z is not None and abs(v.z) >= NOTABLE_Z),
            key=lambda c: -abs(latest[c].z or 0),
        )
        codes = notable
    return list(dict.fromkeys(codes))[:MAX_VALUES]


def template_answer(request: AssistantRequest, chunks: list[Chunk]) -> AssistantResponse:
    f = request.findings
    paragraphs: list[str] = []

    codes = relevant_codes(request)
    if codes:
        paragraphs.append(" ".join(describe(c, f.latest[c]) for c in codes))
    elif f.latest:
        paragraphs.append("Your latest readings are all within your personal normal ranges.")

    for alert in f.active_alerts[:2]:
        paragraphs.append(f"Active {alert.severity.lower()} alert — {alert.title}: {alert.reason}")
    for insight in f.insights[:1]:
        paragraphs.append(f"AI insight ({insight.day}): {insight.explanation}")

    # Background explains ("What happens"…); advice sections feed the actions instead.
    background = [c for c in chunks if not c.section.lower().startswith(ADVICE_SECTIONS)][:2]
    advice = next((c for c in chunks if c.section.lower().startswith("what astronauts can do")), None)
    if background:
        general = " ".join(_sentences(c.text, 2) for c in background)
        paragraphs.append(f"General background: {general}")
    elif not advice:
        paragraphs.append(
            "I don't have a knowledge note on that topic; the flight surgeon can help on the next link."
        )
    if advice:
        paragraphs.append(f"What helps: {_sentences(advice.text, 2)}")

    cited = background + ([advice] if advice else [])
    return AssistantResponse(
        answer="\n\n".join(paragraphs),
        citations=[Citation(chunk_id=c.id, title=c.title, source=c.source) for c in cited],
        suggested_actions=list(f.tasks[:4]),
        mode="template",
        provider="template",
    )
