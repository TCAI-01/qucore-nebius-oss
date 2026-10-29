"""Remember each person's last opened codebase and reopen it on their next visit.

Opened workspaces live in memory (workspace.py), so a page refresh or a backend
restart used to mean choosing the folder or GitHub repository again. Now the last
one is stored per person (their user id, or "local" when sign-in is off) in
backend/data/qucore.db, and POST /api/workspaces/restore reopens it:
  - a local folder is rescanned at the same path (if the person may still open
    server folders and the folder still exists);
  - a GitHub repository reuses the person's unpacked copy of the same commit. When that copy was
    deleted after QUCORE_GITHUB_IDLE_MINUTES without use, nothing is downloaded: the reply carries
    the saved repository ({"restored": false, "github": {...}}) so the page fills in the URL and the
    person imports it again. (QUCORE_GITHUB_IDLE_MINUTES='0': downloaded again, as before.)
Restoring is free: it does not count towards the daily allowance.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

from fastapi import APIRouter

from . import config, ownership

_READY = {"done": False}
_LOCK = threading.Lock()


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
    if _READY["done"]:
        return
    with _LOCK:
        if not _READY["done"]:
            with _db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS last_workspaces (holder TEXT PRIMARY KEY, kind TEXT NOT NULL,
                              value TEXT NOT NULL, updated_at TEXT NOT NULL)""")
            _READY["done"] = True


def _holder() -> str:
    return ownership.current_owner() or "local"


def _save(kind: str, value: dict) -> None:
    try:
        _ensure()
        with _db() as db:
            db.execute("INSERT INTO last_workspaces VALUES (?,?,?,?) ON CONFLICT(holder) DO UPDATE SET "
                       "kind=excluded.kind, value=excluded.value, updated_at=excluded.updated_at",
                       (_holder(), kind, json.dumps(value), datetime.now(timezone.utc).isoformat()))
    except sqlite3.Error:
        pass  # remembering is a convenience; never fail the open itself


def remember_local(path: str) -> None:
    _save("local", {"path": path})


def remember_github(owner: str, repo: str, ref: str, sha: str) -> None:
    _save("github", {"owner": owner, "repo": repo, "ref": ref, "sha": sha})


def forget() -> None:
    try:
        _ensure()
        with _db() as db:
            db.execute("DELETE FROM last_workspaces WHERE holder=?", (_holder(),))
    except sqlite3.Error:
        pass


def last() -> tuple[str, dict] | None:
    try:
        _ensure()
        with _db() as db:
            row = db.execute("SELECT kind, value FROM last_workspaces WHERE holder=?", (_holder(),)).fetchone()
        return (row[0], json.loads(row[1])) if row else None
    except (sqlite3.Error, ValueError):
        return None


router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


@router.post("/restore")
def restore():
    """Reopen the person's last codebase, or {"restored": false} when there is nothing to reopen."""
    from . import github_import, workspace  # local imports: no import cycle at start-up
    item = last()
    if not item:
        return {"restored": False}
    kind, value = item
    try:
        if kind == "local":
            result = workspace.open_workspace(str(value.get("path") or ""))
            return {**result, "restored": True}
        if kind == "github" and github_import.import_enabled():
            owner, repo, sha, ref = (str(value.get(k) or "") for k in ("owner", "repo", "sha", "ref"))
            folder = github_import.WORK / ownership.owner_key() / f"{owner}__{repo}__{sha[:12]}" / repo
            if folder.is_dir():  # this person's unpacked copy is still there: no download, no GitHub API call
                result = workspace.open_workspace(str(folder))
                result["name"] = repo
                result["source"] = {"kind": "github", "repo": f"{owner}/{repo}", "ref": ref or sha[:7], "sha": sha,
                                    "url": f"https://github.com/{owner}/{repo}/tree/{sha}", "description": ""}
            elif github_import.idle_minutes() > 0:  # deleted after inactivity: the person pastes the URL again
                return {"restored": False, "expired": True, "idle_minutes": github_import.idle_minutes(),
                        "github": {"repo": f"{owner}/{repo}", "ref": ref, "url": f"https://github.com/{owner}/{repo}"}}
            else:  # cleaned up after QUCORE_GITHUB_CACHE_HOURS: fetch the same commit again
                result = github_import.import_repo(github_import.GithubInput(url=f"{owner}/{repo}", ref=sha))
                if result.get("source"):
                    result["source"]["ref"] = ref or result["source"]["ref"]
                remember_github(owner, repo, ref, sha)  # keep the branch name, not the commit id
            return {**result, "restored": True}
    except workspace.WorkspaceError:
        forget()  # the folder is gone or the repository is no longer available
    return {"restored": False}
