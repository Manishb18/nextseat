"""In-memory room manager with rate limiting and auto-cleanup."""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .config import settings

if TYPE_CHECKING:
    from fastapi import WebSocket

# Characters that avoid look-alikes (no 0/O, 1/I/L)
ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
ROOM_CODE_LENGTH = 6


@dataclass
class Peer:
    ws: WebSocket
    name: str
    peer_id: str
    client_id: str = ''


@dataclass
class Room:
    code: str
    peers: list[Peer] = field(default_factory=list)
    owner_token: str = field(default_factory=lambda: secrets.token_urlsafe(32), repr=False)
    owner_peer_id: str | None = None
    created_at: float = field(default_factory=time.time)
    cleanup_task: asyncio.Task[None] | None = field(default=None, repr=False)


class RoomFull(Exception):
    pass


class RateLimited(Exception):
    pass


class RoomNotFound(Exception):
    pass


class RoomManager:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}
        # Rate limiting: IP → list of timestamps
        self._create_log: dict[str, list[float]] = {}
        self._join_log: dict[str, list[float]] = {}

    def _generate_code(self) -> str:
        """Generate a unique 6-character room code."""
        for _ in range(100):
            code = "".join(secrets.choice(ROOM_CODE_CHARS) for _ in range(ROOM_CODE_LENGTH))
            if code not in self._rooms:
                return code
        raise RuntimeError("Failed to generate unique room code")

    def _check_rate(self, log: dict[str, list[float]], ip: str, limit: int) -> None:
        """Sliding-window rate limit: max `limit` actions per IP per 60 seconds."""
        now = time.time()
        window = now - 60
        timestamps = log.get(ip, [])
        # Prune old entries
        timestamps = [t for t in timestamps if t > window]
        if len(timestamps) >= limit:
            raise RateLimited(f"Rate limit exceeded ({limit}/min)")
        timestamps.append(now)
        log[ip] = timestamps

    def create_room(self, ip: str) -> str:
        """Create a new room and return its code. Rate-limited per IP."""
        self._check_rate(self._create_log, ip, settings.room_create_limit)
        code = self._generate_code()
        self._rooms[code] = Room(code=code)
        # Rooms that are created but never joined should expire too.
        self._schedule_cleanup(code)
        return code

    def get_room(self, code: str) -> Room | None:
        return self._rooms.get(code)

    def join_room(self, code: str, ws: WebSocket, name: str, ip: str, client_id: str = '', owner_token: str = '') -> tuple[str, bool, bool]:
        """Join a room. Returns (peer_id, is_polite, reconnected).

        The first joiner is impolite, the second is polite
        (perfect negotiation convention).

        Raises RoomNotFound, RoomFull, or RateLimited.
        """
        self._check_rate(self._join_log, ip, settings.room_join_limit)

        room = self._rooms.get(code)
        if room is None:
            raise RoomNotFound(f"Room {code} not found")
        if client_id:
            for index, peer in enumerate(room.peers):
                if peer.client_id == client_id:
                    room.peers[index] = Peer(ws=ws, name=name, peer_id=peer.peer_id, client_id=client_id)
                    if owner_token and secrets.compare_digest(room.owner_token, owner_token):
                        room.owner_peer_id = peer.peer_id
                    return peer.peer_id, index == 1, True

        if len(room.peers) >= 2:
            raise RoomFull(f"Room {code} is full")

        # Cancel any pending cleanup
        if room.cleanup_task and not room.cleanup_task.done():
            room.cleanup_task.cancel()
            room.cleanup_task = None

        peer_id = f"peer-{secrets.token_hex(4)}"
        is_polite = len(room.peers) == 1  # Second joiner is polite
        if owner_token and secrets.compare_digest(room.owner_token, owner_token):
            room.owner_peer_id = peer_id
        room.peers.append(Peer(ws=ws, name=name, peer_id=peer_id, client_id=client_id))
        return peer_id, is_polite, False

    def delete_room(self, code: str, ws: WebSocket) -> list[Peer] | None:
        """Delete a room only when requested by the peer holding its owner slot."""
        room = self._rooms.get(code)
        if room is None or room.owner_peer_id is None:
            return None
        requester = next((peer for peer in room.peers if peer.ws is ws), None)
        if requester is None or requester.peer_id != room.owner_peer_id:
            return None
        self._rooms.pop(code, None)
        if room.cleanup_task and not room.cleanup_task.done():
            room.cleanup_task.cancel()
        return list(room.peers)

    def get_peer_by_client(self, code: str, client_id: str) -> Peer | None:
        room = self._rooms.get(code)
        if room is None:
            return None
        return next((peer for peer in room.peers if peer.client_id == client_id), None)

    def leave_room(self, code: str, ws: WebSocket) -> Peer | None:
        """Remove a peer from the room. Returns the removed peer or None."""
        room = self._rooms.get(code)
        if room is None:
            return None

        removed: Peer | None = None
        for peer in room.peers:
            if peer.ws is ws:
                removed = peer
                break

        if removed:
            room.peers.remove(removed)

        # Schedule cleanup if room is now empty
        if removed and not room.peers:
            self._schedule_cleanup(code)

        return removed

    def get_other_peer(self, code: str, ws: WebSocket) -> Peer | None:
        """Get the other peer in the room (not the one with this ws)."""
        room = self._rooms.get(code)
        if room is None:
            return None
        for peer in room.peers:
            if peer.ws is not ws:
                return peer
        return None

    def get_peers(self, code: str) -> list[dict[str, str]]:
        """Get a list of {peerId, name} for all peers in the room."""
        room = self._rooms.get(code)
        if room is None:
            return []
        return [{"peerId": p.peer_id, "name": p.name} for p in room.peers]

    def _schedule_cleanup(self, code: str) -> None:
        """Delete the room after the configured timeout if it stays empty."""
        room = self._rooms.get(code)
        if room is None:
            return

        async def _cleanup() -> None:
            await asyncio.sleep(settings.room_empty_timeout)
            # Only delete if still empty
            r = self._rooms.get(code)
            if r and not r.peers:
                del self._rooms[code]

        room.cleanup_task = asyncio.create_task(_cleanup())

    @property
    def room_count(self) -> int:
        return len(self._rooms)


# Singleton instance
room_manager = RoomManager()
