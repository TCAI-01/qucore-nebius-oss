"""Reading backend/.env switches.

A process environment variable wins over backend/.env (Docker / hosting variables), so values can be
set either way. The file is re-read only when it changes on disk.
"""
from __future__ import annotations

import os
import threading

from dotenv import dotenv_values

from . import config

_TRUE = {"1", "true", "yes", "on"}
_LOCK = threading.Lock()
_CACHE: dict = {"stamp": None, "values": {}}


def _file_values() -> dict:
    try:
        stamp = config.ENV_FILE.stat().st_mtime_ns
    except OSError:
        stamp = None
    with _LOCK:
        if stamp != _CACHE["stamp"]:
            values = dict(dotenv_values(config.ENV_FILE, interpolate=False)) if stamp is not None else {}
            _CACHE.update(stamp=stamp, values=values)
        return _CACHE["values"]


def setting(key: str, default: str = "") -> str:
    value = os.environ.get(key)
    if value in (None, ""):
        value = _file_values().get(key)
    return default if value in (None, "") else str(value).strip()


def flag(key: str, default: bool = False) -> bool:
    raw = setting(key)
    return default if raw == "" else raw.lower() in _TRUE


def integer(key: str, default: int, low: int, high: int) -> int:
    try:
        return max(low, min(high, int(float(setting(key, str(default))))))
    except ValueError:
        return default
