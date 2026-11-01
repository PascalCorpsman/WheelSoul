"""Loopback-only HTTP/WebSocket bridge between the browser and local BLE."""

import asyncio
import logging
from pathlib import Path
import secrets
import sys
import time

from aiohttp import WSMsgType, web
from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError

from .protocol import SERVICE, Session, identity

LOG = logging.getLogger(__name__)


def failure_text(error):
    if isinstance(error, BaseExceptionGroup):
        return "; ".join(failure_text(child) for child in error.exceptions)
    return f"{type(error).__name__}: {error}"


class Controller:
    def __init__(self, demo_only=False):
        self.demo_only = demo_only
        self.devices = {}
        self.scan_lock = asyncio.Lock()
        self.control_lock = asyncio.Lock()
        self.clients = set()
        self.task = None
        self.latest = None
        self.state = {
            "type": "state", "status": "offline",
            "boardId": None, "boardName": None, "error": None,
        }

    async def broadcast(self, event):
        for socket in tuple(self.clients):
            if socket.closed:
                continue
            try:
                await asyncio.wait_for(socket.send_json(event), 3)
            except (ConnectionError, TimeoutError) as error:
                LOG.warning("Browser event connection failed: %s", error)
                await socket.close()

    async def set_state(self, status, board_id=None, board_name=None, error=None):
        self.state = {
            "type": "state", "status": status,
            "boardId": board_id, "boardName": board_name, "error": error,
        }
        await self.broadcast(self.state)

    async def scan(self):
        if self.demo_only:
            raise web.HTTPServiceUnavailable(text="Live BLE is disabled by --demo-only.")
        async with self.scan_lock:
            discovered = await BleakScanner.discover(timeout=8, return_adv=True)
            found = []
            for device, advertisement in discovered.values():
                name = advertisement.local_name or device.name or ""
                if SERVICE not in advertisement.service_uuids:
                    continue
                self.devices[device.address] = (device, name or "Onewheel", time.monotonic())
                found.append({
                    "id": device.address, "advertisedName": name or "Onewheel",
                    "rssi": advertisement.rssi,
                })
            return found

    async def connect(self, board_id):
        async with self.control_lock:
            if self.demo_only:
                raise web.HTTPServiceUnavailable(text="Live BLE is disabled by --demo-only.")
            if not self.clients:
                raise web.HTTPConflict(text="Open the dashboard event connection before connecting a board.")
            if self.task is not None and not self.task.done():
                raise web.HTTPConflict(text="A board is already connecting or connected. Disconnect it first.")
            found = self.devices.get(board_id)
            if found is None or time.monotonic() - found[2] > 300:
                raise web.HTTPBadRequest(text="Choose a board from a recent BLE scan.")
            device, name, _seen = found
            self.latest = None
            await self.set_state("connecting", board_id, name)
            self.task = asyncio.create_task(self._session(device, name))
            self.task.add_done_callback(self._session_finished)

    @staticmethod
    def _session_finished(task):
        if not task.cancelled():
            error = task.exception()
            if error is not None:
                LOG.error("Unexpected BLE session failure",
                          exc_info=(type(error), error, error.__traceback__))

    async def _session(self, device, name):
        try:
            async with BleakClient(device, timeout=20) as client:
                hardware, firmware = await identity(client)
                session = Session(client, hardware, firmware)
                await session.authenticate()
                await self.set_state("connected", device.address, name)

                async def emit(data):
                    self.latest = {"type": "telemetry", "boardId": device.address, "data": data}
                    await self.broadcast(self.latest)

                await session.stream(emit)
        except asyncio.CancelledError:
            raise
        except (BleakError, TimeoutError, OSError, ValueError, RuntimeError, ExceptionGroup) as error:
            LOG.exception("BLE session failed")
            await self.set_state("error", device.address, name, failure_text(error))
        finally:
            error = sys.exception()
            if error is not None and not isinstance(error, asyncio.CancelledError) and self.state["status"] != "error":
                await self.set_state("error", device.address, name, failure_text(error))
            if self.state["status"] != "error":
                await self.set_state("offline")

    async def disconnect(self):
        async with self.control_lock:
            if self.task is not None:
                if not self.task.done():
                    self.task.cancel()
                    try:
                        await self.task
                    except asyncio.CancelledError:
                        pass
                self.task = None
            await self.set_state("offline")

    async def close(self):
        await self.disconnect()
        for socket in tuple(self.clients):
            await socket.close()


