"""Knowledge base loading and BM25 retrieval (LLD §11.2 step 2, §11.3; TDD ADR-08).

Notes in `knowledge/*.md` are split on `## ` headings; each section is one chunk with the id
`<note id>#<n>`. BM25 over lower-cased word tokens with a tiny suffix stemmer: fully offline,
deterministic, and good enough for a few hundred chunks.
"""

import re
from dataclasses import dataclass
from pathlib import Path

import yaml
from rank_bm25 import BM25Okapi

TOKEN = re.compile(r"[a-z0-9]+")
STOPWORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "been",
        "but",
        "by",
        "can",
        "do",
        "does",
        "for",
        "from",
        "has",
        "have",
        "how",
        "i",
        "if",
        "in",
        "is",
        "it",
        "its",
        "me",
        "my",
        "of",
        "on",
        "or",
        "our",
        "so",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "to",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "you",
        "your",
    ]
)


# Words present in almost every question in this app carry no topic: drop them from queries.
CONTEXT_WORDS = frozenset({"mars", "space", "spaceflight", "astronaut", "mission", "better", "normal"})
# Everyday words → the words the notes use (added to the query, not replacing it).
SYNONYMS = {
    "lonely": "isolation",
    "alone": "isolation",
    "homesick": "isolation",
    "tired": "fatigue",
    "exhausted": "fatigue",
    "dizzy": "dizziness",
    "faint": "fainting",
    "eye": "vision",
    "eyes": "vision",
    "storm": "solar",
    "pulse": "heart",
    "bpm": "heart",
    "sad": "mood",
    "anxious": "stress",
}


def query_tokens(text: str) -> list[str]:
    words = [w for w in TOKEN.findall(text.lower()) if w not in STOPWORDS and w not in CONTEXT_WORDS]
    words += [SYNONYMS[w] for w in words if w in SYNONYMS]
    return [stem(w) for w in words]


def stem(word: str) -> str:
    for suffix, repl in (("ies", "y"), ("ing", ""), ("ed", ""), ("es", ""), ("s", "")):
        if len(word) > len(suffix) + 3 and word.endswith(suffix) and not word.endswith("ss"):
            return word[: -len(suffix)] + repl
    return word


def tokens(text: str) -> list[str]:
    return [stem(t) for t in TOKEN.findall(text.lower()) if t not in STOPWORDS]


@dataclass(frozen=True)
class Chunk:
    id: str
    note_id: str
    note_title: str
    section: str
    text: str
    sources: tuple[str, ...]
    hazard: str

    @property
    def title(self) -> str:
        return f"{self.note_title} — {self.section}"

    @property
    def source(self) -> str:
        return self.sources[0] if self.sources else ""


class KnowledgeError(ValueError):
    pass


def _parse(path: Path) -> list[Chunk]:
    raw = path.read_text(encoding="utf-8")
    if not raw.startswith("---"):
        raise KnowledgeError(f"{path.name}: missing front matter")
    _, front, body = raw.split("---", 2)
    meta = yaml.safe_load(front) or {}
    for key in ("id", "title", "sources"):
        if not meta.get(key):
            raise KnowledgeError(f"{path.name}: front matter needs '{key}'")
    chunks = []
    for n, part in enumerate(re.split(r"^## ", body, flags=re.MULTILINE)[1:], start=1):
        heading, _, text = part.partition("\n")
        chunks.append(
            Chunk(
                id=f"{meta['id']}#{n}",
                note_id=str(meta["id"]),
                note_title=str(meta["title"]),
                section=heading.strip(),
                text=" ".join(text.split()),
                sources=tuple(str(s) for s in meta["sources"]),
                hazard=str(meta.get("hazard", "")),
            )
        )
    if not chunks:
        raise KnowledgeError(f"{path.name}: no '## ' sections")
    return chunks


def load_knowledge(directory: Path) -> list[Chunk]:
    chunks = [c for path in sorted(directory.glob("kb-*.md")) for c in _parse(path)]
    ids = [c.id for c in chunks]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise KnowledgeError(f"duplicate note ids: {', '.join(duplicates)}")
    return chunks


class Retriever:
    def __init__(self, chunks: list[Chunk]) -> None:
        self.chunks = chunks
        self.by_id = {c.id: c for c in chunks}
        # the note title counts twice: "sleep" in "Sleep and the body clock" beats a passing mention
        corpus = [tokens(f"{c.note_title} {c.note_title} {c.section} {c.text}") for c in chunks]
        self._bm25 = BM25Okapi(corpus) if chunks else None

    def search(self, query: str, k: int = 5) -> list[tuple[Chunk, float]]:
        terms = query_tokens(query)
        if self._bm25 is None or not terms:
            return []
        scores = self._bm25.get_scores(terms)
        ranked = sorted(zip(self.chunks, scores, strict=True), key=lambda cs: -cs[1])
        return [(c, float(s)) for c, s in ranked[:k] if s > 0]

    @property
    def note_count(self) -> int:
        return len({c.note_id for c in self.chunks})
