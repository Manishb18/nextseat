import asyncio
import unittest

from app.rooms import RoomManager


class FakeWebSocket:
    pass


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


if __name__ == "__main__":
    unittest.main()
