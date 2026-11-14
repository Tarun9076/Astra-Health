"""Scenario file models (simulator/scenarios/*.yaml)."""

from datetime import date, timedelta
from pathlib import Path
from typing import Literal

import yaml
from pydantic import Field

from astra.config import REPO_ROOT
from astra.core.base import CoreModel

DEFAULT_SCENARIO = REPO_ROOT / "simulator" / "scenarios" / "crew.yaml"

MeanSd = tuple[float, float]


class MissionSpec(CoreModel):
    code: str
    start: date
    preflight_days: int = Field(ge=0)
    days: int = Field(ge=1)
    profile: str
    in_flight_shift: dict[str, float] = {}
    strength_drift_pct_per_day: float = 0.0

    def date_of(self, day: int) -> date:
        """Mission day 1 is the start date; day 0 is the day before (pre-flight)."""
        return self.start + timedelta(days=day - 1)

    def all_days(self) -> range:
        return range(1 - self.preflight_days, self.days + 1)


class RadiationSpec(CoreModel):
    preflight_msv_per_day: MeanSd
    mission_msv_per_day: MeanSd
    neutron_share: float = Field(ge=0, le=1)


class CrewSpec(CoreModel):
    code: str
    name: str
    baseline: dict[str, MeanSd]


class EffectSpec(CoreModel):
    delta: float | None = None
    multiply: float | None = None
    spike: float | None = None
    signal_quality: float | None = Field(default=None, ge=0, le=1)


class EventSpec(CoreModel):
    scenario: Literal["fatigue_onset", "spe_radiation", "sensor_glitch"]
    astronaut: str | None = None  # None = whole crew
    start_day: int
    ramp_days: int = Field(default=1, ge=1)
    replay: str | None = None  # fixture file in simulator/fixtures/
    effects: dict[str, EffectSpec]


class Scenario(CoreModel):
    mission: MissionSpec
    radiation: RadiationSpec
    defaults: dict[str, MeanSd] = {}
    crew: list[CrewSpec]
    events: list[EventSpec] = []

    def baseline(self, crew: CrewSpec, indicator: str) -> MeanSd:
        if indicator in crew.baseline:
            return crew.baseline[indicator]
        if indicator in self.defaults:
            return self.defaults[indicator]
        raise KeyError(f"{crew.code}: no baseline or default for '{indicator}'")


def load_scenario(path: Path = DEFAULT_SCENARIO) -> Scenario:
    return Scenario.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))
