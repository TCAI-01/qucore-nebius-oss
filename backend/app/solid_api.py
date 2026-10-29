"""HTTP routes for the Solidify tab.

POST /api/solidify/preview                     files / tokens / calls / cost before a review
POST /api/solidify/jobs                        start a design review (runs in the background)
GET  /api/solidify/jobs, /jobs/{id}            history and one review (poll while running)
POST /api/solidify/jobs/{id}/stop              stop a running review
DELETE /api/solidify/jobs/{id}
GET  /api/solidify/jobs/{id}/download/pdf|json
POST /api/solidify/jobs/{id}/findings/{fid}/demo      write a new demonstration ("Write a demo", "New demo")
POST /api/solidify/jobs/{id}/findings/{fid}/demo/fix  rewrite a failed demonstration from its error ("Fix with AI")
POST /api/solidify/sandbox/runs                run a demonstration in the sandbox
GET  /api/solidify/sandbox/runs/{id}           poll status / stdout / stderr
POST /api/solidify/sandbox/runs/{id}/stop
"""
from __future__ import annotations

import json
import threading
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import Field

from . import analysis_jobs, cancellation, config, limits, llm, sandbox, solidify, token_usage, workspace
from .models import PROVIDER_LABELS, StrictModel

router = APIRouter(prefix="/api/solidify")
SOLID_LOCK = limits.RunSlots("QuSolids")  # up to QUCORE_RUNS_PER_FEATURE at once (limits.py)


class SolidInput(StrictModel):
    workspace_id: str = Field(min_length=1, max_length=64)
    files: list[str] = Field(min_length=1, max_length=3000)
    groups: list[str] = Field(default_factory=list, max_length=10)   # empty = every focus area
    notes: str = Field(default="", max_length=2000)
    sandbox: bool = False                                            # ask for runnable demos with dummy data


class SandboxRunInput(StrictModel):
    code: str = Field(min_length=1, max_length=60000)
    runtime: Literal["python", "node"] = "python"   # node: demos of JavaScript / TypeScript findings


def _job_or_404(ident: str) -> dict:
    try:
        job = analysis_jobs.get(ident)
    except KeyError:
        job = None
    if not job or job.get("kind") != "solid":
        raise HTTPException(404, "Review not found.")
    return job


def _prepare(value: SolidInput):
    settings = config.active_settings()
    sources = workspace.read_sources(value.workspace_id, value.files)
    pricing = token_usage.options()
    groups = solidify.normalise_groups(value.groups)
    return settings, sources, pricing, groups, solidify.plan(settings, sources, pricing, groups, value.notes, value.sandbox)


@router.post("/preview")
def preview(value: SolidInput):
    _, _, _, _, info = _prepare(value)
    return {k: v for k, v in info.items() if not k.startswith("_")}


@router.post("/jobs", status_code=202)
def start(value: SolidInput, background: BackgroundTasks):
    if not SOLID_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A design review is already running. Wait for it to finish or stop it.")
    try:
        settings = config.active_settings()
        if not settings.deployment:
            raise llm.ReviewError(f"Choose a model for {PROVIDER_LABELS[settings.provider]} in Credentials.")
        with llm.make_client(settings):
            pass  # configuration validation only, as for reviews
        settings, sources, pricing, groups, info = _prepare(value)
        if not info["can_run"]:
            raise solidify.SolidError("Select at least one eligible source file.")
        job = solidify.new_job(sources, groups, value.notes.strip(), workspace.workspace_name(value.workspace_id),
                               settings, PROVIDER_LABELS[settings.provider], pricing, info)
        snapshot = analysis_jobs.save(job)
        cancellation.register(job["id"])
        background.add_task(solidify.run_job, job, settings, pricing, sources, info, SOLID_LOCK)
        return snapshot
    except solidify.SolidError as exc:
        SOLID_LOCK.release()
        raise HTTPException(400, str(exc)) from None
    except BaseException:
        SOLID_LOCK.release()
        raise


@router.get("/jobs")
def jobs():
    return analysis_jobs.summaries("solid")


@router.get("/jobs/{ident}")
def job(ident: str):
    return _job_or_404(ident)


@router.delete("/jobs/{ident}")
def delete(ident: str):
    _job_or_404(ident)
    try:
        return {"deleted": analysis_jobs.delete(ident)}
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/jobs/{ident}/stop", status_code=202)
def stop(ident: str):
    current = _job_or_404(ident)
    if current["status"] not in ("queued", "running"):
        return {"id": ident, "status": current["status"]}
    if not cancellation.stop(ident):
        raise HTTPException(409, "This review is no longer active in this backend process.")
    return {"id": ident, "status": "stopping"}


