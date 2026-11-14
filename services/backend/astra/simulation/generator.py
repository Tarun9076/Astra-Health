"""Calibrated crew-data generator (LLD §16, §20.4).

Each indicator follows its personal baseline with AR(1) noise (today looks a bit like
yesterday), plus scenario effects ramped in over `rampDays`. Output is deterministic for a
given seed, and reading ids are deterministic too, so re-posting the same data is idempotent.
"""

import hashlib
import math
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, time
from typing import Any

import numpy as np

from astra.core.ids import uuid7
from astra.integrations import nasa_donki
from astra.integrations.fixtures import FIXTURES_DIR, load_fixture
from astra.simulation.scenario import CrewSpec, EventSpec, Scenario

AR_PHI = 0.6  # day-to-day persistence of the noise

SCORES = frozenset({"sleep_quality", "mood", "stress", "fatigue"})
DECIMALS = {"body_temp": 1, "sleep_hours": 2, "radiation_dose": 3, "body_weight": 1, "strength_index": 1}
LIMITS = {"spo2": (50.0, 100.0), "sleep_hours": (0.0, 16.0), **{s: (1.0, 10.0) for s in SCORES}}

# (indicator, unit, time of day UTC, device prefix or "" for manual entry)
DAILY = [
    ("sleep_hours", "h", time(6, 0), "WR"),
    ("resting_hr", "bpm", time(6, 30), "WR"),
    ("bp_sys", "mmHg", time(7, 0), "BP"),
    ("bp_dia", "mmHg", time(7, 0), "BP"),
    ("body_temp", "°C", time(7, 5), "TH"),
    ("spo2", "%", time(7, 5), "OX"),
    ("sleep_quality", "score", time(7, 15), ""),
    ("mood", "score", time(7, 15), ""),
    ("stress", "score", time(7, 15), ""),
    ("fatigue", "score", time(7, 15), ""),
    ("activity_min", "min", time(21, 0), "WR"),
    ("hydration_ml", "mL", time(22, 0), ""),
]
EVERY_THIRD_DAY = [("glucose", "mg/dL", time(7, 10), "GL")]
WEEKLY = [
    ("body_weight", "kg", time(7, 20), "MASS"),
    ("strength_index", "%", time(18, 0), "EX"),
    ("exercise_sessions", "count", time(21, 30), ""),
]


@dataclass(frozen=True)
class SimReading:
    astronaut: str
    indicator: str
    value: float
    unit: str
    measured_at: datetime
    device_id: str = ""
    channel: str | None = None
    panel_id: str | None = None
    signal_quality: float | None = None

    @property
    def id(self) -> str:
        key = f"{self.astronaut}|{self.indicator}|{self.channel}|{self.measured_at.isoformat()}"
        ms = int(self.measured_at.timestamp() * 1000)
        return str(uuid7(ms, hashlib.sha256(key.encode()).digest()))

    def to_api(self) -> dict[str, Any]:
        item: dict[str, Any] = {
            "id": self.id,
            "indicator": self.indicator,
            "value": self.value,
            "unit": self.unit,
            "measuredAt": self.measured_at.isoformat(),
            "source": "Simulated",
        }
        optional = {
            "deviceId": self.device_id,
            "channel": self.channel,
            "panelId": self.panel_id,
            "signalQuality": self.signal_quality,
        }
        item.update({k: v for k, v in optional.items() if v})
        return item


class _Noise:
    """Independent AR(1) series per (astronaut, indicator)."""

    def __init__(self, seed: int) -> None:
        self._rng = np.random.default_rng(seed)
        self._state: dict[tuple[str, str], float] = {}

    def next(self, astronaut: str, indicator: str) -> float:
        prev = self._state.get((astronaut, indicator), 0.0)
        value = AR_PHI * prev + math.sqrt(1 - AR_PHI**2) * float(self._rng.standard_normal())
        self._state[(astronaut, indicator)] = value
        return value


def _ramp(event: EventSpec, day: int) -> float:
    if day < event.start_day:
        return 0.0
    return min(1.0, (day - event.start_day + 1) / event.ramp_days)


def _round(indicator: str, value: float) -> float:
    low, high = LIMITS.get(indicator, (0.0, math.inf))
    value = min(max(value, low), high)
    return float(round(value, DECIMALS.get(indicator, 0)))


