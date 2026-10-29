"""Small, durable local store; SQLite connections are scoped to each operation."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from contextlib import contextmanager
from uuid import uuid4
from . import database, ownership
from .config import DATA, REPORTS
from .models import PromptInput


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connection():
    db = database.connect(timeout=15)  # backend/data/qucore.db
    db.row_factory = sqlite3.Row
    try:
        with db:
            yield db
    finally:
        db.close()


# The built-in starter prompts. With sign-in on, everyone can read (not edit) these
# when they are unchanged; every other prompt is private to the person who made it,
# and prompts made while sign-in was off belong to the administrator.
SEED_PROMPTS = [
    ("General code review", "Review correctness, maintainability, error handling, and testability. Identify concrete defects and explain their impact and fixes. Recognize good practices supported by the code. Prioritize actionable findings over style preferences."),
    ("Security review", "Review trust boundaries, input validation, authentication, authorization, injection risks, secrets handling, and unsafe file or network access. Explain exploit preconditions and practical mitigations. Do not invent vulnerabilities without evidence."),
    ("Performance & reliability", "Review performance bottlenecks, resource lifecycle, concurrency, failure handling, and scalability. Distinguish measured facts from hypotheses. Identify good reliability practices and propose focused improvements."),
]


def _starter_filter() -> tuple[str, tuple]:
    """SQL condition matching unowned, unedited starter prompts."""
    pairs = " OR ".join("(name=? AND content=?)" for _ in SEED_PROMPTS)
    return (f"(id NOT IN (SELECT id FROM owners WHERE kind='prompt') AND ({pairs}))",
            tuple(v for pair in SEED_PROMPTS for v in pair))


def init_store():
    DATA.mkdir(parents=True, exist_ok=True)
    REPORTS.mkdir(parents=True, exist_ok=True)
    with connection() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, name TEXT NOT NULL,
            content TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, status TEXT NOT NULL,
            stage TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            title TEXT NOT NULL, file_count INTEGER NOT NULL, error TEXT,
            report TEXT);
        """)
        columns = {row["name"] for row in db.execute("PRAGMA table_info(reviews)")}
        if "metrics" not in columns:
            db.execute("ALTER TABLE reviews ADD COLUMN metrics TEXT")
        # A crashed/reloaded process cannot resume its in-memory source snapshot.
        db.execute("UPDATE reviews SET status='failed', stage='Interrupted', error=?, updated_at=? WHERE status IN ('queued','running')",
                   ("Backend restarted during this review. Run it again.", now()))
        # Stable seed IDs; do not recreate deleted prompts on every restart.
        db.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        if not db.execute("SELECT 1 FROM metadata WHERE key='seeded'").fetchone():
            for title, content in SEED_PROMPTS:
                db.execute("INSERT INTO prompts VALUES (?,?,?,?)", (uuid4().hex, title, content, now()))
            db.execute("INSERT INTO metadata VALUES ('seeded','true')")


def list_prompts():
    # With sign-in on: the person's own prompts plus the unchanged starter prompts.
    where, params = ownership.sql_filter("prompt")
    if ownership.current() is not None:
        starter, extra = _starter_filter()
        where, params = f"({where}) OR {starter}", (*params, *extra)
    with connection() as db:
        return [dict(r) for r in db.execute(f"SELECT * FROM prompts WHERE {where} ORDER BY name COLLATE NOCASE", params)]


def get_prompt(prompt_id: str):
    with connection() as db:
        if not ownership.allowed("prompt", prompt_id):
            starter, extra = _starter_filter()  # the unchanged starter prompts are shared
            if not db.execute(f"SELECT 1 FROM prompts WHERE id=? AND {starter}", (prompt_id, *extra)).fetchone():
                return None
        row = db.execute("SELECT * FROM prompts WHERE id=?", (prompt_id,)).fetchone()
        return dict(row) if row else None


def save_prompt(value: PromptInput, prompt_id: str | None = None):
    ident = prompt_id or uuid4().hex
    with connection() as db:
        if prompt_id:
            if not db.execute("SELECT 1 FROM prompts WHERE id=?", (ident,)).fetchone() \
                    or not ownership.can_modify("prompt", ident):
                return None
            db.execute("UPDATE prompts SET name=?,content=?,updated_at=? WHERE id=?", (value.name, value.content, now(), ident))
        else:
            db.execute("INSERT INTO prompts VALUES (?,?,?,?)", (ident, value.name, value.content, now()))
    if not prompt_id:
        ownership.claim("prompt", ident)
    return get_prompt(ident)


def delete_prompt(prompt_id: str):
    if not ownership.can_modify("prompt", prompt_id):
        return False
    with connection() as db:
        deleted = db.execute("DELETE FROM prompts WHERE id=?", (prompt_id,)).rowcount > 0
    if deleted:
        ownership.forget("prompt", prompt_id)
    return deleted


def create_review(ident: str, title: str, count: int):
    with connection() as db:
        db.execute("INSERT INTO reviews (id,status,stage,created_at,updated_at,title,file_count,error,report) VALUES (?,?,?,?,?,?,?,?,?)", (ident, "queued", "Queued", now(), now(), title, count, None, None))
    ownership.claim("review", ident)


def update_review(ident: str, status: str, stage: str, *, error=None, report=None):
    with connection() as db:
        db.execute("UPDATE reviews SET status=?,stage=?,updated_at=?,error=?,report=? WHERE id=?",
                   (status, stage, now(), error, json.dumps(report, ensure_ascii=False) if report else None, ident))


def list_reviews():
    where, params = ownership.sql_filter("review")
    with connection() as db:
        results = [dict(r) for r in db.execute(f"SELECT id,status,stage,created_at,updated_at,title,file_count,error,metrics FROM reviews WHERE {where} ORDER BY created_at DESC LIMIT 100", params)]
        for item in results:
            item["metrics"] = json.loads(item["metrics"]) if item["metrics"] else None
            if item["metrics"]:
                selection = item["metrics"].get("selection", {})
                item["metrics"]["selection"] = {key: selection.get(key) for key in ("file_count", "lines", "batch_count")}
        return results


def get_review(ident: str):
    if not ownership.allowed("review", ident):
        return None
    with connection() as db:
        row = db.execute("SELECT * FROM reviews WHERE id=?", (ident,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["report"] = json.loads(result["report"]) if result["report"] else None
        result["metrics"] = json.loads(result["metrics"]) if result["metrics"] else None
        return result


def update_metrics(ident: str, metrics: dict):
    with connection() as db:
        db.execute("UPDATE reviews SET metrics=?,updated_at=? WHERE id=?",
                   (json.dumps(metrics, ensure_ascii=False), now(), ident))
