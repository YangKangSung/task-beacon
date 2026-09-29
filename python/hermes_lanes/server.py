"""Localhost board server. Reads state.db and never writes it."""

from __future__ import annotations

import json
import mimetypes
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from hermes_lanes.analyze import StoreData, build_board, read_store, waterfall
from hermes_lanes.discover import Store

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class Snapshot:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stamp: tuple | None = None
        self._loaded_at = 0.0
        self.stores: list[StoreData] = []
        self.error: str | None = None

    def get(self, stores: list[Store], *, fresh: bool = False) -> list[StoreData]:
        stamp = _stamp(stores)
        now = time.time()
        with self._lock:
            age = now - self._loaded_at
            stale = fresh or self._stamp is None or age > 20 or (stamp != self._stamp and age > 5)
            if stale:
                loaded: list[StoreData] = []
                try:
                    for store in stores:
                        loaded.append(read_store(store.profile, store.path))
                    self.error = None
                except sqlite3_error() as exc:
                    self.error = str(exc)
                    raise
                self.stores = loaded
                self._stamp = stamp
                self._loaded_at = now
            return self.stores


def sqlite3_error():
    import sqlite3

    return sqlite3.Error


def _stamp(stores: list[Store]) -> tuple:
    parts = []
    for store in stores:
        wal = store.path.with_name(store.path.name + "-wal")
        wal_ns = wal.stat().st_mtime_ns if wal.exists() else 0
        parts.append((store.profile, str(store.path), store.path.stat().st_mtime_ns, wal_ns))
    return tuple(parts)


def _num(qs: dict[str, list[str]], key: str, default: float) -> float:
    raw = qs.get(key, [None])[0]
    if raw is None or raw == "":
        return default
    return float(raw)


class App:
    def __init__(self, home: Path, stores: list[Store]) -> None:
        self.home = home
        self.stores = stores
        self.snapshot = Snapshot()


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args) -> None:
            return

        def _send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send(code, body, "application/json; charset=utf-8")

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)
            try:
                if path == "/api/board":
                    self._board(qs)
                elif path == "/api/session":
                    self._session(qs)
                elif path in {"/", "/index.html"}:
                    self._file(WEB_DIR / "index.html")
                elif path in {"/app.js", "/app.css"}:
                    self._file(WEB_DIR / path.lstrip("/"))
                else:
                    self._json(404, {"error": "not found"})
            except Exception as exc:  # noqa: BLE001 — surface a local read failure to the page
                self._json(500, {"error": str(exc)})

        def _board(self, qs: dict[str, list[str]]) -> None:
            fresh = qs.get("fresh", ["0"])[0] in {"1", "true"}
            stores = app.snapshot.get(app.stores, fresh=fresh)
            now = time.time()
            end = _num(qs, "end", now)
            start = _num(qs, "start", end - 7 * 86400)
            idle = _num(qs, "idle", 120.0)
            if idle < 1:
                idle = 1.0
            if idle > 3600:
                idle = 3600.0
            board = build_board(stores, start, end, idle)
            board["home"] = str(app.home)
            board["generated_at"] = time.time()
            self._json(200, board)

        def _session(self, qs: dict[str, list[str]]) -> None:
            profile = qs.get("profile", [""])[0]
            session_id = qs.get("id", [""])[0]
            idle = _num(qs, "idle", 120.0)
            stores = app.snapshot.get(app.stores)
            for store in stores:
                for session in store.sessions:
                    if session.id == session_id and session.profile == profile:
                        payload = waterfall(store, session_id, idle)
                        if payload is None:
                            break
                        self._json(200, payload)
                        return
            self._json(404, {"error": "session not found"})

        def _file(self, path: Path) -> None:
            if not path.is_file():
                self._json(404, {"error": "missing asset"})
                return
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if path.suffix in {".js", ".css", ".html"}:
                ctype = {
                    ".js": "text/javascript; charset=utf-8",
                    ".css": "text/css; charset=utf-8",
                    ".html": "text/html; charset=utf-8",
                }[path.suffix]
            self._send(200, path.read_bytes(), ctype)

    return Handler


def serve(home: Path, stores: list[Store], port: int, *, open_browser: bool) -> None:
    app = App(home, stores)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    url = f"http://127.0.0.1:{port}/"
    print(f"hermes-lanes  {url}", flush=True)
    print(f"home          {home}", flush=True)
    for store in stores:
        print(f"profile       {store.profile}  {store.path}", flush=True)
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
