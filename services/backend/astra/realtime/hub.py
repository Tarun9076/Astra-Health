"""In-process WebSocket hub with groups (LLD §14).

Groups: "all", "astronaut:{id}", "medical", "mission", "admin". A socket joins groups from its
token's role when it connects (astra/api/realtime.py).
"""

import asyncio
import logging
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

import anyio.from_thread
from fastapi import WebSocket

from astra.core.enums import Role

logger = logging.getLogger("astra.realtime")


def groups_for(role: Role, astronaut_id: str | None) -> list[str]:
    groups = ["all"]
    if role == Role.ASTRONAUT and astronaut_id:
        groups.append(f"astronaut:{astronaut_id}")
    elif role == Role.FLIGHT_SURGEON:
        groups.append("medical")
    elif role == Role.MISSION_CONTROL:
        groups.append("mission")
    elif role == Role.ADMIN:
        groups.append("admin")
    return groups


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

    def publish_from_thread(self, groups: list[str], type_: str, payload: dict[str, Any]) -> None:
        """For sync (def) route handlers, which FastAPI runs in a worker thread."""
        if not self.connection_count():
            return
        try:
            anyio.from_thread.run(self.publish, groups, type_, payload)
        except RuntimeError:  # not inside an AnyIO worker thread (e.g. CLI scripts)
            logger.debug("publish skipped outside the event loop: %s", type_)


hub = Hub()
