"""FastAPI application — REST endpoints, WebSocket signaling, static serving."""

from __future__ import annotations

import json
import ipaddress
import logging
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .rooms import room_manager, RoomFull, RoomNotFound, RateLimited

logger = logging.getLogger("watchparty")

app = FastAPI(title="Watch Party", version="0.1.0")

def _client_ip(host: str | None, forwarded: str | None) -> str:
    """Trust forwarded addresses only when the socket peer is a configured proxy."""
    if not host:
        return "unknown"
    try:
        peer = ipaddress.ip_address(host)
        trusted = any(peer in ipaddress.ip_network(network) for network in settings.trusted_proxy_networks)
    except ValueError:
        trusted = False
    if trusted and forwarded:
        # Proxies append the observed client address; ignore spoofed leftmost entries.
        candidate = forwarded.split(",")[-1].strip()
        try:
            return str(ipaddress.ip_address(candidate))
        except ValueError:
            pass
    return host


# ── REST endpoints ──────────────────────────────────────────────────


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/rooms")
async def create_room(request: Request) -> dict:
    ip = _client_ip(request.client.host if request.client else None, request.headers.get("x-forwarded-for"))
    try:
        code = room_manager.create_room(ip)
    except RateLimited:
        return JSONResponse({"error": "rate_limited"}, status_code=429)
    room = room_manager.get_room(code)
    return {"code": code, "ownerToken": room.owner_token if room else ""}


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

    if (
        not isinstance(msg, dict)
        or msg.get("type") != "join"
        or not isinstance(msg.get("name"), str)
        or not msg["name"].strip()
    ):
        try:
            await ws.send_json({"type": "error", "message": "Expected {type:'join', name:'...'}"})
            await ws.close()
        except Exception:
            pass
        return

    name = msg["name"].strip()[:30]
    client_id = msg.get("clientId", "")
    if not isinstance(client_id, str) or len(client_id) > 128:
        client_id = ""
    owner_token = msg.get("ownerToken", "")
    if not isinstance(owner_token, str) or len(owner_token) > 128:
        owner_token = ""
    ip = _client_ip(ws.client.host if ws.client else None, ws.headers.get("x-forwarded-for"))
    previous_peer = room_manager.get_peer_by_client(code, client_id) if client_id else None

    # Try to join the room
    try:
        peer_id, is_polite, reconnected = room_manager.join_room(code, ws, name, ip, client_id, owner_token)
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

    # The new socket has replaced this client's stale socket in the room map.
    # Closing the old one lets its handler exit; leave_room checks socket
    # identity so its cleanup cannot remove the replacement peer.
    if previous_peer and previous_peer.ws is not ws:
        try:
            await previous_peer.ws.close(code=4001, reason="signaling session replaced")
        except Exception:
            pass

    # Send "joined" to the new peer
    peers_list = room_manager.get_peers(code)
    await ws.send_json({
        "type": "joined",
        "peerId": peer_id,
        "polite": is_polite,
        "isCreator": bool(room_manager.get_room(code) and room_manager.get_room(code).owner_peer_id == peer_id),
        "peers": peers_list,
    })

    # Notify the existing peer (if any)
    other = room_manager.get_other_peer(code, ws)
    if other:
        try:
            event_type = "peer-reconnected" if reconnected else "peer-joined"
            await other.ws.send_json({"type": event_type, "name": name, "peerId": peer_id})
        except Exception:
            pass

    # Message relay loop
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            if not isinstance(msg, dict):
                continue
            msg_type = msg.get("type")

            if msg_type == "signal":
                data = msg.get("data", {})
                if not isinstance(data, dict) or len(raw) > 256_000:
                    continue
                # Relay signaling data (SDP, ICE, or stream-meta) to the other peer
                other = room_manager.get_other_peer(code, ws)
                if other:
                    try:
                        await other.ws.send_json({"type": "signal", "data": data})
                    except Exception:
                        pass

            elif msg_type == "leave":
                break
            elif msg_type == "ping":
                await ws.send_json({"type": "pong"})
            elif msg_type == "delete-room":
                room_peers = room_manager.delete_room(code, ws)
                if room_peers is None:
                    await ws.send_json({"type": "delete-denied"})
                    continue
                for peer in room_peers:
                    try:
                        await peer.ws.send_json({"type": "room-deleted"})
                        await peer.ws.close(code=4002, reason="room ended by creator")
                    except Exception:
                        pass
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
