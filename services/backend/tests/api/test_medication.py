"""Medication Guide API (Step 20): T-MED-07..10."""

from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from astra.db.models import MedicationDose, SyncOutbox
from tests.conftest import auth

BACK_OK = {"numb": False, "injury": False, "fever": False}
HEAD_OK = {"worst": False, "neuro": False, "fever-neck": False, "head-injury": False}


def _ask(client: TestClient, headers: dict[str, str], dose_id: str, **change: Any) -> Any:
    body = {"id": dose_id, "conditionId": "back-pain", "medicineId": "acetaminophen", "answers": BACK_OK}
    return client.post("/api/medication/doses", json=body | change, headers=headers)


def test_formulary_and_profiles(seeded_client: TestClient) -> None:
    c = seeded_client
    ast1, ast2, ast3, surgeon = (auth(c, u) for u in ("ast1", "ast2", "ast3", "surgeon1"))
    f = c.get("/api/medication/formulary", headers=ast1).json()
    assert f["status"] == "demo" and len(f["conditions"]) == 10 and len(f["medicines"]) == 9
    diph = next(m for m in f["medicines"] if m["id"] == "diphenhydramine")
    assert diph["expired"] is True and diph["stockLeft"] == 48 and diph["drowsy"] is True

    mine = c.get("/api/astronauts/AST-001/medical-profile", headers=ast1).json()
    assert mine["allergies"] == ["NSAID"] and mine["canEdit"] is False
    assert c.get("/api/astronauts/AST-001/medical-profile", headers=ast3).status_code == 403  # not theirs
    assert c.get("/api/astronauts/AST-001/medical-profile", headers=ast2).json()["canEdit"] is True  # the CMO
    body = {"allergies": ["NSAID"], "conditions": ["asthma"], "regularMedicines": [], "note": "updated"}
    assert c.put("/api/astronauts/AST-001/medical-profile", json=body, headers=ast1).status_code == 403
    assert c.put("/api/astronauts/AST-001/medical-profile", json=body | {"allergies": ["peanut"]},
                 headers=surgeon).status_code == 422  # fmt: skip
    r = c.put("/api/astronauts/AST-001/medical-profile", json=body, headers=ast2)
    assert (
        r.status_code == 200
        and r.json()["conditions"] == ["asthma"]
        and r.json()["updatedBy"] == "Dr. M. Okafor"
    )
    with Session(c.app.state.engine) as s:  # type: ignore[attr-defined]
        assert (
            s.exec(select(SyncOutbox).where(SyncOutbox.entity_type == "MedicalProfile")).first() is not None
        )


def test_advice_answers_every_question_and_respects_the_allergy(seeded_client: TestClient) -> None:
    # T-MED-07
    c = seeded_client
    ast1 = auth(c, "ast1")
    url = "/api/astronauts/AST-001/medication/advice"
    assert (
        c.post(url, json={"conditionId": "back-pain", "answers": {"numb": False}}, headers=ast1).status_code
        == 422
    )
    stop = c.post(
        url, json={"conditionId": "back-pain", "answers": BACK_OK | {"numb": True}}, headers=ast1
    ).json()
    assert (
        stop["stop"]["protocol"] == "EMG-NEURO-SYMPTOMS"
        and stop["options"] == []
        and stop["recommended"] is None
    )
    advice = c.post(url, json={"conditionId": "back-pain", "answers": BACK_OK}, headers=ast1).json()
    ibu, acet = advice["options"]
    assert ibu["status"] == "blocked" and "Allergy on record" in ibu["checks"][0]["text"]
    assert advice["recommended"] == "acetaminophen" and acet["doseText"] == "2 tablets (1000 mg)"
    assert acet["kitLocation"] == "Medical kit, drawer A1" and advice["formularyStatus"] == "demo"
    # the server re-checks too: asking for the blocked medicine is refused
    r = _ask(c, ast1, "dose-blocked-01", medicineId="ibuprofen")
    assert r.status_code == 409 and "Allergy on record" in r.json()["detail"]


