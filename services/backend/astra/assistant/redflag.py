"""Deterministic red-flag router (LLD §11.2 step 1). Runs BEFORE any AI; no LLM call on a match.

`protocols/redflags.yaml` lists phrases per emergency. A match returns the emergency protocol.
Negations just before a match ("no chest pain") are ignored. Clearly hypothetical questions
("what should I do if I get chest pain?") still show the protocol but don't report a symptom,
unless the person is also describing themselves now ("…I have it right now").
"""

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

NEGATION_WINDOW_WORDS = 3


@dataclass(frozen=True)
class RedFlag:
    id: str
    symptom: str
    protocol: str
    title: str
    patterns: tuple[re.Pattern[str], ...]


@dataclass(frozen=True)
class RedFlagHit:
    flag: RedFlag
    matched: str
    report: bool  # False = a question about the symptom, not a report of it


class RedFlagError(ValueError):
    pass


def normalise(text: str) -> str:
    return " ".join(text.lower().replace("’", "'").replace("‘", "'").split())


class RedFlagRouter:
    def __init__(
        self,
        flags: list[RedFlag],
        negations: list[str],
        hypothetical: list[re.Pattern[str]],
        reporting: list[re.Pattern[str]],
        version: str,
    ) -> None:
        self.flags, self.negations, self.version = flags, negations, version
        self.hypothetical, self.reporting = hypothetical, reporting

    @classmethod
    def from_file(cls, path: Path, protocol_ids: set[str]) -> "RedFlagRouter":
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        problems: list[str] = []
        flags = []
        for item in data.get("redFlags", []):
            if item["protocol"] not in protocol_ids:
                problems.append(f"{item['id']}: unknown emergency protocol '{item['protocol']}'")
            try:
                patterns = tuple(re.compile(p) for p in item["patterns"])
            except re.error as e:
                problems.append(f"{item['id']}: bad pattern ({e})")
                continue
            flags.append(RedFlag(item["id"], item["symptom"], item["protocol"], item["title"], patterns))
        if problems:
            raise RedFlagError(f"{path.name}: " + "; ".join(problems))
        return cls(
            flags,
            [normalise(n) for n in data.get("negations", [])],
            [re.compile(p) for p in data.get("hypothetical", [])],
            [re.compile(p) for p in data.get("reporting", [])],
            str(data.get("version", "1.0.0")),
        )

    def _negated(self, text: str, start: int) -> bool:
        before = text[:start].split()[-NEGATION_WINDOW_WORDS:]
        if "but" in before:
            before = before[before.index("but") + 1 :]
        window = " " + " ".join(before) + " "
        return any(f" {n} " in window for n in self.negations)

    def check(self, question: str) -> RedFlagHit | None:
        text = normalise(question)
        for flag in self.flags:
            for pattern in flag.patterns:
                for m in pattern.finditer(text):
                    if self._negated(text, m.start()):
                        continue
                    hypothetical = any(p.search(text) for p in self.hypothetical)
                    reporting = any(p.search(text) for p in self.reporting)
                    return RedFlagHit(flag, m.group(0), report=reporting or not hypothetical)
        return None
