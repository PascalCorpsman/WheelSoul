import asyncio
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

from wheelsoul.protocol import SERVICE
from wheelsoul.server import CONTROLLER, Controller, create_app


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "index.html").write_text("<!doctype html><title>WheelSoul</title>", encoding="utf-8")
        self.app = create_app(self.root)
        self.controller = self.app[CONTROLLER]
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        response = await self.client.get("/api/session")
        info = await response.json()
        self.headers = {"X-WheelSoul-Token": info["token"]}
        self.token = info["token"]

    async def asyncTearDown(self):
        await self.client.close()
        self.directory.cleanup()

    async def test_html_and_session(self):
        response = await self.client.get("/")
        self.assertEqual(response.status, 200)
        self.assertIn("WheelSoul", await response.text())
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        info = await (await self.client.get("/api/session")).json()
        self.assertTrue(info["liveBleEnabled"])
        self.assertEqual(info["apiVersion"], 1)

    async def test_token_host_and_origin_guards(self):
        for headers in (
            {}, {"X-WheelSoul-Token": "invalid"}, {"X-WheelSoul-Token": "invalid-\u00e4"},
            {**self.headers, "Origin": "https://unrelated.example"},
            {**self.headers, "Host": "unrelated.example"},
        ):
            response = await self.client.post("/api/scan", headers=headers)
            self.assertEqual(response.status, 403)
            self.assertIn("error", await response.json())

    async def test_api_errors_are_json_and_static_files_cannot_escape(self):
        response = await self.client.get("/api/missing", headers=self.headers)
        self.assertEqual(response.status, 404)
        self.assertIn("error", await response.json())
        for path in ("/../requirements.txt", "/%2e%2e/requirements.txt", "/src/wheelsoul/server.py"):
            response = await self.client.get(path)
            self.assertEqual(response.status, 404)

    async def test_invalid_and_unscanned_connection_requests(self):
        for data, status in (({}, 400), ({"id": ""}, 400), ({"id": "a", "mode": 8}, 400), ({"id": "a" * 257}, 400)):
            response = await self.client.post("/api/connect", json=data, headers=self.headers)
            self.assertEqual(response.status, status)
        response = await self.client.post("/api/connect", data="{", headers=self.headers)
        self.assertEqual(response.status, 415)
        response = await self.client.post("/api/connect", data="{", headers={**self.headers, "Content-Type": "application/json"})
        self.assertEqual(response.status, 400)
        response = await self.client.post("/api/connect", json={"id": "unscanned"}, headers=self.headers)
        self.assertEqual(response.status, 409)
        socket = await self.client.ws_connect(f"/api/events?token={self.token}")
        await socket.receive_json()
        response = await self.client.post("/api/connect", json={"id": "unscanned"}, headers=self.headers)
        self.assertEqual(response.status, 400)
        await socket.close()

    async def test_scan_filters_service_and_returns_dynamic_identifiers(self):
        device = SimpleNamespace(address="synthetic-device", name="XR")
        other = SimpleNamespace(address="unrelated-device", name="Speaker")
        advertisement = SimpleNamespace(local_name="XR Alpha", service_uuids=[SERVICE], rssi=-61)
        unrelated = SimpleNamespace(local_name="Speaker", service_uuids=[], rssi=-40)
        with patch("wheelsoul.server.BleakScanner.discover", return_value={
            "one": (device, advertisement), "two": (other, unrelated),
        }):
            response = await self.client.post("/api/scan", headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["boards"], [
            {"id": "synthetic-device", "advertisedName": "XR Alpha", "rssi": -61},
        ])
        self.assertNotIn("unrelated-device", self.controller.devices)

    async def test_expired_discovery_is_rejected(self):
        socket = await self.client.ws_connect(f"/api/events?token={self.token}")
        await socket.receive_json()
        self.controller.devices["expired"] = (SimpleNamespace(address="expired"), "XR", time.monotonic() - 301)
        response = await self.client.post("/api/connect", json={"id": "expired"}, headers=self.headers)
        self.assertEqual(response.status, 400)
        await socket.close()

    async def test_last_browser_closing_cancels_hardware_session(self):
        socket = await self.client.ws_connect(f"/api/events?token={self.token}")
        self.assertEqual((await socket.receive_json())["status"], "offline")
        stopped = asyncio.Event()

        async def session():
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        self.controller.task = asyncio.create_task(session())
        await asyncio.sleep(0)
        await socket.close()
        await asyncio.wait_for(stopped.wait(), 1)
        self.assertEqual(self.controller.state["status"], "offline")

    async def test_one_browser_closing_does_not_disconnect_another(self):
        first = await self.client.ws_connect(f"/api/events?token={self.token}")
        second = await self.client.ws_connect(f"/api/events?token={self.token}")
        await first.receive_json()
        await second.receive_json()
        self.controller.task = asyncio.create_task(asyncio.sleep(100))
        await first.close()
        await asyncio.sleep(.02)
        self.assertFalse(self.controller.task.done())
        await second.close()

    async def test_server_shutdown_closes_browser_connections_and_stops_the_session(self):
        socket = await self.client.ws_connect(f"/api/events?token={self.token}")
        await socket.receive_json()
        task = asyncio.create_task(asyncio.sleep(100))
        self.controller.task = task

        async def receive_until_closed():
            async for _message in socket:
                pass

        reader = asyncio.create_task(receive_until_closed())
        await asyncio.wait_for(self.client.server.close(), 2)
        await asyncio.wait_for(reader, 1)
        self.assertTrue(socket.closed)
        self.assertTrue(task.cancelled())
        self.assertIsNone(self.controller.task)

    async def test_demo_only_never_scans_hardware(self):
        self.controller.demo_only = True
        with patch("wheelsoul.server.BleakScanner.discover") as discover:
            response = await self.client.post("/api/scan", headers=self.headers)
        self.assertEqual(response.status, 503)
        discover.assert_not_called()
        info = await (await self.client.get("/api/session")).json()
        self.assertFalse(info["liveBleEnabled"])

    async def test_ble_scan_failure_is_explicit(self):
        with patch("wheelsoul.server.BleakScanner.discover", side_effect=OSError("Synthetic radio failure")):
            with self.assertLogs("wheelsoul.server", level="ERROR"):
                response = await self.client.post("/api/scan", headers=self.headers)
        self.assertEqual(response.status, 503)
        self.assertIn("Synthetic radio failure", (await response.json())["error"])

    async def test_connect_uses_selected_scanned_device_and_cancels_cleanly(self):
        socket = await self.client.ws_connect(f"/api/events?token={self.token}")
        await socket.receive_json()
        device = SimpleNamespace(address="chosen-board")
        self.controller.devices[device.address] = (device, "XR Beta", time.monotonic())
        entered = asyncio.Event()

        async def session(selected, name):
            self.assertIs(selected, device)
            self.assertEqual(name, "XR Beta")
            entered.set()
            await asyncio.Event().wait()

        self.controller._session = session
        response = await self.client.post("/api/connect", json={"id": device.address}, headers=self.headers)
        self.assertEqual(response.status, 202)
        await asyncio.wait_for(entered.wait(), 1)
        self.assertEqual((await socket.receive_json())["status"], "connecting")
        response = await self.client.post("/api/connect", json={"id": device.address}, headers=self.headers)
        self.assertEqual(response.status, 409)
        response = await self.client.post("/api/disconnect", headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertIsNone(self.controller.task)
        await socket.close()

    async def test_unexpected_session_failure_is_logged_shown_and_can_be_disconnected(self):
        socket = await self.client.ws_connect(f"/api/events?token={self.token}")
        await socket.receive_json()
        device = SimpleNamespace(address="synthetic-board")
        self.controller.devices[device.address] = (device, "XR", time.monotonic())
        with patch("wheelsoul.server.BleakClient", side_effect=TypeError("Synthetic unexpected failure")):
            with self.assertLogs("wheelsoul.server", level="ERROR"):
                await self.controller.connect(device.address)
                with self.assertRaises(TypeError):
                    await self.controller.task
                await asyncio.sleep(0)
        self.assertEqual(self.controller.state["status"], "error")
        self.assertIn("Synthetic unexpected failure", self.controller.state["error"])
        response = await self.client.post("/api/disconnect", headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertIsNone(self.controller.task)
        self.assertEqual(self.controller.state["status"], "offline")
        await socket.close()


if __name__ == "__main__":
    unittest.main()
