"""FastAPI application — health check, ICE config, and future routes."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings

app = FastAPI(title="Watch Party", version="0.1.0")

# CORS for dev (Vite on :5173 → backend on :8000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/ice-config")
async def ice_config() -> dict:
    """Return ICE server list for the frontend.

    Reads STUN/TURN URLs and credentials from environment variables so
    they are never hard-coded in the client bundle.
    """
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