@router.get("/jobs/{ident}/download/{kind}")
def download(ident: str, kind: str):
    current = _job_or_404(ident)
    name = f"QuCoRe-solidify-{current['id'][:12]}"
    if kind == "json":
        return JSONResponse(current, headers={"Content-Disposition": f'attachment; filename="{name}.json"'})
    if kind == "pdf":
        if not current.get("report"):
            raise HTTPException(404, "This review has no report yet.")
        from .solid_pdf import write_solid_pdf
        return Response(write_solid_pdf(current), media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{name}.pdf"'})
    raise HTTPException(404, "Unknown download format.")


_DEMO_LOCKS: dict[str, threading.Lock] = {}
_DEMO_GUARD = threading.Lock()


def _demo_lock(ident: str) -> threading.Lock:
    """One demo at a time per review (they save into the same job); different reviews run in parallel."""
    with _DEMO_GUARD:
        return _DEMO_LOCKS.setdefault(ident, threading.Lock())


@router.post("/jobs/{ident}/findings/{finding_id}/demo")
def finding_demo(ident: str, finding_id: str):
    """Write a runnable dummy-data demonstration for one finding (used when the review did not include one)."""
    snapshot = _job_or_404(ident)
    if snapshot["status"] in ("queued", "running"):
        raise HTTPException(409, "Wait for the review to finish.")
    settings = config.active_settings()
    if not settings.deployment:
        raise HTTPException(400, f"Choose a model for {PROVIDER_LABELS[settings.provider]} in Credentials.")
    with _demo_lock(ident):
        snapshot = analysis_jobs.get(ident) or snapshot  # re-read: an earlier demo may have just saved
        job = json.loads(json.dumps(snapshot))  # a private copy; saved back below
        finding = next((f for f in (job.get("report") or {}).get("findings", []) if f["id"] == finding_id), None)
        if finding is None:
            raise HTTPException(404, "Finding not found.")
        pricing = token_usage.options()

        def consume(raw):
            token_usage.add_usage(job["usage"], raw, "llm")
            job["cost"] = token_usage.cost(job["usage"], pricing)

        try:
            # The program is kept in "runnable_python" for every runtime; "demo_runtime" says how it runs.
            finding["runnable_python"] = solidify.generate_demo(settings, pricing, finding, consume)
            finding["demo_runtime"] = solidify.demo_runtime(finding.get("file"))
        except (llm.ReviewError, solidify.SolidError) as exc:
            raise HTTPException(400, str(exc)) from None
        analysis_jobs.save(job)
    return {"id": finding_id, "runnable_python": finding["runnable_python"], "demo_runtime": finding["demo_runtime"],
            "usage": job["usage"], "cost": job["cost"]}


class DemoFixInput(StrictModel):
    code: str = Field(min_length=1, max_length=60000)
    runtime: Literal["python", "node"] = "python"
    stdout: str = Field(default="", max_length=200000)
    stderr: str = Field(default="", max_length=200000)
    error: str = Field(default="", max_length=20000)
    exit_code: int | None = None


@router.post("/jobs/{ident}/findings/{finding_id}/demo/fix")
def finding_demo_fix(ident: str, finding_id: str, value: DemoFixInput):
    """"Fix with AI" in the sandbox panel: rewrite a demonstration that failed, from its code and its error output."""
    snapshot = _job_or_404(ident)
    if snapshot["status"] in ("queued", "running"):
        raise HTTPException(409, "Wait for the review to finish.")
    settings = config.active_settings()
    if not settings.deployment:
        raise HTTPException(400, f"Choose a model for {PROVIDER_LABELS[settings.provider]} in Credentials.")
    with _demo_lock(ident):
        snapshot = analysis_jobs.get(ident) or snapshot
        job = json.loads(json.dumps(snapshot))
        finding = next((f for f in (job.get("report") or {}).get("findings", []) if f["id"] == finding_id), None)
        if finding is None:
            raise HTTPException(404, "Finding not found.")
        pricing = token_usage.options()

        def consume(raw):
            token_usage.add_usage(job["usage"], raw, "llm")
            job["cost"] = token_usage.cost(job["usage"], pricing)

        try:
            finding["runnable_python"] = solidify.fix_demo(settings, pricing, finding, value.code, value.runtime, value.stdout,
                                                           value.stderr, value.error, value.exit_code, consume)
            finding["demo_runtime"] = value.runtime
        except (llm.ReviewError, solidify.SolidError) as exc:
            raise HTTPException(400, str(exc)) from None
        analysis_jobs.save(job)
    return {"id": finding_id, "runnable_python": finding["runnable_python"], "demo_runtime": finding["demo_runtime"],
            "usage": job["usage"], "cost": job["cost"]}


# ------------------------------------------------------------------ sandbox ----

@router.post("/sandbox/runs", status_code=202)
def sandbox_run(value: SandboxRunInput):
    settings = config.tolerant_settings()[0]
    try:
        return sandbox.start(value.code, settings, value.runtime)
    except sandbox.SandboxError as exc:
        raise HTTPException(400, str(exc)) from None


@router.get("/sandbox/runs/{ident}")
def sandbox_get(ident: str):
    run = sandbox.get(ident)
    if run is None:
        raise HTTPException(404, "Sandbox run not found (the backend may have restarted).")
    return run


@router.post("/sandbox/runs/{ident}/stop", status_code=202)
def sandbox_stop(ident: str):
    run = sandbox.stop(ident)
    if run is None:
        raise HTTPException(404, "Sandbox run not found (the backend may have restarted).")
    return run
