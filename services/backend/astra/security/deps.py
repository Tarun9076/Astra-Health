"""Authorisation as FastAPI dependencies (LLD §17). Every /api route except login and status uses
`current_user`; test T-SEC-01 enforces that."""

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from astra.core.enums import Role
from astra.db.models import Astronaut, AuditLog, UserAccount
from astra.db.session import SessionDep
from astra.security.jwt import TokenClaims, decode_access_token
from astra.services.crew import find_astronaut

bearer = HTTPBearer(auto_error=False, description="Paste the accessToken from POST /api/auth/login")

MEDICAL_ROLES = frozenset({Role.FLIGHT_SURGEON})


def _unauthorised(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail, headers={"WWW-Authenticate": "Bearer"})


def current_user(
    request: Request,
    session: SessionDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> TokenClaims:
    if credentials is None:
        raise _unauthorised("Not signed in")
    try:
        claims = decode_access_token(credentials.credentials, request.app.state.settings.jwt_secret)
    except jwt.InvalidTokenError:
        raise _unauthorised("Session expired or invalid; sign in again") from None
    user = session.get(UserAccount, claims.user_id)
    if user is None or not user.is_active:
        raise _unauthorised("Account not found or disabled")
    return claims


CurrentUser = Annotated[TokenClaims, Depends(current_user)]


def require_role(*roles: Role) -> Callable[[TokenClaims], TokenClaims]:
    def checker(user: CurrentUser) -> TokenClaims:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role can't do this")
        return user

    return checker


def can_view_astronaut(user: TokenClaims, astronaut: Astronaut) -> bool:
    """Astronauts see only themselves; flight surgeons see everyone (LLD §17)."""
    return user.role in MEDICAL_ROLES or (user.role == Role.ASTRONAUT and user.astronaut_id == astronaut.id)


SURGEON_READ_AUDIT_EVERY = timedelta(minutes=10)
_last_surgeon_read: dict[tuple[str, str, str], datetime] = {}


def viewable_astronaut(astronaut: str, request: Request, session: SessionDep, user: CurrentUser) -> Astronaut:
    """Path dependency for /astronauts/{astronaut}/…: resolves code or id, then checks access.

    A flight surgeon reading an astronaut's data is audited (Step 8), at most once per 10 minutes
    per (surgeon, astronaut, kind of data), so the crew grid's refreshes don't flood the log.
    """
    found = find_astronaut(session, astronaut)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Astronaut '{astronaut}' not found")
    if not can_view_astronaut(user, found):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only view your own health data")
    if user.role in MEDICAL_ROLES and request.method == "GET":
        kind = request.url.path.rstrip("/").rsplit("/", 1)[-1]
        key, now = (user.user_id, found.id, kind), datetime.now(UTC)
        if now - _last_surgeon_read.get(key, datetime.min.replace(tzinfo=UTC)) >= SURGEON_READ_AUDIT_EVERY:
            _last_surgeon_read[key] = now
            session.add(
                AuditLog(
                    user_id=user.user_id,
                    action="SurgeonRead",
                    entity_type="Astronaut",
                    entity_id=found.code,
                    node_id=request.app.state.settings.node_id,
                    details=json.dumps({"data": kind}),
                )  # fmt: skip
            )
            session.commit()
    return found


ViewableAstronaut = Annotated[Astronaut, Depends(viewable_astronaut)]
