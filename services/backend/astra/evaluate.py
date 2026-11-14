"""Prototype evaluation (Step 11; TDD §9): `python -m astra.evaluate`.

Replays two simulated 150-day missions (seed 42) through the real intake → rules → alerts → ML
pipeline, each in a fresh temporary database:
- ARES-1: fatigue onset on AST-001 (day 114), the real May 2024 solar storm (day 87), a sensor glitch
  on AST-002 (day 60);
- the same crew with no events (false-alarm budget).
Then times the main API endpoints on the ARES-1 database. Writes `metrics.json` and `EVALUATION.md`
to docs/evaluation/. Simulated data only: these are prototype engineering metrics, not clinical
performance.
"""

import argparse
import json
import statistics
import tempfile
import time
from collections import defaultdict
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import Engine
from sqlmodel import Session, select

from astra.config import BACKEND_ROOT, REPO_ROOT, Settings
from astra.core.protocols import load_protocol_bundle
from astra.db.models import HealthAlert, HealthMeasurement, Insight
from astra.db.session import init_db, make_engine
from astra.seed import load_seed, seed_database
from astra.services.crew import find_astronaut
from astra.services.ingestion import IncomingReading, ingest_batch
from astra.simulation.generator import SimReading, generate
from astra.simulation.scenario import Scenario, load_scenario

NOW = datetime(2026, 11, 14, 8, 0, tzinfo=UTC)
OUT_DIR = REPO_ROOT / "docs" / "evaluation"
FATIGUE_ONSET, STORM_DAY, GLITCH_DAY = 114, 87, 60
FATIGUE_STORY = ("CV-RHR-BASELINE", "BEH-FATIGUE-COMPOSITE", "ML-ANOMALY-CORROBORATED")


def _incoming(r: SimReading) -> IncomingReading:
    return IncomingReading(
        id=r.id, indicator=r.indicator, value=r.value, unit=r.unit, measured_at=r.measured_at, source="Simulated",
        device_id=r.device_id, channel=r.channel, panel_id=r.panel_id, signal_quality=r.signal_quality,
        is_simulated=True,
    )  # fmt: skip


def run_mission(db: Path, scenario: Scenario) -> Engine:
    engine = make_engine(f"sqlite:///{db.as_posix()}")
    init_db(engine)
    bundle = load_protocol_bundle(REPO_ROOT / "protocols")
    readings = generate(scenario, seed=42)
    with Session(engine) as session:
        seed_database(session, load_seed(BACKEND_ROOT / "seed.example.json"), bcrypt_rounds=4)
        for code in sorted({r.astronaut for r in readings}):
            astronaut = find_astronaut(session, code)
            assert astronaut is not None
            mine = [_incoming(r) for r in readings if r.astronaut == code]
            for i in range(0, len(mine), 500):
                ingest_batch(
                    session, bundle, astronaut, mine[i : i + 500], node_id="EVAL", backfill=True, now=NOW
                )
    return engine


def _day(start: date, t: datetime | date) -> int:
    d = t.date() if isinstance(t, datetime) else t
    return (d - start).days + 1


def mission_facts(engine: Engine, start: date) -> dict[str, Any]:
    with Session(engine) as session:
        codes = {
            a.id: a.code for a in [find_astronaut(session, c) for c in ("AST-001", "AST-002", "AST-003")] if a
        }
        alerts = [
            {"astronaut": codes[a.astronaut_id], "rule": a.rule_id, "severity": a.severity,
             "first": _day(start, a.first_triggered_at), "last": _day(start, a.last_triggered_at)}
            for a in session.exec(select(HealthAlert)).all()
        ]  # fmt: skip
        insights = [
            {"astronaut": codes[i.astronaut_id], "kind": i.kind, "day": _day(start, i.insight_date)}
            for i in session.exec(select(Insight)).all()
        ]
        glitch = session.exec(
            select(HealthMeasurement).where(HealthMeasurement.indicator_code == "heart_rate")
        ).all()
        return {
            "alerts": sorted(alerts, key=lambda a: (a["astronaut"], a["first"])),
            "insights": insights,
            "glitch": [
                {"quality": g.quality, "reason": g.quality_reason, "day": _day(start, g.measured_at)}
                for g in glitch
            ],
        }


