"""Health photos: camera images an astronaut attaches for the flight surgeon (skin, eye, wound, a
device's display). The photo is evidence for a human to look at; nothing in the app analyses it.

- POST /api/photos                                      — astronaut, Habitat: store (idempotent by id)
- GET  /api/astronauts/{astronaut}/photos               — list (no image data)
- GET  /api/astronauts/{astronaut}/photos/{photo}/image — the image itself
"""

import base64
import binascii
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import Field
from sqlmodel import col, select

from astra.api.base import ApiModel
from astra.core.enums import NodeRole, Role
from astra.core.ids import new_id
from astra.db.models import Astronaut, HealthPhoto, SyncOutbox
from astra.db.session import SessionDep
from astra.realtime.hub import hub
from astra.security.deps import CurrentUser, ViewableAstronaut

router = APIRouter(prefix="/api", tags=["photos"])

MAX_BYTES = 2_000_000
PhotoKind = Literal["Skin", "Eye", "Wound", "DeviceReading", "Other"]
KIND_LABEL: dict[str, str] = {
    "Skin": "Skin",
    "Eye": "Eye",
    "Wound": "Wound or injury",
    "DeviceReading": "Device reading",
    "Other": "Other",
}
# the first bytes of each accepted format, so a renamed file can't pass as an image
SIGNATURES: dict[str, tuple[bytes, ...]] = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/webp": (b"RIFF",),
}


class PhotoIn(ApiModel):
    id: str | None = Field(default=None, max_length=64, description="From the client; generated if missing")
    kind: PhotoKind
    note: str | None = Field(default=None, max_length=300)
    checkin_id: str | None = Field(default=None, max_length=64)
    taken_at: datetime | None = None
    data_url: str = Field(
        max_length=2_800_000, description="data:image/jpeg;base64,… (JPEG, PNG or WebP, at most 2 MB)"
    )


class PhotoOut(ApiModel):
    id: str
    astronaut_code: str
    kind: PhotoKind
    kind_label: str
    note: str | None
    content_type: str
    size_bytes: int
    checkin_id: str | None
    taken_at: datetime


def _out(photo: HealthPhoto, code: str) -> PhotoOut:
    return PhotoOut(
        id=photo.id,
        astronaut_code=code,
        kind=photo.kind,  # type: ignore[arg-type]
        kind_label=KIND_LABEL.get(photo.kind, photo.kind),
        note=photo.note,
        content_type=photo.content_type,
        size_bytes=photo.size_bytes,
        checkin_id=photo.checkin_id,
        taken_at=photo.taken_at,
    )


def _decode(data_url: str) -> tuple[str, bytes]:
    header, sep, data = data_url.partition(",")
    if not sep or not header.startswith("data:") or not header.endswith(";base64"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Send the photo as a base64 data URL")
    content_type = header[5:-7]
    if content_type not in SIGNATURES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Only JPEG, PNG or WebP photos")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The photo data is damaged") from None
    if len(raw) > MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "The photo is larger than 2 MB")
    if not raw.startswith(SIGNATURES[content_type]) or (
        content_type == "image/webp" and raw[8:12] != b"WEBP"
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The file is not a valid image")
    return content_type, raw


@router.post("/photos", status_code=status.HTTP_201_CREATED, response_model=PhotoOut)
def post_photo(body: PhotoIn, request: Request, session: SessionDep, user: CurrentUser) -> PhotoOut:
    if request.app.state.settings.node_role == NodeRole.GROUND:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Photos are taken onboard: send them to the Habitat node"
        )
    if user.role != Role.ASTRONAUT or not user.astronaut_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only astronauts add health photos")
    astronaut = session.get(Astronaut, user.astronaut_id)
    if astronaut is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Astronaut not found")
    photo_id = body.id or new_id()
    existing = session.get(HealthPhoto, photo_id)
    if existing is not None:
        if existing.astronaut_id != astronaut.id:
            raise HTTPException(status.HTTP_409_CONFLICT, "Photo id already used")
        return _out(existing, astronaut.code)  # the outbox re-sent it: no-op
    content_type, raw = _decode(body.data_url)
    now = datetime.now(UTC).replace(microsecond=0)
    photo = HealthPhoto(
        id=photo_id,
        astronaut_id=astronaut.id,
        kind=body.kind,
        note=(body.note or "").strip() or None,
        content_type=content_type,
        size_bytes=len(raw),
        data_b64=base64.b64encode(raw).decode("ascii"),
        checkin_id=body.checkin_id,
        taken_at=min(body.taken_at or now, now),
        node_id=request.app.state.settings.node_id,
    )
    session.add(photo)
    payload = photo.model_dump_json()
    session.add(SyncOutbox(entity_type="HealthPhoto", entity_id=photo.id, payload_json=payload, priority=4))
    session.commit()
    out = _out(photo, astronaut.code)
    hub.publish_from_thread(
        [f"astronaut:{astronaut.id}", "medical"],
        "PhotoAdded",
        {"astronautCode": astronaut.code, "id": photo.id},
    )
    return out


@router.get("/astronauts/{astronaut}/photos", response_model=list[PhotoOut])
def list_photos(astronaut: ViewableAstronaut, session: SessionDep) -> list[PhotoOut]:
    rows = session.exec(
        select(HealthPhoto)
        .where(HealthPhoto.astronaut_id == astronaut.id)
        .order_by(col(HealthPhoto.taken_at).desc())
        .limit(100)
    ).all()
    return [_out(p, astronaut.code) for p in rows]


@router.get(
    "/astronauts/{astronaut}/photos/{photo}/image",
    response_class=Response,
    responses={200: {"content": {"image/jpeg": {}, "image/png": {}, "image/webp": {}}}},
)
def photo_image(astronaut: ViewableAstronaut, photo: str, session: SessionDep) -> Response:
    row = session.get(HealthPhoto, photo)
    if row is None or row.astronaut_id != astronaut.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Photo not found")
    return Response(
        content=base64.b64decode(row.data_b64),
        media_type=row.content_type,
        headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"},
    )
