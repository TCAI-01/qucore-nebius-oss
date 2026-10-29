"""Automatic deletion of the files QuCoRe saves locally (QUCORE_AUTO_DELETE).

backend/.env
  QUCORE_AUTO_DELETE='true'       turn it on ('false', the default, keeps everything until you delete it).
  QUCORE_AUTO_DELETE_DAYS='7'     days counted from the first use. When they have passed, everything inside the
                                  sub-folders of backend/data (reports/ PDFs and JSON, analyses/, changes/, qa/,
                                  chroma/ vectors, github/ downloads, ...) is deleted, and the count starts again.

The first use is recorded in backend/data/.first_use when the backend starts. The check runs at start-up and
then every hour, and waits while a run is in progress. backend/data/qucore.db (prompts and the lists of past runs)
and backend/.env are never deleted; runs whose files were removed simply show that their files are gone.
"""
from __future__ import annotations

import json
import logging
import shutil
import threading
import time
from datetime import datetime, timezone

from . import config, env, limits

_LOG = logging.getLogger("qucore.cleanup")
MARKER = ".first_use"
CHECK_SECONDS = 3600
_LOCK = threading.Lock()


def enabled() -> bool:
    return env.flag("QUCORE_AUTO_DELETE", False)


def days() -> int:
    return env.integer("QUCORE_AUTO_DELETE_DAYS", 7, 1, 3650)


def _marker():
    return config.DATA / MARKER


def first_use() -> float:
    """When the current period started (written on first use)."""
    path = _marker()
    try:
        return float(json.loads(path.read_text(encoding="utf-8"))["first_use"])
    except (OSError, ValueError, KeyError, TypeError):
        return _start_period()


def _start_period() -> float:
    now = time.time()
    config.DATA.mkdir(parents=True, exist_ok=True)
    _marker().write_text(json.dumps({"first_use": now, "first_use_utc": datetime.fromtimestamp(now, timezone.utc).isoformat()}),
                         encoding="utf-8")
    return now


def _clear_chroma() -> None:
    """QuBot vectors: drop every collection through ChromaDB itself (its open database file stays valid)."""
    from . import qa_index
    folder = qa_index.options().chroma_dir
    if not folder.exists():
        return
    try:
        client = qa_index._chroma()
        for item in client.list_collections():
            client.delete_collection(getattr(item, "name", item))
    except Exception:  # noqa: BLE001 - ChromaDB not installed or unreadable: leave its folder alone
        _LOG.warning("Auto-delete: the ChromaDB collections could not be removed.")


def purge() -> int:
    """Delete everything inside the sub-folders of backend/data. Returns the number of entries removed."""
    from . import qa_index
    removed = 0
    chroma = qa_index.options().chroma_dir.resolve()
    _clear_chroma()
    for folder in sorted(p for p in config.DATA.iterdir() if p.is_dir()):
        if folder.resolve() == chroma:
            continue  # emptied through ChromaDB above
        for entry in list(folder.iterdir()):
            try:
                if entry.is_dir() and not entry.is_symlink():
                    shutil.rmtree(entry)
                else:
                    entry.unlink()
                removed += 1
            except OSError as exc:
                _LOG.warning("Auto-delete could not remove %s: %s", entry, exc)
    return removed


def check() -> bool:
    """Purge when QUCORE_AUTO_DELETE is on and QUCORE_AUTO_DELETE_DAYS have passed since the first use."""
    with _LOCK:
        started = first_use()
        if not enabled() or time.time() - started < days() * 86400 or limits.active_runs():
            return False
        count = purge()
        _start_period()
        _LOG.info("Auto-delete: %d item(s) removed from %s (every %d day(s) from first use).", count, config.DATA, days())
        return True


def loop() -> None:
    """Background thread started with the backend: check now, then every hour."""
    while True:
        try:
            check()
        except Exception as exc:  # noqa: BLE001 - never stop the loop
            _LOG.warning("Auto-delete check failed: %s", exc)
        time.sleep(CHECK_SECONDS)
