"""HTTP routes for the QuCoder tab.

POST /api/qucoder/preview       input tokens / cost estimate for the reference files and question
POST /api/qucoder/ask           one answer, streamed as Server-Sent Events (text, then the edits)
POST /api/qucoder/stop          stop a streaming answer (terminates the model call)
GET  /api/qucoder/sessions      chat history; GET/DELETE /api/qucoder/sessions/{id}
"""
from __future__ import annotations

import asyncio
import json
import queue
import threading
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import Field

from . import config, limits, llm, ownership, qa_index, qc_store, qucoder, token_usage, workspace
from .models import PROVIDER_LABELS, StrictModel
from .qa_api import QAImage

router = APIRouter(prefix="/api/qucoder")
_STREAMS: dict[str, threading.Event] = {}
_LOCK = threading.Lock()
# QuCoder answers streaming at once: at least 3, or QUCORE_RUNS_PER_FEATURE if higher (limits.py).
_SLOTS = threading.BoundedSemaphore(max(3, limits.per_feature()))


class QCScope(StrictModel):
    workspace_id: str = Field(min_length=1, max_length=64)
    files: list[str] = Field(default_factory=list, max_length=200)      # reference files


class QCPreview(QCScope):
    question: str = Field(default="", max_length=20000)
    image_count: int = Field(default=0, ge=0, le=6)
    session_id: str | None = Field(default=None, max_length=64)


class QCAsk(QCScope):
    question: str = Field(min_length=1, max_length=20000)
    images: list[QAImage] = Field(default_factory=list, max_length=6)
    session_id: str | None = Field(default=None, max_length=64)
    include_history: bool = True


class QCStop(StrictModel):
    stream_id: str = Field(min_length=1, max_length=64)


def _sources(workspace_id: str, files: list[str]):
    return workspace.read_sources(workspace_id, files) if files else []


@router.post("/preview")
def preview(value: QCPreview):
    settings, pricing = config.active_settings(), token_usage.options()
    root, allowed = qa_index.workspace_info(value.workspace_id)
    sources = _sources(value.workspace_id, value.files)
    history = qc_store.history(value.session_id, qucoder.HISTORY_TURNS) if value.session_id else []
    result = qucoder.estimate(settings, pricing, sources, allowed, workspace.workspace_name(value.workspace_id),
                              value.question, value.image_count, history)
    result["configured"] = bool(settings.deployment)
    return result


def _prepare(value: QCAsk) -> dict:
    settings = config.active_settings()
    if not settings.deployment:
        raise llm.ReviewError(f"Set the model for {PROVIDER_LABELS[settings.provider]} in Credentials.")
    with llm.make_client(settings):
        pass  # configuration validation only
    pricing, opts = token_usage.options(), qa_index.options()
    root, allowed = qa_index.workspace_info(value.workspace_id)
    sources = _sources(value.workspace_id, value.files)
    folder = workspace.workspace_name(value.workspace_id)
    session = qc_store.get_session(value.session_id) if value.session_id else None
    if value.session_id and not session:
        raise HTTPException(404, "Chat not found.")
    if not session:
        session = qc_store.create_session(value.question, root, folder)
    images = [image.model_dump() for image in value.images]
    question = qc_store.add_message(session["id"], "user", value.question, data={
        "images": len(images), "files": [s.path for s in sources]})
    history = qc_store.history(session["id"], qucoder.HISTORY_TURNS, before_seq=question["seq"]) if value.include_history else []
    assistant = qc_store.add_message(session["id"], "assistant", "", "qucoder", "streaming", {})
    return {"settings": settings, "pricing": pricing, "opts": opts, "sources": sources, "allowed": allowed, "root": root,
            "workspace_id": value.workspace_id,
            "folder": folder, "question": value.question, "images": images, "history": history, "session": session,
            "question_message": question, "assistant_message": assistant}


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.post("/ask")
async def ask(value: QCAsk, request: Request):
    if not _SLOTS.acquire(blocking=False):
        raise HTTPException(503, "QuCoder is busy with other requests. Try again shortly.")
    try:
        ctx = await run_in_threadpool(_prepare, value)
    except BaseException:
        _SLOTS.release()
        raise
    stream_id, stop = uuid4().hex, threading.Event()
    with _LOCK:
        _STREAMS[stream_id] = stop
    events: "queue.Queue[tuple[str, object] | None]" = queue.Queue()

    def emit(event, data):
        events.put((event, data))

    principal = ownership.current()  # the changes this answer saves belong to the person who asked

    def worker():
        token = ownership.bind(principal) if principal is not None else None
        try:
            qucoder.run(ctx, emit, stop)
        except BaseException:  # noqa: BLE001 - the stream must always end cleanly
            emit("error", {"message": "QuCoder stopped unexpectedly."})
        finally:
            with _LOCK:
                _STREAMS.pop(stream_id, None)
            _SLOTS.release()
            events.put(None)
            if token is not None:
                ownership.unbind(token)

    emit("meta", {"stream_id": stream_id, "session": ctx["session"], "question_id": ctx["question_message"]["id"],
                  "message_id": ctx["assistant_message"]["id"], "deployment": ctx["settings"].deployment,
                  "provider_label": PROVIDER_LABELS[ctx["settings"].provider]})
    threading.Thread(target=worker, name=f"qucoder-{stream_id[:8]}", daemon=True).start()

    async def stream():
        try:
            while True:
                try:
                    item = events.get_nowait()
                except queue.Empty:
                    if await request.is_disconnected():
                        stop.set()
                        break
                    await asyncio.sleep(0.03)
                    continue
                if item is None:
                    break
                yield _sse(*item)
        finally:
            stop.set()

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"X-Accel-Buffering": "no", "Connection": "keep-alive"})


@router.post("/stop", status_code=202)
def stop_answer(value: QCStop):
    with _LOCK:
        event = _STREAMS.get(value.stream_id)
    if event is None:
        return {"stream_id": value.stream_id, "status": "finished"}
    event.set()
    return {"stream_id": value.stream_id, "status": "stopping"}


@router.get("/sessions")
def sessions():
    return qc_store.list_sessions()


@router.get("/sessions/{ident}")
def session(ident: str):
    item = qc_store.get_session(ident)
    if not item:
        raise HTTPException(404, "Chat not found.")
    return {"session": item, "messages": qc_store.messages(ident)}


@router.delete("/sessions/{ident}")
def delete_session(ident: str):
    if not qc_store.delete_session(ident):
        raise HTTPException(404, "Chat not found.")
    return {"deleted": True}
