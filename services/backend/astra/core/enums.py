"""Domain enums. astra.core is pure: no FastAPI, database or network imports (TDD ADR-13)."""

from enum import IntEnum, StrEnum


class NodeRole(StrEnum):
    """Which deployment this server is: onboard the spacecraft or on Earth."""

    HABITAT = "Habitat"
    GROUND = "Ground"


class Severity(IntEnum):
    """Ordered so comparisons work. Only deterministic rules may set URGENT (TDD ADR-03)."""

    NORMAL = 0
    ATTENTION = 1
    URGENT = 2


class Hazard(StrEnum):
    """NASA's 5 Hazards of Human Spaceflight."""

    RADIATION = "Radiation"
    ISOLATION = "Isolation"
    DISTANCE = "Distance"
    GRAVITY = "Gravity"
    ENVIRONMENT = "Environment"


class AlertCategory(StrEnum):
    CARDIOVASCULAR = "Cardiovascular"
    BEHAVIORAL = "Behavioral"
    METABOLIC = "Metabolic"
    RESPIRATORY = "Respiratory"
    THERMAL = "Thermal"
    MUSCULOSKELETAL = "Musculoskeletal"
    RADIATION = "Radiation"
    ENVIRONMENT = "Environment"
    SYMPTOM = "Symptom"


class AlertStatus(StrEnum):
    OPEN = "Open"
    ACKNOWLEDGED = "Acknowledged"
    IN_REVIEW = "InReview"
    RESOLVED = "Resolved"
    DISMISSED = "Dismissed"


# Sync merge order: when two nodes disagree, the higher rank wins (LLD §7).
# Resolved and Dismissed are both terminal and share the top rank.
ALERT_STATUS_RANK: dict[AlertStatus, int] = {
    AlertStatus.OPEN: 0,
    AlertStatus.ACKNOWLEDGED: 1,
    AlertStatus.IN_REVIEW: 2,
    AlertStatus.RESOLVED: 3,
    AlertStatus.DISMISSED: 3,
}


class MeasurementQuality(StrEnum):
    VALID = "Valid"
    QUESTIONABLE = "Questionable"
    REJECTED = "Rejected"


class MeasurementSource(StrEnum):
    MANUAL = "Manual"
    WEARABLE = "Wearable"
    DEVICE = "Device"
    DERIVED = "Derived"
    SIMULATED = "Simulated"


class Role(StrEnum):
    ASTRONAUT = "Astronaut"
    FLIGHT_SURGEON = "FlightSurgeon"
    MISSION_CONTROL = "MissionControl"
    ADMIN = "Admin"
