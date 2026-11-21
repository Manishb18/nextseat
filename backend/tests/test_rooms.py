import asyncio
import unittest

from app.rooms import InviteInvalid, Room, RoomManager


class FakeWebSocket:
    pass


def _make_manager_no_cleanup():
    """Return a RoomManager that skips the asyncio cleanup task (useful outside an event loop)."""
    manager = RoomManager()

    original_schedule = manager._schedule_cleanup

    def _noop_schedule(code):
        pass  # Skip asyncio.create_task in synchronous test contexts

    manager._schedule_cleanup = _noop_schedule
    return manager


class ReconnectionTests(unittest.TestCase):
    def test_rejoining_client_reuses_its_room_slot_and_peer_identity(self) -> None:
        async def scenario() -> None:
            manager = RoomManager()
            code = manager.create_room("test")
            self.assertIsNotNone(manager.get_room(code).cleanup_task)
            old_socket = FakeWebSocket()
            first_peer_id, first_is_polite, first_reconnected = manager.join_room(
                code, old_socket, "Host", "test", "browser-tab-1"
            )

            new_socket = FakeWebSocket()
            second_peer_id, second_is_polite, second_reconnected = manager.join_room(
                code, new_socket, "Host", "test", "browser-tab-1"
            )

            self.assertFalse(first_is_polite)
            self.assertFalse(first_reconnected)
            self.assertEqual(second_peer_id, first_peer_id)
            self.assertFalse(second_is_polite)
            self.assertTrue(second_reconnected)
            self.assertIs(manager.get_peer_by_client(code, "browser-tab-1").ws, new_socket)
            self.assertIsNone(manager.leave_room(code, old_socket))
            self.assertEqual(len(manager.get_peers(code)), 1)

        asyncio.run(scenario())


class InviteTokenTests(unittest.TestCase):
    def test_room_create_has_invite_token(self) -> None:
        manager = _make_manager_no_cleanup()
        code = manager.create_room("1.2.3.4")
        room = manager.get_room(code)
        self.assertIsNotNone(room)
        self.assertGreaterEqual(len(room.invite_token), 24)

    def test_first_joiner_does_not_need_invite_token(self) -> None:
        """The host (first joiner) can join with owner_token only — no invite needed."""
        manager = _make_manager_no_cleanup()
        code = manager.create_room("1.2.3.4")
        room = manager.get_room(code)
        ws = FakeWebSocket()
        peer_id, _, _ = manager.join_room(code, ws, "Host", "1.2.3.4", "", room.owner_token)
        self.assertTrue(peer_id)

    def test_second_joiner_needs_correct_invite_token(self) -> None:
        manager = _make_manager_no_cleanup()
        code = manager.create_room("1.2.3.4")
        room = manager.get_room(code)
        ws_host = FakeWebSocket()
        manager.join_room(code, ws_host, "Host", "1.2.3.4", "", room.owner_token)
        room = manager.get_room(code)
        ws_guest = FakeWebSocket()
        peer_id, _, _ = manager.join_room(code, ws_guest, "Guest", "5.6.7.8", "", "", room.invite_token)
        self.assertTrue(peer_id)

    def test_second_joiner_rejected_without_invite_token(self) -> None:
        manager = _make_manager_no_cleanup()
        code = manager.create_room("1.2.3.4")
        room = manager.get_room(code)
        ws_host = FakeWebSocket()
        manager.join_room(code, ws_host, "Host", "1.2.3.4", "", room.owner_token)
        ws_stranger = FakeWebSocket()
        with self.assertRaises(InviteInvalid):
            manager.join_room(code, ws_stranger, "Stranger", "9.9.9.9")

    def test_second_joiner_rejected_with_wrong_invite_token(self) -> None:
        manager = _make_manager_no_cleanup()
        code = manager.create_room("1.2.3.4")
        room = manager.get_room(code)
        ws_host = FakeWebSocket()
        manager.join_room(code, ws_host, "Host", "1.2.3.4", "", room.owner_token)
        ws_stranger = FakeWebSocket()
        with self.assertRaises(InviteInvalid):
            manager.join_room(code, ws_stranger, "Stranger", "9.9.9.9", "", "", "wrong-token")


class KickAndRotateTests(unittest.TestCase):
    def _setup(self):
        manager = _make_manager_no_cleanup()
        code = manager.create_room("1.2.3.4")
        room = manager.get_room(code)
        ws_host = FakeWebSocket()
        manager.join_room(code, ws_host, "Host", "1.2.3.4", "", room.owner_token)
        room = manager.get_room(code)
        ws_guest = FakeWebSocket()
        guest_peer_id, _, _ = manager.join_room(code, ws_guest, "Guest", "5.6.7.8", "", "", room.invite_token)
        return manager, code, ws_host, ws_guest, guest_peer_id

    def test_host_can_kick_guest(self) -> None:
        manager, code, ws_host, ws_guest, guest_peer_id = self._setup()
        kicked = manager.kick_peer(code, ws_host, guest_peer_id)
        self.assertIsNotNone(kicked)
        self.assertEqual(kicked.peer_id, guest_peer_id)
        self.assertEqual(len(manager.get_peers(code)), 1)

    def test_guest_cannot_kick(self) -> None:
        manager, code, ws_host, ws_guest, guest_peer_id = self._setup()
        host_peer_id = manager.get_room(code).owner_peer_id
        result = manager.kick_peer(code, ws_guest, host_peer_id)
        self.assertIsNone(result)

    def test_host_can_rotate_invite_token(self) -> None:
        manager, code, ws_host, ws_guest, _ = self._setup()
        old_token = manager.get_room(code).invite_token
        new_token = manager.rotate_invite_token(code, ws_host)
        self.assertIsNotNone(new_token)
        self.assertNotEqual(new_token, old_token)
        self.assertEqual(manager.get_room(code).invite_token, new_token)

    def test_guest_cannot_rotate_invite_token(self) -> None:
        manager, code, ws_host, ws_guest, _ = self._setup()
        result = manager.rotate_invite_token(code, ws_guest)
        self.assertIsNone(result)

    def test_old_invite_token_rejected_after_rotation(self) -> None:
        manager, code, ws_host, ws_guest, _ = self._setup()
        old_invite = manager.get_room(code).invite_token
        manager.rotate_invite_token(code, ws_host)
        ws_latecomer = FakeWebSocket()
        with self.assertRaises(InviteInvalid):
            manager.join_room(code, ws_latecomer, "Latecomer", "2.2.2.2", "", "", old_invite)


if __name__ == "__main__":
    unittest.main()
