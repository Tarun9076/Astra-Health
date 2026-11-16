"""Medication Guide safety checks (Step 20; LLD §15.7): T-MED-01..06. Pure functions, real formulary."""

from datetime import UTC, datetime, timedelta

import pytest

from astra.core.medication import (
    Formulary,
    Profile,
    TakenDose,
    advise,
    evaluate,
    match_condition,
)
from astra.core.protocols import ProtocolBundle

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)


@pytest.fixture
def formulary(bundle: ProtocolBundle) -> Formulary:
    assert bundle.formulary is not None
    return bundle.formulary


def full_stock(f: Formulary) -> dict[str, int]:
    return {m.id: m.stock_units for m in f.medicines}


def test_formulary_loads_and_references_are_checked(formulary: Formulary) -> None:
    # T-MED-01: every medicine, group, condition and emergency procedure it names exists
    routine = [m for m in formulary.medicines if m.kit == "routine"]
    assert len(routine) == 9 and len(formulary.medicines) == 13 and len(formulary.conditions) == 10
    assert (
        formulary.status == "demo"
        and formulary.approved_by is None
        and "NOT been approved" in formulary.disclaimer
    )
    assert all(m.source_url.startswith("https://dailymed.nlm.nih.gov/") for m in routine)
    assert all(m.source_url.startswith("https://") for m in formulary.medicines)
    broken = formulary.model_copy(
        update={"conditions": [formulary.conditions[0].model_copy(update={"options": [
            formulary.conditions[0].options[0].model_copy(update={"medicine": "aspirin"})]})]}
    )  # fmt: skip
    assert broken.problems({"EMG-NEURO-SYMPTOMS", "EMG-FEVER"}) == [
        "condition 'headache': unknown medicine 'aspirin'"
    ]
    assert any("unknown emergency procedure" in p for p in formulary.problems(set()))


def test_red_flag_stops_the_guide(formulary: Formulary) -> None:
    # T-MED-02: any "yes" → no medicine, the emergency procedure or the CMO
    back = formulary.condition("back-pain")
    assert back is not None
    advice = advise(formulary, back, {"numb": True}, Profile(), [], stock=full_stock(formulary), now=NOW)
    assert advice.stop is not None and advice.stop.protocol == "EMG-NEURO-SYMPTOMS"
    assert advice.options == () and advice.recommended is None
    advice = advise(formulary, back, {"injury": True}, Profile(), [], stock=full_stock(formulary), now=NOW)
    assert advice.stop is not None and (advice.stop.action, advice.stop.protocol) == ("cmo", None)


def test_allergy_and_conditions_pick_the_next_safe_medicine(formulary: Formulary) -> None:
    # T-MED-03: back pain → ibuprofen first; an NSAID allergy blocks it and acetaminophen is recommended
    back = formulary.condition("back-pain")
    assert back is not None
    plain = advise(formulary, back, {}, Profile(), [], stock=full_stock(formulary), now=NOW)
    assert plain.recommended is not None and plain.recommended.medicine.id == "ibuprofen"
    assert plain.recommended.dose_text == "1 tablet (200 mg)" and plain.recommended.status == "ok"

    allergic = advise(formulary, back, {}, Profile(allergies=frozenset({"NSAID"})), [],
                      stock=full_stock(formulary), now=NOW)  # fmt: skip
    ibu, acet = allergic.options
    assert ibu.status == "blocked" and ibu.checks[0].code == "allergy" and ibu.next_allowed_at is None
    assert allergic.recommended is acet and acet.dose_text == "2 tablets (1000 mg)"

    kidney = advise(formulary, back, {}, Profile(conditions=frozenset({"kidney"})), [],
                    stock=full_stock(formulary), now=NOW)  # fmt: skip
    assert kidney.options[0].status == "blocked" and kidney.recommended is kidney.options[1]
    asthma = advise(formulary, back, {}, Profile(conditions=frozenset({"asthma"})), [],
                    stock=full_stock(formulary), now=NOW)  # fmt: skip
    assert asthma.options[0].status == "caution" and asthma.recommended is asthma.options[0]


def test_interactions_with_regular_medicines_and_recent_doses(formulary: Formulary) -> None:
    ibu = formulary.medicine("ibuprofen")
    meclizine = formulary.medicine("meclizine")
    assert ibu is not None and meclizine is not None
    on_thinner = evaluate(formulary, ibu, None, Profile(regular_medicines=frozenset({"anticoagulant"})), [],
                          stock_left=100, now=NOW)  # fmt: skip
    assert on_thinner.status == "blocked" and on_thinner.checks[0].code == "interaction"
    # a drowsy antihistamine 3 h ago: meclizine gets a caution (more drowsiness), not a block
    recent = [TakenDose("diphenhydramine", 1, NOW - timedelta(hours=3))]
    out = evaluate(formulary, meclizine, None, Profile(), recent, stock_left=30, now=NOW)
    assert out.status == "caution" and {c.code for c in out.checks} == {"interaction", "drowsy"}


