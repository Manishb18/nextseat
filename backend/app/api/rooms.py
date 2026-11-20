"""Room creation endpoints."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..rooms import RateLimited, room_manager
from ..services.client_ip import resolve_client_ip

router = APIRouter()


@router.post("/api/rooms")
async def create_room(request: Request) -> dict:
    ip = resolve_client_ip(
        request.client.host if request.client else None,
        request.headers.get("x-forwarded-for"),
    )
    try:
        code = room_manager.create_room(ip)
    except RateLimited:
        return JSONResponse({"error": "rate_limited"}, status_code=429)

    room = room_manager.get_room(code)
    return {"code": code, "ownerToken": room.owner_token if room else ""}
