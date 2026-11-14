"""In-process WebSocket hub with groups (LLD §14).

Groups: astronaut:{id}, medical, mission, admin, and "all". Until auth arrives in Step 3,
every socket joins "all" only.
"""

import asyncio
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket


class Hub:
    def __init__(self) -> None:
        self._groups: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def join(self, ws: WebSocket, groups: list[str]) -> None:
        async with self._lock:
            for g in groups:
                self._groups[g].add(ws)

    async def leave(self, ws: WebSocket) -> None:
        async with self._lock:
            for members in self._groups.values():
                members.discard(ws)

    def connection_count(self) -> int:
        return len({ws for members in self._groups.values() for ws in members})

    async def publish(self, groups: list[str], type_: str, payload: dict[str, Any]) -> None:
        """Send {type, payload, at} to every socket in any of the groups; drop dead sockets."""
        message = {"type": type_, "payload": payload, "at": datetime.now(UTC).isoformat()}
        async with self._lock:
            targets = {ws for g in groups for ws in self._groups.get(g, set())}
        for ws in targets:
            try:
                await ws.send_json(message)
            except Exception:  # socket closed mid-send
                await self.leave(ws)


hub = Hub()
