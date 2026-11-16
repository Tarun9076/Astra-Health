"""Treatment at check-in (Step 21): T-TX-01..05.

- T-TX-01: every clinical case in protocols/treatments/cases.json (shared with the on-device engine).
- T-TX-02: safety properties on 400 random situations (never an allergy, never a "do not give",
  never over a 24-hour limit, each medicine once, same input → same answer).
- T-TX-03: broken protocol files are refused with a clear message.
"""

import json
import random
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from astra.core.medication import Formulary, Profile, TakenDose
from astra.core.protocols import ProtocolBundle, load_protocol_bundle
from astra.core.symptoms import CHECKIN_SYMPTOMS
from astra.core.treatment import Assessment, Situation, TreatmentProtocol, Treatments, assess
from tests.conftest import PROTOCOLS_DIR

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=UTC)
CASES = json.loads((PROTOCOLS_DIR / "treatments" / "cases.json").read_text(encoding="utf-8"))["cases"]


@pytest.fixture(scope="module")
def parts(bundle: ProtocolBundle) -> tuple[Treatments, Formulary]:
    assert bundle.treatments is not None and bundle.formulary is not None
    return bundle.treatments, bundle.formulary


def situation(raw: dict[str, Any], formulary: Formulary) -> Situation:
    profile = raw.get("profile", {})
    stock = {m.id: m.stock_units for m in formulary.medicines} | raw.get("stock", {})
    return Situation(
        rules=frozenset(raw.get("rules", [])),
        symptoms=dict(raw.get("symptoms", {})),
        vitals={k: float(v) for k, v in raw.get("vitals", {}).items()},
        questionable=frozenset(raw.get("questionable", [])),
        profile=Profile(
            frozenset(profile.get("allergies", [])),
            frozenset(profile.get("conditions", [])),
            frozenset(profile.get("regularMedicines", [])),
        ),  # fmt: skip
        history=tuple(
            TakenDose(h["medicine"], h["units"], NOW - timedelta(minutes=h["minutesAgo"]))
            for h in raw.get("history", [])
        ),  # fmt: skip
        stock=stock,
        pending=tuple(raw.get("pending", [])),
        now=NOW,
    )


def summary(a: Assessment) -> dict[str, Any]:
    """The same shape the web unit tests build from the on-device engine."""
    picks: dict[str, str | None] = {}
    rejected: dict[str, list[str]] = {}
    cautions: dict[str, list[str]] = {}
    for p in a.critical:
        for s in p.steps:
            if s.step.kind != "medicine":
                continue
            key = f"{p.protocol.id}/{s.step.id}"
            picks[key] = f"{s.pick.medicine.id} {s.pick.dose_text}" if s.pick else None
            rejected[key] = [f"{r.medicine_id}:{c}" for r in s.rejected for c in r.codes]
            cautions[key] = [c.code for c in s.pick.checks if c.level == "caution"] if s.pick else []
    return {
        "tier": a.tier,
        "critical": [p.protocol.id for p in a.critical],
        "routine": [[r.condition, r.tier] for r in a.routine],
        "picks": picks,
        "rejected": rejected,
        "cautions": cautions,
        "remeasure": {p.protocol.id: list(p.remeasure) for p in a.critical if p.remeasure},
    }


def check_case(case: dict[str, Any], got: dict[str, Any]) -> list[str]:
    """Only what the case states is checked; picks/rejected/cautions per listed step."""
    out = []
    for key in ("tier", "critical", "routine"):
        if key in case["expect"] and got[key] != case["expect"][key]:
            out.append(f"{key}: expected {case['expect'][key]}, got {got[key]}")
    for key in ("picks", "rejected", "cautions", "remeasure"):
        expected = case["expect"].get(key)
        if expected is None:
            continue
        if key == "picks" and expected == {} and got["picks"]:
            out.append(f"picks: expected no medicine steps, got {got['picks']}")
        for step, value in expected.items():
            actual = got[key].get(step)
            if key in ("rejected", "cautions"):
                if not set(value) <= set(actual or []):
                    out.append(f"{key} {step}: expected {value} in {actual}")
            elif actual != value:
                out.append(f"{key} {step}: expected {value}, got {actual}")
    return out


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_clinical_cases(case: dict[str, Any], parts: tuple[Treatments, Formulary]) -> None:
    # T-TX-01
    treatments, formulary = parts
    got = summary(
        assess(treatments, formulary, situation(case["situation"], formulary), chosen=case.get("chosen"))
    )
    problems = check_case(case, got)
    assert not problems, f"{case['id']} ({case['why']}): " + "; ".join(problems)


