from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt

from astra.core.enums import Role

ALGORITHM = "HS256"
ISSUER = "astra-health"


@dataclass(frozen=True)
class TokenClaims:
    user_id: str
    username: str
    role: Role
    display_name: str
    astronaut_id: str | None = None


def create_access_token(claims: TokenClaims, secret: str, minutes: int) -> tuple[str, int]:
    now = datetime.now(UTC)
    payload = {
        "iss": ISSUER,
        "sub": claims.user_id,
        "username": claims.username,
        "role": claims.role.value,
        "name": claims.display_name,
        "astronautId": claims.astronaut_id,
        "iat": now,
        "exp": now + timedelta(minutes=minutes),
    }
    return jwt.encode(payload, secret, algorithm=ALGORITHM), minutes * 60


def decode_access_token(token: str, secret: str) -> TokenClaims:
    """Raises jwt.InvalidTokenError (expired, bad signature, wrong issuer, …)."""
    data = jwt.decode(
        token, secret, algorithms=[ALGORITHM], issuer=ISSUER, options={"require": ["exp", "sub"]}
    )
    return TokenClaims(
        user_id=data["sub"],
        username=data["username"],
        role=Role(data["role"]),
        display_name=data.get("name", ""),
        astronaut_id=data.get("astronautId"),
    )
