"""Find Hermes state databases without opening them."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Store:
    profile: str
    path: Path


def resolve_home(explicit: Path | None = None) -> Path:
    if explicit is not None:
        return explicit.expanduser().resolve()
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env).expanduser().resolve()
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidate = Path(local) / "hermes"
        if (candidate / "state.db").is_file():
            return candidate
    return (Path.home() / ".hermes").resolve()


def discover(home: Path) -> list[Store]:
    """Default profile lives at ``<home>/state.db``. Named profiles live under ``profiles/``."""
    stores: list[Store] = []
    default_db = home / "state.db"
    if default_db.is_file():
        stores.append(Store(profile="default", path=default_db))
    profiles = home / "profiles"
    if profiles.is_dir():
        for entry in sorted(profiles.iterdir(), key=lambda p: p.name.lower()):
            if not entry.is_dir():
                continue
            db = entry / "state.db"
            if db.is_file():
                stores.append(Store(profile=entry.name, path=db))
    return stores
