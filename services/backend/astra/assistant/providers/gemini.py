"""Gemini provider (Step 17) through Google's official `google-genai` SDK; an alternative to Claude.

Same contract as the Claude provider (providers/common.py): the same instructions, the same JSON
answer (short answer, detail, citations, steps), checked by the same safety guard in the service.
- Structured output: `response_mime_type` "application/json" with `response_json_schema`.
- Thinking kept low, so answers stay quick and are never cut off by long reasoning.
- A blocked or truncated answer, or any API / network error, raises ProviderError and the caller
  falls back to the offline template.
"""

import json
from typing import Any

from google import genai
from google.genai import errors, types
from pydantic import ValidationError

from astra.assistant.knowledge import Chunk
from astra.assistant.models import AssistantRequest
from astra.assistant.providers.common import (
    ANSWER_SCHEMA,
    NARRATIVE_SCHEMA,
    REPORT_PROMPT,
    SYSTEM_PROMPT,
    LlmAnswer,
    NoConnectionError,
    ProviderError,
    conversation,
    without_additional_properties,
)

TIMEOUT_MS = 45_000
MAX_OUTPUT_TOKENS = 8192
BLOCKED = {
    types.FinishReason.SAFETY,
    types.FinishReason.PROHIBITED_CONTENT,
    types.FinishReason.BLOCKLIST,
    types.FinishReason.SPII,
    types.FinishReason.RECITATION,
}


def make_client(api_key: str) -> genai.Client:
    return genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=TIMEOUT_MS))


def _config(system: str, schema: dict[str, Any]) -> types.GenerateContentConfig:
    return types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        response_json_schema=without_additional_properties(schema),
        max_output_tokens=MAX_OUTPUT_TOKENS,
        thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
    )


def _generate(
    client: genai.Client, model: str, contents: list[types.Content], config: types.GenerateContentConfig
) -> str:
    try:
        response = client.models.generate_content(model=model, contents=contents, config=config)
    except errors.APIError as e:
        raise ProviderError(f"Gemini API error {e.code}") from e
    except Exception as e:  # network errors from the HTTP client
        raise NoConnectionError(f"no connection to the Gemini API ({type(e).__name__})") from e
    if response.prompt_feedback is not None and response.prompt_feedback.block_reason is not None:
        raise ProviderError("Gemini declined to answer")
    finish = response.candidates[0].finish_reason if response.candidates else None
    if finish in BLOCKED:
        raise ProviderError("Gemini declined to answer")
    if finish == types.FinishReason.MAX_TOKENS:
        raise ProviderError("Gemini answer was cut off")
    text = response.text
    if not text:
        raise ProviderError("Gemini returned no text")
    return text


def gemini_answer(
    client: genai.Client,
    model: str,
    request: AssistantRequest,
    chunks: list[Chunk],
    *,
    reminder: str | None = None,
) -> LlmAnswer:
    contents = [
        types.Content(role="user" if role == "user" else "model", parts=[types.Part(text=text)])
        for role, text in conversation(request, chunks, reminder)
    ]
    text = _generate(client, model, contents, _config(SYSTEM_PROMPT, ANSWER_SCHEMA))
    try:
        return LlmAnswer.model_validate_json(text)
    except ValidationError as e:
        raise ProviderError("Gemini answer did not match the schema") from e


def gemini_report_narrative(client: genai.Client, model: str, summary: dict[str, Any]) -> str:
    contents = [types.Content(role="user", parts=[types.Part(text=json.dumps(summary, ensure_ascii=False))])]
    text = _generate(client, model, contents, _config(REPORT_PROMPT, NARRATIVE_SCHEMA))
    try:
        return str(json.loads(text)["narrative"])
    except (ValueError, KeyError) as e:
        raise ProviderError("Gemini narrative did not match the schema") from e
