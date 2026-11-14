"""Golden scenario tests (TDD §9): the full simulated mission through the real intake + assessment.

- ARES-1 scenario: fatigue onset (AST-001, day 114), the real May 2024 solar storm (day 87),
  a sensor glitch (AST-002, day 60). The right alerts must appear at the right time.
- Healthy crew (same data, no events): the false-alarm budget (T-SC-01).
"""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import Engine
from sqlmodel import Session, select

from astra.config import BACKEND_ROOT
from astra.core.protocols import ProtocolBundle, load_protocol_bundle
from astra.db.models import HealthAlert, HealthMeasurement
from astra.db.session import init_db, make_engine
from astra.seed import load_seed, seed_database
from astra.services.crew import find_astronaut
from astra.services.ingestion import IncomingReading, ingest_batch
from astra.simulation.generator import SimReading, generate
from astra.simulation.scenario import Scenario, load_scenario
from tests.conftest import PROTOCOLS_DIR

NOW = datetime(2026, 11, 14, 8, 0, tzinfo=UTC)
SCENARIO = load_scenario()
START: date = SCENARIO.mission.start


def mission_day(t: datetime) -> int:
    return (t.date() - START).days + 1


def _incoming(r: SimReading) -> IncomingReading:
    return IncomingReading(
        id=r.id,
        indicator=r.indicator,
        value=r.value,
        unit=r.unit,
        measured_at=r.measured_at,
        source="Simulated",
        device_id=r.device_id,
        channel=r.channel,
        panel_id=r.panel_id,
        signal_quality=r.signal_quality,
        is_simulated=True,
    )


def _run_mission(path: str, scenario: Scenario, bundle: ProtocolBundle) -> Engine:
    engine = make_engine(f"sqlite:///{path}")
    init_db(engine)
    readings = generate(scenario, seed=42)
    with Session(engine) as session:
        seed_database(session, load_seed(BACKEND_ROOT / "seed.example.json"), bcrypt_rounds=4)
        for code in sorted({r.astronaut for r in readings}):
            astronaut = find_astronaut(session, code)
            assert astronaut is not None
            mine = [_incoming(r) for r in readings if r.astronaut == code]
            for i in range(0, len(mine), 500):  # same batch size as the simulator CLI
                ingest_batch(
                    session, bundle, astronaut, mine[i : i + 500], node_id="TEST", backfill=True, now=NOW
                )
    return engine


@dataclass(frozen=True)
class AlertRow:
    astronaut: str
    rule_id: str
    severity: str
    first_day: int
    last_day: int
    trigger_count: int


def _alerts(engine: Engine) -> list[AlertRow]:
    with Session(engine) as session:
        codes = {
            a.id: a.code for a in [find_astronaut(session, c) for c in ("AST-001", "AST-002", "AST-003")] if a
        }
        return [
            AlertRow(codes[a.astronaut_id], a.rule_id, a.severity, mission_day(a.first_triggered_at),
                     mission_day(a.last_triggered_at), a.trigger_count)
            for a in session.exec(select(HealthAlert)).all()
        ]  # fmt: skip


@pytest.fixture(scope="module")
def bundle_m() -> ProtocolBundle:
    return load_protocol_bundle(PROTOCOLS_DIR)


@pytest.fixture(scope="module")
def mission(tmp_path_factory: pytest.TempPathFactory, bundle_m: ProtocolBundle) -> Iterator[Engine]:
    engine = _run_mission((tmp_path_factory.mktemp("ares1") / "m.db").as_posix(), SCENARIO, bundle_m)
    yield engine
    engine.dispose()


@pytest.fixture(scope="module")
def healthy(tmp_path_factory: pytest.TempPathFactory, bundle_m: ProtocolBundle) -> Iterator[Engine]:
    calm = SCENARIO.model_copy(update={"events": []})
    engine = _run_mission((tmp_path_factory.mktemp("healthy") / "h.db").as_posix(), calm, bundle_m)
    yield engine
    engine.dispose()


