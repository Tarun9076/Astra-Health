import jwt
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from astra.realtime.hub import groups_for, hub
from astra.security.jwt import decode_access_token

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str | None = None) -> None:
    """Live event channel: connect with `/ws?token=<accessToken>` (browsers can't set headers on
    WebSockets). Messages are JSON {type, payload, at}; send {"type": "ping"} to get a pong."""
    try:
        claims = decode_access_token(token or "", ws.app.state.settings.jwt_secret)
    except jwt.InvalidTokenError:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="Sign in first")
        return
    await ws.accept()
    groups = groups_for(claims.role, claims.astronaut_id)
    await hub.join(ws, groups)
    await ws.send_json(
        {"type": "Connected", "payload": {"nodeId": ws.app.state.settings.node_id, "groups": groups}}
    )
    try:
        while True:
            msg = await ws.receive_json()
            if isinstance(msg, dict) and msg.get("type") == "ping":
                await ws.send_json({"type": "pong", "payload": {}})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.leave(ws)
