"""Legacy Gemini authentication and XR telemetry, without board configuration."""

import asyncio
import hashlib
import logging
import time

LOG = logging.getLogger(__name__)
SERVICE = "e659f300-ea98-11e3-ac10-0800200c9a66"
AUTH_READ = "e659f3fe-ea98-11e3-ac10-0800200c9a66"
AUTH_WRITE = "e659f3ff-ea98-11e3-ac10-0800200c9a66"
GEMINI_PROTOCOL_SALT = bytes.fromhex("d9255f0f23354e19ba739ccdc4a91765")
KEEPALIVE_INTERVAL = 10.0
CELL_MAX_AGE = 30.0
WHEEL_CIRCUMFERENCE_M = 0.91766
FIELDS = {
    "mode": "302",
    "battery": "303",
    "trip": "30a",
    "rpm": "30b",
    "temperature": "310",
    "firmware": "311",
    "current": "312",
    "battery_temperature": "315",
    "voltage": "316",
    "hardware": "318",
    "lifetime": "319",
    "cell": "31b",
}
MODES = {4: "Sequoia", 5: "Cruz", 6: "Mission", 7: "Elevated", 8: "Delirium", 9: "Custom"}


class ProtocolError(RuntimeError):
    pass


def field_uuid(name):
    return f"e659f{FIELDS[name]}-ea98-11e3-ac10-0800200c9a66"


def word(data, signed=False):
    if len(data) != 2:
        raise ProtocolError(f"Expected a two-byte value; received {len(data)} bytes.")
    return int.from_bytes(data, "big", signed=signed)


def gemini_response(challenge):
    if len(challenge) != 20:
        raise ProtocolError("A Gemini challenge must contain exactly 20 bytes.")
    digest = hashlib.md5(
        challenge[3:19] + GEMINI_PROTOCOL_SALT, usedforsecurity=False,
    ).digest()
    body = challenge[:3] + digest
    checksum = 0
    for value in body:
        checksum ^= value
    return body + bytes([checksum])


def decode_cell(data, firmware):
    value = word(data)
    if firmware >= 4141:
        index = value >> 12
        voltage = (value & 0x0FFF) * 0.0011
    else:
        index, encoded = data
        voltage = encoded * 0.02
    if index == 15:
        return None
    if not 0 <= index < 15 or not 0 < voltage <= 5:
        raise ProtocolError("Invalid XR cell index or voltage.")
    return index, voltage


class CellSamples:
    def __init__(self):
        self.samples = {}

    def update(self, data, firmware, now):
        cell = decode_cell(data, firmware)
        if cell is not None:
            index, voltage = cell
            self.samples[index] = (voltage, now)

    def values(self, now):
        return [
            round(self.samples[i][0], 4)
            if i in self.samples and now - self.samples[i][1] <= CELL_MAX_AGE else None
            for i in range(15)
        ]


def characteristic(client, identifier, permission):
    result = client.services.get_characteristic(identifier)
    if result is None or permission not in result.properties:
        raise ProtocolError(f"Missing characteristic or {permission} permission: {identifier}")
    return result


