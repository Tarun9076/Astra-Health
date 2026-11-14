"""T-ARCH-01: astra.core holds the safety logic and must stay free of I/O frameworks."""

import ast
from pathlib import Path

import astra.core

FORBIDDEN = {"fastapi", "starlette", "sqlmodel", "sqlalchemy", "httpx", "anthropic", "requests"}


def test_core_imports_no_io_frameworks() -> None:
    core_dir = Path(astra.core.__file__).parent
    offenders: list[str] = []
    for file in core_dir.rglob("*.py"):
        for node in ast.walk(ast.parse(file.read_text(encoding="utf-8"))):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            offenders += [f"{file.name}: {n}" for n in names if n.split(".")[0] in FORBIDDEN]
    assert offenders == []