def _sep_days(event: EventSpec) -> set[int]:
    if event.replay:
        events = nasa_donki.parse_sep(load_fixture(FIXTURES_DIR / event.replay))
        return {event.start_day + offset for offset in nasa_donki.event_day_offsets(events)}
    return {event.start_day}


def generate(scenario: Scenario, *, seed: int = 42) -> list[SimReading]:
    return sorted(_generate(scenario, seed), key=lambda r: (r.astronaut, r.measured_at, r.indicator))


def _generate(scenario: Scenario, seed: int) -> Iterator[SimReading]:
    mission = scenario.mission
    noise = _Noise(seed)
    spe_days: dict[int, float] = {}
    for event in scenario.events:
        if event.scenario == "spe_radiation":
            effect = event.effects.get("radiation_dose")
            factor = effect.multiply if effect and effect.multiply else 1.0
            spe_days.update(dict.fromkeys(_sep_days(event), factor))

    for n, crew in enumerate(scenario.crew, start=1):
        events = [e for e in scenario.events if e.astronaut in (None, crew.code)]
        for day in mission.all_days():
            yield from _CrewDay(scenario, noise, crew, n, events, day).readings(spe_days.get(day, 1.0))


@dataclass(frozen=True)
class _CrewDay:
    """Everything generated for one crew member on one day."""

    scenario: Scenario
    noise: _Noise
    crew: CrewSpec
    number: int  # 1-based crew index, used in device ids (WR-1, BP-1, …)
    events: list[EventSpec]
    day: int

    @property
    def on_mission(self) -> bool:
        return self.day >= 1

    def at(self, t: time) -> datetime:
        return datetime.combine(self.scenario.mission.date_of(self.day), t, tzinfo=UTC)

    def value(self, indicator: str) -> float:
        mission = self.scenario.mission
        mean, sd = self.scenario.baseline(self.crew, indicator)
        v = mean + sd * self.noise.next(self.crew.code, indicator)
        if self.on_mission:
            v += mission.in_flight_shift.get(indicator, 0.0)
            if indicator == "strength_index":
                v += mission.strength_drift_pct_per_day * self.day
        for event in self.events:
            effect = event.effects.get(indicator)
            if effect and effect.delta is not None:
                v += effect.delta * _ramp(event, self.day)
        return _round(indicator, v)

    def reading(self, indicator: str, unit: str, t: time, device: str, **kw: Any) -> SimReading:
        device_id = f"{device}-{self.number}" if device else ""
        return SimReading(self.crew.code, indicator, self.value(indicator), unit, self.at(t), device_id, **kw)

    def readings(self, radiation_factor: float) -> Iterator[SimReading]:
        code = self.crew.code
        for indicator, unit, t, device in DAILY:
            panel = f"BP-{code}-{self.at(t).date().isoformat()}" if indicator.startswith("bp_") else None
            yield self.reading(indicator, unit, t, device, panel_id=panel)
        if self.day % 3 == 0:
            for indicator, unit, t, device in EVERY_THIRD_DAY:
                yield self.reading(indicator, unit, t, device)
        if self.day % 7 == 0:
            for indicator, unit, t, device in WEEKLY:
                yield self.reading(indicator, unit, t, device)

        # Radiation: personal dosimeter, total + neutron channels
        radiation = self.scenario.radiation
        mean, sd = radiation.mission_msv_per_day if self.on_mission else radiation.preflight_msv_per_day
        total = max(mean + sd * self.noise.next(code, "radiation_dose"), 0.0) * radiation_factor
        for channel, dose in (("Total", total), ("Neutron", total * radiation.neutron_share)):
            yield SimReading(code, "radiation_dose", _round("radiation_dose", dose), "mSv",
                             self.at(time(23, 55)), f"DOS-{self.number}", channel=channel)  # fmt: skip

        # Sensor glitch: one implausible-looking wearable reading with poor signal
        for event in self.events:
            spike = event.effects.get("heart_rate")
            if event.scenario == "sensor_glitch" and spike and self.day == event.start_day:
                yield SimReading(code, "heart_rate", spike.spike or 190, "bpm", self.at(time(14, 0)),
                                 f"WR-{self.number}", signal_quality=spike.signal_quality)  # fmt: skip
