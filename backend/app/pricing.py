"""Live model prices: the current USD price per million tokens of the Nebius model each run uses.

Source: LiteLLM's public price catalogue (a JSON file on GitHub, refreshed by its maintainers), which
lists Nebius Token Factory prices as nebius/<model> (chat and embedding models). Only the JSON file is
downloaded; the litellm Python package is not used or installed.
  QUCORE_PRICING_LITELLM_URL   default: the raw GitHub file below.

Stored once in the database (table model_prices, backend/data/qucore.db) and reused: the catalogue is
fetched at most every QUCORE_PRICING_REFRESH_HOURS (default 168 = weekly), in the background, when the
backend starts or when a new model is chosen and the stored catalogue is older than that. Every lookup
reads the stored copy; no request waits for the network.

Matching: nebius/<model> first, then the same model name elsewhere in the catalogue (compared without
punctuation). A model that matches nothing keeps the .env prices (NEBIUS_*_COST_PER_MILLION).
QUCORE_LIVE_PRICING='false' turns live prices off (only the .env prices are used).
"""
from __future__ import annotations

import logging
import re
import threading
import time
from decimal import Decimal

from . import database, env

_LOG = logging.getLogger("qucore.pricing")
_LOCK = threading.RLock()
_FETCH_LOCK = threading.Lock()
_STATE: dict = {"rows": None, "loaded": 0.0, "ready": False, "fetching": False, "attempt": 0.0, "errors": {}, "memo": {}}
SOURCE = "litellm"
DEFAULT_URLS = {
    "litellm": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
}
# LiteLLM provider names kept: Nebius Token Factory.
_LITELLM_PROVIDERS = {"nebius"}
_PREFIXES = ("nebius/",)
LABELS = {"litellm": "LiteLLM catalogue", "env": "backend/.env prices"}


# ---------------------------------------------------------------- settings ----

def enabled() -> bool:
    return env.flag("QUCORE_LIVE_PRICING", True)


def sources() -> list[str]:
    return [SOURCE]


def refresh_hours() -> float:
    try:
        return max(1.0, float(env.setting("QUCORE_PRICING_REFRESH_HOURS", "168") or 168))
    except ValueError:
        return 168.0


def _url(source: str) -> str:
    return env.setting(f"QUCORE_PRICING_{source.upper()}_URL", DEFAULT_URLS[source])


# ---------------------------------------------------------------- database ----

def _ensure() -> None:
    if _STATE["ready"]:
        return
    with _LOCK:
        if _STATE["ready"]:
            return
        db = database.connect(timeout=15)
        try:
            with db:
                db.execute("""CREATE TABLE IF NOT EXISTS model_prices (source TEXT NOT NULL, model_key TEXT NOT NULL,
                              provider TEXT, name TEXT, mode TEXT, input_per_million REAL, output_per_million REAL,
                              cached_input_per_million REAL, context TEXT, verified TEXT, fetched_at REAL NOT NULL,
                              PRIMARY KEY (source, model_key))""")
        finally:
            db.close()
        _STATE["ready"] = True


def _rows() -> list[dict]:
    """The stored catalogue (re-read every 10 minutes, so another server's refresh is seen)."""
    with _LOCK:
        if _STATE["rows"] is not None and time.time() - _STATE["loaded"] < 600:
            return _STATE["rows"]
    _ensure()
    db = database.connect(timeout=15)
    try:
        cur = db.execute("SELECT source, model_key, provider, name, mode, input_per_million, output_per_million, "
                         "cached_input_per_million, context, verified, fetched_at FROM model_prices")
        names = ("source", "model_key", "provider", "name", "mode", "input", "output", "cached", "context",
                 "verified", "fetched_at")
        rows = [dict(zip(names, tuple(r))) for r in cur.fetchall()]
    finally:
        db.close()
    with _LOCK:
        _STATE.update(rows=rows, loaded=time.time(), memo={})
        _STATE.pop("index", None)
    return rows


def _replace(source: str, rows: list[tuple]) -> None:
    _ensure()
    now = time.time()
    db = database.connect(timeout=30)
    try:
        with db:
            db.execute("DELETE FROM model_prices WHERE source=?", (source,))
            for start in range(0, len(rows), 150):
                part = rows[start:start + 150]
                marks = ",".join(["(?,?,?,?,?,?,?,?,?,?,?)"] * len(part))
                db.execute("INSERT INTO model_prices (source, model_key, provider, name, mode, input_per_million, "
                           "output_per_million, cached_input_per_million, context, verified, fetched_at) VALUES " + marks,
                           tuple(v for row in part for v in (*row, now)))
    finally:
        db.close()
    with _LOCK:
        _STATE["loaded"] = 0.0  # read the new catalogue on the next lookup