CONTROLLER = web.AppKey("controller", Controller)
TOKEN = web.AppKey("token", str)
DIST = web.AppKey("dist", Path)


@web.middleware
async def local_only(request, handler):
    port = request.transport.get_extra_info("sockname")[1]
    allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
    if request.remote not in ("127.0.0.1", "::1") or request.host not in allowed:
        return web.json_response({"error": "Only local dashboard requests are accepted."}, status=403)
    origin = request.headers.get("Origin")
    if origin is not None and origin != f"http://{request.host}":
        return web.json_response({"error": "Cross-origin requests are not allowed."}, status=403)
    if request.path.startswith("/api/") and request.path != "/api/session":
        supplied = request.query.get("token", "") if request.path == "/api/events" else request.headers.get("X-WheelSoul-Token", "")
        if not supplied.isascii() or not secrets.compare_digest(supplied, request.app[TOKEN]):
            return web.json_response({"error": "Invalid local session token. Reload the dashboard."}, status=403)
    try:
        response = await handler(request)
    except web.HTTPException as error:
        if not request.path.startswith("/api/"):
            raise
        response = web.json_response({"error": error.text}, status=error.status)
    except (BleakError, TimeoutError, OSError) as error:
        LOG.exception("Local BLE request failed")
        response = web.json_response({"error": failure_text(error)}, status=503)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


async def session_info(request):
    return web.json_response({
        "token": request.app[TOKEN],
        "liveBleEnabled": not request.app[CONTROLLER].demo_only,
        "platform": sys.platform,
        "apiVersion": 1,
    })


async def scan(request):
    return web.json_response({"boards": await request.app[CONTROLLER].scan()})


async def connect(request):
    if request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType(text="Send JSON with a board id.")
    try:
        body = await request.json()
    except (ValueError, UnicodeError):
        raise web.HTTPBadRequest(text="Invalid JSON request.") from None
    if not isinstance(body, dict) or set(body) != {"id"} or not isinstance(body["id"], str) or not 0 < len(body["id"]) <= 256:
        raise web.HTTPBadRequest(text="A single non-empty board id is required.")
    await request.app[CONTROLLER].connect(body["id"])
    return web.json_response({"accepted": True}, status=202)


async def disconnect(request):
    await request.app[CONTROLLER].disconnect()
    return web.json_response({"disconnected": True})


async def events(request):
    controller = request.app[CONTROLLER]
    socket = web.WebSocketResponse(heartbeat=20)
    await socket.prepare(request)
    controller.clients.add(socket)
    try:
        await socket.send_json(controller.state)
        if controller.latest is not None:
            await socket.send_json(controller.latest)
        async for message in socket:
            if message.type == WSMsgType.ERROR:
                LOG.warning("Browser WebSocket failed: %s", socket.exception())
            elif message.type in (WSMsgType.TEXT, WSMsgType.BINARY):
                await socket.close(code=1008, message=b"Use the HTTP API for commands.")
    finally:
        controller.clients.discard(socket)
        if not controller.clients:
            await controller.disconnect()
    return socket


async def static(request):
    root = request.app[DIST]
    relative = request.match_info.get("path", "") or "index.html"
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(target)


async def cleanup(app):
    await app[CONTROLLER].close()


def create_app(dist, demo_only=False):
    app = web.Application(middlewares=[local_only], client_max_size=8192)
    app[CONTROLLER] = Controller(demo_only)
    app[TOKEN] = secrets.token_urlsafe(32)
    app[DIST] = Path(dist).resolve()
    app.add_routes([
        web.get("/api/session", session_info),
        web.post("/api/scan", scan),
        web.post("/api/connect", connect),
        web.post("/api/disconnect", disconnect),
        web.get("/api/events", events),
        web.get("/{path:.*}", static),
    ])
    app.on_shutdown.append(cleanup)
    return app