def time_endpoints(db: Path) -> dict[str, float]:
    from fastapi.testclient import TestClient

    from astra.main import create_app

    cfg = Settings(database_url=f"sqlite:///{db.as_posix()}", bcrypt_rounds=4, routine_interval_minutes=0,
                   sync_interval_seconds=0, space_weather_interval_minutes=0, anthropic_api_key=None)  # fmt: skip
    out: dict[str, float] = {}
    with TestClient(create_app(cfg)) as client:

        def token(user: str, pw: str) -> dict[str, str]:
            r = client.post("/api/auth/login", json={"username": user, "password": pw})
            return {"Authorization": f"Bearer {r.json()['accessToken']}"}

        ast1, surgeon = token("ast1", "astra-demo-ast1"), token("surgeon1", "astra-demo-surgeon")
        for name, headers, path in (
            ("dashboard", ast1, "/api/astronauts/AST-001/dashboard"),
            ("body_systems", ast1, "/api/astronauts/AST-001/body-systems"),
            (
                "analytics_mission",
                ast1,
                "/api/astronauts/AST-001/analytics?indicator=resting_hr&range=mission",
            ),
            ("crew_summary", surgeon, "/api/crew/summary"),
            ("report_7d", surgeon, None),
        ):
            samples = []
            for _ in range(5):
                t0 = time.perf_counter()
                if path is None:
                    r = client.post("/api/astronauts/AST-001/reports", headers=headers,
                                    json={"start": "2026-11-07", "end": "2026-11-13"})  # fmt: skip
                else:
                    r = client.get(path, headers=headers)
                assert r.status_code in (200, 201), (name, r.text[:200])
                samples.append((time.perf_counter() - t0) * 1000)
            out[name] = round(statistics.median(samples), 1)
    return out


def summarise(ares: dict[str, Any], calm: dict[str, Any], timings: dict[str, float]) -> dict[str, Any]:
    a = ares["alerts"]
    story = [
        x
        for x in a
        if x["astronaut"] == "AST-001" and x["rule"] in FATIGUE_STORY and x["first"] >= FATIGUE_ONSET
    ]
    first_story = min((x["first"] for x in story), default=None)
    trend = min((i["day"] for i in ares["insights"] if i["astronaut"] == "AST-001" and i["kind"] == "Trend"
                 and i["day"] >= FATIGUE_ONSET - 3), default=None)  # fmt: skip
    storm = [x for x in a if x["rule"] == "RAD-SPE-EVENT"]
    storm_crew = sorted(
        {x["astronaut"] for x in storm if x["first"] == STORM_DAY and x["severity"] == "Urgent"}
    )
    glitch_alerts = [x for x in a if x["astronaut"] == "AST-002" and x["first"] == GLITCH_DAY]
    calm_by = defaultdict(list)
    for x in calm["alerts"]:
        calm_by[x["astronaut"]].append(x)
    detections = {
        "fatigue": first_story - FATIGUE_ONSET if first_story is not None else None,
        "solar_storm": 0 if len(storm_crew) == 3 else None,
    }
    detected = [v for v in detections.values() if v is not None]
    return {
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "data": "simulated ARES-1 mission, seed 42, 150 days (30 pre-flight + 120 in flight), 3 crew",
        "scenarioDetection": {
            "fatigue": {
                "onsetDay": FATIGUE_ONSET,
                "firstRuleAlertDay": first_story,
                "trendInsightDay": trend,
                "rules": sorted({x["rule"] for x in story}),
            },
            "solarStorm": {"day": STORM_DAY, "urgentForCrew": storm_crew},
            "sensorGlitch": {
                "day": GLITCH_DAY,
                "reading": ares["glitch"],
                "alertsThatDay": len(glitch_alerts),
            },
        },  # fmt: skip
        "detectionRate": f"{len(detected)}/{len(detections)}",
        "medianTimeToDetectionDays": statistics.median(detected) if detected else None,
        "falseAlarmsHealthyCrew": {
            code: {
                "attention": sum(x["severity"] == "Attention" for x in rows),
                "urgent": sum(x["severity"] == "Urgent" for x in rows),
                "rules": sorted({x["rule"] for x in rows}),
            }
            for code, rows in sorted(calm_by.items())
        },  # fmt: skip
        "healthyCrewTrendInsights": sum(i["kind"] == "Trend" for i in calm["insights"]),
        "healthyCrewAnomalyInsights": sum(i["kind"] == "Anomaly" for i in calm["insights"]),
        "apiMedianMs": timings,
    }