# ------------------------------------------------------------------ fetching ----

def _number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 and number == number and number != float("inf") else None


def _get_json(url: str):
    import httpx
    response = httpx.get(url, timeout=httpx.Timeout(40.0, connect=15.0), follow_redirects=True,
                         headers={"Accept": "application/json",
                                  "User-Agent": "QuCoRe/1.0"})
    response.raise_for_status()
    try:
        return response.json()
    except ValueError:
        kind = response.headers.get("content-type", "?")
        raise ValueError(f"not JSON from {url} (HTTP {response.status_code}, {kind}): {response.text[:120]!r}") from None


def _shape(data) -> str:
    if isinstance(data, dict):
        keys = list(data)[:8]
        first = next((v for v in data.values() if isinstance(v, list) and v), None)
        sample = list(first[0])[:10] if first and isinstance(first[0], dict) else []
        return f"object with keys {keys}" + (f"; first item keys {sample}" if sample else "")
    if isinstance(data, list):
        return f"list of {len(data)}" + (f"; first item keys {list(data[0])[:10]}" if data and isinstance(data[0], dict) else "")
    return type(data).__name__


def _fetch(source: str) -> list[tuple]:
    data = _get_json(_url(source))
    rows: dict[str, tuple] = {}
    for key, m in (data or {}).items():
        if not isinstance(m, dict) or m.get("litellm_provider") not in _LITELLM_PROVIDERS:
            continue
        mode = m.get("mode")
        if mode not in ("chat", "embedding", "responses", "completion"):
            continue
        per_in, per_out = _number(m.get("input_cost_per_token")), _number(m.get("output_cost_per_token"))
        if per_in is None:
            continue
        cached = _number(m.get("cache_read_input_token_cost"))
        rows[key] = (source, key, m.get("litellm_provider"), key.split("/", 1)[-1], "embedding" if mode == "embedding" else "chat",
                     round(per_in * 1e6, 6), round((per_out or 0.0) * 1e6, 6),
                     round(cached * 1e6, 6) if cached is not None else None,
                     str(m.get("max_input_tokens") or ""), "")
    if not rows:
        raise ValueError(f"no prices in the response ({_shape(data)})")
    return list(rows.values())


def refresh(force: bool = False) -> dict:
    """Fetch every source now (one at a time; a failing source keeps its stored prices)."""
    if not _FETCH_LOCK.acquire(blocking=False):
        return status()
    try:
        _STATE["fetching"], _STATE["attempt"] = True, time.time()
        for source in sources():
            if not force and not _stale(source):
                continue
            try:
                rows = _fetch(source)
                _replace(source, rows)
                _STATE["errors"].pop(source, None)
                _LOG.info("Model prices updated from %s: %d models", source, len(rows))
            except Exception as exc:  # noqa: BLE001 - network or format problem: keep the stored prices
                _STATE["errors"][source] = f"{exc.__class__.__name__}: {str(exc)[:400]}"
                _LOG.warning("Model prices from %s not updated: %s: %s", source, exc.__class__.__name__, str(exc)[:400])
    finally:
        _STATE["fetching"] = False
        _FETCH_LOCK.release()
    return status()


def _fetched_at(source: str) -> float:
    return max((r["fetched_at"] for r in _rows() if r["source"] == source), default=0.0)


def _stale(source: str) -> bool:
    return time.time() - _fetched_at(source) > refresh_hours() * 3600


def ensure_fresh() -> None:
    """Refresh in the background when the stored catalogue is older than QUCORE_PRICING_REFRESH_HOURS."""
    if not enabled() or _STATE["fetching"] or time.time() - _STATE["attempt"] < 600:
        return
    try:
        if not any(_stale(s) for s in sources()):
            return
    except Exception:  # noqa: BLE001 - database not reachable yet; try again later
        return
    threading.Thread(target=refresh, name="pricing-refresh", daemon=True).start()


# ------------------------------------------------------------------ lookup ----

def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _index() -> dict:
    with _LOCK:
        if "index" in _STATE and _STATE["rows"] is not None and time.time() - _STATE["loaded"] < 600:
            return _STATE["index"]
    rows = _rows()
    exact, loose = {}, {}
    for row in rows:
        exact.setdefault((row["source"], row["model_key"].lower()), row)
        names = {row["model_key"].split("/", 1)[-1], row["model_key"].rsplit("/", 1)[-1], row["name"]}
        for name in names:
            loose.setdefault((row["source"], _norm(name)), []).append(row)
    index = {"exact": exact, "loose": loose}
    with _LOCK:
        _STATE["index"] = index
    return index


