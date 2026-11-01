import asyncio
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from wheelsoul.protocol import (
    AUTH_READ, AUTH_WRITE, CELL_MAX_AGE, CellSamples, ProtocolError, Session,
    decode_cell, field_uuid, gemini_response, identity, word,
)

CHALLENGE = bytes.fromhex("435258000102030405060708090a0b0c0d0e0f00")
RESPONSE = bytes.fromhex("435258c15a4c9f0616f53b5bdde730fc15280847")


class FakeClient:
    def __init__(self, locked=True):
        self.locked = locked
        self.is_connected = True
        self.writes = []
        self.notify = None
        self.stopped = False
        self.cell_index = 0
        self.fragments = [CHALLENGE[:4], CHALLENGE[4:11], CHALLENGE[11:]]
        self.values = {
            "mode": 8, "hardware": 4206, "firmware": 4134,
            "battery": 43, "trip": 1000, "rpm": -100, "current": -27,
            "voltage": 567, "lifetime": 2660,
        }
        self.services = SimpleNamespace(get_characteristic=lambda identifier: SimpleNamespace(
            uuid=identifier, properties=["read", "write", "notify"],
        ))

    async def read_gatt_char(self, target):
        name = next((name for name in self.values if field_uuid(name) == target.uuid), None)
        if name:
            value = 0 if name == "mode" and self.locked else self.values[name]
            return value.to_bytes(2, "big", signed=value < 0)
        if target.uuid == field_uuid("temperature"):
            return bytes([19, 21])
        if target.uuid == field_uuid("battery_temperature"):
            return bytes([0, 18])
        if target.uuid == field_uuid("cell"):
            index = self.cell_index % 15
            self.cell_index += 1
            return bytes([index, 190])
        raise AssertionError(f"Unexpected read: {target.uuid}")

    async def write_gatt_char(self, target, data, response):
        self.writes.append((target.uuid, bytes(data), response))
        if target.uuid == field_uuid("firmware"):
            if data != (4134).to_bytes(2, "big"):
                raise AssertionError("Firmware value must never change.")
            if self.notify:
                for fragment in self.fragments:
                    self.notify(AUTH_READ, fragment)
        elif target.uuid == AUTH_WRITE:
            if data != RESPONSE:
                raise AssertionError("Invalid authentication response.")
            self.locked = False
        else:
            raise AssertionError("Configuration writes are forbidden.")

    async def start_notify(self, target, callback):
        self.notify = callback

    async def stop_notify(self, target):
        self.stopped = True
        self.notify = None


class ProtocolTests(unittest.TestCase):
    def test_documented_authentication_vector(self):
        self.assertEqual(gemini_response(CHALLENGE), RESPONSE)
        for invalid in (b"", CHALLENGE[:-1], CHALLENGE + b"\0"):
            with self.assertRaises(ProtocolError):
                gemini_response(invalid)

    def test_big_endian_signed_and_invalid_lengths(self):
        self.assertEqual(word(b"\x10\x26"), 4134)
        self.assertEqual(word(b"\xff\xe5", signed=True), -27)
        for invalid in (b"", b"\0", b"\0\0\0"):
            with self.assertRaises(ProtocolError):
                word(invalid)

    def test_cells_and_freshness_boundary(self):
        cells = CellSamples()
        for index in range(15):
            cells.update(bytes([index, 190]), 4134, 100)
        self.assertEqual(cells.values(100 + CELL_MAX_AGE), [3.8] * 15)
        self.assertEqual(cells.values(100 + CELL_MAX_AGE + .001), [None] * 15)
        self.assertIsNone(decode_cell(bytes([15, 0]), 4134))
        self.assertEqual(decode_cell(bytes([0x1D, 0x7E]), 4141), (1, 3454 * .0011))
        with self.assertRaises(ProtocolError):
            decode_cell(bytes([0, 0]), 4134)

    def test_unsupported_handshake_never_writes(self):
        for hardware, firmware in ((4210, 4134), (4206, 4155), (3000, 4134), (4206, 4000)):
            client = FakeClient()
            with self.assertRaises(ProtocolError):
                Session(client, hardware, firmware)
            self.assertEqual(client.writes, [])


class AsyncProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_fragmented_authentication_and_write_allowlist(self):
        client = FakeClient()
        self.assertEqual(await identity(client), (4206, 4134))
        session = Session(client, 4206, 4134)
        await session.authenticate()
        self.assertTrue(client.stopped)
        self.assertFalse(client.locked)
        self.assertEqual(client.values["mode"], 8)
        self.assertEqual(client.writes, [
            (field_uuid("firmware"), bytes.fromhex("1026"), True),
            (AUTH_WRITE, RESPONSE, True),
        ])

    async def test_existing_session_only_touches_existing_firmware(self):
        client = FakeClient(locked=False)
        await Session(client, 4206, 4134).authenticate()
        self.assertEqual(client.writes, [(field_uuid("firmware"), bytes.fromhex("1026"), True)])

    async def test_oversized_challenge_cleans_up_notifications(self):
        client = FakeClient()
        client.fragments = [CHALLENGE + b"\0"]
        with self.assertRaises(ProtocolError):
            await Session(client, 4206, 4134).authenticate()
        self.assertTrue(client.stopped)
        self.assertNotIn(AUTH_WRITE, [item[0] for item in client.writes])

    async def test_identity_change_aborts_authentication(self):
        client = FakeClient()
        client.values["hardware"] = 4205
        with self.assertRaisesRegex(ProtocolError, "identity changed"):
            await Session(client, 4206, 4134).authenticate()

    async def test_frame_units_current_sign_temperatures_and_missing_cells(self):
        frame = await Session(FakeClient(locked=False), 4206, 4134).snapshot()
        self.assertEqual(frame["source"], "physical")
        self.assertEqual(frame["packVoltage"], 56.7)
        self.assertEqual(frame["current"], -.054)
        self.assertEqual(frame["speed"], 5.506)
        self.assertEqual(frame["tripKm"], .9177)
        self.assertEqual(frame["lifetimeKm"], 4280.855)
        self.assertEqual(frame["controllerTemperature"], 19)
        self.assertEqual(frame["motorTemperature"], 21)
        self.assertEqual(frame["batteryTemperature"], 18)
        self.assertEqual(frame["cellVoltages"], [None] * 15)
        self.assertEqual(frame["mode"], "Delirium")

    async def test_locked_data_is_never_returned(self):
        with self.assertRaisesRegex(ProtocolError, "locked"):
            await Session(FakeClient(), 4206, 4134).snapshot()

    async def test_zero_motor_temperature_is_unknown_but_other_zero_readings_are_valid(self):
        client = FakeClient(locked=False)
        original_read = client.read_gatt_char

        async def read(target):
            if target.uuid in (field_uuid("temperature"), field_uuid("battery_temperature")):
                return bytes([0, 0])
            return await original_read(target)

        client.read_gatt_char = read
        session = Session(client, 4206, 4134)
        with self.assertLogs("wheelsoul.protocol", level="WARNING") as log:
            first = await session.snapshot()
            await session.snapshot()
        self.assertEqual(len(log.output), 1)
        self.assertIsNone(first["motorTemperature"])
        self.assertEqual(first["controllerTemperature"], 0)
        self.assertEqual(first["batteryTemperature"], 0)

    async def test_optional_temperatures_are_null_with_a_warning(self):
        client = FakeClient(locked=False)
        lookup = client.services.get_characteristic
        client.services.get_characteristic = lambda identifier: (
            None if identifier in (field_uuid("temperature"), field_uuid("battery_temperature")) else lookup(identifier)
        )
        with self.assertLogs("wheelsoul.protocol", level="WARNING") as log:
            session = Session(client, 4206, 4134)
            first = await session.snapshot()
            await session.snapshot()
        self.assertEqual(len(log.output), 2)
        self.assertIsNone(first["controllerTemperature"])
        self.assertIsNone(first["batteryTemperature"])

    async def test_stream_fills_all_cells_keeps_alive_and_cancels_all_workers(self):
        client = FakeClient(locked=False)
        session = Session(client, 4206, 4134)
        complete = asyncio.Event()
        frames = []

        async def emit(data):
            frames.append(data)
            if all(value is not None for value in data["cellVoltages"]):
                complete.set()

        with patch("wheelsoul.protocol.KEEPALIVE_INTERVAL", .02):
            task = asyncio.create_task(session.stream(emit))
            await asyncio.wait_for(complete.wait(), 4)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        writes = len(client.writes)
        await asyncio.sleep(.04)
        self.assertEqual(len(client.writes), writes)
        self.assertGreater(writes, 1)
        self.assertEqual(frames[-1]["cellVoltages"], [3.8] * 15)
        self.assertTrue(all(uuid == field_uuid("firmware") for uuid, *_ in client.writes))

    async def test_keepalive_failure_stops_the_stream(self):
        client = FakeClient(locked=False)
        session = Session(client, 4206, 4134)

        async def fail():
            raise ProtocolError("Synthetic keepalive failure")

        async def emit(_data):
            pass

        session._touch_session = fail
        with patch("wheelsoul.protocol.KEEPALIVE_INTERVAL", .01):
            with self.assertRaises(ExceptionGroup) as caught:
                await asyncio.wait_for(session.stream(emit), 1)
        self.assertIsInstance(caught.exception.exceptions[0], ProtocolError)


if __name__ == "__main__":
    unittest.main()
