"""Load and cross-validate everything under protocols/ (TDD ADR-04).

    protocols/indicators.json          → IndicatorCatalog
    protocols/recommendations.json     → Recommendation
    protocols/emergency/EMG-*.md       → EmergencyProtocol (YAML front matter + Markdown steps)
    protocols/mission-profiles/*.json  → MissionProfile
    protocols/rules/*.json             → Rule (checked against all of the above)
    protocols/exercise-plans.json      → ExerciseProgramme (optional; its rules must exist)
    protocols/medications.json         → Formulary (optional; Medication Guide, Step 20)

`load_protocol_bundle` collects every problem and raises one ProtocolError, so the app
refuses to start with a clear list of what to fix.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import yaml
from pydantic import Field, ValidationError

from astra.core.base import CoreModel
from astra.core.enums import Hazard
from astra.core.errors import ProtocolError, describe_validation_error
from astra.core.exercise import ExerciseProgramme
from astra.core.indicators import IndicatorCatalog, load_catalog
from astra.core.medication import Formulary
from astra.core.rules.loader import load_rules
from astra.core.rules.models import SEMVER_PATTERN, Rule


class Recommendation(CoreModel):
    code: str = Field(pattern=r"^REC-[A-Z0-9-]+$")
    title: str
    body: str
    category: Literal[
        "Sleep", "Cardiovascular", "Thermal", "Behavioral", "Radiation", "Hydration", "Exercise", "General"
    ]
    priority: int = Field(ge=1, le=3)  # 1 = do now, 3 = when convenient
    due_in_hours: int | None = Field(default=None, ge=0)
    hazards: list[Hazard] = []
    source: str


class RecommendationSet(CoreModel):
    version: str = Field(pattern=SEMVER_PATTERN)
    disclaimer: str
    recommendations: list[Recommendation]


class EmergencyProtocol(CoreModel):
    id: str = Field(pattern=r"^EMG-[A-Z0-9-]+$")
    title: str
    version: str = Field(pattern=SEMVER_PATTERN)
    severity: Literal["Urgent"]
    applies_to: list[str] = Field(min_length=1)
    disclaimer: str
    body: str = Field(min_length=20)  # the Markdown steps


class CommsDelay(CoreModel):
    min: float = Field(ge=0)  # one-way, minutes; ~0 near Earth
    max: float = Field(ge=0)


class HealthFocus(CoreModel):
    """What matters most for health in this environment, shown to the crew."""

    title: str
    detail: str
    kb: str | None = None  # knowledge-base note with the sources


class MissionProfile(CoreModel):
    code: str
    name: str
    environment: Literal["Space station", "Spacecraft", "Pressurized rover", "Planetary base"]
    location: str
    gravity_g: float = Field(ge=0, le=1)  # 0 = weightlessness (microgravity)
    sol_length_hours: float = Field(gt=0)
    day_name: str = "Day"  # "Sol" on Mars
    comms_delay_minutes: CommsDelay
    # "horizons-mars": the real Earth-Mars light time for today (JPL Horizons); else the midpoint above
    light_time: Literal["horizons-mars", "profile"] = "profile"
    evacuation: str  # how quickly a sick crew member could reach a hospital
    health_focus: list[HealthFocus] = Field(min_length=1)
    radiation_limit_msv: float = Field(gt=0)
    exercise_target_sessions_per_week: int = Field(ge=0)
    hydration_target_ml_per_day: int = Field(ge=0)
    disclaimer: str


class ProtocolCounts(CoreModel):
    indicators: int
    rules: int
    recommendations: int
    emergency_protocols: int
    mission_profiles: int


@dataclass(frozen=True)
class ProtocolBundle:
    catalog: IndicatorCatalog
    rules: tuple[Rule, ...]
    recommendations: dict[str, Recommendation] = field(default_factory=dict)
    emergency_protocols: dict[str, EmergencyProtocol] = field(default_factory=dict)
    mission_profiles: dict[str, MissionProfile] = field(default_factory=dict)
    exercise: ExerciseProgramme | None = None  # protocols/exercise-plans.json (Step 13)
    formulary: Formulary | None = None  # protocols/medications.json (Step 20)

    def counts(self) -> ProtocolCounts:
        return ProtocolCounts(
            indicators=len(self.catalog),
            rules=len(self.rules),
            recommendations=len(self.recommendations),
            emergency_protocols=len(self.emergency_protocols),
            mission_profiles=len(self.mission_profiles),
        )


def _parse_front_matter(text: str) -> tuple[dict[str, object], str]:
    if not text.startswith("---"):
        raise ValueError("missing YAML front matter (file must start with ---)")
    _, header, body = text.split("---", 2)
    data = yaml.safe_load(header)
    if not isinstance(data, dict):
        raise ValueError("front matter must be a YAML mapping")
    return data, body.strip()


def _load_emergency(directory: Path, problems: list[str]) -> dict[str, EmergencyProtocol]:
    result: dict[str, EmergencyProtocol] = {}
    for file in sorted(directory.glob("*.md")):
        label = f"emergency/{file.name}"
        try:
            meta, body = _parse_front_matter(file.read_text(encoding="utf-8"))
            protocol = EmergencyProtocol.model_validate({**meta, "body": body})
        except ValidationError as exc:
            problems.append(f"{label}: {describe_validation_error(exc)}")
            continue
        except (ValueError, yaml.YAMLError) as exc:
            problems.append(f"{label}: {exc}")
            continue
        if file.stem != protocol.id:
            problems.append(f"{label}: file name must match the protocol id '{protocol.id}'")
        result[protocol.id] = protocol
    return result


def _load_recommendations(path: Path, problems: list[str]) -> dict[str, Recommendation]:
    try:
        recs = RecommendationSet.model_validate_json(path.read_text(encoding="utf-8")).recommendations
    except ValidationError as exc:
        problems.append(f"{path.name}: {describe_validation_error(exc)}")
        return {}
    codes = [r.code for r in recs]
    problems += [
        f"{path.name}: duplicate code '{c}'" for c in sorted({c for c in codes if codes.count(c) > 1})
    ]
    return {r.code: r for r in recs}


def _load_missions(directory: Path, problems: list[str]) -> dict[str, MissionProfile]:
    result: dict[str, MissionProfile] = {}
    for file in sorted(directory.glob("*.json")):
        try:
            profile = MissionProfile.model_validate_json(file.read_text(encoding="utf-8"))
        except ValidationError as exc:
            problems.append(f"mission-profiles/{file.name}: {describe_validation_error(exc)}")
            continue
        result[profile.code] = profile
    return result


def _load_exercise(path: Path, rule_ids: set[str], problems: list[str]) -> ExerciseProgramme | None:
    if not path.is_file():
        return None
    try:
        programme = ExerciseProgramme.model_validate_json(path.read_text(encoding="utf-8"))
    except ValidationError as exc:
        problems.append(f"{path.name}: {describe_validation_error(exc)}")
        return None
    problems += [f"{path.name}: {p}" for p in programme.problems(rule_ids)]
    return programme


def _load_formulary(path: Path, emergency_ids: set[str], problems: list[str]) -> Formulary | None:
    if not path.is_file():
        return None
    try:
        formulary = Formulary.model_validate_json(path.read_text(encoding="utf-8"))
    except ValidationError as exc:
        problems.append(f"{path.name}: {describe_validation_error(exc)}")
        return None
    problems += [f"{path.name}: {p}" for p in formulary.problems(emergency_ids)]
    return formulary


def load_protocol_bundle(root: Path) -> ProtocolBundle:
    if not root.is_dir():
        raise ProtocolError([f"protocols folder not found: {root}"])
    try:
        catalog = load_catalog(root / "indicators.json")
    except FileNotFoundError:
        raise ProtocolError(["indicators.json is missing"]) from None
    except ValidationError as exc:
        raise ProtocolError([f"indicators.json: {describe_validation_error(exc)}"]) from None

    problems: list[str] = []
    recommendations = _load_recommendations(root / "recommendations.json", problems)
    emergency = _load_emergency(root / "emergency", problems)
    missions = _load_missions(root / "mission-profiles", problems)
    rules, rule_problems = load_rules(root / "rules", catalog, set(recommendations), set(emergency))
    problems += rule_problems
    exercise = _load_exercise(root / "exercise-plans.json", {r.id for r in rules}, problems)
    formulary = _load_formulary(root / "medications.json", set(emergency), problems)
    if problems:
        raise ProtocolError(problems)
    return ProtocolBundle(catalog, tuple(rules), recommendations, emergency, missions, exercise, formulary)
