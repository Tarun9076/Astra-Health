from fastapi import APIRouter, HTTPException, Request, status
from pydantic import Field
from sqlmodel import select

from astra.api.base import ApiModel
from astra.core.enums import Role
from astra.db.models import Astronaut, UserAccount
from astra.db.session import SessionDep
from astra.security.deps import CurrentUser
from astra.security.jwt import TokenClaims, create_access_token
from astra.security.passwords import verify_password

router = APIRouter(prefix="/api", tags=["auth"])


class LoginIn(ApiModel):
    username: str = Field(examples=["ast1"])
    password: str = Field(examples=["astra-demo-ast1"])


class MeOut(ApiModel):
    user_id: str
    username: str
    role: Role
    display_name: str
    astronaut_id: str | None
    astronaut_code: str | None


class LoginOut(ApiModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: MeOut


def _me(session: SessionDep, claims: TokenClaims) -> MeOut:
    astronaut = session.get(Astronaut, claims.astronaut_id) if claims.astronaut_id else None
    return MeOut(
        user_id=claims.user_id,
        username=claims.username,
        role=claims.role,
        display_name=claims.display_name,
        astronaut_id=claims.astronaut_id,
        astronaut_code=astronaut.code if astronaut else None,
    )


@router.post("/auth/login", response_model=LoginOut)
def login(body: LoginIn, request: Request, session: SessionDep) -> LoginOut:
    """Demo accounts are in services/backend/seed.example.json."""
    user = session.exec(select(UserAccount).where(UserAccount.username == body.username)).first()
    if (
        not verify_password(body.password, user.password_hash if user else None)
        or user is None
        or not user.is_active
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong username or password")
    claims = TokenClaims(
        user_id=user.id,
        username=user.username,
        role=Role(user.role),
        display_name=user.display_name,
        astronaut_id=user.astronaut_id,
    )
    cfg = request.app.state.settings
    token, expires_in = create_access_token(claims, cfg.jwt_secret, cfg.access_token_minutes)
    return LoginOut(access_token=token, expires_in=expires_in, user=_me(session, claims))


@router.get("/me", response_model=MeOut)
def me(user: CurrentUser, session: SessionDep) -> MeOut:
    return _me(session, user)
