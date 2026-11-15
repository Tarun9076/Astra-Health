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
from pydantic import ValidationError

from astra.assistant.knowledge import Chunk
from astra.assistant.models import AssistantRequest
from astra.assistant.providers.common import (
    ANSWER_SCHEMA,
    NARRATIVE_SCHEMA,
    REPORT_PROMPT,
    SYSTEM_PROMPT,
    LlmAnswer,
    ProviderError,
    conversation,
)


def claude_answer(
    client: anthropic.Anthropic,
    model: str,
    request: AssistantRequest,
    chunks: list[Chunk],
    *,
    reminder: str | None = None,
) -> LlmAnswer:
    turns = conversation(request, chunks, reminder)
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
        return LlmAnswer.model_validate_json(text)
    except ValidationError as e:
        raise ProviderError("Claude answer did not match the schema") from e


def claude_report_narrative(client: anthropic.Anthropic, model: str, summary: dict[str, Any]) -> str:
    output_config: BetaOutputConfigParam = {
        "effort": "low",
        "format": {"type": "json_schema", "schema": NARRATIVE_SCHEMA},
    }
    try:
        response = client.beta.messages.create(
            model=model,
            max_tokens=8000,
            system=REPORT_PROMPT,
            messages=[{"role": "user", "content": json.dumps(summary, ensure_ascii=False)}],
            output_config=output_config,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.APIError as e:
        raise ProviderError("Claude API unavailable for the report narrative") from e
    if response.stop_reason in ("refusal", "max_tokens"):
        raise ProviderError(f"Claude narrative stopped: {response.stop_reason}")
    text = next((b.text for b in response.content if b.type == "text"), None)
    try:
        return str(json.loads(text or "")["narrative"])
    except (ValueError, KeyError) as e:
        raise ProviderError("Claude narrative did not match the schema") from e
