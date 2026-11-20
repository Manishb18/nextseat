"""ICE server configuration endpoint."""

from fastapi import APIRouter

from ..config import settings

router = APIRouter()


@router.get("/api/ice-config")
async def ice_config() -> dict:
    """Return ICE servers without hard-coding credentials in the frontend."""
    servers: list[dict] = []

    if settings.stun_urls:
        servers.append({"urls": settings.stun_urls})

    if settings.turn_urls:
        entry: dict = {"urls": settings.turn_urls}
        if settings.turn_username:
            entry["username"] = settings.turn_username
        if settings.turn_credential:
            entry["credential"] = settings.turn_credential
        servers.append(entry)

    return {
        "iceServers": servers,
        "iceTransportPolicy": "relay" if settings.force_relay else "all",
    }
