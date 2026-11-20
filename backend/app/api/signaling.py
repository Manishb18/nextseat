"""WebSocket signaling for room membership and WebRTC message relay."""

from __future__ import annotations

import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..rooms import RateLimited, RoomFull, RoomNotFound, room_manager
from ..services.client_ip import resolve_client_ip

router = APIRouter()


@router.websocket("/ws/{code}")
async def signaling(ws: WebSocket, code: str) -> None:
    await ws.accept()

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
    ip = resolve_client_ip(
        ws.client.host if ws.client else None,
        ws.headers.get("x-forwarded-for"),
    )
    previous_peer = room_manager.get_peer_by_client(code, client_id) if client_id else None

    try:
        peer_id, is_polite, reconnected = room_manager.join_room(
            code, ws, name, ip, client_id, owner_token
        )
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

    # Replace an old socket for a reconnecting client without removing its new slot.
    if previous_peer and previous_peer.ws is not ws:
        try:
            await previous_peer.ws.close(code=4001, reason="signaling session replaced")
        except Exception:
            pass

    peers_list = room_manager.get_peers(code)
    room = room_manager.get_room(code)
    await ws.send_json({
        "type": "joined",
        "peerId": peer_id,
        "polite": is_polite,
        "isCreator": bool(room and room.owner_peer_id == peer_id),
        "peers": peers_list,
    })

    other = room_manager.get_other_peer(code, ws)
    if other:
        try:
            event_type = "peer-reconnected" if reconnected else "peer-joined"
            await other.ws.send_json({"type": event_type, "name": name, "peerId": peer_id})
        except Exception:
            pass

    try:
        await _relay_messages(ws, code)
    except (WebSocketDisconnect, json.JSONDecodeError):
        pass
    finally:
        removed = room_manager.leave_room(code, ws)
        if removed:
            other = room_manager.get_other_peer(code, ws)
            if other:
                try:
                    await other.ws.send_json({"type": "peer-left", "peerId": removed.peer_id})
                except Exception:
                    pass


async def _relay_messages(ws: WebSocket, code: str) -> None:
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
            other = room_manager.get_other_peer(code, ws)
            if other:
                try:
                    await other.ws.send_json({"type": "signal", "data": data})
                except Exception:
                    pass
        elif msg_type == "leave":
            return
        elif msg_type == "ping":
            await ws.send_json({"type": "pong"})
        elif msg_type == "delete-room":
            peers = room_manager.delete_room(code, ws)
            if peers is None:
                await ws.send_json({"type": "delete-denied"})
                continue
            for peer in peers:
                try:
                    await peer.ws.send_json({"type": "room-deleted"})
                    await peer.ws.close(code=4002, reason="room ended by creator")
                except Exception:
                    pass
            return
