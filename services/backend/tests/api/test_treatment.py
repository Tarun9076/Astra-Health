"""Treatment at check-in and Act Now API (Step 21): T-TX-05..08, T-TX-11."""

import time
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from astra.db.models import MedicationDose, SyncOutbox, TreatmentEvent
from tests.conftest import auth

CHECKIN: dict[str, Any] = {"sleepHours": 7, "sleepQuality": 7, "mood": 7, "stress": 3, "fatigue": 3}


def _checkin(c: TestClient, who: str, **extra: Any) -> dict[str, Any]:
    r = c.post("/api/checkins", json=CHECKIN | extra, headers=auth(c, who))
    assert r.status_code == 201, r.text
    return r.json()


def _step(plan: dict[str, Any], step_id: str) -> dict[str, Any]:
    return next(s for s in plan["steps"] if s["id"] == step_id)


def test_checkin_returns_what_to_do_now(seeded_client: TestClient) -> None:
    # T-TX-05: nothing, mild, critical: decided by the protocols at check-in
    c = seeded_client
    assert _checkin(c, "ast2")["treatment"] is None
    mild = _checkin(c, "ast3", symptoms=[{"code": "headache", "severity": 3}])["treatment"]
    assert (mild["tier"], mild["tierWord"], mild["critical"]) == (1, "Mild", [])
    assert mild["routine"] == [
        {"condition": "headache", "title": "Headache", "tier": 1, "matchedBy": ["symptom headache 3/10"]}
    ]

    out = _checkin(c, "ast1", vitals=[{"indicator": "glucose", "value": 45, "unit": "mg/dL"}])
    t = out["treatment"]
    assert (
        t["tier"] == 3
        and t["tierWord"] == "Critical: act now"
        and [p["id"] for p in t["critical"]] == ["TX-LOW-GLUCOSE"]
    )
    plan = t["critical"][0]
    assert plan["approvalStatus"] == "demo" and plan["actFirst"] is True and plan["escalation"]
    glucose = _step(plan, "glucose")
    assert glucose["pick"]["doseText"] == "4 tablets (16 g)" and glucose["pick"]["route"] == "chew"
    assert glucose["pick"]["kitLocation"] == "Emergency kit, pocket E1" and glucose["ifNone"] == "glucagon"
    assert _step(plan, "swallow")["yes"] == "glucose" and _step(plan, "recheck")["afterMinutes"] == 15
    assert plan["steps"][0]["id"] == "swallow"  # self-rescue: the first screen is already the treatment
    assert _step(plan, "glucagon")["pick"]["doseText"] == "1 injection (1 mg)"
    assert len(plan["steps"]) <= 8 and not any("Call the crew" in s["text"] for s in plan["steps"])


def test_help_now_respects_the_profile_and_access(seeded_client: TestClient) -> None:
    # T-TX-06: any crewmate opens a protocol for anyone; AST-001's NSAID allergy rules out aspirin
    c = seeded_client
    ast3 = auth(c, "ast3")
    url = "/api/astronauts/AST-001/treatment/assess"
    assert c.post(url, json={}, headers=ast3).status_code == 403  # not theirs, no emergency
    r = c.post(url, json={"protocolId": "TX-CHEST-PAIN"}, headers=ast3)
    assert r.status_code == 200
    aspirin = _step(r.json()["critical"][0], "aspirin")
    assert aspirin["pick"] is None and aspirin["rejected"][0]["codes"] == ["allergy"]
    assert "No safe medicine in the kit" in aspirin["withheld"]
    assert c.post(url, json={"protocolId": "TX-NOPE"}, headers=ast3).status_code == 404
    p = c.get("/api/treatment/protocols", headers=ast3).json()
    assert len(p["protocols"]) == 7 and [m["code"] for m in p["crew"]] == ["AST-001", "AST-002", "AST-003"]
    assert p["protocols"][0]["priority"] == 1 and "NOT been approved" in p["disclaimer"]