def test_interval_and_24_hour_limit_give_the_next_possible_time(formulary: Formulary) -> None:
    # T-MED-04: acetaminophen: 6 h between doses, at most 6 tablets in 24 h
    acet = formulary.medicine("acetaminophen")
    assert acet is not None
    one = [TakenDose("acetaminophen", 2, NOW - timedelta(hours=2))]
    out = evaluate(formulary, acet, None, Profile(), one, stock_left=98, now=NOW)
    assert out.status == "blocked" and [c.code for c in out.checks] == ["interval"]
    assert out.next_allowed_at == NOW + timedelta(hours=4)
    three = [TakenDose("acetaminophen", 2, NOW - timedelta(hours=h)) for h in (7, 13, 19)]
    out = evaluate(formulary, acet, None, Profile(), three, stock_left=94, now=NOW)
    assert [c.code for c in out.checks] == ["limit24h"] and "6 tablets (3000 mg)" in out.checks[0].text
    assert out.next_allowed_at == NOW - timedelta(hours=19) + timedelta(hours=24)  # the oldest dose expires
    assert evaluate(formulary, acet, None, Profile(), three[:2], stock_left=96, now=NOW).status == "ok"


def test_days_limit_stock_expiry_and_pending(formulary: Formulary) -> None:
    # T-MED-05: nose spray 3 days at most; empty kit; expired box; a dose already waiting
    spray = formulary.medicine("oxymetazoline")
    sleep_med = formulary.medicine("diphenhydramine")
    assert spray is not None and sleep_med is not None
    three_days = [TakenDose("oxymetazoline", 1, NOW - timedelta(days=d)) for d in (1, 2, 3)]
    out = evaluate(formulary, spray, None, Profile(), three_days, stock_left=50, now=NOW)
    assert out.status == "blocked" and [c.code for c in out.checks] == ["days"]
    assert evaluate(formulary, spray, None, Profile(), [], stock_left=0, now=NOW).checks[0].code == "stock"
    low = evaluate(formulary, spray, None, Profile(), [], stock_left=3, now=NOW)
    assert low.status == "caution" and low.checks[0].code == "stock"
    expired = evaluate(
        formulary, sleep_med, None, Profile(), [], stock_left=40, now=NOW
    )  # box expired 2026-09
    assert expired.status == "caution" and {c.code for c in expired.checks} == {"expired", "drowsy"}
    waiting = evaluate(
        formulary, spray, None, Profile(), [], stock_left=50, pending=["oxymetazoline"], now=NOW
    )
    assert waiting.status == "blocked" and waiting.checks[0].code == "pending"


def test_dose_size_first_dose_and_condition_override(formulary: Formulary) -> None:
    # loperamide: 2 caplets first, then 1; the sleep option uses 2 capsules of diphenhydramine
    lop = formulary.medicine("loperamide")
    diarrhea, sleep = formulary.condition("diarrhea"), formulary.condition("sleep")
    assert lop is not None and diarrhea is not None and sleep is not None
    assert evaluate(formulary, lop, diarrhea.options[0], Profile(), [], stock_left=24, now=NOW).units == 2
    after = [TakenDose("loperamide", 2, NOW - timedelta(hours=1))]
    assert evaluate(formulary, lop, diarrhea.options[0], Profile(), after, stock_left=22, now=NOW).units == 1
    night = advise(formulary, sleep, {}, Profile(), [], stock=full_stock(formulary), now=NOW)
    assert night.recommended is not None and night.recommended.dose_text == "2 capsules (50 mg)"


@pytest.mark.parametrize(
    ("text", "condition"),
    [
        ("What can I take for my headache?", "headache"),
        ("my lower back hurts, any medicine?", "back-pain"),
        ("I can't sleep, can I take a sleeping pill", "sleep"),
        ("itchy eyes and sneezing", "allergy"),
        ("what dose of ibuprofen should I take?", None),
    ],
)
def test_questions_are_matched_to_a_condition(formulary: Formulary, text: str, condition: str | None) -> None:
    # T-MED-06: the assistant links the right page of the guide
    found = match_condition(formulary, text)
    assert (found.id if found else None) == condition
