"""Cached real API responses in simulator/fixtures/, so demos and tests run offline (LLD §20.3)."""

import json
from pathlib import Path
from typing import Any

from astra.config import REPO_ROOT

FIXTURES_DIR = REPO_ROOT / "simulator" / "fixtures"
DONKI_SEP_MAY_2024 = FIXTURES_DIR / "donki-sep-2024-05.json"
HORIZONS_MARS_MISSION = FIXTURES_DIR / "horizons-mars-2026-07-to-11.json"


def save_fixture(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def load_fixture(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))
