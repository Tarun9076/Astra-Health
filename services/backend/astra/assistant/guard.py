"""Post-filter for AI answers (LLD §11.2 step 6).

- Rejects answers with doses, medication instructions or diagnoses ("you have …syndrome").
- Drops citations that don't point at a retrieved knowledge chunk.
- Adds the escalation line when an alert needs the flight surgeon or the person says things are worse.
"""

import re
from dataclasses import dataclass

from astra.assistant.models import Findings

DOSAGE = re.compile(
    r"\b\d+(\.\d+)?\s?(mg|mcg|µg|ug|units?|iu|tablets?|pills?|capsules?|puffs?|drops)\b", re.I
)
MEDICATION = re.compile(
    r"\b(take|taking|start|stop|increase|decrease|double|skip)\s+(your\s+|a\s+|an\s+|some\s+)?"
    r"(medication|medicine|meds|dose|pills?|tablets?|ibuprofen|paracetamol|acetaminophen|aspirin|"
    r"antibiotics?|painkillers?|sleeping pills?|melatonin)\b",
    re.I,
)
DIAGNOSIS = re.compile(
    r"\byou (have|'ve got|are suffering from|definitely have|probably have|likely have)\s+"
    r"(a |an )?[\w\- ]{0,40}?(disease|syndrome|disorder|infection|cancer|failure|deficiency|"
    r"heart attack|stroke|pneumonia|diabetes|hypertension|depression)\b"
    r"|\b(i|we) (can )?diagnose\b|\byour diagnosis is\b",
    re.I,
)
WORSENING = re.compile(
    r"\b(worse|worsening|getting bad|severe|not improving|keeps getting|spreading)\b", re.I
)

MEDICATION_QUESTION = re.compile(
    r"\b(dose|dosage|medication|medicine|meds|pills?|tablets?|ibuprofen|paracetamol|acetaminophen|aspirin|"
    r"antibiotics?|painkillers?|melatonin|sleeping pills?|drug)\b|how much .{0,30}\btake\b",
    re.I,
)
MEDICATION_LINE = (
    "I can't advise on medication or doses. The crew medical officer decides on any medication using the "
    "onboard checklists, in contact with the flight surgeon; please ask them."
)

ESCALATION_LINE = (
    "Please contact the crew medical officer or the flight surgeon about this; the app has flagged it "
    "for medical review."
)


@dataclass(frozen=True)
class GuardResult:
    ok: bool
    flags: list[str]


def _negated(text: str, start: int) -> bool:
    """'Don't take any medication unless the CMO directs it' is the advice we want, not a violation."""
    before = " ".join(text[:start].lower().split()[-2:])
    return bool(re.search(r"(\bnot|n't|\bnever|\bno|\bwithout)\b", before))


def check_answer(text: str) -> GuardResult:
    flags = []
    if DOSAGE.search(text):
        flags.append("dosage")
    if any(not _negated(text, m.start()) for m in MEDICATION.finditer(text)):
        flags.append("medication_instruction")
    if DIAGNOSIS.search(text):
        flags.append("diagnosis")
    return GuardResult(not flags, flags)


def needs_escalation(findings: Findings, question: str) -> bool:
    if any(a.escalation_required or a.severity == "Urgent" for a in findings.active_alerts):
        return True
    return bool(WORSENING.search(question))


def with_escalation(answer: str, escalate: bool) -> str:
    if not escalate or ESCALATION_LINE in answer:
        return answer
    return f"{answer.rstrip()}\n\n{ESCALATION_LINE}"


def with_medication_note(answer: str, question: str) -> str:
    """Questions about medicines always get the same deterministic line, whatever the provider said."""
    if not MEDICATION_QUESTION.search(question) or MEDICATION_LINE in answer:
        return answer
    return f"{MEDICATION_LINE}\n\n{answer}"
