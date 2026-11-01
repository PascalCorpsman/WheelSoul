import argparse
import logging
from pathlib import Path

from aiohttp import web

from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="WheelSoul local dashboard and BLE server.")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--demo-only", action="store_true", help="Disable live BLE requests.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    dist = Path(__file__).resolve().parents[2] / "dist"
    if not (dist / "index.html").is_file():
        parser.error("Dashboard build missing. Run npm ci and npm run build in the repository root.")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    web.run_app(create_app(dist, args.demo_only), host="127.0.0.1", port=args.port, access_log=None)


if __name__ == "__main__":
    main()
