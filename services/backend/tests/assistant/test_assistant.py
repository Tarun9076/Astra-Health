"""AI Health Assistant (LLD §19): T-AI-01 red flags, T-AI-02 no doses, T-AI-03 no key → template with
citations, T-AI-04 valid citations only; plus retrieval, the guard, providers and fallback."""

import json
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx
import pytest

from astra.assistant.guard import ESCALATION_LINE, check_answer
from astra.assistant.knowledge import Retriever, load_knowledge
from astra.assistant.models import AssistantRequest, FindingAlert, Findings, LatestValue
from astra.assistant.redflag import RedFlagRouter
from astra.assistant.service import Assistant
from astra.config import REPO_ROOT
from astra.core.protocols import ProtocolBundle
from tests.conftest import PROTOCOLS_DIR

SOURCES = {
    "https://www.nasa.gov/hrp/hazards/",
    "http://nasa.gov/hrp/risks/",
    "https://www.nasa.gov/hrp/ongoing-hrp-research/",
    "https://www.asc-csa.gc.ca/eng/news/articles/2026/2026-02-26-monitoring-radiation-astronaut-health.asp",
    "https://www.asc-csa.gc.ca/eng/iss/science/why-do-we-conduct-science-experiments-in-space.asp",
}
FINDINGS = Findings(
    astronaut_code="AST-001",
    mission_day=121,
    latest={
        "resting_hr": LatestValue(
            name="Resting heart rate", value=92, unit="bpm", baseline=64, sigma=3, z=9.3
        ),
        "sleep_hours": LatestValue(
            name="Sleep duration", value=4.5, unit="h", baseline=6.2, sigma=0.5, z=-3.3
        ),
        "body_temp": LatestValue(
            name="Body temperature", value=36.6, unit="°C", baseline=36.7, sigma=0.15, z=-0.6
        ),
    },
    active_alerts=[
        FindingAlert(
            rule_id="BEH-FATIGUE-COMPOSITE",
            title="Fatigue and recovery pattern needs review",
            severity="Attention",
            reason="Sleep has averaged 4.3 h …",
            escalation_required=False,
        )
    ],  # fmt: skip
    tasks=["Recheck resting heart rate at wake-up"],
)


@pytest.fixture(scope="module")
def router(bundle: ProtocolBundle) -> RedFlagRouter:
    return RedFlagRouter.from_file(PROTOCOLS_DIR / "redflags.yaml", set(bundle.emergency_protocols))


@pytest.fixture(scope="module")
def retriever() -> Retriever:
    return Retriever(load_knowledge(REPO_ROOT / "knowledge"))


# --- T-AI-01: red flags are caught deterministically, before any AI ---------------------------------


@pytest.mark.parametrize(
    ("question", "flag", "report"),
    [
        ("I have chest pain", "CHEST-PAIN", True),
        ("my chest feels tight and it hurts", "CHEST-PAIN", True),
        ("I can’t breathe properly", "BREATHING", True),
        ("I fainted after the treadmill session", "SYNCOPE", True),
        ("my speech is slurred and my face is drooping", "NEURO", True),
        ("I feel suddenly confused", "NEURO", True),
        ("there is heavy bleeding from my hand", "BLEEDING", True),
        ("I keep thinking I want to end my life", "SELF-HARM", True),
        ("What should I do if I get chest pain?", "CHEST-PAIN", False),  # question about it, not a report
        ("What are the warning signs of a heart attack?", "CHEST-PAIN", False),
        ("what if I get chest pain? I think I'm having it right now", "CHEST-PAIN", True),
    ],
)
def test_red_flags_are_detected(router: RedFlagRouter, question: str, flag: str, report: bool) -> None:
    hit = router.check(question)
    assert hit is not None and hit.flag.id == flag and hit.report is report, hit


@pytest.mark.parametrize(
    "question",
    [
        "Why is my resting heart rate increasing?",
        "I have no chest pain, just tired",
        "I don't have chest pain but I slept badly",
        "How can I sleep better before the sudden schedule change?",
        "What is SANS?",
    ],
)
def test_ordinary_questions_are_not_red_flags(router: RedFlagRouter, question: str) -> None:
    assert router.check(question) is None


