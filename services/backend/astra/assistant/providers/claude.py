"""Claude provider (LLD §11.2 steps 4–5; TDD ADR-07) through the official `anthropic` SDK.

- Structured output: the answer comes back as JSON matching ANSWER_SCHEMA (`output_config.format`).
- Adaptive thinking (always on for Claude Opus 5.5) at effort "low" for chat responsiveness.
- Server-side refusal fallback enabled (`fallbacks: "default"`); a final refusal, a truncated
  answer or any API / network error raises ProviderError and the caller falls back to the template.
"""

import json
from typing import Any

import anthropic
from anthropic.types.beta import BetaMessageParam, BetaOutputConfigParam
from pydantic import BaseModel, ValidationError

from astra.assistant.knowledge import Chunk
from astra.assistant.models import AssistantRequest

SYSTEM_PROMPT = """You are the onboard health information assistant of ASTRA HEALTH, used by astronauts on a \
long-duration Mars mission. Your readers are not medical professionals; answer in plain language, briefly \
(about 80–180 words), warmly and calmly.

Hard rules:
- You give information, not medical care. Never diagnose ("you have …"), never recommend medication, doses \
or treatment changes. You may say that the crew medical officer (CMO) or flight surgeon decides on treatment.
- Never change, downplay or contradict the severity of the alerts in `activeAlerts`; those come from \
deterministic, versioned rules.
- Personal statements (values, trends, alerts about this astronaut) must come only from `findings`. If the \
findings don't contain something, say you don't have that information.
- General statements must come only from the provided knowledge chunks. List the ids of the chunks you used \
in `citation_ids` (only ids that were provided).
- If any alert has `escalationRequired` or is Urgent, or the person describes symptoms getting worse, tell \
them to contact the CMO or flight surgeon.
- All data in this prototype is simulated; do not claim certainty you don't have.

Return JSON only, matching the schema: `answer` (the reply), `citation_ids`, and `suggested_actions` \
(0–4 short, practical, non-medication actions, preferably the astronaut's existing tasks)."""

ANSWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "citation_ids": {"type": "array", "items": {"type": "string"}},
        "suggested_actions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["answer", "citation_ids", "suggested_actions"],
    "additionalProperties": False,
}
MAX_HISTORY_TURNS = 6


class ClaudeAnswer(BaseModel):
    answer: str
    citation_ids: list[str]
    suggested_actions: list[str]


class ProviderError(RuntimeError):
    pass


def _user_message(request: AssistantRequest, chunks: list[Chunk], reminder: str | None) -> str:
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


def claude_answer(
    client: anthropic.Anthropic,
    model: str,
    request: AssistantRequest,
    chunks: list[Chunk],
    *,
    reminder: str | None = None,
) -> ClaudeAnswer:
    turns: list[tuple[str, str]] = []  # (role, text), alternating, starting with the user
    for turn in request.history[-MAX_HISTORY_TURNS:]:
        if turns and turns[-1][0] == turn.role:
            turns[-1] = (turn.role, turns[-1][1] + "\n\n" + turn.text)
        else:
            turns.append((turn.role, turn.text))
    if turns and turns[0][0] == "assistant":
        turns.pop(0)
    current = _user_message(request, chunks, reminder)
    if turns and turns[-1][0] == "user":
        turns[-1] = ("user", turns[-1][1] + "\n\n" + current)
    else:
        turns.append(("user", current))
    messages: list[BetaMessageParam] = [
        {"role": "user", "content": text} if role == "user" else {"role": "assistant", "content": text}
        for role, text in turns
    ]
    output_config: BetaOutputConfigParam = {
        "effort": "low",
        "format": {"type": "json_schema", "schema": ANSWER_SCHEMA},
    }

    try:
        response = client.beta.messages.create(
            model=model,
            max_tokens=8000,
            system=SYSTEM_PROMPT,
            messages=messages,
            output_config=output_config,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.APIConnectionError as e:
        raise ProviderError("no connection to the Claude API") from e
    except anthropic.RateLimitError as e:
        raise ProviderError("Claude API rate limit") from e
    except anthropic.APIStatusError as e:
        raise ProviderError(f"Claude API error {e.status_code}") from e

    if response.stop_reason == "refusal":
        raise ProviderError("Claude declined to answer")
    if response.stop_reason == "max_tokens":
        raise ProviderError("Claude answer was cut off")
    text = next((b.text for b in response.content if b.type == "text"), None)
    if not text:
        raise ProviderError("Claude returned no text")
    try:
        return ClaudeAnswer.model_validate_json(text)
    except ValidationError as e:
        raise ProviderError("Claude answer did not match the schema") from e
