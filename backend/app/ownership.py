"""Who owns what (data-scoping layer).

QuCoRe OSS runs as a local single-user app with no sign-in, so nothing is bound to a request:
every check passes and nothing is claimed. Stores still call `claim()` when they create a record
and `allowed()` / `sql_filter()` / `visible()` when they read, so the scoping stays in one place.

Ownership rows live in their own table in backend/data/qucore.db; the existing
tables and JSON records are not changed.
"""
from __future__ import annotations

import contextvars
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone

from . import config


@dataclass(frozen=True)
class Principal:
    owner: str          # user id
    admin: bool = False
    session: str = ""   # session id (unused in the local app); recorded with each new record
    email: str = ""


_CURRENT: contextvars.ContextVar[Principal | None] = contextvars.ContextVar("qucore_principal", default=None)
_READY = False
_LOCK = threading.Lock()

# Kinds whose unowned records everyone may read. None: records made while sign-in
# was off belong to the administrator. (The built-in starter prompts are shared by
# store.py itself.)
SHARED_KINDS: set[str] = set()


def bind(principal: Principal | None):
    return _CURRENT.set(principal)


def unbind(token) -> None:
    _CURRENT.reset(token)


def current() -> Principal | None:
    return _CURRENT.get()


def current_owner() -> str | None:
    p = _CURRENT.get()
    return p.owner if p else None


def is_admin() -> bool:
    p = _CURRENT.get()
    return p is None or p.admin


@contextmanager
def _db():
    config.DATA.mkdir(parents=True, exist_ok=True)
    from . import database  # backend/data/qucore.db
    db = database.connect(timeout=15)
    try:
        with db:
            yield db
    finally:
        db.close()


def _ensure() -> None:
    global _READY
    if _READY:
        return
    with _LOCK:
        if _READY:
            return
        with _db() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS owners (kind TEXT NOT NULL, id TEXT NOT NULL,
                          owner TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (kind, id))""")
            db.execute("CREATE INDEX IF NOT EXISTS owners_owner ON owners(owner, kind)")
            columns = {row[1] for row in db.execute("PRAGMA table_info(owners)")}
            if "session" not in columns:  # which sign-in session created the record
                db.execute("ALTER TABLE owners ADD COLUMN session TEXT")
        _READY = True


def claim(kind: str, ident: str) -> None:
    """Record the current person as the owner of a new record (no-op when sign-in is off)."""
    p = _CURRENT.get()
    if p is None or not p.owner or not ident:
        return
    _ensure()
    with _db() as db:
        db.execute("INSERT OR IGNORE INTO owners (kind, id, owner, created_at, session) VALUES (?,?,?,?,?)",
                   (kind, ident, p.owner, datetime.now(timezone.utc).isoformat(), p.session or None))


def forget(kind: str, ident: str) -> None:
    if not ident:
        return
    _ensure()
    with _db() as db:
        db.execute("DELETE FROM owners WHERE kind=? AND id=?", (kind, ident))


def owner_of(kind: str, ident: str) -> str | None:
    _ensure()
    with _db() as db:
        row = db.execute("SELECT owner FROM owners WHERE kind=? AND id=?", (kind, ident)).fetchone()
    return row[0] if row else None


def can_see_owner(owner: str | None, kind: str = "") -> bool:
    """Visibility of a record owned by `owner` (None = created while sign-in was off)."""
    p = _CURRENT.get()
    if p is None:
        return True
    if owner is None:
        return p.admin or kind in SHARED_KINDS
    return owner == p.owner


def allowed(kind: str, ident: str) -> bool:
    """May the current person read this record?"""
    if _CURRENT.get() is None:
        return True
    return can_see_owner(owner_of(kind, ident), kind)


def can_modify(kind: str, ident: str) -> bool:
    """Shared, unowned records (seeded prompts) are read-only except for admins."""
    p = _CURRENT.get()
    if p is None:
        return True
    owner = owner_of(kind, ident)
    return owner == p.owner if owner is not None else p.admin


def visible(kind: str, idents) -> set[str]:
    """The subset of `idents` the current person may see."""
    idents = [i for i in idents if i]
    if _CURRENT.get() is None:
        return set(idents)
    _ensure()
    owners: dict[str, str] = {}
    with _db() as db:
        for start in range(0, len(idents), 500):
            part = idents[start:start + 500]
            marks = ",".join("?" * len(part))
            for ident, owner in db.execute(f"SELECT id, owner FROM owners WHERE kind=? AND id IN ({marks})", (kind, *part)):
                owners[ident] = owner
    return {i for i in idents if can_see_owner(owners.get(i), kind)}


def sql_filter(kind: str, column: str = "id") -> tuple[str, tuple]:
    """An SQL condition (and its parameters) limiting `column` to visible records.

    Only for tables inside backend/data/qucore.db, where the owners table lives.
    Returns ("1=1", ()) when sign-in is off.
    """
    p = _CURRENT.get()
    if p is None:
        return "1=1", ()
    _ensure()
    mine = f"{column} IN (SELECT id FROM owners WHERE kind=? AND owner=?)"
    if p.admin or kind in SHARED_KINDS:
        return f"({mine} OR {column} NOT IN (SELECT id FROM owners WHERE kind=?))", (kind, p.owner, kind)
    return mine, (kind, p.owner)


def owner_key(owner: str | None = None) -> str:
    """A filesystem-safe folder name for the current (or given) owner."""
    import hashlib
    value = owner if owner is not None else current_owner()
    if not value:
        return "local"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]
