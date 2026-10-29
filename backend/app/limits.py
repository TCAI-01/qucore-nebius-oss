"""How many runs may happen at once.

  QUCORE_RUNS_PER_FEATURE  runs of one feature at the same time (default 1)
  QUCORE_MAX_ACTIVE_RUNS   runs of all features together (default 12)
  Each feature's one-at-a-time lock is a `RunSlots`, with the same acquire/release calls as a
  threading.Lock. Runs are threads in ONE server process (do not start uvicorn with several
  workers: open workspaces, live jobs and streams are kept in that process's memory).
"""
from __future__ import annotations

import threading

from fastapi import HTTPException

from . import env


def _int(key: str, default: int, low: int = 0, high: int = 100000) -> int:
    return env.integer(key, default, low, high)


# --------------------------------------------------------------- concurrency ----

_PER_FEATURE = _int("QUCORE_RUNS_PER_FEATURE", 1, 1, 50)
_TOTAL = _int("QUCORE_MAX_ACTIVE_RUNS", 12, 1, 200)
_GLOBAL = threading.BoundedSemaphore(_TOTAL)
_ACTIVE = {"runs": 0}
_ACTIVE_LOCK = threading.Lock()


def per_feature() -> int:
    return _PER_FEATURE


def active_runs() -> int:
    """Runs holding a slot right now (the automatic clean-up waits until this is 0)."""
    with _ACTIVE_LOCK:
        return _ACTIVE["runs"]


def thread_pool_size() -> int:
    """Background runs use the server's worker threads; keep room for ordinary requests."""
    return 40 + 2 * _TOTAL


class RunSlots:
    """Drop-in replacement for a feature's threading.Lock: up to N runs at once."""

    def __init__(self, label: str):
        self.label = label
        self._slots = threading.BoundedSemaphore(_PER_FEATURE)

    def acquire(self, blocking: bool = False) -> bool:
        if not _GLOBAL.acquire(blocking=blocking):
            raise HTTPException(409, f"The server is busy with {_TOTAL} runs right now. Try again in a minute.")
        if not self._slots.acquire(blocking=blocking):
            _GLOBAL.release()
            if _PER_FEATURE == 1:
                raise HTTPException(409, f"Another {self.label} run is in progress. Wait for it to finish.")
            raise HTTPException(409, f"{_PER_FEATURE} {self.label} runs are already in progress. Try again when one finishes.")
        with _ACTIVE_LOCK:
            _ACTIVE["runs"] += 1
        return True

    def release(self) -> None:
        self._slots.release()
        _GLOBAL.release()
        with _ACTIVE_LOCK:
            _ACTIVE["runs"] = max(0, _ACTIVE["runs"] - 1)