def test_fatigue_pattern_detected_within_days_of_onset(mission: Engine) -> None:
    # T-R-04: onset ramps in from day 114; the composite alert must fire by day 117
    fatigue = [
        a for a in _alerts(mission) if a.astronaut == "AST-001" and a.rule_id == "BEH-FATIGUE-COMPOSITE"
    ]
    assert len(fatigue) == 1, fatigue
    assert 114 <= fatigue[0].first_day <= 117, fatigue
    assert fatigue[0].last_day == 120  # still active at the end of the data


def test_resting_heart_rate_and_sleep_alerts_join_the_fatigue_story(mission: Engine) -> None:
    active_at_end = {a.rule_id for a in _alerts(mission) if a.astronaut == "AST-001" and a.last_day == 120}
    assert active_at_end == {"CV-RHR-BASELINE", "SLP-DEFICIT", "BEH-FATIGUE-COMPOSITE"}
    rhr = next(a for a in _alerts(mission) if a.astronaut == "AST-001" and a.rule_id == "CV-RHR-BASELINE")
    assert rhr.first_day >= 114  # heart-rate rise is part of the episode, not earlier noise


def test_real_may_2024_storm_raises_urgent_radiation_alert_on_day_87_for_everyone(mission: Engine) -> None:
    storm = [a for a in _alerts(mission) if a.rule_id == "RAD-SPE-EVENT"]
    assert sorted(a.astronaut for a in storm) == ["AST-001", "AST-002", "AST-003"]
    assert all(a.severity == "Urgent" and a.first_day == 87 and a.last_day == 91 for a in storm), storm


def test_sensor_glitch_is_questionable_and_raises_nothing(mission: Engine) -> None:
    # T-R-06: a 190 bpm reading with poor signal must never alarm
    with Session(mission) as session:
        glitch = session.exec(
            select(HealthMeasurement).where(HealthMeasurement.indicator_code == "heart_rate")
        ).one()
    assert (glitch.quality, glitch.quality_reason, mission_day(glitch.measured_at)) == (
        "Questionable",
        "low_signal",
        60,
    )
    assert not [a for a in _alerts(mission) if a.astronaut == "AST-002" and a.first_day == 60]


def test_high_normal_heart_rate_is_not_flagged_for_ast003(mission: Engine) -> None:
    # Context-aware: AST-003's ~80 bpm is their normal, so no heart-rate alert at the end of the mission
    assert not [a for a in _alerts(mission) if a.astronaut == "AST-003" and a.rule_id == "CV-RHR-BASELINE"
                and a.last_day >= 110]  # fmt: skip


def test_healthy_crew_false_alarm_budget(healthy: Engine) -> None:
    # T-SC-01: 120 days without events → no Urgent, at most 2 Attention alerts per astronaut
    alerts = _alerts(healthy)
    assert not [a for a in alerts if a.severity == "Urgent"], alerts
    for code in ("AST-001", "AST-002", "AST-003"):
        mine = [a for a in alerts if a.astronaut == code]
        assert len(mine) <= 2, mine


def test_wellness_index_tracks_the_fatigue_episode(mission: Engine) -> None:
    from astra.db.models import WellnessScore

    with Session(mission) as session:
        ast1 = find_astronaut(session, "AST-001")
        assert ast1 is not None
        rows = {
            mission_day(datetime.combine(r.score_date, datetime.min.time(), tzinfo=UTC)): r
            for r in session.exec(select(WellnessScore).where(WellnessScore.astronaut_id == ast1.id)).all()
        }
    calm = [rows[d].overall for d in range(60, 80) if d in rows]  # before the day-87 storm
    assert len(calm) == 20 and min(o for o in calm if o is not None) >= 75
    # Nobody closes the Urgent storm alert in this test, so the index stays capped at 40 afterwards
    # (by design: Urgent alerts never close themselves).
    assert rows[88].overall == rows[100].overall == 40
    assert rows[120].overall is not None and rows[120].overall < 40  # fatigue episode on top
    assert rows[87].overall == 40  # urgent solar-storm alert caps the index
