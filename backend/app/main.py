"""FastAPI application — REST endpoints, WebSocket signaling, static serving."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .rooms import room_manager, RoomFull, RoomNotFound, RateLimited

logger = logging.getLogger("watchparty")

app = FastAPI(title="Watch Party", version="0.1.0")

# CORS for dev (Vite on :5173 → backend on :8000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _client_ip(request: Request) -> str:
    """Best-effort client IP (respects X-Forwarded-For behind a proxy)."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    client = request.client
    return client.host if client else "unknown"


# ── REST endpoints ──────────────────────────────────────────────────


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/rooms")
async def create_room(request: Request) -> dict:
    ip = _client_ip(request)
    try:
        code = room_manager.create_room(ip)
    except RateLimited:
        return JSONResponse({"error": "rate_limited"}, status_code=429)
    return {"code": code}


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


# ── WebSocket signaling ────────────────────────────────────────────


@app.websocket("/ws/{code}")
async def signaling(ws: WebSocket, code: str) -> None:
    await ws.accept()

    # Wait for the initial "join" message
    try:
        raw = await ws.receive_text()
        msg = json.loads(raw)
    except (WebSocketDisconnect, json.JSONDecodeError):
        try:
            await ws.close()
        except Exception:
            pass
        return

    if msg.get("type") != "join" or not msg.get("name"):
        try:
            await ws.send_json({"type": "error", "message": "Expected {type:'join', name:'...'}"})
            await ws.close()
        except Exception:
            pass
        return

    name: str = msg["name"]
    ip = ws.client.host if ws.client else "unknown"

    # Try to join the room
    try:
        peer_id, is_polite = room_manager.join_room(code, ws, name, ip)
    except RoomNotFound:
        try:
            await ws.send_json({"type": "error", "message": "Room not found"})
            await ws.close()
        except Exception:
            pass
        return
    except RoomFull:
        try:
            await ws.send_json({"type": "room-full"})
            await ws.close()
        except Exception:
            pass
        return
    except RateLimited:
        try:
            await ws.send_json({"type": "error", "message": "Rate limited"})
            await ws.close()
        except Exception:
            pass
        return

    # Send "joined" to the new peer
    peers_list = room_manager.get_peers(code)
    await ws.send_json({
        "type": "joined",
        "peerId": peer_id,
        "polite": is_polite,
        "peers": peers_list,
    })

    # Notify the existing peer (if any)
    other = room_manager.get_other_peer(code, ws)
    if other:
        try:
            await other.ws.send_json({"type": "peer-joined", "name": name, "peerId": peer_id})
        except Exception:
            pass

    # Message relay loop
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            msg_type = msg.get("type")

            if msg_type == "signal":
                # Relay signaling data (SDP, ICE, or stream-meta) to the other peer
                other = room_manager.get_other_peer(code, ws)
                if other:
                    try:
                        await other.ws.send_json({"type": "signal", "data": msg.get("data", {})})
                    except Exception:
                        pass

            elif msg_type == "leave":
                break

    except (WebSocketDisconnect, json.JSONDecodeError):
        pass
    finally:
        # Clean up
        removed = room_manager.leave_room(code, ws)
        if removed:
            other = room_manager.get_other_peer(code, ws)
            if other:
                try:
                    await other.ws.send_json({"type": "peer-left", "peerId": removed.peer_id})
                except Exception:
                    pass


# ── Static file serving (production) ──────────────────────────────
# Serve the built Vite frontend from ../frontend/dist (when running from
# inside the Docker container the path is /app/frontend/dist).
# In development, Vite serves its own files; this block is a no-op.

_DIST = Path(__file__).parent.parent.parent / "frontend" / "dist"
if not _DIST.exists():
    # Try Docker layout: /app/frontend/dist
    _DIST = Path("/app/frontend/dist")

if _DIST.exists():
    _INDEX = _DIST / "index.html"

    # Mount /assets directly
    app.mount("/assets", StaticFiles(directory=str(_DIST / "assets")), name="assets")

    # Serve favicon and other root-level static files
    @app.get("/favicon.svg")
    async def favicon() -> FileResponse:
        return FileResponse(str(_DIST / "favicon.svg"))

    # SPA fallback: any path not matched above returns index.html
    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str) -> FileResponse:  # noqa: ARG001
        return FileResponse(str(_INDEX))

    logger.info(f"Serving frontend from {_DIST}")
else:
    logger.info("No frontend/dist found — running in API-only mode (use Vite for dev)")