def test_red_flag_file_must_name_real_protocols(tmp_path: Any) -> None:
    from pathlib import Path

    from astra.assistant.redflag import RedFlagError

    path = Path(str(tmp_path)) / "redflags.yaml"
    path.write_text("redFlags:\n  - {id: X, symptom: x, protocol: EMG-NOPE, title: X, patterns: [x]}\n")
    with pytest.raises(RedFlagError, match="unknown emergency protocol 'EMG-NOPE'"):
        RedFlagRouter.from_file(path, {"EMG-CHEST-PAIN"})


# --- knowledge base + retrieval ---------------------------------------------------------------------


def test_knowledge_base_notes_cite_the_organizer_sources(retriever: Retriever) -> None:
    assert retriever.note_count >= 25
    for chunk in retriever.chunks:
        assert set(chunk.sources) <= SOURCES, chunk.id
        assert len(chunk.text) > 60, chunk.id


@pytest.mark.parametrize(
    ("query", "note"),
    [
        ("Why is my resting heart rate increasing?", {"kb-cardio-reduced-gravity", "kb-fatigue-recovery"}),
        ("what do I do during a solar storm", {"kb-radiation-shelter-spe"}),
        ("why is my vision blurry up close", {"kb-sans-vision"}),
        ("how much of the radiation is neutrons", {"kb-neutron-radiation"}),
        ("I can't fall asleep at night", {"kb-sleep-circadian"}),
        ("How can I sleep better on Mars?", {"kb-sleep-circadian"}),  # "Mars" is context, not topic
        ("I feel dizzy when I stand up", {"kb-orthostatic-dizziness"}),
        ("I feel lonely and stressed", {"kb-stress-coping", "kb-hazard-isolation"}),
    ],
)
def test_retrieval_finds_the_right_note(retriever: Retriever, query: str, note: set[str]) -> None:
    top = [c.note_id for c, _ in retriever.search(query, k=3)]
    assert note & set(top), top


# --- the guard (T-AI-02) ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "flag"),
    [
        ("Take 400 mg of ibuprofen before bed.", "dosage"),
        ("You should start taking melatonin tonight.", "medication_instruction"),
        ("You have heart failure, unfortunately.", "diagnosis"),
        ("Based on this I diagnose you with anaemia.", "diagnosis"),
    ],
)
def test_guard_rejects_doses_medication_and_diagnoses(text: str, flag: str) -> None:
    verdict = check_answer(text)
    assert not verdict.ok and flag in verdict.flags


def test_guard_allows_safe_advice() -> None:
    assert check_answer("Don't take any medication unless the CMO directs it. Drink 500 ml of water.").ok
    assert check_answer("Your heart rate is 92 bpm, above your normal of 64 bpm. Mars gravity is 0.38 g.").ok


# --- providers -----------------------------------------------------------------------------------


class FakeMessages:
    def __init__(self, replies: list[Any]) -> None:
        self.replies, self.calls = replies, []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def fake_claude(*replies: Any) -> Any:
    messages = FakeMessages(list(replies))
    return SimpleNamespace(beta=SimpleNamespace(messages=messages), messages_api=messages)


def reply(answer: str, citations: list[str], stop_reason: str = "end_turn") -> Any:
    body = json.dumps(
        {
            "short_answer": answer,
            "detail": "",
            "citation_ids": citations,
            "suggested_actions": ["Recheck at wake-up"],
        }
    )
    return SimpleNamespace(
        stop_reason=stop_reason,
        content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=body)],
    )


@pytest.fixture
def assistant(bundle: ProtocolBundle, router: RedFlagRouter, retriever: Retriever) -> Assistant:
    return Assistant(retriever, router, bundle)


QUESTION = "Why is my resting heart rate increasing?"


