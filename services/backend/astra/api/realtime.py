from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from astra.config import settings
from astra.realtime.hub import hub

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    """Live event channel. Step 3 adds `?token=<jwt>` and role-based groups."""
    await ws.accept()
    await hub.join(ws, ["all"])
    await ws.send_json({"type": "Connected", "payload": {"nodeId": settings.node_id}})
    try:
        while True:
            msg = await ws.receive_json()
            if isinstance(msg, dict) and msg.get("type") == "ping":
                await ws.send_json({"type": "pong", "payload": {}})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.leave(ws)