def test_safety_properties_on_random_situations(parts: tuple[Treatments, Formulary]) -> None:
    # T-TX-02
    treatments, formulary = parts
    rng = random.Random(21)
    vocab = formulary.vocabulary
    rules = sorted({r for p in treatments.protocols.values() for r in p.triggers.rules}
                   | {r for link in treatments.routine.links for r in link.rules})  # fmt: skip
    for _ in range(400):
        history = tuple(
            TakenDose(m.id, rng.randint(1, m.max_per_dose), NOW - timedelta(minutes=rng.randint(1, 3000)))
            for m in rng.sample(formulary.medicines, rng.randint(0, 4))
        )
        s = Situation(
            rules=frozenset(rng.sample(rules, rng.randint(0, 3))),
            symptoms={c: rng.randint(1, 10) for c in rng.sample(sorted(CHECKIN_SYMPTOMS), rng.randint(0, 4))},
            vitals={
                "glucose": rng.uniform(30, 140),
                "spo2": rng.uniform(78, 100),
                "body_temp": rng.uniform(36, 41),
            },
            profile=Profile(
                frozenset(rng.sample(sorted(vocab.allergies), rng.randint(0, 2))),
                frozenset(rng.sample(sorted(vocab.conditions), rng.randint(0, 3))),
                frozenset(rng.sample(sorted(vocab.regular_medicines), rng.randint(0, 2))),
            ),
            history=history,
            stock={m.id: rng.choice([0, 1, 3, m.stock_units]) for m in formulary.medicines},
            now=NOW,
        )
        chosen = rng.choice([None, None, *treatments.protocols])
        a = assess(treatments, formulary, s, chosen=chosen)
        assert a == assess(treatments, formulary, s, chosen=chosen)  # same input, same answer
        if a.tier == 3:
            assert a.critical and all(p.steps for p in a.critical)
        forbidden = [d for p in a.critical for d in p.protocol.do_not_give]
        seen: set[str] = set()
        for p in a.critical:
            for step in p.steps:
                if step.pick is None:
                    continue
                med = step.pick.medicine
                overrides = set(step.step.override)
                assert med.id not in seen, f"{med.id} planned twice"
                seen.add(med.id)
                assert not set(med.allergy_groups) & s.profile.allergies, f"{med.id} given despite an allergy"
                assert not any(d.target in (med.id, med.route, *med.groups) for d in forbidden), (
                    f"{med.id} given despite a do-not-give rule"
                )
                if "limit24h" not in overrides:
                    taken = sum(
                        d.units
                        for d in s.history
                        if d.medicine_id == med.id and NOW - d.at < timedelta(hours=24)
                    )
                    assert taken + step.pick.units <= med.max_units_per_24h, (
                        f"{med.id} over its 24-hour limit"
                    )
                if "stock" not in overrides:
                    assert s.stock[med.id] >= step.pick.units, f"{med.id} given with no stock"


def _broken(
    tmp: Path, protocols_copy: Path, change: dict[str, Any], name: str = "TX-CHEST-PAIN"
) -> list[str]:
    file = protocols_copy / "treatments" / f"{name}.json"
    original = PROTOCOLS_DIR / "treatments" / f"{name}.json"  # each change starts from the real file
    data = json.loads(original.read_text(encoding="utf-8")) | change
    file.write_text(json.dumps(data), encoding="utf-8")
    try:
        load_protocol_bundle(protocols_copy)
    except Exception as exc:  # ProtocolError lists every problem
        return [str(p) for p in getattr(exc, "problems", [str(exc)])]
    return []


def test_broken_protocol_files_are_refused(tmp_path: Path, protocols_copy: Path) -> None:
    # T-TX-03
    base = json.loads((PROTOCOLS_DIR / "treatments" / "TX-CHEST-PAIN.json").read_text(encoding="utf-8"))
    steps = base["steps"]
    loop = [*steps[:-1], steps[-1] | {"next": "rest"}]  # back to the start, no limit
    assert any("loop without a limit" in p for p in _broken(tmp_path, protocols_copy, {"steps": loop}))
    bad_target = [steps[0] | {"next": "nowhere"}, *steps[1:]]
    assert any(
        "unknown step 'nowhere'" in p for p in _broken(tmp_path, protocols_copy, {"steps": bad_target})
    )
    bad_med = [s | {"medicines": [{"medicine": "morphine"}]} if s["kind"] == "medicine" else s for s in steps]
    assert any(
        "unknown medicine 'morphine'" in p for p in _broken(tmp_path, protocols_copy, {"steps": bad_med})
    )
    over = [
        s | {"medicines": [{"medicine": "aspirin81", "doseUnits": 9}]} if s["kind"] == "medicine" else s
        for s in steps
    ]
    assert any(
        "above its largest single dose" in p for p in _broken(tmp_path, protocols_copy, {"steps": over})
    )
    assert any("doNotGive" in p for p in _broken(tmp_path, protocols_copy, {"doNotGive": None}))
    assert any(
        "unknown symptom" in p
        for p in _broken(tmp_path, protocols_copy, {"triggers": {"symptoms": [{"code": "hiccups"}]}})
    )


def test_every_critical_protocol_is_complete(parts: tuple[Treatments, Formulary]) -> None:
    # T-TX-04: escalation, approval and an end on every path
    treatments, _ = parts
    assert len(treatments.protocols) == 7
    for p in treatments.protocols.values():
        assert isinstance(p, TreatmentProtocol) and p.escalation and p.approval.status == "demo"
        ends = {t for _, _, t in p.edges()} & {"done", "escalate"}
        assert "done" in ends or "escalate" in ends, p.id