def test_template_answers_from_findings_and_knowledge(assistant: Assistant) -> None:
    # T-AI-03: no API key → template answer with citations
    out = assistant.answer(AssistantRequest(question=QUESTION, findings=FINDINGS))
    assert (out.mode, out.provider) == ("template", "template")
    # Step 14: a short answer in everyday words first, then the details; no statistics words
    short, _, detail = out.answer.partition("\n\n")
    assert short == "Your resting heart rate is much higher than usual: 92 bpm instead of about 64 bpm."
    assert (
        "Your resting heart rate is 92 bpm; your usual is about 64 bpm, so this is well above your usual."
        in detail
    )
    assert "σ" not in out.answer
    assert "Fatigue and recovery pattern needs review" in out.answer
    assert out.citations and all(c.source in SOURCES for c in out.citations)
    assert out.suggested_actions == ["Recheck resting heart rate at wake-up"]


def test_same_question_uses_claude_when_configured(assistant: Assistant) -> None:
    chunk = assistant.retrieve(AssistantRequest(question=QUESTION, findings=FINDINGS))[0].id
    assistant.claude = fake_claude(
        reply("Your resting heart rate is 92 bpm, well above your normal.", [chunk, "kb-made-up#9"])
    )
    out = assistant.answer(AssistantRequest(question=QUESTION, findings=FINDINGS))
    assert (out.mode, out.provider) == ("llm", "claude")
    assert [c.chunk_id for c in out.citations] == [chunk]  # T-AI-04: unknown citation dropped
    assert "dropped 1 unknown citation(s)" in out.safety_flags
    call = assistant.claude.beta.messages.calls[0]
    assert call["model"] == "claude-opus-5-5" and call["output_config"]["effort"] == "low"
    assert call["fallbacks"] == "default" and "findings" in call["messages"][-1]["content"]


def test_claude_dose_answer_is_retried_then_replaced_by_template(assistant: Assistant) -> None:
    bad = reply("Take 400 mg of ibuprofen.", [])
    assistant.claude = fake_claude(bad, reply("Take 200 mg instead.", []))
    out = assistant.answer(AssistantRequest(question=QUESTION, findings=FINDINGS))
    assert out.provider == "template" and "guard: dosage" in out.safety_flags
    second = assistant.claude.beta.messages.calls[1]["messages"][-1]["content"]
    assert "rejected because it contained dosage" in second


@pytest.mark.parametrize(
    "failure",
    [
        reply("", [], stop_reason="refusal"),
        anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages")),
    ],
)
def test_claude_failure_falls_back_to_template(assistant: Assistant, failure: Any) -> None:
    assistant.claude = fake_claude(failure)
    out = assistant.answer(AssistantRequest(question=QUESTION, findings=FINDINGS))
    assert out.provider == "template" and any(f.startswith("fallback:") for f in out.safety_flags)


def test_no_internet_skips_the_online_model_for_a_while(assistant: Assistant) -> None:
    # T-AI-07: with no internet, only the first question waits for the network; the next ones are
    # answered offline at once, and the model is tried again after the pause.
    offline = anthropic.APIConnectionError(
        request=httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    )
    good = reply("Your resting heart rate is 92 bpm, well above your normal.", [])
    assistant.claude = fake_claude(offline, good)
    request = AssistantRequest(question=QUESTION, findings=FINDINGS)
    assert assistant.answer(request).provider == "template"
    second = assistant.answer(request)
    assert second.provider == "template" and "fallback: no internet, offline answer" in second.safety_flags
    assert len(assistant.claude.beta.messages.calls) == 1  # not tried again during the pause
    assistant.offline_until = 0.0  # the pause is over
    assert assistant.answer(request).provider == "claude"


def test_template_preference_skips_claude(assistant: Assistant) -> None:
    assistant.claude = fake_claude()  # would raise IndexError if called
    out = assistant.answer(
        AssistantRequest(question=QUESTION, findings=FINDINGS, preferred_provider="template")
    )
    assert out.provider == "template"


def test_escalation_line_when_an_alert_needs_the_surgeon(assistant: Assistant) -> None:
    alert = FINDINGS.active_alerts[0].model_copy(update={"escalation_required": True})
    findings = FINDINGS.model_copy(update={"active_alerts": [alert]})
    out = assistant.answer(AssistantRequest(question=QUESTION, findings=findings))
    assert out.answer.endswith(ESCALATION_LINE)
    calm = assistant.answer(AssistantRequest(question=QUESTION, findings=FINDINGS))
    assert ESCALATION_LINE not in calm.answer