def test_episode_log_doses_and_review(seeded_client: TestClient) -> None:
    # T-TX-07: a crewmate treats AST-001; doses are always recorded, with flags when the checks disagree
    c = seeded_client
    ast1, ast2, ast3, surgeon = (auth(c, u) for u in ("ast1", "ast2", "ast3", "surgeon1"))
    plan = c.post(
        "/api/astronauts/AST-001/treatment/assess", json={"protocolId": "TX-SEVERE-ALLERGY"}, headers=ast3
    ).json()
    body = {"id": "episode-0001", "astronautCode": "AST-001", "protocolIds": ["TX-SEVERE-ALLERGY"], "tier": 3,
            "source": "help-now", "plan": plan}  # fmt: skip
    r = c.post("/api/treatment/episodes", json=body, headers=ast3)
    assert (
        r.status_code == 201 and r.json()["startedBy"] == "Eng. L. Fischer" and r.json()["status"] == "Active"
    )
    assert (
        c.post("/api/treatment/episodes", json=body, headers=ast3).status_code == 201
    )  # sent twice: stored once
    assert (
        c.post("/api/treatment/episodes", json=body | {"id": "episode-0002"}, headers=surgeon).status_code
        == 403
    )

    def event(eid: str, kind: str, who: dict[str, str] = ast3, **kw: Any) -> Any:
        return c.post(
            "/api/treatment/episodes/episode-0001/events", json={"id": eid, "kind": kind, **kw}, headers=who
        )

    dose = {"medicineId": "epinephrine", "units": 1, "readBackBy": "Dr. M. Okafor"}
    first = event("event-0001", "dose_given", protocolId="TX-SEVERE-ALLERGY", stepId="epi", data=dose)
    assert first.status_code == 200 and first.json()["events"][0]["flags"] == []
    assert (
        event("event-0001", "dose_given", protocolId="TX-SEVERE-ALLERGY", stepId="epi", data=dose).status_code
        == 200
    )
    event(
        "event-0002",
        "recheck",
        protocolId="TX-SEVERE-ALLERGY",
        stepId="better",
        data={"answer": "no", "result": "failed"},
    )
    # a second injection one minute later: recorded (it was given), flagged as too soon
    second = event("event-0003", "dose_given", protocolId="TX-SEVERE-ALLERGY", stepId="epi",
                   data={"medicineId": "epinephrine", "units": 1})  # fmt: skip
    flags = second.json()["events"][-1]["flags"]
    assert any("Too soon" in f for f in flags)
    assert (
        event("event-0004", "note", who=ast1, data={"text": "breathing easier"}).status_code == 200
    )  # the patient
    assert event("event-0005", "dose_given", data={"medicineId": "morphine", "units": 1}).status_code == 422
    done = event("event-0006", "resolved", data={"note": "Breathing normal after 2 doses"})
    assert (
        done.json()["status"] == "Resolved" and done.json()["outcomeNote"] == "Breathing normal after 2 doses"
    )

    with Session(c.app.state.engine) as s:  # type: ignore[attr-defined]
        doses = s.exec(select(MedicationDose).where(MedicationDose.medicine_id == "epinephrine")).all()
        assert sorted((d.status, d.self_confirmed) for d in doses) == [("Taken", False), ("Taken", True)]
        assert len(s.exec(select(TreatmentEvent)).all()) == 5
        kinds = {o.entity_type for o in s.exec(select(SyncOutbox).where(SyncOutbox.priority == 1)).all()}
        assert {"TreatmentEpisode", "TreatmentEvent", "MedicationDose"} <= kinds
    stock = {
        m["id"]: m["stockLeft"] for m in c.get("/api/medication/formulary", headers=ast1).json()["medicines"]
    }
    assert stock["epinephrine"] == 2

    # after the end, only the patient, the CMO and the surgeon still see it
    assert c.get("/api/treatment/episodes/episode-0001", headers=ast3).status_code == 404
    assert c.get("/api/treatment/episodes/episode-0001", headers=ast2).status_code == 200
    assert event("event-0007", "note", data={"text": "late"}).status_code == 403
    r = c.post(
        "/api/treatment/episodes/episode-0001/review",
        json={"note": "Good. Restock epinephrine."},
        headers=surgeon,
    )
    assert r.json()["reviewNote"] == "Good. Restock epinephrine." and r.json()["reviewedBy"]
    mine = c.get("/api/treatment/episodes", params={"astronaut": "AST-001"}, headers=ast1).json()
    assert [e["id"] for e in mine] == ["episode-0001"] and len(mine[0]["events"]) == 5
    guide = c.get("/api/astronauts/AST-001/medication/doses", headers=ast1).json()
    assert {d["conditionTitle"] for d in guide} == {"Severe allergic reaction"}


