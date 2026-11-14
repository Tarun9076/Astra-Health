"""UUIDv7 ids: time-ordered, generated at the edge, safe to sync (TDD ADR-10).

Python 3.12 has no uuid.uuid7(), so this is a small RFC 9562 implementation.
Passing `entropy` makes the id deterministic (the simulator uses this so re-seeding
the same data is idempotent).
"""

import os
import time
import uuid


def uuid7(timestamp_ms: int | None = None, entropy: bytes | None = None) -> uuid.UUID:
    ms = int(time.time() * 1000) if timestamp_ms is None else timestamp_ms
    rand = int.from_bytes((entropy or os.urandom(10))[:10].ljust(10, b"\0"), "big")  # 80 bits
    rand_a = (rand >> 62) & 0xFFF  # 12 bits
    rand_b = rand & ((1 << 62) - 1)  # 62 bits
    value = (ms & ((1 << 48) - 1)) << 80 | 0x7 << 76 | rand_a << 64 | 0b10 << 62 | rand_b
    return uuid.UUID(int=value)


def new_id() -> str:
    return str(uuid7())


ASTRA_NAMESPACE = uuid.UUID("6f1c2b8e-5d1a-4c3e-9b7a-2e5f0d4c8a11")


def stable_id(kind: str, key: str) -> str:
    """Same input → same id on every node (seeded records: mission, astronauts, users)."""
    return str(uuid.uuid5(ASTRA_NAMESPACE, f"{kind}:{key}"))
