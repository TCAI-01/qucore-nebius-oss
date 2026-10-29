"""QuCoRe's database: one local SQLite file, backend/data/qucore.db (QUCORE_DATA_DIR moves the folder).

Modules use the sqlite3 interface directly: connect(), "?" placeholders, `with db:` for one transaction.
"""
from __future__ import annotations

import sqlite3

from . import config


def path():
    return config.DATA / "qucore.db"


def connect(timeout: float = 15, isolation_level: str | None = ""):
    """A sqlite3 connection (close it when done)."""
    config.DATA.mkdir(parents=True, exist_ok=True)
    return sqlite3.connect(path(), timeout=timeout, isolation_level=isolation_level)


def describe() -> str:
    """Where the data lives (for logs and the dashboard)."""
    return f"SQLite ({path()})"
