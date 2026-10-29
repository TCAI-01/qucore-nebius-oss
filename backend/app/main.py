from __future__ import annotations

import json
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4
from fastapi import BackgroundTasks, Body, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware
from . import cancellation, cleanup, config, limits, llm, store, workspace, review_pipeline, token_usage, workspace_memory
from . import database, file_store  # database: backend/data/qucore.db (SQLite); file_store: backend/data folders
from .models import PROVIDER_LABELS, ModelInput, PromptInput, ReviewInput, WorkspaceInput
from .pdf_report import write_pdf
from .analysis_api import router as analysis_router  # SonarQube fixes + Flow map tabs
from .qa_api import router as qa_router  # Code Q&A tab
from .folder_picker import router as folder_router  # native "Browse" folder dialog
from .solid_api import router as solid_router  # Solidify tab (design review + sandbox)
from .changes_api import router as changes_router  # code changes: draft / save / replace / revert
from .qucoder_api import router as qucoder_router  # QuCoder coding assistant
from .uml_api import router as uml_router  # UML diagrams shown in the Flow tab
from .quscan_api import router as quscan_router  # QuScan: dependency threat intelligence (Tavily)
from .github_import import router as github_router, sweeper as github_sweep  # public GitHub repos as workspaces
from .dashboard import router as dashboard_router  # cost & token dashboard, live model prices
from . import pricing  # live model prices, stored in the database and refreshed in the background

RUN_LOCK = limits.RunSlots("QuCodeRev review")  # up to QUCORE_RUNS_PER_FEATURE at once (limits.py)
OPTIONS = config.server_options()

# uvicorn app.main:app --host 127.0.0.1 --port 8000   (from backend/; see README.md)
@asynccontextmanager
async def lifespan(app: FastAPI):
    import logging
    logging.getLogger("uvicorn.error").info("QuCoRe data: %s; files: %s", database.describe(), file_store.describe())
    store.init_store()
    pricing.ensure_fresh()  # fetches the price catalogue in the background when it is older than the refresh interval
    # Running jobs use the server's worker threads; leave room for ordinary requests.
    import anyio.to_thread
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = max(limiter.total_tokens, limits.thread_pool_size())
    threading.Thread(target=github_sweep, name="github-sweep", daemon=True).start()  # every minute
    threading.Thread(target=cleanup.loop, name="auto-delete", daemon=True).start()  # QUCORE_AUTO_DELETE (hourly)
    yield


