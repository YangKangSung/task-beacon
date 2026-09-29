"""JSON worker for the VS Code extension. One request per stdin line."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from hermes_lanes.analyze import build_board, waterfall
from hermes_lanes.discover import discover
from hermes_lanes.server import Snapshot

_snapshot = Snapshot()


def _idle(raw) -> float:
    try:
        idle = float(raw)
    except (TypeError, ValueError):
        idle = 120.0
    return min(3600.0, max(1.0, idle))


def handle(req: dict) -> dict:
    home_raw = req.get("home") or ""
    home = Path(str(home_raw)).expanduser()
    if not home.is_dir():
        return {"ok": False, "error": f"Hermes home not found: {home}"}
    stores = discover(home)
    if not stores:
        return {"ok": False, "error": f"No state.db under {home}"}
    idle = _idle(req.get("idle"))
    cmd = req.get("cmd") or "board"
    if cmd == "session":
        loaded = _snapshot.get(stores, fresh=False)
        profile = str(req.get("profile") or "")
        session_id = str(req.get("id") or "")
        for store in loaded:
            for session in store.sessions:
                if session.id == session_id and session.profile == profile:
                    return {"ok": True, "session": waterfall(store, session_id, idle)}
        return {"ok": False, "error": "session not found"}
    end = float(req.get("end") or time.time())
    start_raw = req.get("start")
    start = float(start_raw) if start_raw is not None else end - 7 * 86400
    loaded = _snapshot.get(stores, fresh=bool(req.get("fresh")))
    board = build_board(loaded, start, end, idle)
    board["home"] = str(home)
    board["generated_at"] = time.time()
    return {"ok": True, "board": board}


def serve() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        req = {}
        try:
            parsed = json.loads(text)
            if not isinstance(parsed, dict):
                raise ValueError("request must be an object")
            req = parsed
            resp = handle(req)
        except Exception as exc:  # noqa: BLE001 — the editor shows this string
            resp = {"ok": False, "error": str(exc)}
        if "id" in req:
            resp["id"] = req["id"]
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["serve"]:
        serve()
        return 0
    print("usage: python -m hermes_lanes.export serve", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