def test_red_flag_never_reaches_the_ai(assistant: Assistant) -> None:
    assistant.claude = fake_claude()  # would raise if called
    out = assistant.answer(AssistantRequest(question="I have chest pain", findings=FINDINGS))
    assert (out.mode, out.provider, out.emergency_protocol_id, out.report) == (
        "emergency", "redflag", "EMG-CHEST-PAIN", True,
    )  # fmt: skip


def test_dose_question_gets_no_dose_and_is_sent_to_the_cmo(assistant: Assistant) -> None:
    # T-AI-02: no dose from the AI; the answer starts with the way to the Medication Guide (Step 20)
    from astra.assistant.guard import medication_line

    out = assistant.answer(
        AssistantRequest(question="What dose of ibuprofen should I take?", findings=FINDINGS)
    )
    assert out.answer.startswith(medication_line(None, None)) and check_answer(out.answer).ok
    assert "Medication Guide" in out.answer and "crew medical officer confirms" in out.answer
    assistant.claude = fake_claude(reply("Rest and drink water.", []))
    llm = assistant.answer(
        AssistantRequest(question="Can I take a sleeping pill?", findings=FINDINGS,
                         medication_condition="Trouble sleeping (now and then)")
    )  # fmt: skip
    assert llm.provider == "claude"
    assert llm.answer.startswith(
        "I don't choose medicines myself. Open the Medication Guide (Trouble sleeping"
    )


def test_only_the_confirmed_dose_passes_the_guard(assistant: Assistant) -> None:
    # T-AI-08 (Step 20): with a CMO-confirmed dose the assistant may repeat exactly it; nothing else
    from astra.assistant.models import ApprovedMedication

    approved = ApprovedMedication(
        condition="Headache", medicine="Acetaminophen (paracetamol)", dose="2 tablets (1000 mg)",
        when="Now. If still needed, every 6 hours.", status="Confirmed",
    )  # fmt: skip
    assert check_answer("Take 2 tablets (1000 mg) of acetaminophen with water.", approved).ok
    assert check_answer("Take your medicine with water.", approved).ok
    assert check_answer("Take 3 tablets now.", approved).flags == ["dosage"]
    assert check_answer("Take ibuprofen instead.", approved).flags == ["medication_instruction"]
    assert not check_answer("Take 2 tablets (1000 mg).").ok  # without approval: still rejected

    findings = FINDINGS.model_copy(update={"approved_medication": approved})
    assistant.claude = fake_claude(
        reply("Take 2 tablets (1000 mg) of acetaminophen with a glass of water.", [])
    )
    out = assistant.answer(
        AssistantRequest(question="How much acetaminophen should I take for my headache?", findings=findings)
    )
    assert out.provider == "claude" and "guard: dosage" not in out.safety_flags
    assert out.answer.startswith(
        "Your confirmed medicine for headache (Medication Guide, checked by the CMO)"
    )
    assistant.claude = fake_claude(reply("Take 4 tablets.", []), reply("Take 4 tablets.", []))
    out = assistant.answer(AssistantRequest(question="Can I take more medicine?", findings=findings))
    assert out.provider == "template" and "guard: dosage" in out.safety_flags


# --- Gemini (Step 17): the same contract, through google-genai ------------------------------------

from google.genai import errors as genai_errors  # noqa: E402
from google.genai import types as genai_types  # noqa: E402

from astra.assistant.providers.common import SYSTEM_PROMPT  # noqa: E402


