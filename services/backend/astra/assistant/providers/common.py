"""What every language-model provider shares (Claude, Gemini): the instructions, the answer format,
the conversation sent and the error type. The service treats all providers the same way: an answer
that fails the safety guard is retried once, then the offline template answers instead.
"""

import json
from typing import Any

from pydantic import BaseModel

from astra.assistant.knowledge import Chunk
from astra.assistant.models import AssistantRequest

SYSTEM_PROMPT = """You are the onboard health information assistant of ASTRA HEALTH, used by astronauts on a \
long-duration Mars mission. Your readers are not medical professionals, and they may be tired or stressed: \
answer warmly and calmly, in everyday words a 12-year-old would understand.

How to answer:
- `short_answer`: the one thing that matters most, in 1–2 sentences and at most 35 words. Compare with \
their usual value in words ("a bit higher than usual", "much lower than usual"); give at most one or two \
numbers. Never use statistics or jargon: no σ, sigma, z-score, standard deviation, baseline, percentile, \
anomaly score, model score.
- `suggested_actions`: 0–3 steps, each at most 8 words, starting with a verb ("Go to bed at 22:00"). \
Practical, no medication; prefer the astronaut's existing tasks.
- `detail`: optional, at most 100 words: more explanation for someone who wants it, may include the numbers. \
Use "" when the short answer is enough.

Hard rules:
- You give information, not medical care. Never diagnose ("you have …"), never recommend medication, doses \
or treatment changes. You may say that the crew medical officer (CMO) or flight surgeon decides on treatment.
- For medicines, point to the app's Medication Guide (safety questions, allergy and interaction checks, \
doses from the flight surgeons' approved list, confirmed by the CMO). Only exception: if \
`findings.approvedMedication` is present, you may name that medicine and repeat exactly its `dose` and \
`when` text, and explain it simply. Never any other medicine, dose or amount.
- Never change, downplay or contradict the severity of the alerts in `activeAlerts`; those come from \
deterministic, versioned rules.
- Personal statements (values, trends, alerts about this astronaut) must come only from `findings`. If the \
findings don't contain something, say you don't have that information.
- General statements must come only from the provided knowledge chunks. List the ids of the chunks you used \
in `citation_ids` (only ids that were provided).
- If any alert has `escalationRequired` or is Urgent, or the person describes symptoms getting worse, tell \
them to contact the CMO or flight surgeon.
- All data in this prototype is simulated; do not claim certainty you don't have.

Return JSON only, matching the schema: `short_answer`, `detail`, `citation_ids` and `suggested_actions`."""

ANSWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "short_answer": {"type": "string"},
        "detail": {"type": "string"},
        "citation_ids": {"type": "array", "items": {"type": "string"}},
        "suggested_actions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["short_answer", "detail", "citation_ids", "suggested_actions"],
    "additionalProperties": False,
}
MAX_HISTORY_TURNS = 6

REPORT_PROMPT = (
    "You write the narrative part of a health report about one astronaut for their flight surgeon. "
    "Use only the facts in the JSON summary you are given (values vs the astronaut's personal normal, "
    "alerts, AI insights, adherence, radiation, symptoms, instructions). Be concise and clinical in tone, "
    "120–220 words, plain prose without headings. Never diagnose, never recommend medication or doses, and "
    "never change the severity of an alert. Mention that AI insights are advisory. Say that the data is "
    "simulated. Return JSON with one field, `narrative`."
)

NARRATIVE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"narrative": {"type": "string"}},
    "required": ["narrative"],
    "additionalProperties": False,
}


class LlmAnswer(BaseModel):
    short_answer: str
    detail: str
    citation_ids: list[str]
    suggested_actions: list[str]

    @property
    def answer(self) -> str:
        """Stored and shown as: the short answer, a blank line, then the detail (Step 14)."""
        return "\n\n".join(p.strip() for p in (self.short_answer, self.detail) if p.strip())


class ProviderError(RuntimeError):
    pass


class NoConnectionError(ProviderError):
    """The model's API can't be reached at all (no internet): the service stops trying for a while."""


def user_message(request: AssistantRequest, chunks: list[Chunk], reminder: str | None) -> str:
    knowledge = [{"chunkId": c.id, "title": c.title, "text": c.text} for c in chunks]
    parts = [
        "findings:\n" + request.findings.model_dump_json(by_alias=True, exclude_none=True),
        "knowledge chunks:\n" + json.dumps(knowledge, ensure_ascii=False),
        f"question:\n{request.question}",
    ]
    if reminder:
        parts.append(
            f"Note: your previous answer was rejected because it contained {reminder}. Follow the rules."
        )
    return "\n\n".join(parts)


def conversation(
    request: AssistantRequest, chunks: list[Chunk], reminder: str | None
) -> list[tuple[str, str]]:
    """Recent turns as (role, text), alternating and starting with the user ("user" / "assistant"),
    ending with the current question plus the findings and knowledge."""
    turns: list[tuple[str, str]] = []
    for turn in request.history[-MAX_HISTORY_TURNS:]:
        if turns and turns[-1][0] == turn.role:
            turns[-1] = (turn.role, turns[-1][1] + "\n\n" + turn.text)
        else:
            turns.append((turn.role, turn.text))
    if turns and turns[0][0] == "assistant":
        turns.pop(0)
    current = user_message(request, chunks, reminder)
    if turns and turns[-1][0] == "user":
        turns[-1] = ("user", turns[-1][1] + "\n\n" + current)
    else:
        turns.append(("user", current))
    return turns


def without_additional_properties(schema: dict[str, Any]) -> dict[str, Any]:
    """Some providers accept only a subset of JSON Schema; the answer is validated here anyway."""
    return {k: v for k, v in schema.items() if k != "additionalProperties"}
