"""Code Q&A chat history in backend/data/qucore.db (own tables; reviews/prompts untouched).

Image bytes are not stored: a message records how many images were attached.
"""
from __future__ import annotations

import json
import threading
from uuid import uuid4

from . import ownership
from .store import connection, now

_READY = False
_LOCK = threading.Lock()


def _ensure() -> None:
    global _READY
    if _READY:
        return
    with _LOCK:
        if _READY:
            return
        with connection() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS qa_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL,
                workspace_root TEXT NOT NULL, workspace_name TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS qa_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                seq INTEGER NOT NULL, role TEXT NOT NULL, method TEXT, status TEXT NOT NULL,
                content TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS qa_messages_session ON qa_messages(session_id, seq);
            """)
        _READY = True


def create_session(title: str, root: str, name: str) -> dict:
    _ensure()
    ident, stamp = uuid4().hex, now()
    title = " ".join(title.split())[:90] or "New chat"
    with connection() as db:
        db.execute("INSERT INTO qa_sessions VALUES (?,?,?,?,?,?)", (ident, title, root, name, stamp, stamp))
    ownership.claim("qa_session", ident)
    return {"id": ident, "title": title, "workspace_root": root, "workspace_name": name,
            "created_at": stamp, "updated_at": stamp}


def get_session(ident: str) -> dict | None:
    _ensure()
    if not ownership.allowed("qa_session", ident):
        return None
    with connection() as db:
        row = db.execute("SELECT * FROM qa_sessions WHERE id=?", (ident,)).fetchone()
    return dict(row) if row else None


def list_sessions(limit: int = 100) -> list[dict]:
    _ensure()
    where, params = ownership.sql_filter("qa_session", "s.id")
    with connection() as db:
        rows = db.execute(f"""SELECT s.*, (SELECT COUNT(*) FROM qa_messages m WHERE m.session_id=s.id AND m.role='user')
                             AS questions FROM qa_sessions s WHERE {where} ORDER BY updated_at DESC LIMIT ?""", (*params, limit)).fetchall()
    return [dict(r) for r in rows]


def delete_session(ident: str) -> bool:
    _ensure()
    if not ownership.allowed("qa_session", ident):
        return False
    with connection() as db:
        db.execute("DELETE FROM qa_messages WHERE session_id=?", (ident,))
        deleted = db.execute("DELETE FROM qa_sessions WHERE id=?", (ident,)).rowcount > 0
    if deleted:
        ownership.forget("qa_session", ident)
    return deleted


def add_message(session_id: str, role: str, content: str, method: str | None = None,
                status: str = "complete", data: dict | None = None) -> dict:
    _ensure()
    ident, stamp = uuid4().hex, now()
    with connection() as db:
        seq = db.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM qa_messages WHERE session_id=?",
                         (session_id,)).fetchone()[0]
        db.execute("INSERT INTO qa_messages VALUES (?,?,?,?,?,?,?,?,?)",
                   (ident, session_id, seq, role, method, status, content, json.dumps(data or {}), stamp))
        db.execute("UPDATE qa_sessions SET updated_at=? WHERE id=?", (stamp, session_id))
    return {"id": ident, "session_id": session_id, "seq": seq, "role": role, "method": method,
            "status": status, "content": content, "data": data or {}, "created_at": stamp}


def update_message(ident: str, content: str, status: str, data: dict) -> None:
    _ensure()
    with connection() as db:
        db.execute("UPDATE qa_messages SET content=?, status=?, data=? WHERE id=?",
                   (content, status, json.dumps(data), ident))


def get_message(ident: str) -> dict | None:
    _ensure()
    with connection() as db:
        row = db.execute("SELECT * FROM qa_messages WHERE id=?", (ident,)).fetchone()
    return dict(row) if row else None


def messages(session_id: str) -> list[dict]:
    _ensure()
    if not ownership.allowed("qa_session", session_id):
        return []
    with connection() as db:
        rows = db.execute("SELECT * FROM qa_messages WHERE session_id=? ORDER BY seq", (session_id,)).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        try:
            item["data"] = json.loads(item["data"] or "{}")
        except ValueError:
            item["data"] = {}
        out.append(item)
    return out


def history(session_id: str, turns: int, before_seq: int | None = None) -> list[dict]:
    """Last `turns` question/answer pairs before `before_seq` (text only; first completed answer per question)."""
    if turns <= 0:
        return []
    pairs, question, answered = [], None, False
    for item in messages(session_id):
        if before_seq is not None and item["seq"] >= before_seq:
            break
        if item["role"] == "user":
            question, answered = item["content"], False
        elif item["role"] == "assistant" and question is not None and not answered \
                and item["status"] in ("complete", "stopped") and item["content"].strip():
            pairs.append((question, item["content"]))
            answered = True
    out = []
    for q, a in pairs[-turns:]:
        out += [{"role": "user", "text": q}, {"role": "assistant", "text": a}]
    return out