class FakeGeminiModels:
    def __init__(self, replies: list[Any]) -> None:
        self.replies, self.calls = replies, []

    def generate_content(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def fake_gemini(*replies: Any) -> Any:
    return SimpleNamespace(models=FakeGeminiModels(list(replies)))


def gemini_reply(answer: str, citations: list[str], finish: Any = genai_types.FinishReason.STOP) -> Any:
    body = json.dumps(
        {
            "short_answer": answer,
            "detail": "",
            "citation_ids": citations,
            "suggested_actions": ["Recheck at wake-up"],
        }
    )
    return SimpleNamespace(
        text=body, prompt_feedback=None, candidates=[SimpleNamespace(finish_reason=finish)]
    )


def test_gemini_answers_with_the_same_contract(assistant: Assistant) -> None:
    chunk = assistant.retrieve(AssistantRequest(question=QUESTION, findings=FINDINGS))[0].id
    assistant.gemini = fake_gemini(
        gemini_reply("Your resting heart rate is higher than usual.", [chunk, "kb-x#1"])
    )
    out = assistant.answer(AssistantRequest(question=QUESTION, findings=FINDINGS))
    assert (out.mode, out.provider) == ("llm", "gemini")
    assert [c.chunk_id for c in out.citations] == [
        chunk
    ] and "dropped 1 unknown citation(s)" in out.safety_flags
    call = assistant.gemini.models.calls[0]
    config = call["config"]
    assert call["model"] == "gemini-3.8-flash" and config.system_instruction == SYSTEM_PROMPT
    assert config.response_mime_type == "application/json"
    assert "additionalProperties" not in config.response_json_schema
    assert set(config.response_json_schema["required"]) == {
        "short_answer",
        "detail",
        "citation_ids",
        "suggested_actions",
    }
    assert config.thinking_config.thinking_level == genai_types.ThinkingLevel.LOW
    last = call["contents"][-1]
    assert last.role == "user" and "findings" in last.parts[0].text


def test_provider_choice_claude_first_unless_gemini_is_chosen(assistant: Assistant) -> None:
    assistant.claude, assistant.gemini = fake_claude(), fake_gemini()  # would raise if called
    assert assistant.provider_for("auto") == "claude"
    assistant.default_provider = "gemini"
    assert assistant.provider_for("auto") == "gemini" and assistant.provider_for("template") == "template"
    assistant.claude = None
    assistant.default_provider = "auto"
    assert assistant.provider_for("auto") == "gemini" and assistant.llm_configured
    assert assistant.model_for("gemini") == "gemini-3.8-flash"


def test_gemini_dose_answer_is_retried_then_replaced_by_template(assistant: Assistant) -> None:
    assistant.gemini = fake_gemini(
        gemini_reply("Take 400 mg of ibuprofen.", []), gemini_reply("Take 200 mg.", [])
    )
    out = assistant.answer(AssistantRequest(question=QUESTION, findings=FINDINGS))
    assert out.provider == "template" and "guard: dosage" in out.safety_flags
    second = assistant.gemini.models.calls[1]["contents"][-1].parts[0].text
    assert "rejected because it contained dosage" in second


@pytest.mark.parametrize(
    "failure",
    [
        gemini_reply("", [], finish=genai_types.FinishReason.SAFETY),
        gemini_reply("", [], finish=genai_types.FinishReason.MAX_TOKENS),
        genai_errors.APIError(
            503, {"error": {"code": 503, "message": "overloaded", "status": "UNAVAILABLE"}}
        ),
        httpx.ConnectError("no route to host"),
        SimpleNamespace(
            text="not json", prompt_feedback=None, candidates=[SimpleNamespace(finish_reason=None)]
        ),
    ],
)
def test_gemini_failure_falls_back_to_template(assistant: Assistant, failure: Any) -> None:
    assistant.gemini = fake_gemini(failure)
    out = assistant.answer(AssistantRequest(question=QUESTION, findings=FINDINGS))
    assert out.provider == "template" and any(f.startswith("fallback:") for f in out.safety_flags)


def test_gemini_writes_the_report_narrative(assistant: Assistant) -> None:
    narrative = json.dumps(
        {"narrative": "Sleep fell below the usual range this week. All data is simulated."}
    )
    reply = SimpleNamespace(
        text=narrative, prompt_feedback=None, candidates=[SimpleNamespace(finish_reason=None)]
    )
    assistant.gemini = fake_gemini(reply)
    text, provider = assistant.narrate_report({"astronaut": "AST-001"})
    assert provider == "gemini" and text.startswith("Sleep fell below")
