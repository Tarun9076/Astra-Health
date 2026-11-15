"""`Assistant.answer(request)`: the AI Health Assistant pipeline (LLD §11.2).

1. Red-flag router (deterministic, no AI) → emergency protocol at once.
2. BM25 retrieval over the knowledge base.
3. Provider: Claude or Gemini (Step 17) if configured and allowed, else the offline template.
   `ASTRA_LLM_PROVIDER` = auto (Claude if its key is set, else Gemini), claude, gemini or template.
4. Guard: no doses / medication instructions / diagnoses; known citations only; escalation line.
   A model answer that fails the guard is retried once with a reminder, then the template answers.
"""

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anthropic
from google import genai

from astra.assistant.guard import check_answer, needs_escalation, with_escalation, with_medication_note
from astra.assistant.knowledge import Chunk, Retriever, load_knowledge, tokens
from astra.assistant.models import AssistantRequest, AssistantResponse, Citation
from astra.assistant.providers import gemini as gemini_provider
from astra.assistant.providers.claude import claude_answer, claude_report_narrative
from astra.assistant.providers.common import LlmAnswer, NoConnectionError, ProviderError
from astra.assistant.providers.template import template_answer
from astra.assistant.redflag import RedFlagHit, RedFlagRouter
from astra.core.protocols import ProtocolBundle

logger = logging.getLogger(__name__)

TOP_K = 5
LLM_ATTEMPTS = 2
ADVICE = "what astronauts can do"
# No internet (spacecraft, Wi-Fi off): after a failed connection the online model is skipped for this
# long, so every answer comes straight from the offline template instead of waiting on the network.
OFFLINE_PAUSE_S = 60.0
VAGUE_QUESTION_TERMS = 3  # fewer meaningful words than this → add the active alerts to the search