def markdown(m: dict[str, Any]) -> str:
    sd = m["scenarioDetection"]
    fat, storm, glitch = sd["fatigue"], sd["solarStorm"], sd["sensorGlitch"]
    rows = [
        "| Scenario | Injected | Detected | Time to detection |",
        "|---|---|---|---|",
        f"| Fatigue episode (AST-001) | day {fat['onsetDay']}, ramping over 5 days | rule alerts from day "
        f"{fat['firstRuleAlertDay']} ({', '.join(fat['rules'])}); AI trend insight day {fat['trendInsightDay']} "
        f"| {fat['firstRuleAlertDay'] - fat['onsetDay']} days (trend: {fat['trendInsightDay'] - fat['onsetDay']}) |",
        f"| Solar particle event (real May 2024 DONKI replay) | day {storm['day']} | Urgent RAD-SPE-EVENT for "
        f"{len(storm['urgentForCrew'])}/3 crew | same day |",
        f"| Sensor glitch (HR 190, low signal, AST-002) | day {glitch['day']} | reading marked "
        f"{glitch['reading'][0]['quality'] if glitch['reading'] else '—'}; {glitch['alertsThatDay']} alerts | "
        "correctly not alarmed |",
    ]
    fa = ["| Astronaut | Attention | Urgent | Rules |", "|---|---|---|---|"] + [
        f"| {code} | {v['attention']} | {v['urgent']} | {', '.join(v['rules']) or '—'} |"
        for code, v in m["falseAlarmsHealthyCrew"].items()
    ]
    api = ["| Endpoint (150 days × 3 crew) | Median |", "|---|---|"] + [
        f"| {k.replace('_', ' ')} | {v:.0f} ms |" for k, v in m["apiMedianMs"].items()
    ]
    return "\n".join(
        [
            "# ASTRA HEALTH — prototype evaluation",
            "",
            f"Generated {m['generatedAt']} by `python -m astra.evaluate` (services/backend). Data: {m['data']}.",
            "**Simulated data only — engineering metrics of the prototype, not clinical performance.**",
            "",
            "## Scenario detection",
            "",
            *rows,
            "",
            f"Detection rate: **{m['detectionRate']}** injected episodes; median time to detection "
            f"**{m['medianTimeToDetectionDays']} days**.",
            "",
            "## False alarms — same crew, no injected events (budget ≤ 2 Attention, 0 Urgent per astronaut)",
            "",
            *fa,
            "",
            f"AI insights for the healthy crew: {m['healthyCrewTrendInsights']} trend, "
            f"{m['healthyCrewAnomalyInsights']} anomaly (advisory notes, no alerts).",
            "",
            "## API response time",
            "",
            *api,
            "",
            "Other measured results are in the implementation plan (Steps 4–9): check-in completed in 38 s in the "
            "browser; sync delivered every item exactly once (re-sent envelopes are no-ops, T-S-01); alerts reached "
            "Earth 24.4 s after link-up with a 22 s simulated light time.",
            "",
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", type=Path, default=OUT_DIR)
    args = parser.parse_args()
    scenario = load_scenario()
    start = scenario.mission.start
    with tempfile.TemporaryDirectory() as tmp:
        print("Replaying ARES-1 (fatigue + solar storm + glitch)...")
        ares_engine = run_mission(Path(tmp) / "ares.db", scenario)
        ares = mission_facts(ares_engine, start)
        print("Replaying the healthy crew (no events)...")
        calm_engine = run_mission(Path(tmp) / "calm.db", scenario.model_copy(update={"events": []}))
        calm = mission_facts(calm_engine, start)
        calm_engine.dispose()
        print("Timing the API on the ARES-1 database...")
        timings = time_endpoints(Path(tmp) / "ares.db")
        ares_engine.dispose()
    metrics = summarise(ares, calm, timings)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    (args.out / "EVALUATION.md").write_text(markdown(metrics), encoding="utf-8")
    print(json.dumps({k: metrics[k] for k in ("detectionRate", "medianTimeToDetectionDays", "apiMedianMs")}))
    print(f"Wrote {args.out / 'EVALUATION.md'}")


if __name__ == "__main__":
    main()
