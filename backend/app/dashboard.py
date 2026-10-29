"""Cost & token dashboard: every run of every tool, with its tokens, cost, provider, model and keys.

GET  /api/dashboard?scope=mine|all   runs, newest first (scope=all: administrators only, every person)
GET  /api/pricing                    live price status and the prices used for the current model
GET  /api/pricing/catalogue?q=       the stored price catalogue (pricing.py), searchable
POST /api/pricing/refresh            fetch the prices again now (administrators)

Nothing new is recorded for this: the runs are read from where the tools already keep them
(reviews table, analyses/<id>.json, QuBot and QuCoder chat messages). Runs saved from this version on also carry the
provider, model, price source and the keys used (your own Nebius key, BYOK)
(token_usage.Options.prices()); older runs show what they stored (model name where known).
Each person sees only their own runs, as everywhere else in QuCoRe.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException

from . import analysis_jobs, database, ownership, pricing, token_usage
from .models import PROVIDER_LABELS

LIMIT = 3000  # runs per source
# analysis job kind -> (solution, mode)
JOB_KINDS = {"sonar": ("QuReview", "QuSonar"), "solid": ("QuReview", "QuSolids"), "flow": ("QuReview", "QuFlow"),
             "uml": ("QuReview", "QuFlow UML"), "quscan": ("QuScan", "QuScan")}
KEY_LABELS = {"byok": "Your keys (BYOK)", "server": "Server keys"}
# Runs saved before the model was recorded with each run's cost (QuBot / QuCoder answers before v18 store tokens and
# cost, but not which model produced them). Shown as such rather than guessed.
NOT_RECORDED = "Not recorded"

router = APIRouter(tags=["dashboard"])


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _row(*, ident, solution, mode, title, workspace, created_at, status, usage, cost, provider="", provider_label="",
         model="", extra_usd=0.0, tavily=None, owner=None) -> dict:
    usage, cost = usage or {}, cost or {}
    rates = cost.get("rates") or {}
    provider = rates.get("provider") or provider or ""
    model = rates.get("model") or model or ""
    keys = rates.get("keys") or ""
    known = _num(cost.get("known_subtotal_usd")) + _num(extra_usd)
    return {
        "id": ident, "solution": solution, "mode": mode, "title": (title or "")[:160], "workspace": workspace or "",
        "created_at": created_at or "", "status": status or "",
        "provider": provider, "provider_label": PROVIDER_LABELS.get(provider) or provider_label or provider or NOT_RECORDED,
        "model": model or NOT_RECORDED, "embedding_model": rates.get("embedding_model") or "",
        "keys": keys, "keys_label": KEY_LABELS.get(keys, "Not recorded"),
        "price_source": pricing.LABELS.get(rates.get("source") or "env", rates.get("source") or "env"),
        "price_key": rates.get("price_key") or "",
        "input_per_million": rates.get("input_per_million"), "output_per_million": rates.get("output_per_million"),
        "input_tokens": int(_num(usage.get("input_tokens"))), "output_tokens": int(_num(usage.get("output_tokens"))),
        "embedding_tokens": int(_num(usage.get("embedding_tokens"))),
        "requests": int(_num(usage.get("requests")) + _num(usage.get("embedding_requests"))),
        "cost_usd": round(known, 6), "cost_complete": bool(cost.get("complete")) if usage else True,
        "input_usd": _num(cost.get("input_usd")), "output_usd": _num(cost.get("output_usd")),
        "embedding_usd": _num(cost.get("embedding_usd")) + _num(extra_usd),
        "tavily_calls": sum(int(_num(v)) for k, v in (tavily or {}).items() if k != "failed") if tavily else 0,
        "owner": owner,
    }


def _owners(db, kind: str, idents: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for start in range(0, len(idents), 500):
        part = idents[start:start + 500]
        if not part:
            continue
        marks = ",".join("?" * len(part))
        for ident, owner in db.execute(f"SELECT id, owner FROM owners WHERE kind=? AND id IN ({marks})", (kind, *part)):
            out[ident] = owner
    return out


def _where(kind: str, column: str, everyone: bool) -> tuple[str, tuple]:
    return ("1=1", ()) if everyone else ownership.sql_filter(kind, column)


def _reviews(db, everyone: bool) -> list[dict]:
    where, params = _where("review", "id", everyone)
    rows = db.execute(f"SELECT id, status, created_at, title, metrics FROM reviews WHERE {where} "
                      f"ORDER BY created_at DESC LIMIT ?", (*params, LIMIT)).fetchall()
    out, missing = [], []
    for r in rows:
        try:
            metrics = json.loads(r[4]) if r[4] else {}
        except ValueError:
            metrics = {}
        item = _row(ident=r[0], solution="QuReview", mode="QuCodRev", title=r[3], workspace="", created_at=r[2],
                    status=r[1], usage=metrics.get("usage"), cost=metrics.get("cost"))
        if item["model"] == NOT_RECORDED and r[1] == "completed":
            missing.append(r[0])
        out.append(item)
    if missing:  # runs saved before the model was recorded with the cost: the report names it
        found = {}
        for start in range(0, len(missing), 200):
            part = missing[start:start + 200]
            marks = ",".join("?" * len(part))
            for ident, report in db.execute(f"SELECT id, report FROM reviews WHERE id IN ({marks})", tuple(part)):
                try:
                    data = json.loads(report) if report else {}
                    found[ident] = (data.get("deployment") or "", data.get("provider") or "", data.get("workspace_name") or "")
                except ValueError:
                    continue
        for item in out:
            if item["id"] in found:
                model, provider, workspace = found[item["id"]]
                item.update(model=model or NOT_RECORDED, workspace=workspace,
                            provider=item["provider"] or provider,
                            provider_label=PROVIDER_LABELS.get(item["provider"] or provider, item["provider_label"]))
    if everyone:
        owners = _owners(db, "review", [i["id"] for i in out])
        for item in out:
            item["owner"] = owners.get(item["id"])
    return out


def _jobs(db, everyone: bool) -> list[dict]:
    analysis_jobs.ensure_ready()
    with analysis_jobs._LOCK:
        jobs = [job for job in analysis_jobs._SNAPSHOTS.values() if job.get("kind") in JOB_KINDS]
    ids = [job["id"] for job in jobs]
    if not everyone:
        mine = ownership.visible("job", ids)
        jobs = [job for job in jobs if job["id"] in mine]
    owners = _owners(db, "job", [job["id"] for job in jobs]) if everyone else {}
    out = []
    for job in sorted(jobs, key=lambda j: j.get("created_at", ""), reverse=True)[:LIMIT]:
        solution, mode = JOB_KINDS[job["kind"]]
        out.append(_row(ident=job["id"], solution=solution, mode=mode, title=job.get("title"),
                        workspace=job.get("workspace_name"), created_at=job.get("created_at"), status=job.get("status"),
                        usage=job.get("usage"), cost=job.get("cost"), provider_label=job.get("provider_label") or "",
                        model=job.get("deployment") or "", tavily=job.get("tavily"), owner=owners.get(job["id"])))
    return out


def _chats(db, everyone: bool, prefix: str, kind: str, solution: str, mode: str) -> list[dict]:
    try:
        where, params = _where(kind, "s.id", everyone)
        rows = db.execute(f"SELECT m.id, m.status, m.created_at, m.data, s.title, s.workspace_name, s.id, m.method "
                          f"FROM {prefix}_messages m JOIN {prefix}_sessions s ON s.id = m.session_id "
                          f"WHERE m.role='assistant' AND {where} ORDER BY m.created_at DESC LIMIT ?",
                          (*params, LIMIT)).fetchall()
    except Exception:  # noqa: BLE001 - the tool was never used: its tables do not exist yet
        return []
    owners = _owners(db, kind, list({r[6] for r in rows})) if everyone else {}
    out = []
    for r in rows:
        try:
            data = json.loads(r[3] or "{}")
        except ValueError:
            data = {}
        metrics = data.get("metrics") or {}
        if not metrics.get("usage"):
            continue  # an answer still streaming, or stopped before any model call
        out.append(_row(ident=r[0], solution=solution, mode=data.get("method_label") or mode if solution == "QuBot" else mode,
                        title=r[4], workspace=r[5], created_at=r[2], status=r[1], usage=metrics.get("usage"),
                        cost=metrics.get("cost"), owner=owners.get(r[6])))
    return out


@router.get("/api/dashboard")
def dashboard(scope: str = "mine"):
    principal = ownership.current()
    everyone = scope == "all"
    if everyone and principal is not None and not principal.admin:
        raise HTTPException(403, "Only administrators can see everyone's usage.")
    db = database.connect(timeout=15)
    try:
        rows = _reviews(db, everyone) + _jobs(db, everyone) \
            + _chats(db, everyone, "qa", "qa_session", "QuBot", "QuBot") \
            + _chats(db, everyone, "qc", "qc_session", "QuCoder", "QuCoder")
    finally:
        db.close()
    rows.sort(key=lambda r: r["created_at"], reverse=True)
    admin = principal is None or principal.admin
    out = {"runs": rows, "admin": admin, "scope": "all" if everyone else "mine", "pricing": _pricing_summary(),
           "signin": principal is not None}
    if admin:  # where these runs were read from (no credentials: host and folder names only)
        from . import file_store
        out["storage"] = {"database": database.describe(), "files": file_store.describe()}
    return out


def _pricing_summary() -> dict:
    try:
        options = token_usage.options()
        current = options.prices()
    except Exception as exc:  # noqa: BLE001 - invalid .env prices are reported, not raised
        current = {"error": str(exc)[:200]}
    current["source_label"] = pricing.LABELS.get(current.get("source") or "env", current.get("source") or "")
    current["provider_label"] = PROVIDER_LABELS.get(current.get("provider") or "", current.get("provider") or "")
    return {**pricing.status(), "current": current}


@router.get("/api/pricing")
def pricing_status():
    return _pricing_summary()


@router.get("/api/pricing/catalogue")
def pricing_catalogue(q: str = "", limit: int = 400):
    return {"models": pricing.catalogue(q[:100], limit)}


@router.post("/api/pricing/refresh")
def pricing_refresh():
    if not ownership.is_admin():
        raise HTTPException(403, "Only administrators can refresh the price catalogue.")
    pricing.refresh(force=True)
    return _pricing_summary()