@dataclass
class Assistant:
    retriever: Retriever
    redflags: RedFlagRouter
    bundle: ProtocolBundle
    claude: anthropic.Anthropic | None = None
    model: str = "claude-opus-5-5"
    default_provider: str = "auto"
    gemini: genai.Client | None = None
    gemini_model: str = "gemini-3.8-flash"
    offline_until: float = field(default=0.0, repr=False)  # time.monotonic(); see OFFLINE_PAUSE_S

    @classmethod
    def load(
        cls,
        kb_path: Path,
        bundle: ProtocolBundle,
        protocols_path: Path,
        *,
        api_key: str | None,
        model: str,
        provider: str,
        gemini_api_key: str | None = None,
        gemini_model: str = "gemini-3.8-flash",
    ) -> "Assistant":
        redflags = RedFlagRouter.from_file(protocols_path / "redflags.yaml", set(bundle.emergency_protocols))
        client = anthropic.Anthropic(api_key=api_key, max_retries=1, timeout=45.0) if api_key else None
        gemini = gemini_provider.make_client(gemini_api_key) if gemini_api_key else None
        return cls(
            Retriever(load_knowledge(kb_path)), redflags, bundle, client, model, provider,
            gemini=gemini, gemini_model=gemini_model,
        )  # fmt: skip

    @property
    def claude_configured(self) -> bool:
        return self.claude is not None

    @property
    def gemini_configured(self) -> bool:
        return self.gemini is not None

    @property
    def llm_configured(self) -> bool:
        """A language model (Claude or Gemini) can be used."""
        return self.provider_for("auto") != "template"

    def provider_for(self, preferred: str) -> str:
        choice = preferred if preferred != "auto" else self.default_provider
        if choice in ("auto", "claude") and self.claude_configured:
            return "claude"
        if choice in ("auto", "gemini") and self.gemini_configured:
            return "gemini"
        return "template"

    def model_for(self, provider: str) -> str | None:
        return {"claude": self.model, "gemini": self.gemini_model}.get(provider)

    def _ask(
        self, provider: str, request: AssistantRequest, chunks: list[Chunk], reminder: str | None
    ) -> LlmAnswer:
        if provider == "claude" and self.claude is not None:
            return claude_answer(self.claude, self.model, request, chunks, reminder=reminder)
        if provider == "gemini" and self.gemini is not None:
            return gemini_provider.gemini_answer(
                self.gemini, self.gemini_model, request, chunks, reminder=reminder
            )
        raise ProviderError(f"{provider} is not configured")

    def emergency(self, hit: RedFlagHit) -> AssistantResponse:
        protocol = self.bundle.emergency_protocols[hit.flag.protocol]
        if hit.report:
            text = (
                f"This could be serious: {protocol.title.lower()}. Follow the emergency steps below "
                "now and call the crew medical officer. I have reported it as an urgent symptom, so the "
                "CMO and the flight surgeon are alerted."
            )
        else:
            text = (
                f"Here is the emergency procedure for {protocol.title.lower()}. If this is happening to "
                "you or a crewmate now, call the crew medical officer and follow these steps straight away."
            )
        return AssistantResponse(
            answer=text,
            mode="emergency",
            provider="redflag",
            emergency_protocol_id=protocol.id,
            red_flag_id=hit.flag.id,
            report=hit.report,
            safety_flags=["red_flag"],
        )

    def retrieve(self, request: AssistantRequest) -> list[Chunk]:
        """Search on the question; only a vague question ("what's wrong?") borrows the alert titles.

        The best note's own "What astronauts can do" section is always included, so advice
        matches the topic of the explanation.
        """
        query = request.question
        if len(tokens(query)) < VAGUE_QUESTION_TERMS:
            query += " " + " ".join(a.title for a in request.findings.active_alerts[:3])
        chunks = [c for c, _ in self.retriever.search(query, k=TOP_K)]
        if chunks:
            top = chunks[0].note_id
            advice = next(
                (
                    c
                    for c in self.retriever.chunks
                    if c.note_id == top and c.section.lower().startswith(ADVICE)
                ),
                None,
            )
            if advice and advice not in chunks:
                chunks.insert(1, advice)
            elif advice:
                chunks.insert(1, chunks.pop(chunks.index(advice)))
        return chunks

    def answer(self, request: AssistantRequest) -> AssistantResponse:
        hit = self.redflags.check(request.question)
        if hit is not None:
            return self.emergency(hit)

        chunks = self.retrieve(request)
        escalate = needs_escalation(request.findings, request.question)
        flags: list[str] = []

        provider = self.provider_for(request.preferred_provider)
        if provider != "template" and time.monotonic() < self.offline_until:
            flags.append("fallback: no internet, offline answer")
            provider = "template"
        if provider != "template":
            known = {c.id: c for c in chunks}
            reminder: str | None = None
            for _ in range(LLM_ATTEMPTS):
                try:
                    reply = self._ask(provider, request, chunks, reminder)
                except ProviderError as e:
                    logger.warning("%s unavailable, using the template: %s", provider, e)
                    if isinstance(e, NoConnectionError):
                        self.offline_until = time.monotonic() + OFFLINE_PAUSE_S
                    flags.append(f"fallback: {e}")
                    break
                verdict = check_answer(" ".join([reply.answer, *reply.suggested_actions]))
                if verdict.ok:
                    cited = [known[i] for i in dict.fromkeys(reply.citation_ids) if i in known]
                    dropped = len(set(reply.citation_ids) - set(known))
                    return AssistantResponse(
                        answer=with_medication_note(
                            with_escalation(reply.answer, escalate), request.question
                        ),
                        citations=[Citation(chunk_id=c.id, title=c.title, source=c.source) for c in cited],
                        suggested_actions=reply.suggested_actions[:3],
                        safety_flags=flags + ([f"dropped {dropped} unknown citation(s)"] if dropped else []),
                        mode="llm",
                        provider="claude" if provider == "claude" else "gemini",
                    )
                flags += [f"guard: {f}" for f in verdict.flags]
                reminder = ", ".join(verdict.flags)

        response = template_answer(request, chunks)
        return response.model_copy(
            update={
                "answer": with_medication_note(with_escalation(response.answer, escalate), request.question),
                "safety_flags": flags,
            }
        )

    def narrate_report(self, summary: dict[str, Any]) -> tuple[str, str]:
        """Report narrative from the configured model, guarded like chat answers. Raises so the caller
        uses the template."""
        provider = self.provider_for("auto")
        if provider == "claude" and self.claude is not None:
            text = claude_report_narrative(self.claude, self.model, summary)
        elif provider == "gemini" and self.gemini is not None:
            text = gemini_provider.gemini_report_narrative(self.gemini, self.gemini_model, summary)
        else:
            raise ProviderError("No language model is configured")
        verdict = check_answer(text)
        if not verdict.ok:
            raise ProviderError(f"narrative failed the guard: {', '.join(verdict.flags)}")
        return text, provider
