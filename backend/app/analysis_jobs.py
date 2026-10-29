"""Durable JSON records for SonarQube-fix and flow-map runs.

Stored in backend/data/analyses/<id>.json (see file_store.py), separate from the review database, so
the existing review store is untouched. The worker thread owns the live job dict;
every save publishes an immutable JSON snapshot that API reads return.
"""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from . import config, file_store, ownership, store

ROOT = config.DATA / "analyses"
_LOCK = threading.RLock()
_SNAPSHOTS: dict[str, dict] = {}
_READY = False
_ID = re.compile(r"^[0-9a-f]{32}$")
_SUMMARY_KEYS = ("id", "kind", "status", "stage", "created_at", "updated_at", "title", "workspace_name",
                 "deployment", "provider_label", "error", "counts", "usage", "cost")


def _path(ident: str) -> Path:
    if not _ID.match(ident or ""):
        raise KeyError(ident)
    return ROOT / f"{ident}.json"


def _write(job: dict) -> dict:
    text = json.dumps(job, ensure_ascii=False, indent=1, default=str)
    file_store.write_text(_path(job["id"]), text)  # local: <id>.json.tmp then renamed, as before
    return json.loads(text)


def ensure_ready() -> None:
    """Load saved runs once; runs interrupted by a restart are marked as such."""
    global _READY
    with _LOCK:
        if _READY:
            return
        file_store.ensure_folder(ROOT)
        for file, text in file_store.read_many(file_store.list_files(ROOT, ".json")):
            try:
                if text is None:
                    continue
                job = json.loads(text)
            except (OSError, ValueError):
                continue
            if not isinstance(job, dict) or not _ID.match(str(job.get("id", ""))):
                continue
            if job.get("status") in ("queued", "running"):
                job["status"] = "failed"
                job["stage"] = "Interrupted"
                job["error"] = "The backend restarted during this run. Completed parts are kept; run the rest again."
                for item in job.get("items", []):
                    if item.get("status") in ("pending", "running"):
                        item["status"] = "failed"
                        item["error"] = "Interrupted by a backend restart."
                job["updated_at"] = store.now()
                try:
                    job = _write(job)
                except OSError:
                    pass
            _SNAPSHOTS[job["id"]] = job
        _READY = True


def save(job: dict) -> dict:
    """Persist the live job and publish a snapshot for readers."""
    ensure_ready()
    job["updated_at"] = store.now()
    with _LOCK:
        if job["id"] not in _SNAPSHOTS:
            ownership.claim("job", job["id"])  # first save happens in the request that started it
        snapshot = _write(job)
        _SNAPSHOTS[job["id"]] = snapshot
        return snapshot


def get(ident: str) -> dict | None:
    ensure_ready()
    if not ownership.allowed("job", ident):
        return None
    with _LOCK:
        return _SNAPSHOTS.get(ident)


def summaries(kind: str, limit: int = 100) -> list[dict]:
    ensure_ready()
    with _LOCK:
        jobs = [job for job in _SNAPSHOTS.values() if job.get("kind") == kind]
    mine = ownership.visible("job", [job["id"] for job in jobs])
    jobs = [job for job in jobs if job["id"] in mine]
    jobs.sort(key=lambda job: job.get("created_at", ""), reverse=True)
    return [{key: job.get(key) for key in _SUMMARY_KEYS} for job in jobs[:limit]]


def delete(ident: str) -> bool:
    ensure_ready()
    if not ownership.allowed("job", ident):
        return False
    with _LOCK:
        job = _SNAPSHOTS.get(ident)
        if not job:
            return False
        if job.get("status") in ("queued", "running"):
            raise ValueError("This run is still in progress.")
        file_store.delete(_path(ident))
        _SNAPSHOTS.pop(ident, None)
    ownership.forget("job", ident)
    return True