def test_active_critical_episodes_are_visible_to_the_whole_crew(seeded_client: TestClient) -> None:
    # T-TX-08: the crew alarm: any crewmate can open an active critical treatment of another
    c = seeded_client
    ast1, ast3 = auth(c, "ast1"), auth(c, "ast3")
    plan = c.post(
        "/api/astronauts/AST-001/treatment/assess", json={"protocolId": "TX-CHEST-PAIN"}, headers=ast1
    ).json()
    body = {"id": "episode-crew-1", "astronautCode": "AST-001", "protocolIds": ["TX-CHEST-PAIN"], "tier": 3,
            "source": "help-now", "plan": plan}  # fmt: skip
    assert c.post("/api/treatment/episodes", json=body, headers=ast1).status_code == 201
    active = c.get("/api/treatment/episodes", params={"active": "true"}, headers=ast3).json()
    assert [(e["id"], e["astronautCode"], e["title"]) for e in active] == [
        ("episode-crew-1", "AST-001", "Chest pain")
    ]


def test_rechecks_are_readings_and_finished_treatments_are_not_reopened(seeded_client: TestClient) -> None:
    # T-TX-11: the recheck value goes into the health record; the next check-in does not restart the same
    # treatment from old evidence (the Urgent alert stays open for the surgeon); new evidence does.
    c = seeded_client
    ast2 = auth(c, "ast2")
    first = _checkin(c, "ast2", vitals=[{"indicator": "glucose", "value": 45, "unit": "mg/dL"}])["treatment"]
    assert first["tier"] == 3
    body = {"id": "episode-glu-1", "astronautCode": "AST-002", "protocolIds": ["TX-LOW-GLUCOSE"], "tier": 3,
            "source": "checkin", "plan": first}  # fmt: skip
    assert c.post("/api/treatment/episodes", json=body, headers=ast2).status_code == 201
    url = "/api/treatment/episodes/episode-glu-1/events"
    recheck = {"id": "event-glu-1", "kind": "recheck", "protocolId": "TX-LOW-GLUCOSE", "stepId": "recheck",
               "data": {"indicator": "glucose", "value": 84, "result": "passed"}}  # fmt: skip
    assert c.post(url, json=recheck, headers=ast2).status_code == 200
    time.sleep(1.1)  # a real treatment takes minutes; check-in times are stored to the second
    assert c.post(url, json={"id": "event-glu-2", "kind": "resolved"}, headers=ast2).status_code == 200
    latest = c.get(
        "/api/astronauts/AST-002/measurements", params={"indicator": "glucose"}, headers=ast2
    ).json()
    assert latest["points"][-1]["value"] == 84

    again = _checkin(c, "ast2")["treatment"]
    assert again is None or again["tier"] < 3  # treated: not reopened
    alerts = c.get("/api/astronauts/AST-002/alerts", params={"status": "active"}, headers=ast2).json()
    assert any(a["ruleId"] == "MET-GLUCOSE-LOW" for a in alerts)  # still open for the flight surgeon

    new = _checkin(c, "ast2", vitals=[{"indicator": "glucose", "value": 41, "unit": "mg/dL"}])["treatment"]
    assert new["tier"] == 3 and [p["id"] for p in new["critical"]] == ["TX-LOW-GLUCOSE"]  # new evidence
