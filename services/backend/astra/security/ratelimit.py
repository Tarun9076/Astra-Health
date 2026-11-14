"""Login throttling (Step 11 security pass).

After MAX_FAILURES wrong passwords for the same username from the same client within WINDOW, that
pair is locked out for LOCKOUT (HTTP 429 + Retry-After). A successful sign-in clears the counter.
In memory, per server process: enough for a single habitat node; not a substitute for real IAM.
"""

import threading
import time
from dataclasses import dataclass, field

MAX_FAILURES = 5
WINDOW_S = 5 * 60
LOCKOUT_S = 5 * 60


@dataclass
class _Entry:
    failures: list[float] = field(default_factory=list)
    locked_until: float = 0.0


class LoginLimiter:
    def __init__(self) -> None:
        self._entries: dict[tuple[str, str], _Entry] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _key(username: str, client: str) -> tuple[str, str]:
        return username.strip().lower(), client

    def retry_after(self, username: str, client: str, now: float | None = None) -> int:
        """Seconds until this pair may try again (0 = allowed)."""
        now = time.monotonic() if now is None else now
        with self._lock:
            entry = self._entries.get(self._key(username, client))
            return max(0, int(entry.locked_until - now) + 1) if entry and entry.locked_until > now else 0

    def failure(self, username: str, client: str, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        with self._lock:
            entry = self._entries.setdefault(self._key(username, client), _Entry())
            entry.failures = [t for t in entry.failures if now - t < WINDOW_S] + [now]
            if len(entry.failures) >= MAX_FAILURES:
                entry.locked_until, entry.failures = now + LOCKOUT_S, []

    def success(self, username: str, client: str) -> None:
        with self._lock:
            self._entries.pop(self._key(username, client), None)
