"""Build lanes from Hermes message timestamps.

Hermes does not persist a model or tool stopwatch. The durable clock is the
message timestamp: a short gap that ends on a tool result is that tool's time,
a short gap that ends on an assistant message is model time, and a gap longer
than the idle threshold ends one working burst and starts the next.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class SessionRec:
    profile: str
    id: str
    source: str
    model: str
    title: str
    parent_id: str | None
    started_at: float
    ended_at: float | None
    last_activity_at: float | None
    message_count: int
    tool_call_count: int

    @property
    def open(self) -> bool:
        return self.ended_at is None

    def closed_at(self) -> float:
        end = self.ended_at if self.ended_at is not None else self.last_activity_at
        if end is None:
            end = self.started_at
        return max(self.started_at, float(end))


@dataclass(frozen=True)
class MsgRec:
    role: str
    tool_name: str
    timestamp: float


@dataclass
class StoreData:
    profile: str
    path: str
    sessions: list[SessionRec] = field(default_factory=list)
    messages: dict[str, list[MsgRec]] = field(default_factory=dict)
    session_count: int = 0
    message_count: int = 0


def ro_connect(path: Path) -> sqlite3.Connection:
    uri = path.resolve().as_posix()
    con = sqlite3.connect(f"file:{uri}?mode=ro", uri=True, timeout=8)
    con.row_factory = sqlite3.Row
    return con


def _columns(con: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in con.execute(f"PRAGMA table_info({table})")}


def _lane_profile(store_profile: str, row_profile: str | None) -> str:
    name = (row_profile or "").strip()
    if name and name not in {"default", store_profile}:
        return name
    return store_profile or name or "default"


def read_store(store_profile: str, path: Path) -> StoreData:
    data = StoreData(profile=store_profile, path=str(path))
    con = ro_connect(path)
    try:
        tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "sessions" not in tables:
            return data
        scols = _columns(con, "sessions")
        select = ["id", "source", "started_at"]
        for optional in (
            "profile_name",
            "model",
            "title",
            "parent_session_id",
            "ended_at",
            "last_activity_at",
            "message_count",
            "tool_call_count",
        ):
            if optional in scols:
                select.append(optional)
        rows = con.execute(
            f"SELECT {', '.join(select)} FROM sessions"
        ).fetchall()
        for row in rows:
            keys = row.keys()
            parent = row["parent_session_id"] if "parent_session_id" in keys else None
            parent = str(parent).strip() if parent else None
            profile = _lane_profile(
                store_profile,
                row["profile_name"] if "profile_name" in keys else None,
            )
            title = row["title"] if "title" in keys and row["title"] else ""
            title = " ".join(str(title).split())[:180]
            data.sessions.append(
                SessionRec(
                    profile=profile,
                    id=str(row["id"]),
                    source=str(row["source"] or "unknown"),
                    model=str(row["model"] or "") if "model" in keys else "",
                    title=title,
                    parent_id=parent or None,
                    started_at=float(row["started_at"]),
                    ended_at=float(row["ended_at"]) if "ended_at" in keys and row["ended_at"] is not None else None,
                    last_activity_at=(
                        float(row["last_activity_at"])
                        if "last_activity_at" in keys and row["last_activity_at"] is not None
                        else None
                    ),
                    message_count=int(row["message_count"] or 0) if "message_count" in keys else 0,
                    tool_call_count=int(row["tool_call_count"] or 0) if "tool_call_count" in keys else 0,
                )
            )
        data.session_count = len(data.sessions)
        if "messages" not in tables or not data.sessions:
            return data
        mcols = _columns(con, "messages")
        where = ""
        if "active" in mcols and "compacted" in mcols:
            where = "WHERE active = 1 OR compacted = 1"
        tool = "tool_name" if "tool_name" in mcols else "NULL AS tool_name"
        msg_rows = con.execute(
            f"SELECT session_id, role, {tool}, timestamp FROM messages {where} "
            "ORDER BY session_id, timestamp, id"
        ).fetchall()
        bucket: dict[str, list[MsgRec]] = {}
        for row in msg_rows:
            if row["timestamp"] is None:
                continue
            bucket.setdefault(str(row["session_id"]), []).append(
                MsgRec(
                    role=str(row["role"] or ""),
                    tool_name=str(row["tool_name"] or ""),
                    timestamp=float(row["timestamp"]),
                )
            )
        data.messages = bucket
        data.message_count = sum(len(v) for v in bucket.values())
        return data
    finally:
        con.close()


def split_bursts(timestamps: list[float], idle: float) -> list[tuple[float, float, int]]:
    if not timestamps:
        return []
    bursts: list[tuple[float, float, int]] = []
    start = prev = timestamps[0]
    count = 1
    for raw in timestamps[1:]:
        t = raw if raw >= prev else prev
        if t - prev > idle:
            bursts.append((start, prev, count))
            start = t
            count = 1
        else:
            count += 1
        prev = t
    bursts.append((start, prev, count))
    return bursts


def presence(start: float, end: float) -> tuple[float, float]:
    """Give a single timestamp a one-second width so it still counts as concurrent."""
    if end <= start:
        return start, start + 1.0
    return start, end


def _event_key(item: tuple[float, int]) -> tuple[float, int]:
    """Starts share a timestamp with ends. Count the overlap before the end."""
    return (item[0], 0 if item[1] > 0 else 1)


def overlaps(a0: float, a1: float, b0: float, b1: float) -> bool:
    return a0 <= b1 and b0 <= a1


def step_series(
    intervals: list[tuple[float, float]],
    start: float,
    end: float,
    *,
    max_points: int = 480,
) -> list[list[float]]:
    events: list[tuple[float, int]] = []
    for a, b in intervals:
        lo = max(a, start)
        hi = min(b, end)
        if hi < start or lo > end or hi < lo:
            continue
        if hi == lo:
            hi = min(end, lo + 1.0)
        events.append((lo, 1))
        events.append((hi, -1))
    events.sort(key=_event_key)
    points: list[list[float]] = [[start, 0.0]]
    cur = 0
    for t, delta in events:
        if points[-1][0] != t:
            points.append([t, float(cur)])
        cur += delta
        points.append([t, float(cur)])
    if points[-1][0] != end:
        points.append([end, float(cur)])
    return _downsample(points, max_points)


def _downsample(points: list[list[float]], max_points: int) -> list[list[float]]:
    if len(points) <= max_points or max_points < 4:
        return points
    buckets = max_points // 2
    t0 = points[0][0]
    t1 = points[-1][0]
    width = (t1 - t0) / buckets or 1.0
    out: list[list[float]] = []
    index = 0
    for i in range(buckets):
        lo = t0 + i * width
        hi = t0 + (i + 1) * width
        chunk: list[list[float]] = []
        while index < len(points) and points[index][0] < hi:
            if points[index][0] >= lo:
                chunk.append(points[index])
            index += 1
        if not chunk:
            continue
        out.append(chunk[0])
        peak = max(chunk, key=lambda p: p[1])
        if peak is not chunk[0]:
            out.append(peak)
    if out[-1] != points[-1]:
        out.append(points[-1])
    return out


def peak_of(intervals: list[tuple[float, float]], start: float, end: float) -> tuple[int, float | None]:
    events: list[tuple[float, int]] = []
    for a, b in intervals:
        lo = max(a, start)
        hi = min(b, end)
        if hi < start or lo > end or hi < lo:
            continue
        if hi == lo:
            hi = min(end, lo + 1.0)
        events.append((lo, 1))
        events.append((hi, -1))
    events.sort(key=_event_key)
    cur = peak = 0
    at: float | None = None
    for t, delta in events:
        cur += delta
        if cur > peak:
            peak = cur
            at = t
    return peak, at


def _clip_intervals(
    intervals: list[tuple[float, float]], start: float, end: float
) -> list[tuple[float, float]]:
    clipped: list[tuple[float, float]] = []
    for a, b in intervals:
        lo = max(a, start)
        hi = min(b, end)
        if hi >= lo and lo <= end and hi >= start:
            clipped.append((lo, hi))
    return clipped


def session_spans(messages: list[MsgRec], idle: float) -> tuple[list[dict], float]:
    spans: list[dict] = []
    idle_s = 0.0
    for prev, nxt in zip(messages, messages[1:]):
        gap = nxt.timestamp - prev.timestamp
        if gap < 0:
            gap = 0.0
        if gap > idle:
            idle_s += gap
            continue
        if gap == 0:
            continue
        if nxt.role == "tool":
            kind = "tool"
            name = nxt.tool_name or "(unnamed)"
        elif nxt.role == "assistant":
            kind = "model"
            name = "model"
        else:
            kind = "user"
            name = nxt.role or "user"
        spans.append(
            {
                "kind": kind,
                "name": name,
                "start": prev.timestamp,
                "end": nxt.timestamp,
                "duration_s": gap,
            }
        )
    return spans, idle_s


def build_board(
    stores: list[StoreData],
    start: float,
    end: float,
    idle: float,
) -> dict:
    if end < start:
        start, end = end, start
    sessions = [s for store in stores for s in store.sessions]
    by_key = {(s.profile, s.id): s for s in sessions}

    prepared: list[dict] = []
    working: list[tuple[float, float]] = []
    opened: list[tuple[float, float]] = []
    tool_totals: dict[str, list[float]] = {}
    slow: list[dict] = []
    model_s = 0.0
    tool_s = 0.0
    child_intervals: list[tuple[float, float]] = []

    for store in stores:
        for session in store.sessions:
            msgs = store.messages.get(session.id, [])
            bursts = split_bursts([m.timestamp for m in msgs], idle)
            life = (session.started_at, session.closed_at())
            if overlaps(life[0], life[1], start, end):
                opened.append(presence(*life) if life[1] <= life[0] else life)
            burst_iv = [presence(a, b) for a, b, _n in bursts]
            hit = [iv for iv in burst_iv if overlaps(iv[0], iv[1], start, end)]
            if not hit:
                continue
            working.extend(hit)
            if session.parent_id:
                child_intervals.extend(hit)
            active_s = 0.0
            session_model = 0.0
            session_tools: dict[str, list[float]] = {}
            for a, b, _n in bursts:
                if overlaps(a, b, start, end):
                    active_s += max(0.0, min(b, end) - max(a, start))
            for prev, nxt in zip(msgs, msgs[1:]):
                gap = nxt.timestamp - prev.timestamp
                if gap <= 0 or gap > idle:
                    continue
                if nxt.timestamp < start or prev.timestamp > end:
                    continue
                if nxt.role == "tool":
                    name = nxt.tool_name or "(unnamed)"
                    slot = tool_totals.setdefault(name, [0.0, 0.0, 0.0])
                    slot[0] += gap
                    slot[1] += 1
                    tool_s += gap
                    if gap >= slot[2]:
                        slot[2] = gap
                    local = session_tools.setdefault(name, [0.0, 0.0])
                    local[0] += gap
                    local[1] += 1
                    slow.append(
                        {
                            "tool": name,
                            "duration_s": gap,
                            "at": prev.timestamp,
                            "session_id": session.id,
                            "profile": session.profile,
                            "title": session.title or session.id,
                            "source": session.source,
                        }
                    )
                elif nxt.role == "assistant":
                    model_s += gap
                    session_model += gap
            parent_in_view = bool(session.parent_id) and (session.profile, session.parent_id) in by_key
            prepared.append(
                {
                    "profile": session.profile,
                    "id": session.id,
                    "title": session.title,
                    "source": session.source,
                    "model": session.model,
                    "parent_id": session.parent_id,
                    "child": bool(session.parent_id),
                    "nested": parent_in_view,
                    "open": session.open,
                    "started_at": session.started_at,
                    "closed_at": session.closed_at(),
                    "active_s": active_s,
                    "message_count": session.message_count or len(msgs),
                    "tool_call_count": session.tool_call_count,
                    "model_s": session_model,
                    "tools": [
                        {"name": name, "total_s": vals[0], "count": int(vals[1])}
                        for name, vals in sorted(session_tools.items(), key=lambda item: item[1][0], reverse=True)
                    ],
                    "bursts": [[a, b] for a, b, _n in bursts if overlaps(a, max(b, a), start, end)],
                }
            )

    profiles: dict[str, list[dict]] = {}
    for row in prepared:
        profiles.setdefault(row["profile"], []).append(row)

    def sort_key(row: dict) -> float:
        bursts = row["bursts"]
        return bursts[0][0] if bursts else row["started_at"]

    profile_blocks = []
    for name in sorted(profiles):
        rows = profiles[name]
        by_id = {row["id"]: row for row in rows}
        roots = [row for row in rows if not row["parent_id"] or row["parent_id"] not in by_id]
        kids: dict[str, list[dict]] = {}
        for row in rows:
            if row["parent_id"] and row["parent_id"] in by_id:
                kids.setdefault(row["parent_id"], []).append(row)
        roots.sort(key=sort_key)
        for group in kids.values():
            group.sort(key=sort_key)
        ordered: list[dict] = []
        seen: set[str] = set()

        def walk(row: dict) -> None:
            if row["id"] in seen:
                return
            seen.add(row["id"])
            ordered.append(row)
            for child in kids.get(row["id"], []):
                walk(child)

        for root in roots:
            walk(root)
        for row in rows:
            if row["id"] not in seen:
                ordered.append(row)
        p_working = [presence(a, b) for row in rows for a, b in row["bursts"]]
        p_open = [
            (session.started_at, session.closed_at())
            for session in sessions
            if session.profile == name and overlaps(session.started_at, session.closed_at(), start, end)
        ]
        pw, pwa = peak_of(p_working, start, end)
        po, poa = peak_of(p_open, start, end)
        profile_blocks.append(
            {
                "name": name,
                "peak_working": pw,
                "peak_working_at": pwa,
                "peak_open": po,
                "peak_open_at": poa,
                "sessions": ordered,
            }
        )

    work_peak, work_at = peak_of(working, start, end)
    open_peak, open_at = peak_of(opened, start, end)
    child_peak, child_at = peak_of(child_intervals, start, end)
    slow.sort(key=lambda item: item["duration_s"], reverse=True)
    longest = sorted(prepared, key=lambda row: row["active_s"], reverse=True)[:12]
    tools = [
        {"name": name, "total_s": vals[0], "count": int(vals[1]), "max_s": vals[2]}
        for name, vals in tool_totals.items()
    ]
    tools.sort(key=lambda item: item["total_s"], reverse=True)

    t_min = start
    t_max = end
    for store in stores:
        for session in store.sessions:
            t_min = min(t_min, session.started_at)
            t_max = max(t_max, session.closed_at())

    return {
        "window": {"start": start, "end": end},
        "idle_gap_s": idle,
        "range": {"start": t_min, "end": t_max},
        "stores": [
            {
                "profile": store.profile,
                "sessions": store.session_count,
                "messages": store.message_count,
            }
            for store in stores
        ],
        "summary": {
            "sessions_in_window": len(prepared),
            "bursts": sum(len(row["bursts"]) for row in prepared),
            "children": sum(1 for row in prepared if row["child"]),
            "peak_working": work_peak,
            "peak_working_at": work_at,
            "peak_open": open_peak,
            "peak_open_at": open_at,
            "peak_children": child_peak,
            "peak_children_at": child_at,
            "model_s": model_s,
            "tool_s": tool_s,
            "active_s": sum(row["active_s"] for row in prepared),
        },
        "concurrency": {
            "working": step_series(_clip_intervals(working, start, end), start, end),
            "open": step_series(_clip_intervals(opened, start, end), start, end),
        },
        "tools": tools[:18],
        "slow_calls": slow[:15],
        "longest": [
            {
                "profile": row["profile"],
                "session_id": row["id"],
                "title": row["title"] or row["id"],
                "source": row["source"],
                "active_s": row["active_s"],
                "start": row["bursts"][0][0] if row["bursts"] else row["started_at"],
            }
            for row in longest
            if row["active_s"] > 0
        ],
        "profiles": profile_blocks,
    }


def waterfall(store: StoreData, session_id: str, idle: float) -> dict | None:
    session = next((s for s in store.sessions if s.id == session_id), None)
    if session is None:
        return None
    messages = store.messages.get(session_id, [])
    spans, idle_s = session_spans(messages, idle)
    bursts = split_bursts([m.timestamp for m in messages], idle)
    return {
        "profile": session.profile,
        "id": session.id,
        "title": session.title,
        "source": session.source,
        "model": session.model,
        "parent_id": session.parent_id,
        "open": session.open,
        "started_at": session.started_at,
        "closed_at": session.closed_at(),
        "message_count": len(messages),
        "idle_omitted_s": idle_s,
        "bursts": [[a, b, n] for a, b, n in bursts],
        "spans": spans[:800],
        "spans_truncated": len(spans) > 800,
    }
