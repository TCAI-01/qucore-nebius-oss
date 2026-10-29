"""HTTP routes for the QuScan tab.

GET  /api/quscan/credentials                 is a Tavily key saved? (the key itself is never returned)
PUT  /api/quscan/credentials                 save or remove TAVILY_API_KEY in backend/.env
POST /api/quscan/inventory                   dependency files and packages found in an opened folder
POST /api/quscan/jobs                        start a scan (packages, threat briefing, or both)
GET  /api/quscan/jobs, /jobs/{id}            history and one scan (poll while running)
POST /api/quscan/jobs/{id}/stop              stop a running scan
DELETE /api/quscan/jobs/{id}
GET  /api/quscan/jobs/{id}/download/{pdf|xlsx|json}
"""
from __future__ import annotations

import threading
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import Field

from . import analysis_jobs, cancellation, config, limits, llm, qa_index, quscan, token_usage, workspace
from .models import PROVIDER_LABELS, StrictModel
from .quscan_manifest import discover
from .quscan_tavily import api_key

router = APIRouter(prefix="/api/quscan")
SCAN_LOCK = limits.RunSlots("QuScan")  # up to QUCORE_RUNS_PER_FEATURE at once (limits.py)


class TavilyInput(StrictModel):
    api_key: str = Field(default="", max_length=300)
    clear: bool = False


class InventoryInput(StrictModel):
    workspace_id: str = Field(min_length=1, max_length=64)


class ScanOptions(StrictModel):
    mode: Literal["full", "packages", "briefing"] = "full"
    depth: Literal["basic", "advanced"] = "basic"
    time_range: Literal["day", "week", "month", "year"] = "week"
    results: int = Field(default=5, ge=2, le=10)
    opencve: bool = True
    supply_chain: bool = True
    deep_crawl: bool = False
    focus: str = Field(default="", max_length=400)


class ScanInput(StrictModel):
    workspace_id: str | None = Field(default=None, max_length=64)
    packages: list[str] = Field(default_factory=list, max_length=quscan.MAX_SCAN)
    options: ScanOptions = Field(default_factory=ScanOptions)


# ------------------------------------------------------------- credentials ----

def _write_env_key(key: str, value: str | None) -> None:
    """Set or remove one key in backend/.env, keeping every other line and comment (config.write_env_values)."""
    with config.LOCK:
        config.write_env_values({key: value or None})


def _credentials() -> dict:
    key = api_key()
    try:
        import tavily  # noqa: F401
        sdk = True
    except ImportError:
        sdk = False
    return {"has_tavily_api_key": bool(key), "hint": f"{key[:5]}…{key[-4:]}" if len(key) > 12 else ("saved" if key else ""),
            "sdk_installed": sdk}


@router.get("/credentials")
def credentials():
    return _credentials()


@router.put("/credentials")
def save_credentials(value: TavilyInput):
    if value.clear:
        _write_env_key("TAVILY_API_KEY", None)
    elif value.api_key.strip():
        key = value.api_key.strip()
        if any(ch.isspace() for ch in key):
            raise HTTPException(400, "The Tavily API key must not contain spaces.")
        _write_env_key("TAVILY_API_KEY", key)
    return _credentials()


# --------------------------------------------------------------- inventory ----

def _root(workspace_id: str) -> str:
    root, _ = qa_index.workspace_info(workspace_id)
    return root


@router.post("/inventory")
def inventory(value: InventoryInput):
    result = discover(_root(value.workspace_id))
    result["workspace_name"] = workspace.workspace_name(value.workspace_id)
    return result


# -------------------------------------------------------------------- jobs ----

def _job_or_404(ident: str) -> dict:
    try:
        job = analysis_jobs.get(ident)
    except KeyError:
        job = None
    if not job or job.get("kind") != "quscan":
        raise HTTPException(404, "Scan not found.")
    return job


@router.post("/jobs", status_code=202)
def start(value: ScanInput, background: BackgroundTasks):
    if not SCAN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A scan is already running. Wait for it to finish or stop it.")
    try:
        if not api_key():
            raise HTTPException(400, "Add your Tavily API key in Credentials > Tavily web search.")
        settings = config.active_settings()
        if not settings.deployment:
            raise HTTPException(400, f"Choose a model for {PROVIDER_LABELS[settings.provider]} in Credentials.")
        with llm.make_client(settings):
            pass  # configuration validation only
        options = value.options.model_dump()
        root, name, inv = None, "", None
        if value.workspace_id:
            root = _root(value.workspace_id)
            name = workspace.workspace_name(value.workspace_id)
            inv = discover(root)
        elif options["mode"] != "briefing":
            raise HTTPException(400, "Open a folder to scan its packages.")
        keys = []
        if options["mode"] != "briefing":
            known = {p["key"] for p in inv["packages"]}
            keys = [k for k in dict.fromkeys(value.packages) if k in known][:quscan.MAX_SCAN]
            if not keys:
                raise HTTPException(400, "Select at least one package to scan.")
        pricing = token_usage.options()
        job = quscan.new_job(inv, keys, options, name, settings, PROVIDER_LABELS[settings.provider], pricing)
        snapshot = analysis_jobs.save(job)
        cancellation.register(job["id"])
        background.add_task(quscan.run_job, job, settings, pricing, root, SCAN_LOCK)
        return snapshot
    except BaseException:
        SCAN_LOCK.release()
        raise


@router.get("/jobs")
def jobs():
    return analysis_jobs.summaries("quscan")


@router.get("/jobs/{ident}")
def job(ident: str):
    return _job_or_404(ident)


@router.post("/jobs/{ident}/stop", status_code=202)
def stop(ident: str):
    current = _job_or_404(ident)
    if current["status"] not in ("queued", "running"):
        return {"id": ident, "status": current["status"]}
    if not cancellation.stop(ident):
        raise HTTPException(409, "This scan is no longer active in this backend process.")
    return {"id": ident, "status": "stopping"}


@router.delete("/jobs/{ident}")
def delete(ident: str):
    _job_or_404(ident)
    try:
        return {"deleted": analysis_jobs.delete(ident)}
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@router.get("/jobs/{ident}/download/{kind}")
def download(ident: str, kind: str):
    current = _job_or_404(ident)
    name = f"QuCoRe-quscan-{current['id'][:12]}"
    if kind == "json":
        return JSONResponse(current, headers={"Content-Disposition": f'attachment; filename="{name}.json"'})
    if not current.get("report"):
        raise HTTPException(404, "This scan has no report yet.")
    from .quscan_export import write_pdf, write_xlsx
    if kind == "pdf":
        return Response(write_pdf(current), media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{name}.pdf"'})
    if kind == "xlsx":
        return Response(write_xlsx(current), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": f'attachment; filename="{name}.xlsx"'})
    raise HTTPException(404, "Unknown download format.")