class Session:
    def __init__(self, client, hardware, firmware, io_lock=None):
        if not (4000 <= hardware <= 4209 and 4000 < firmware < 4141):
            raise ProtocolError(
                f"Unsupported local handshake: hardware {hardware}, firmware {firmware}. "
                "Only legacy XR hardware 4000-4209 with firmware 4001-4140 is supported. "
                "No authentication commands have been sent."
            )
        self.client = client
        self.hardware = hardware
        self.firmware = firmware
        self.io_lock = io_lock if io_lock is not None else asyncio.Lock()
        self.cells = CellSamples()
        self.missing_optional = set()

    async def read(self, name, optional=False):
        identifier = field_uuid(name)
        if optional and self.client.services.get_characteristic(identifier) is None:
            if name not in self.missing_optional:
                LOG.warning("Board does not expose optional telemetry: %s", name)
                self.missing_optional.add(name)
            return None
        target = characteristic(self.client, identifier, "read")
        async with self.io_lock:
            return bytes(await asyncio.wait_for(self.client.read_gatt_char(target), 5))

    async def _touch_session(self):
        # This endpoint uses the existing version as a session command, not a flash.
        target = characteristic(self.client, field_uuid("firmware"), "write")
        async with self.io_lock:
            await asyncio.wait_for(
                self.client.write_gatt_char(
                    target, self.firmware.to_bytes(2, "big"), response=True,
                ), 5,
            )

    async def authenticate(self):
        original_mode = word(await self.read("mode"))
        if original_mode == 0:
            incoming = characteristic(self.client, AUTH_READ, "notify")
            outgoing = characteristic(self.client, AUTH_WRITE, "write")
            characteristic(self.client, field_uuid("firmware"), "write")
            challenge = asyncio.get_running_loop().create_future()
            buffer = bytearray()

            def receive(_target, data):
                if challenge.done():
                    return
                buffer.extend(data)
                if not data or len(buffer) > 20:
                    challenge.set_exception(ProtocolError("Invalid Gemini challenge length."))
                elif len(buffer) == 20:
                    challenge.set_result(bytes(buffer))

            LOG.info("Starting local Gemini authentication; no cloud or firmware update.")
            await asyncio.wait_for(self.client.start_notify(incoming, receive), 5)
            try:
                await self._touch_session()
                payload = await asyncio.wait_for(challenge, 10)
            finally:
                if not challenge.done():
                    challenge.cancel()
                elif not challenge.cancelled():
                    challenge.exception()
                await asyncio.wait_for(self.client.stop_notify(incoming), 5)
            async with self.io_lock:
                await asyncio.wait_for(
                    self.client.write_gatt_char(outgoing, gemini_response(payload), response=True), 5,
                )
        else:
            await self._touch_session()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            mode = word(await self.read("mode"))
            if mode and 0 < word(await self.read("voltage")) * 0.1 <= 80:
                break
            await asyncio.sleep(0.1)
        else:
            raise ProtocolError("Authentication did not unlock valid telemetry.")
        if original_mode and mode != original_mode:
            raise ProtocolError("The riding mode changed unexpectedly during authentication.")
        identity = word(await self.read("hardware")), word(await self.read("firmware"))
        if identity != (self.hardware, self.firmware):
            raise ProtocolError("Board identity changed unexpectedly during authentication.")
        LOG.info("Authenticated XR: hardware %s, firmware %s, mode %s.",
                 self.hardware, self.firmware, MODES.get(mode, f"Unknown ({mode})"))

    async def snapshot(self):
        mode = word(await self.read("mode"))
        if not mode:
            raise ProtocolError("Telemetry is locked. Zero values are not measurements.")
        raw = {}
        for name in ("battery", "trip", "rpm", "current", "voltage", "lifetime"):
            raw[name] = await self.read(name)
        voltage = word(raw["voltage"]) * 0.1
        battery = word(raw["battery"])
        if not 0 < voltage <= 80 or not 0 <= battery <= 100:
            raise ProtocolError("Invalid battery telemetry; the last valid sample is retained.")
        temperature = await self.read("temperature", optional=True)
        battery_temperature = await self.read("battery_temperature", optional=True)
        if temperature is not None:
            word(temperature)
        if battery_temperature is not None:
            word(battery_temperature)
        motor_temperature = temperature[1] if temperature is not None else None
        if motor_temperature == 0:
            motor_temperature = None
            if "motor_temperature" not in self.missing_optional:
                LOG.warning("Legacy XR reports zero motor temperature; treating it as unavailable.")
                self.missing_optional.add("motor_temperature")
        return {
            "source": "physical",
            "timestamp": time.time() * 1000,
            "hardware": self.hardware,
            "firmware": self.firmware,
            "lifetimeKm": round(word(raw["lifetime"]) * 1.609344, 3),
            "tripKm": round(word(raw["trip"]) * WHEEL_CIRCUMFERENCE_M / 1000, 4),
            "packVoltage": round(voltage, 2),
            "batteryPercent": battery,
            "current": round(word(raw["current"], signed=True) * 0.002, 3),
            "speed": round(abs(word(raw["rpm"], signed=True)) * WHEEL_CIRCUMFERENCE_M * 60 / 1000, 3),
            "mode": MODES.get(mode, f"Unknown ({mode})"),
            "cellVoltages": self.cells.values(time.monotonic()),
            "motorTemperature": motor_temperature,
            "controllerTemperature": temperature[0] if temperature is not None else None,
            "batteryTemperature": battery_temperature[1] if battery_temperature is not None else None,
        }

    async def _poll_cells(self):
        while True:
            self.cells.update(await self.read("cell"), self.firmware, time.monotonic())
            await asyncio.sleep(0.1)

    async def _poll_frames(self, emit):
        while True:
            if not self.client.is_connected:
                raise ProtocolError("BLE connection lost.")
            await emit(await self.snapshot())
            await asyncio.sleep(0.3)

    async def _keep_alive(self):
        while True:
            await asyncio.sleep(KEEPALIVE_INTERVAL)
            await self._touch_session()

    async def stream(self, emit):
        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(self._poll_cells())
            tasks.create_task(self._poll_frames(emit))
            tasks.create_task(self._keep_alive())


async def identity(client):
    values = []
    for name in ("hardware", "firmware"):
        target = characteristic(client, field_uuid(name), "read")
        values.append(word(bytes(await asyncio.wait_for(client.read_gatt_char(target), 5))))
    return tuple(values)
