"""The simulator produces the intended stories, deterministically."""

from statistics import mean

from astra.simulation.generator import SimReading, generate
from astra.simulation.scenario import load_scenario

SCENARIO = load_scenario()
READINGS = generate(SCENARIO, seed=42)


def _series(astronaut: str, indicator: str, channel: str | None = None) -> list[SimReading]:
    return [
        r for r in READINGS if r.astronaut == astronaut and r.indicator == indicator and r.channel == channel
    ]


def _day(r: SimReading) -> int:
    return (r.measured_at.date() - SCENARIO.mission.start).days + 1


def test_covers_preflight_and_mission_for_three_crew() -> None:
    days = sorted({_day(r) for r in READINGS})
    assert days[0] == -29 and days[-1] == 120
    assert {r.astronaut for r in READINGS} == {"AST-001", "AST-002", "AST-003"}


def test_is_deterministic_including_ids() -> None:
    again = generate(SCENARIO, seed=42)
    assert [(r.id, r.value) for r in again[:50]] == [(r.id, r.value) for r in READINGS[:50]]
    assert len({r.id for r in READINGS}) == len(READINGS)


def test_fatigue_story_for_ast001_from_day_114() -> None:
    rhr = {_day(r): r.value for r in _series("AST-001", "resting_hr")}
    sleep = {_day(r): r.value for r in _series("AST-001", "sleep_hours")}
    assert mean(rhr[d] for d in range(100, 113)) < 70
    assert mean(rhr[d] for d in range(118, 121)) > 80
    assert mean(sleep[d] for d in range(118, 121)) < 5


def test_in_flight_sleep_is_shorter_than_preflight() -> None:
    sleep = {_day(r): r.value for r in _series("AST-002", "sleep_hours")}
    assert mean(sleep[d] for d in range(1, 101)) < mean(sleep[d] for d in range(-29, 1)) - 0.3


def test_real_may_2024_storm_is_replayed_from_day_87() -> None:
    dose = {_day(r): r.value for r in _series("AST-001", "radiation_dose", "Total")}
    storm_days = {d for d, v in dose.items() if v > 5}
    assert storm_days == {87, 88, 89, 91}  # NASA DONKI SEP activity on 9, 10, 11 and 13 May 2024
    assert 0.5 < mean(dose[d] for d in range(1, 80)) < 0.8  # ≈ 0.64 mSv/day on Mars


def test_neutron_channel_is_about_thirty_percent() -> None:
    total = {_day(r): r.value for r in _series("AST-003", "radiation_dose", "Total")}
    neutron = {_day(r): r.value for r in _series("AST-003", "radiation_dose", "Neutron")}
    assert abs(neutron[50] / total[50] - 0.30) < 0.01


def test_sensor_glitch_has_poor_signal() -> None:
    (glitch,) = _series("AST-002", "heart_rate")
    assert _day(glitch) == 60 and glitch.signal_quality == 0.3
