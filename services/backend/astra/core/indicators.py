"""Indicator catalog: units, conversions, plausible ranges and baseline spread floors (LLD §2)."""

from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Literal, Self

from pydantic import Field, model_validator

from astra.core.base import CoreModel
from astra.core.enums import Hazard


class IndicatorError(ValueError):
    """Unknown indicator or unit."""


class UnitConversion(CoreModel):
    """canonical = (value + offset) * factor. Example: °F → °C is offset -32, factor 5/9."""

    factor: float = 1.0
    offset: float = 0.0


class PlausibleRange(CoreModel):
    min: float
    max: float

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if self.min >= self.max:
            raise ValueError(f"plausible.min ({self.min}) must be below plausible.max ({self.max})")
        return self


class Indicator(CoreModel):
    code: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    name: str
    unit: str
    units: dict[str, UnitConversion]
    plausible: PlausibleRange
    sigma_floor: float | None = Field(default=None, gt=0)
    decimals: int = Field(ge=0, le=4)
    worse_when: Literal["high", "low", "both"]
    hazard: Hazard
    body_system: str | None = None
    collection: str

    @model_validator(mode="after")
    def _canonical_unit_is_identity(self) -> Self:
        conv = self.units.get(self.unit)
        if conv is None or conv.factor != 1 or conv.offset != 0:
            raise ValueError(
                f"units must include the canonical unit '{self.unit}' with factor 1 and offset 0"
            )
        return self

    @property
    def has_baseline(self) -> bool:
        """Only indicators with a spread floor get personal baselines (z-score rules)."""
        return self.sigma_floor is not None


def _unit_key(unit: str) -> str:
    return unit.strip().casefold()


def round_half_up(value: float, decimals: int) -> float:
    """Round the way people expect (37.05 → 37.1), not banker's rounding."""
    step = Decimal(1).scaleb(-decimals)
    return float(Decimal(repr(value)).quantize(step, rounding=ROUND_HALF_UP))


class IndicatorCatalog(CoreModel):
    version: str
    disclaimer: str
    indicators: list[Indicator]

    @model_validator(mode="after")
    def _unique_codes(self) -> Self:
        codes = [i.code for i in self.indicators]
        duplicates = sorted({c for c in codes if codes.count(c) > 1})
        if duplicates:
            raise ValueError(f"duplicate indicator codes: {', '.join(duplicates)}")
        return self

    def __contains__(self, code: object) -> bool:
        return any(i.code == code for i in self.indicators)

    def __len__(self) -> int:
        return len(self.indicators)

    def get(self, code: str) -> Indicator:
        for indicator in self.indicators:
            if indicator.code == code:
                return indicator
        raise IndicatorError(f"unknown indicator '{code}'")

    def to_canonical(self, code: str, value: float, unit: str) -> float:
        """Convert a reading to the indicator's canonical unit, rounded to its precision.

        >>> catalog.to_canonical("glucose", 5.5, "mmol/L")   # 99.1 (mg/dL)
        """
        indicator = self.get(code)
        conversions = {_unit_key(u): c for u, c in indicator.units.items()}
        conv = conversions.get(_unit_key(unit))
        if conv is None:
            accepted = ", ".join(indicator.units)
            raise IndicatorError(f"unit '{unit}' is not accepted for '{code}' (accepted: {accepted})")
        return round_half_up((value + conv.offset) * conv.factor, indicator.decimals)


def load_catalog(path: Path) -> IndicatorCatalog:
    return IndicatorCatalog.model_validate_json(path.read_text(encoding="utf-8"))
