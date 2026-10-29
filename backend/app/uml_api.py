"""HTTP routes for UML diagrams (generated from Solidify, shown in the Flow tab).

POST /api/uml/jobs               start a diagram (background job)
GET  /api/uml/jobs               history (optionally ?source=<solidify job id>)
GET  /api/uml/jobs/{id}          one diagram (poll while running)
POST /api/uml/jobs/{id}/stop     stop generation
DELETE /api/uml/jobs/{id}
"""
from __future__ import annotations

import threading
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import Field

from . import analysis_jobs, cancellation, config, limits, llm, token_usage, uml, workspace
from .models import PROVIDER_LABELS, StrictModel

router = APIRouter(prefix="/api/uml")
UML_LOCK = limits.RunSlots("UML diagram")  # up to QUCORE_RUNS_PER_FEATURE at once (limits.py)


class UmlInput(StrictModel):
    workspace_id: str = Field(min_length=1, max_length=64)
    files: list[str] = Field(min_length=1, max_length=2000)
    diagram: Literal["class", "sequence", "activity", "state", "usecase", "object"]
    scope: str = Field(default="", max_length=600)
    source: str = Field(default="", max_length=64)     # the Solidify review this came from


def _job_or_404(ident: str) -> dict:
    try:
        job = analysis_jobs.get(ident)
    except KeyError:
        job = None
    if not job or job.get("kind") != "uml":
        raise HTTPException(404, "Diagram not found.")
    return job


@router.post("/jobs", status_code=202)
def start(value: UmlInput, background: BackgroundTasks):
    if not UML_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A diagram is already being drawn. Wait for it to finish or stop it.")
    try:
        settings = config.active_settings()
        if not settings.deployment:
            raise llm.ReviewError(f"Choose a model for {PROVIDER_LABELS[settings.provider]} in Credentials.")
        with llm.make_client(settings):
            pass  # configuration validation only
        sources = workspace.read_sources(value.workspace_id, value.files)
        pricing = token_usage.options()
        job = uml.new_job(value.diagram, value.scope.strip(), value.source, sources,
                          workspace.workspace_name(value.workspace_id), settings, PROVIDER_LABELS[settings.provider], pricing)
        snapshot = analysis_jobs.save(job)
        cancellation.register(job["id"])
        background.add_task(uml.run_job, job, settings, pricing, sources, UML_LOCK)
        return snapshot
    except BaseException:
        UML_LOCK.release()
        raise


@router.get("/jobs")
def jobs(source: str | None = None):
    items = analysis_jobs.summaries("uml")
    return [i for i in items if i.get("counts", {}).get("source") == source] if source else items


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
        raise HTTPException(409, "This diagram is no longer being drawn in this backend process.")
    return {"id": ident, "status": "stopping"}
