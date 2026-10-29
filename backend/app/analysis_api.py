"""HTTP routes for the two added tabs: SonarQube fixes and Flow map.

Included by app.main with one line (app.include_router). Reuses the existing
settings, workspace, LLM and usage/cost code without changing it.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal
from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import Field
from . import analysis_jobs, cancellation, config, flowmap, limits, llm, sonar, token_usage, workspace
from .models import PROVIDER_LABELS, StrictModel

router = APIRouter(prefix="/api")
# Up to QUCORE_RUNS_PER_FEATURE runs at once (see limits.py); same acquire/release as a lock.
SONAR_LOCK = limits.RunSlots("QuSonar")
FLOW_LOCK = limits.RunSlots("QuFlow")


# ----------------------------------------------------------------- inputs ----

class SonarUploadInput(StrictModel):
    filename: str = Field(min_length=1, max_length=255)
    content_base64: str = Field(min_length=4, max_length=36_000_000)


class SonarResolveInput(StrictModel):
    upload_id: str = Field(min_length=1, max_length=64)
    workspace_id: str = Field(min_length=1, max_length=64)


class SonarChoice(StrictModel):
    sonar_path: str = Field(min_length=1, max_length=4096)
    path: str = Field(min_length=1, max_length=4096)


class SonarRunInput(StrictModel):
    upload_id: str = Field(min_length=1, max_length=64)
    workspace_id: str = Field(min_length=1, max_length=64)
    files: list[SonarChoice] = Field(min_length=1, max_length=5000)
    severities: list[str] = Field(default_factory=list, max_length=50)
    types: list[str] = Field(default_factory=list, max_length=50)


class SonarRetryInput(StrictModel):
    workspace_id: str = Field(min_length=1, max_length=64)


class FlowInput(StrictModel):
    workspace_id: str = Field(min_length=1, max_length=64)
    files: list[str] = Field(min_length=1, max_length=1000)
    detail: Literal["overview", "detailed"] = "overview"
    focus: str = Field(default="", max_length=2000)


# ---------------------------------------------------------------- helpers ----

def _ready_settings():
    settings = config.active_settings()
    if not settings.deployment:
        raise llm.ReviewError(f"Set the deployment for {PROVIDER_LABELS[settings.provider]} in Settings > Credentials.")
    with llm.make_client(settings):
        pass  # configuration validation only, as for reviews
    return settings


def _job_or_404(ident: str, kind: str) -> dict:
    try:
        job = analysis_jobs.get(ident)
    except KeyError:
        job = None
    if not job or job.get("kind") != kind:
        raise HTTPException(404, "Run not found.")
    return job


def _bad_request(exc: Exception):
    raise HTTPException(400, str(exc)) from None


# ------------------------------------------------------------------ sonar ----

@router.post("/sonar/uploads")
def sonar_upload(value: SonarUploadInput):
    try:
        return sonar.parse_upload(value.filename, value.content_base64)
    except sonar.SonarError as exc:
        _bad_request(exc)


@router.post("/sonar/resolve")
def sonar_resolve(value: SonarResolveInput):
    try:
        record = sonar.get_upload(value.upload_id)
    except sonar.SonarError as exc:
        _bad_request(exc)
    allowed = sonar.workspace_files(value.workspace_id)
    return {"files": sonar.resolve(list(sonar.grouped(record).keys()), allowed),
            "workspace_files": sorted(allowed)}


@router.post("/sonar/jobs", status_code=202)
def sonar_start(value: SonarRunInput, background: BackgroundTasks):
    if not SONAR_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A SonarQube analysis is already running. Wait for it to finish.")
    try:
        settings = _ready_settings()
        record = sonar.get_upload(value.upload_id)
        allowed = sonar.workspace_files(value.workspace_id)
        missing = [c.path for c in value.files if c.path not in allowed]
        if missing:
            raise sonar.SonarError("These files are not selectable in the opened folder: " + ", ".join(missing[:5]))
        pricing = token_usage.options()
        job = sonar.new_job(record, [c.model_dump() for c in value.files],
                            {s.strip().upper() for s in value.severities if s.strip()} or None,
                            {t.strip().upper() for t in value.types if t.strip()} or None,
                            workspace.workspace_name(value.workspace_id), settings,
                            PROVIDER_LABELS[settings.provider], pricing)
        snapshot = analysis_jobs.save(job)
        cancellation.register(job["id"])
        background.add_task(sonar.run_job, job, settings, pricing, value.workspace_id, SONAR_LOCK)
        return snapshot
    except sonar.SonarError as exc:
        SONAR_LOCK.release()
        _bad_request(exc)
    except BaseException:
        SONAR_LOCK.release()
        raise


@router.post("/sonar/jobs/{ident}/retry", status_code=202)
def sonar_retry(ident: str, value: SonarRetryInput, background: BackgroundTasks):
    snapshot = _job_or_404(ident, "sonar")
    if snapshot["status"] in ("queued", "running"):
        raise HTTPException(409, "This run is still in progress.")
    if not any(item["status"] != "done" for item in snapshot["items"]):
        raise HTTPException(400, "Every file in this run is already analysed.")
    if not SONAR_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A SonarQube analysis is already running. Wait for it to finish.")
    try:
        settings = _ready_settings()
        allowed = sonar.workspace_files(value.workspace_id)
        job = json.loads(json.dumps(snapshot))  # the worker owns its own copy
        for item in job["items"]:
            if item["status"] != "done":
                if item["path"] not in allowed:
                    raise sonar.SonarError(f"{item['path']} is not in the opened folder. Open the same codebase.")
                item.update(status="pending", error=None)
        pricing = token_usage.options()
        job["counts"]["cancelled"] = 0
        job["counts"]["failed"] = 0
        job.update(status="queued", stage="Queued for retry", error=None,
                   deployment=settings.deployment, provider_label=PROVIDER_LABELS[settings.provider])
        snapshot = analysis_jobs.save(job)
        cancellation.register(job["id"])
        background.add_task(sonar.run_job, job, settings, pricing, value.workspace_id, SONAR_LOCK, True)
        return snapshot
    except sonar.SonarError as exc:
        SONAR_LOCK.release()
        _bad_request(exc)
    except BaseException:
        SONAR_LOCK.release()
        raise


@router.get("/sonar/jobs")
def sonar_jobs():
    return analysis_jobs.summaries("sonar")


@router.get("/sonar/jobs/{ident}")
def sonar_job(ident: str):
    return _job_or_404(ident, "sonar")


@router.delete("/sonar/jobs/{ident}")
def sonar_delete(ident: str):
    _job_or_404(ident, "sonar")
    try:
        return {"deleted": analysis_jobs.delete(ident)}
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@router.get("/sonar/jobs/{ident}/download/{kind}")
def sonar_download(ident: str, kind: str):
    job = _job_or_404(ident, "sonar")
    name = f"QuCoRe-sonar-{job['id'][:12]}"
    if kind == "pdf":
        with TemporaryDirectory(prefix="qucore-sonar-") as folder:
            target = Path(folder) / "report.pdf"
            sonar.write_job_pdf(job, target)
            content = target.read_bytes()
        return Response(content, media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{name}.pdf"'})
    if kind == "md":
        return Response(sonar.job_markdown(job), media_type="text/markdown; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}.md"'})
    if kind == "json":
        return JSONResponse(job, headers={"Content-Disposition": f'attachment; filename="{name}.json"'})
    raise HTTPException(404, "Unknown download format.")


# ------------------------------------------------------------------- flow ----

def _flow_plan(value: FlowInput):
    settings = config.active_settings()
    sources = workspace.read_sources(value.workspace_id, value.files)
    pricing = token_usage.options()
    preview = flowmap.plan(settings, sources, pricing, value.detail, value.focus)
    return settings, sources, pricing, preview


@router.post("/flows/preview")
def flow_preview(value: FlowInput):
    _, _, _, preview = _flow_plan(value)
    return {k: v for k, v in preview.items() if not k.startswith("_")}


@router.post("/flows", status_code=202)
def flow_start(value: FlowInput, background: BackgroundTasks):
    if not FLOW_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A flow map is already being built. Wait for it to finish.")
    try:
        _ready_settings()
        settings, sources, pricing, preview = _flow_plan(value)
        if preview["oversized_files"]:
            names = ", ".join(item["path"] for item in preview["oversized_files"][:5])
            raise flowmap.FlowError("These files are too large for one request and are not split: " + names)
        if not preview["can_run"]:
            raise flowmap.FlowError("Select at least one eligible source file.")
        job = flowmap.new_job(sources, value.detail, value.focus.strip(), workspace.workspace_name(value.workspace_id),
                              settings, PROVIDER_LABELS[settings.provider], pricing, preview)
        snapshot = analysis_jobs.save(job)
        cancellation.register(job["id"])
        background.add_task(flowmap.run_job, job, settings, pricing, sources, preview, FLOW_LOCK)
        return snapshot
    except flowmap.FlowError as exc:
        FLOW_LOCK.release()
        _bad_request(exc)
    except BaseException:
        FLOW_LOCK.release()
        raise


@router.get("/flows")
def flow_jobs():
    return analysis_jobs.summaries("flow")


@router.get("/flows/{ident}")
def flow_job(ident: str):
    return _job_or_404(ident, "flow")


@router.delete("/flows/{ident}")
def flow_delete(ident: str):
    _job_or_404(ident, "flow")
    try:
        return {"deleted": analysis_jobs.delete(ident)}
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


def _stop_job(ident: str, kind: str):
    job = _job_or_404(ident, kind)
    if job["status"] not in ("queued", "running"):
        return {"id": ident, "status": job["status"]}
    if not cancellation.stop(ident):
        raise HTTPException(409, "This run is no longer active in this backend process.")
    return {"id": ident, "status": "stopping"}


@router.post("/sonar/jobs/{ident}/stop", status_code=202)
def sonar_stop(ident: str):
    return _stop_job(ident, "sonar")


@router.post("/flows/{ident}/stop", status_code=202)
def flow_stop(ident: str):
    return _stop_job(ident, "flow")
