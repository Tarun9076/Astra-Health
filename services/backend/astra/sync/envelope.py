"""Sync envelopes and node-to-node authentication (LLD §12.1, §12.3).

An envelope carries up to 500 outbox items. The HTTP body is signed with HMAC-SHA256 over the
shared `ASTRA_SYNC_KEY` (header `X-Astra-Signature`), so only the paired node can deliver data.
"""

import base64
import hashlib
import hmac
import json
from typing import Any

NODE_HEADER = "X-Astra-Node"
SIGNATURE_HEADER = "X-Astra-Signature"
DELIVER_AT_HEADER = "X-Astra-Deliver-At"  # Habitat → Ground: when the simulated link delivers it


def canonical(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sign(key: str, data: bytes) -> str:
    return base64.b64encode(hmac.new(key.encode(), data, hashlib.sha256).digest()).decode()


def verify(key: str, data: bytes, signature: str | None) -> bool:
    return signature is not None and hmac.compare_digest(sign(key, data), signature)


def build_envelope(
    envelope_id: str, from_node: str, to_node: str, seq_from: int, seq_to: int, created_at: str,
    items: list[dict[str, Any]], key: str,
) -> dict[str, Any]:  # fmt: skip
    return {
        "envelopeId": envelope_id,
        "fromNodeId": from_node,
        "toNodeId": to_node,
        "seqFrom": seq_from,
        "seqTo": seq_to,
        "createdAt": created_at,
        "itemCount": len(items),
        "items": items,
        "hmac": sign(key, canonical(items)),
    }


def items_valid(envelope: dict[str, Any], key: str) -> bool:
    return verify(key, canonical(envelope.get("items", [])), envelope.get("hmac"))