app = FastAPI(title="QuCoRe - Quick Code Review (OSS)", version="1.0.0", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=OPTIONS["hosts"])  # QUCORE_ALLOWED_HOSTS
app.add_middleware(CORSMiddleware, allow_origins=OPTIONS["origins"], allow_credentials=False,
                   allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type"])


@app.middleware("http")
async def local_browser_guard(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        # The UI's own address is always allowed (any port or host the server itself is reached on, e.g. a Docker
        # port mapping or http://[::1]:8000); other sites must be listed in QUCORE_ALLOWED_ORIGINS.
        same_origin = origin in (f"http://{request.headers.get('host')}", f"https://{request.headers.get('host')}")
        if (origin and not same_origin and origin not in OPTIONS["origins"]) or request.headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse(status_code=403, content={"detail": "QuCoRe accepts requests from its local UI only."})
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    # FastAPI's default validation response may echo input, including API keys.
    details = [{"field": ".".join(str(v) for v in error["loc"]), "message": error["msg"]} for error in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": details})


@app.exception_handler(ValidationError)
async def config_error(request, exc):
    return JSONResponse(status_code=400, content={"detail": "Invalid backend/.env configuration. Check field values and token budgets."})


@app.exception_handler(workspace.WorkspaceError)
async def workspace_error(request, exc):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(llm.ReviewError)
async def review_error(request, exc):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/api/settings")
def settings():
    return config.public_settings()


@app.put("/api/settings")
def update_settings(value: dict = Body(...)):
    # A plain JSON object: fields are merged into backend/.env and validated there,
    # so a stale or partial form never causes a schema 422 and hand edits survive.
    try:
        result = config.save_settings(value)
    except config.SettingsSaveError as exc:
        raise HTTPException(400, str(exc)) from None
    pricing.on_new_model("nebius", result.get("nebius_model") or "")  # price a newly chosen model (background)
    return result


@app.put("/api/settings/model")
def switch_model(value: ModelInput):
    """Header switch: pick the Nemotron model on Nebius Token Factory (NEBIUS_MODEL)."""
    if not RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A review is running. Switch the model after it finishes.")
    try:
        result = config.set_model(value.model)
    finally:
        RUN_LOCK.release()
    pricing.on_new_model("nebius", value.model)
    return result


def public_report(report):
    """Reports never carry the review prompt's text (older saved reports may)."""
    if isinstance(report, dict) and isinstance(report.get("prompt"), dict):
        report = {**report, "prompt": {k: v for k, v in report["prompt"].items() if k != "content"}}
    return report


@app.get("/api/prompts")
def prompts():
    return store.list_prompts()


@app.post("/api/prompts", status_code=201)
def create_prompt(value: PromptInput):
    return store.save_prompt(value)


@app.put("/api/prompts/{ident}")
def update_prompt(ident: str, value: PromptInput):
    result = store.save_prompt(value, ident)
    if not result:
        raise HTTPException(404, "Prompt not found.")
    return result


@app.delete("/api/prompts/{ident}")
def delete_prompt(ident: str):
    if not store.delete_prompt(ident):
        raise HTTPException(404, "Prompt not found.")
    return {"deleted": True}


@app.post("/api/workspaces")
def open_workspace(value: WorkspaceInput):
    result = workspace.open_workspace(value.path)
    workspace_memory.remember_local(result["root"])  # reopened on this person's next visit
    return result


@app.get("/api/workspaces/{ident}/file")
def read_file(ident: str, path: str):
    source = workspace.read_sources(ident, [path])[0]
    return {"path": source.path, "content": source.text, "lines": source.lines, "sha256": source.sha256}


@app.exception_handler(token_usage.PlanningError)
async def planning_error(request, exc):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.post("/api/reviews/preview")
def preview_review(value: ReviewInput):
    settings = config.active_settings()
    sources = workspace.read_sources(value.workspace_id, value.files)
    prompt = store.get_prompt(value.prompt_id)
    preview_prompt = prompt or {"name": "", "content": ""}
    result = review_pipeline.plan(settings, sources, preview_prompt, token_usage.options()).public
    if not prompt:
        result["can_run"] = False
        result["prompt_required"] = True
    return result


def run_review(ident, settings, sources, batch_plan, prompt, pricing, use_embeddings, workspace_name):
    cancellation.attach(ident)
    stage = "Preparing"
    metrics = {"selection": batch_plan.public, "usage": token_usage.empty_usage(),
               "files_reviewed": 0, "lines_reviewed": 0, "batches_completed": 0}
    def persist_metrics():
        metrics["cost"] = token_usage.cost(metrics["usage"], pricing)
        store.update_metrics(ident, metrics)
    def consume(raw, kind="llm"):
        token_usage.add_usage(metrics["usage"], raw, kind)
        persist_metrics()
    def progress(message):
        nonlocal stage
        cancellation.check()
        stage = message
        store.update_review(ident, "running", message)
    def completed(batch):
        metrics["files_reviewed"] += len(batch.sources)
        metrics["lines_reviewed"] += sum(len(s.text.splitlines()) for s in batch.sources)
        metrics["batches_completed"] += 1
        persist_metrics()
    try:
        cancellation.check()
        persist_metrics()
        embeddings = {"enabled": False}
        order = None
        if use_embeddings:
            progress("Ordering whole-file batches with embeddings")
            ranked, embeddings = llm.rank_sources(settings, sources, prompt, on_usage=lambda raw: consume(raw, "embedding"))
            rank = {source.path: index for index, source in enumerate(ranked)}
            # Keep the preview's file grouping and budget unchanged. Embeddings
            # schedule batches; they do not move files across batch boundaries.
            order = sorted(range(len(batch_plan.batches)), key=lambda i: min(rank[s.path] for s in batch_plan.batches[i].sources))
        result = review_pipeline.execute(settings, batch_plan, prompt, pricing, ident,
                                         progress, consume, completed, order)
        report = {
            **result, "id": ident, "created_at": store.now(), "workspace_name": workspace_name,
            # The prompt's text is deliberately not stored in the report or the PDF.
            "prompt": {key: prompt[key] for key in ("id", "name", "updated_at")},
            "deployment": settings.deployment, "api_style": settings.api_style,
            "provider": settings.provider, "provider_label": PROVIDER_LABELS[settings.provider],
            "selection": batch_plan.public, "metrics": metrics,
            "usage": metrics["usage"], "cost": metrics["cost"], "embeddings": embeddings,
            "files": [{"path": s.path, "lines": len(s.text.splitlines()), "size": s.size, "sha256": s.sha256} for s in sources],
        }
        progress("Formatting PDF report")
        pdf_tmp = config.REPORTS / (ident + ".pdf.tmp")
        json_tmp = config.REPORTS / (ident + ".json.tmp")
        write_pdf(report, pdf_tmp)
        json_tmp.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        # backend/data/reports/<id>.pdf|.json (file_store.py)
        file_store.commit_file(pdf_tmp, config.REPORTS / (ident + ".pdf"))
        file_store.commit_file(json_tmp, config.REPORTS / (ident + ".json"))
        cancellation.check()
        store.update_review(ident, "completed", "Report ready", report=report)
    except cancellation.Cancelled:
        for suffix in (".pdf.tmp", ".json.tmp", ".pdf", ".json"):
            try:
                file_store.delete(config.REPORTS / (ident + suffix))
            except OSError:
                pass
        metrics["failure_note"] = "Stopped by user. Usage excludes tokens not returned by the provider."
        persist_metrics()
        store.update_review(ident, "cancelled", "Stopped", error="Stopped by user. Completed batch results are preserved.")
    except Exception as exc:
        error = str(exc) if isinstance(exc, (llm.ReviewError, token_usage.PlanningError)) else f"Review failed while {stage.lower()}. Check local permissions and configuration."
        for suffix in (".pdf.tmp", ".json.tmp", ".pdf", ".json"):
            try:
                file_store.delete(config.REPORTS / (ident + suffix))
            except OSError:
                pass
        metrics["failure_note"] = "Reported usage may not include failed attempts or SDK retries without usage."
        persist_metrics()
        error += f" Completed batch results, if any, remain in backend/data/reports/{ident}.parts/. A new run starts from the beginning."
        store.update_review(ident, "failed", "Failed", error=error)
    finally:
        cancellation.finish(ident)
        RUN_LOCK.release()


@app.post("/api/reviews", status_code=202)
def start_review(value: ReviewInput, background: BackgroundTasks):
    if not RUN_LOCK.acquire(blocking=False):
        raise HTTPException(409, "A review is already running. Wait for it to finish.")
    try:
        settings = config.active_settings()
        if not settings.deployment:
            raise llm.ReviewError(f"Set the deployment for {PROVIDER_LABELS[settings.provider]} in Settings > Credentials.")
        with llm.make_client(settings):
            pass  # Configuration validation only; no connection test.
        if value.use_embeddings:
            if not settings.embedding_deployment:
                raise llm.ReviewError("Set the Nebius embedding model (NEBIUS_EMBEDDING_MODEL) in Credentials.")
            with llm.make_client(settings, embeddings=True):
                pass
        prompt = store.get_prompt(value.prompt_id)
        if not prompt:
            raise HTTPException(404, "Select an existing saved prompt.")
        sources = workspace.read_sources(value.workspace_id, value.files)
        pricing = token_usage.options()
        batch_plan = review_pipeline.plan(settings, sources, prompt, pricing)
        if batch_plan.public["oversized_files"]:
            names = ", ".join(item["path"] for item in batch_plan.public["oversized_files"][:10])
            raise llm.ReviewError("These files cannot fit individually and will not be split or skipped: " + names + ". Deselect them or use a deployment with sufficient context.")
        if not batch_plan.batches:
            raise llm.ReviewError("Select at least one eligible source file.")
        ident = uuid4().hex
        workspace_name = workspace.workspace_name(value.workspace_id)
        store.create_review(ident, prompt["name"], len(sources))
        metrics = {"selection": batch_plan.public, "usage": token_usage.empty_usage(),
                   "files_reviewed": 0, "lines_reviewed": 0, "batches_completed": 0}
        metrics["cost"] = token_usage.cost(metrics["usage"], pricing)
        store.update_metrics(ident, metrics)
        cancellation.register(ident)
        background.add_task(run_review, ident, settings, sources, batch_plan, prompt, pricing, value.use_embeddings, workspace_name)
        return {"id": ident, "status": "queued", "metrics": metrics}
    except BaseException:
        RUN_LOCK.release()
        raise


@app.get("/api/reviews")
def reviews():
    return store.list_reviews()


@app.get("/api/reviews/{ident}")
def get_review(ident: str):
    result = store.get_review(ident)
    if not result:
        raise HTTPException(404, "Review not found.")
    if result.get("report"):
        result = {**result, "report": public_report(result["report"])}
    return result


@app.post("/api/reviews/{ident}/stop", status_code=202)
def stop_review(ident: str):
    row = store.get_review(ident)
    if not row:
        raise HTTPException(404, "Review not found.")
    if row["status"] not in ("queued", "running"):
        return {"id": ident, "status": row["status"]}
    if not cancellation.stop(ident):
        raise HTTPException(409, "This review is no longer active in this backend process.")
    return {"id": ident, "status": "stopping"}


@app.get("/api/reviews/{ident}/download/{kind}")
def download(ident: str, kind: str):
    if kind not in {"pdf", "json"}:
        raise HTTPException(404, "Unknown report format.")
    row = store.get_review(ident)
    if not row or row["status"] != "completed":
        raise HTTPException(404, "Completed report not found.")
    # Only use the ID obtained from the database, never user path segments.
    path = config.REPORTS / f"{row['id']}.{kind}"
    if not path.is_file():
        raise HTTPException(404, "Report file is missing from disk.")
    if kind == "json":
        # Strip the prompt text from reports saved by earlier versions too.
        data = public_report(json.loads(path.read_text(encoding="utf-8")))
        return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="QuCoRe-{row["id"][:12]}.json"'})
    return FileResponse(path, media_type="application/pdf" if kind == "pdf" else "application/json", filename=f"QuCoRe-{row['id'][:12]}.{kind}")


# SonarQube fixes and Flow map routes. Registered before the static UI mount below.
app.include_router(analysis_router)
# Code Q&A routes (/api/qa/...). Also before the static UI mount.
app.include_router(qa_router)
# Native folder dialog (/api/system/pick-folder).
app.include_router(folder_router)
# Solidify routes (/api/solidify/...).
app.include_router(solid_router)
app.include_router(changes_router)
app.include_router(qucoder_router)
app.include_router(uml_router)
app.include_router(quscan_router)
app.include_router(github_router)  # POST /api/workspaces/github
app.include_router(workspace_memory.router)  # POST /api/workspaces/restore: reopen the last codebase
app.include_router(dashboard_router)  # /api/dashboard, /api/pricing


# `npm run build` enables the single-origin local production UI.
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
