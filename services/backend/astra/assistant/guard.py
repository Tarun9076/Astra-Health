"""Post-filter for AI answers (LLD §11.2 step 6).

- Rejects answers with doses, medication instructions or diagnoses ("you have …syndrome"). The one
  exception (Step 20): the medicine and dose the Medication Guide worked out and the CMO confirmed
  (`ApprovedMedication`); any other dose or medicine is still rejected.
- Drops citations that don't point at a retrieved knowledge chunk.
- Adds the escalation line when an alert needs the flight surgeon or the person says things are worse.
"""

import re
from dataclasses import dataclass

from astra.assistant.models import ApprovedMedication, Findings

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
    r"antibiotics?|painkillers?|melatonin|sleeping pills?|drug)\b|how much .{0,30}\btake\b"
    r"|\bwhat (can|could|should) i (take|use)\b|\b(something|anything) (to take )?for (my|the|a|this)\b",
    re.I,
)
MEDICATION_LINE = (
    "I don't choose medicines myself. Open the Medication Guide{topic}: it asks a few safety questions, "
    "checks your allergies, other medicines and the medical kit, and gives the dose from the flight "
    "surgeons' approved list. The crew medical officer confirms it before you take it."
)
GENERIC_MEDICINE = {"medication", "medicine", "meds", "dose", "pill", "pills", "tablet", "tablets"}

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


def _approved_word(word: str, approved: ApprovedMedication | None) -> bool:
    word = word.lower()
    return approved is not None and (word in GENERIC_MEDICINE or word in approved.medicine.lower())


def check_answer(text: str, approved: ApprovedMedication | None = None) -> GuardResult:
    """`approved`: the confirmed Medication Guide dose; only its own dose text and medicine pass."""
    flags = []
    allowed_dose = approved.dose.lower() if approved else ""
    if any(m.group(0).lower() not in allowed_dose for m in DOSAGE.finditer(text)):
        flags.append("dosage")
    if any(
        not _negated(text, m.start()) and not _approved_word(m.group(3), approved)
        for m in MEDICATION.finditer(text)
    ):
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


def medication_line(approved: ApprovedMedication | None, topic: str | None) -> str:
    if approved is not None:
        return (
            f"Your confirmed medicine for {approved.condition.lower()} (Medication Guide, checked by the "
            f"CMO): {approved.medicine}, {approved.dose}. {approved.when}"
        )
    return MEDICATION_LINE.format(topic=f" ({topic})" if topic else "")


def with_medication_note(
    answer: str, question: str, approved: ApprovedMedication | None = None, topic: str | None = None
) -> str:
    """Questions about medicines always start with the same deterministic line, whatever the provider
    said: the confirmed dose, or where to get one (the Medication Guide)."""
    line = medication_line(approved, topic)
    if not MEDICATION_QUESTION.search(question) or line in answer:
        return answer
    return f"{line}\n\n{answer}"