def lookup(provider: str, model: str, embedding: bool = False) -> dict | None:
    """The best stored price for this Nebius model, or None."""
    if not model:
        return None
    memo_key = (provider, model, embedding)
    memo = _STATE["memo"]
    if memo_key in memo and _STATE["rows"] is not None and time.time() - _STATE["loaded"] < 600:
        return memo[memo_key]
    index = _index()
    wanted = "embedding" if embedding else "chat"
    found = None
    for key in (p + model for p in _PREFIXES):  # 1. Nebius's own price: nebius/<model>
        row = index["exact"].get((SOURCE, key.lower()))
        if row and row["mode"] == wanted:
            found = row
            break
    if not found:  # 2. the same model name elsewhere in the catalogue (Nebius entries first)
        for n in (_norm(model), _norm(model.rsplit("/", 1)[-1])):
            rows = [r for r in index["loose"].get((SOURCE, n), []) if r["mode"] == wanted]
            rows.sort(key=lambda r: (not r["model_key"].startswith(_PREFIXES), "/" in r["model_key"]))
            if rows:
                found = rows[0]
                break
    result = None
    if found:
        result = {"source": found["source"], "key": found["model_key"], "provider": found["provider"],
                  "input": found["input"], "output": found["output"], "cached_input": found["cached"],
                  "verified": found["verified"], "fetched_at": found["fetched_at"]}
    memo[memo_key] = result
    return result


def live_rates() -> dict | None:
    """Prices for the model and embedding model of the active settings.

    With QUCORE_LIVE_PRICING='false' the model is still named (for the dashboard) but no price is returned.
    """
    from . import config
    try:
        s = config.read_settings().active()
    except Exception:  # noqa: BLE001 - invalid settings: the .env prices apply
        return None
    if not enabled():
        return {"provider": s.provider, "model": s.deployment or "", "embedding_model": s.embedding_deployment or "",
                "chat": None, "embedding": None}
    try:
        chat = lookup(s.provider, s.deployment or "")
        emb = lookup(s.provider, s.embedding_deployment or "", embedding=True) if s.embedding_deployment else None
    except Exception:  # noqa: BLE001 - database not reachable: the .env prices apply
        return None
    ensure_fresh()
    return {"provider": s.provider, "model": s.deployment or "", "embedding_model": s.embedding_deployment or "",
            "chat": chat, "embedding": emb}


def decimal(value) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(round(float(value), 6)))


# ------------------------------------------------------------------ status ----

def status() -> dict:
    try:
        rows = _rows()
    except Exception as exc:  # noqa: BLE001
        return {"enabled": enabled(), "sources": [], "error": str(exc)[:200]}
    out = []
    for source in sources():
        mine = [r for r in rows if r["source"] == source]
        out.append({"id": source, "label": LABELS[source], "url": _url(source), "models": len(mine),
                    "fetched_at": max((r["fetched_at"] for r in mine), default=None),
                    "error": _STATE["errors"].get(source)})
    return {"enabled": enabled(), "sources": out, "refresh_hours": refresh_hours(), "fetching": _STATE["fetching"]}


def catalogue(query: str = "", limit: int = 400) -> list[dict]:
    q = _norm(query)
    out = []
    for r in _rows():
        if q and q not in _norm(r["model_key"]) and q not in _norm(r["name"]) and q not in _norm(r["provider"] or ""):
            continue
        out.append({"source": r["source"], "key": r["model_key"], "name": r["name"], "provider": r["provider"],
                    "mode": r["mode"], "input": r["input"], "output": r["output"], "cached_input": r["cached"],
                    "context": r["context"], "verified": r["verified"]})
    out.sort(key=lambda r: (r["provider"] or "", r["key"]))
    return out[:max(1, min(2000, limit))]


def on_new_model(provider: str, model: str) -> None:
    """A new model was chosen in Credentials: make sure the stored catalogue can price it.

    Refreshes in the background only when the catalogue is stale, or when it does not know this model and
    was last fetched more than an hour ago, so saving settings never hits the catalogue repeatedly.
    """
    if not enabled() or _STATE["fetching"]:
        return
    try:
        known = lookup(provider, model) is not None
        newest = max((_fetched_at(s) for s in sources()), default=0.0)
    except Exception:  # noqa: BLE001
        return
    if known:
        ensure_fresh()
    elif time.time() - max(newest, _STATE["attempt"]) > 3600:
        threading.Thread(target=refresh, kwargs={"force": True}, name="pricing-refresh", daemon=True).start()


if __name__ == "__main__":  # python -m app.pricing (from backend/): fetch every source now and print the result
    import json as _json
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(_json.dumps(refresh(force=True), indent=2, default=str))