def test_request_confirm_take_follow_up_and_review(seeded_client: TestClient) -> None:
    # T-MED-08: the whole path, with the roles: astronaut asks, CMO confirms, astronaut takes it
    c = seeded_client
    ast1, ast2, ast3, surgeon = (auth(c, u) for u in ("ast1", "ast2", "ast3", "surgeon1"))
    r = _ask(c, ast1, "dose-back-0001")
    assert r.status_code == 201 and r.json()["status"] == "Requested"
    assert _ask(c, ast1, "dose-back-0001").json()["status"] == "Requested"  # sent twice: stored once
    assert _ask(c, ast1, "dose-back-0002").status_code == 409  # one already waiting
    assert (
        c.post("/api/medication/doses/dose-back-0001/taken", headers=ast1).status_code == 409
    )  # not confirmed

    assert c.get("/api/medication/doses", headers=ast3).status_code == 403
    assert (
        c.post(
            "/api/medication/doses/dose-back-0001/confirm", json={"approve": True}, headers=ast3
        ).status_code
        == 403
    )
    queue = c.get("/api/medication/doses", headers=ast2).json()
    assert [(d["id"], d["status"], d["astronautCode"]) for d in queue] == [
        ("dose-back-0001", "Requested", "AST-001")
    ]
    r = c.post("/api/medication/doses/dose-back-0001/confirm", json={"approve": True}, headers=ast2)
    assert r.status_code == 200 and (r.json()["status"], r.json()["confirmedBy"]) == (
        "Confirmed",
        "Dr. M. Okafor",
    )

    r = c.post("/api/medication/doses/dose-back-0001/taken", headers=ast1)
    assert r.status_code == 200 and r.json()["status"] == "Taken" and r.json()["followUpDue"] is False
    stock = {
        m["id"]: m["stockLeft"] for m in c.get("/api/medication/formulary", headers=ast1).json()["medicines"]
    }
    assert stock["acetaminophen"] == 98
    again = _ask(c, ast1, "dose-back-0003")
    assert again.status_code == 409 and "Too soon" in again.json()["detail"]

    r = c.post("/api/medication/doses/dose-back-0001/outcome", json={"outcome": "worse"}, headers=ast1)
    assert r.json()["outcome"] == "worse"
    assert (
        c.post("/api/medication/doses/dose-back-0001/review", json={"note": "x"}, headers=ast1).status_code
        == 403
    )
    r = c.post(
        "/api/medication/doses/dose-back-0001/review", json={"note": "Seen. Call at 18:00."}, headers=surgeon
    )
    assert r.json()["reviewNote"] == "Seen. Call at 18:00." and r.json()["reviewedBy"]
    mine = c.get("/api/astronauts/AST-001/medication/doses", headers=ast1).json()
    assert [d["status"] for d in mine] == ["Taken"]


def test_decline_cancel_and_confirming_alone(seeded_client: TestClient) -> None:
    # T-MED-09: the CMO can decline (with a reason); the CMO's own dose and "no CMO available" are
    # confirmed alone, with a reason, and flagged for the flight surgeon
    c = seeded_client
    ast1, ast2, ast3 = (auth(c, u) for u in ("ast1", "ast2", "ast3"))
    _ask(c, ast3, "dose-ast3-0001", conditionId="headache", answers=HEAD_OK)
    assert (
        c.post(
            "/api/medication/doses/dose-ast3-0001/confirm", json={"approve": False}, headers=ast2
        ).status_code
        == 422
    )
    decline = {"approve": False, "reason": "Drink water first"}
    r = c.post("/api/medication/doses/dose-ast3-0001/confirm", json=decline, headers=ast2)
    assert (r.json()["status"], r.json()["declineReason"]) == ("Declined", "Drink water first")

    _ask(c, ast3, "dose-ast3-0002", conditionId="headache", answers=HEAD_OK)
    assert c.post("/api/medication/doses/dose-ast3-0002/cancel", headers=ast3).json()["status"] == "Cancelled"

    assert _ask(c, ast2, "dose-cmo-0001", conditionId="headache", answers=HEAD_OK).status_code == 422
    r = _ask(
        c, ast2, "dose-cmo-0001", conditionId="headache", answers=HEAD_OK, selfConfirmReason="I am the CMO"
    )
    assert r.status_code == 201 and (r.json()["status"], r.json()["selfConfirmed"]) == ("Confirmed", True)
    r = _ask(c, ast1, "dose-ast1-0009", conditionId="headache", answers=HEAD_OK,
             selfConfirmReason="CMO on EVA, link down")  # fmt: skip
    assert r.json()["status"] == "Confirmed" and r.json()["selfConfirmReason"] == "CMO on EVA, link down"
    with Session(c.app.state.engine) as s:  # type: ignore[attr-defined]
        rows = s.exec(select(MedicationDose)).all()
        assert {r.id: r.status for r in rows} == {
            "dose-ast3-0001": "Declined", "dose-ast3-0002": "Cancelled",
            "dose-cmo-0001": "Confirmed", "dose-ast1-0009": "Confirmed",
        }  # fmt: skip


def test_assistant_links_the_guide_and_repeats_only_the_confirmed_dose(seeded_client: TestClient) -> None:
    # T-MED-10: no dose from the AI before the guide; after confirmation, exactly that dose
    c = seeded_client
    ast1 = auth(c, "ast1")
    r = c.post(
        "/api/assistant/chat", json={"question": "What can I take for my headache?"}, headers=ast1
    ).json()
    assert r["medicationGuide"] == {"conditionId": "headache", "title": "Headache"}
    assert r["shortAnswer"].startswith(
        "I don't choose medicines myself. Open the Medication Guide (Headache)"
    )
    _ask(c, ast1, "dose-head-0001", conditionId="headache", answers=HEAD_OK, selfConfirmReason="CMO asleep")
    r = c.post(
        "/api/assistant/chat", json={"question": "How much medicine for my headache?"}, headers=ast1
    ).json()
    expected = "Your confirmed medicine for headache (Medication Guide, checked by the CMO): "
    assert r["shortAnswer"].startswith(expected + "Acetaminophen (paracetamol), 2 tablets (1000 mg).")
    plain = c.post("/api/assistant/chat", json={"question": "Why am I tired?"}, headers=ast1).json()
    assert plain["medicationGuide"] is None
