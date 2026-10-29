"""HTTP routes for the Code Q&A tab.

POST /api/qa/preview            before-run lines / tokens / cost per method (no network)
POST /api/qa/ask                one answer, streamed as Server-Sent Events
POST /api/qa/stop               stop a streaming answer (terminates the model call)
GET  /api/qa/sessions           chat history
GET  /api/qa/sessions/{id}      one chat with its messages
DELETE /api/qa/sessions/{id}
POST /api/qa/snippet            file content + outline for the reference pop-up
"""
from __future__ import annotations

import asyncio
import json
import queue
import threading
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import Field

from . import config, llm, qa_index, qa_pipeline, qa_store, token_usage, workspace
from .models import PROVIDER_LABELS, StrictModel
from .qa_chunker import language, outline

router = APIRouter(prefix="/api/qa")
_STREAMS: dict[str, threading.Event] = {}
_STREAMS_LOCK = threading.Lock()

Method = Literal["default", "hybrid", "cursor"]


class QAImage(StrictModel):
    name: str = Field(default="", max_length=200)
    media_type: Literal["image/png", "image/jpeg", "image/gif", "image/webp"]
    data: str = Field(min_length=8, max_length=7_000_000)  # base64, about 5 MiB of image


class QAScope(StrictModel):
    workspace_id: str = Field(min_length=1, max_length=64)
    files: list[str] = Field(default_factory=list, max_length=12000)  # empty = entire codebase


class QAPreviewInput(QAScope):
    methods: list[Method] = Field(min_length=1, max_length=3)
    question: str = Field(default="", max_length=20000)
    image_count: int = Field(default=0, ge=0, le=6)
    session_id: str | None = Field(default=None, max_length=64)
    include_history: bool = True


class QAAskInput(QAScope):
    method: Method
    question: str = Field(min_length=1, max_length=20000)
    images: list[QAImage] = Field(default_factory=list, max_length=6)
    session_id: str | None = Field(default=None, max_length=64)
    question_id: str | None = Field(default=None, max_length=64)  # reuse the question for a second method
    include_history: bool = True  # send the previous QUCORE_QA_HISTORY_TURNS answers of this chat with the question


class QAStopInput(StrictModel):
    stream_id: str = Field(min_length=1, max_length=64)


class QASnippetInput(StrictModel):
    workspace_id: str = Field(min_length=1, max_length=64)
    path: str = Field(min_length=1, max_length=4096)


def _scope(workspace_id: str, files: list[str]):
    root, allowed = qa_index.workspace_info(workspace_id)
    paths = sorted(set(files)) if files else sorted(allowed)
    if not paths:
        raise workspace.WorkspaceError("The opened folder has no readable source files.")
    return root, allowed, workspace.read_sources(workspace_id, paths)


@router.post("/preview")
def preview(value: QAPreviewInput):
    settings = config.active_settings()
    pricing = token_usage.options()
    opts = qa_index.options()
    root, allowed, sources = _scope(value.workspace_id, value.files)
    history = (qa_store.history(value.session_id, opts.history_turns)
               if value.session_id and value.include_history else [])
    methods = list(dict.fromkeys(value.methods))
    result = qa_pipeline.estimate(settings, pricing, opts, sources, allowed, qa_index.index_key(root, settings),
                                  value.question, history, value.image_count, methods)
    result["configured"] = bool(settings.deployment)
    return result


def _prepare(value: QAAskInput) -> dict:
    settings = config.active_settings()
    if not settings.deployment:
        raise llm.ReviewError(f"Set the deployment for {PROVIDER_LABELS[settings.provider]} in Credentials.")
    with llm.make_client(settings):
        pass  # configuration validation only, as for reviews
    pricing = token_usage.options()
    opts = qa_index.options()
    root, allowed, sources = _scope(value.workspace_id, value.files)
    name = workspace.workspace_name(value.workspace_id)
    session = qa_store.get_session(value.session_id) if value.session_id else None
    if value.session_id and not session:
        raise HTTPException(404, "Chat not found.")
    if not session:
        session = qa_store.create_session(value.question, root, name)
    images = [image.model_dump() for image in value.images]
    question = None
    if value.question_id:
        question = qa_store.get_message(value.question_id)
        if not question or question["session_id"] != session["id"] or question["role"] != "user":
            raise HTTPException(400, "The question to answer again was not found in this chat.")
    else:
        question = qa_store.add_message(session["id"], "user", value.question, data={
            "images": len(images), "image_names": [image["name"] for image in images],
            "scope": len(value.files) or "all", "file_count": len(sources),
            # The picked files, so reopening this chat restores the same selection.
            "files": sorted(set(value.files))[:5000]})
    history = (qa_store.history(session["id"], opts.history_turns, before_seq=question["seq"])
               if value.include_history else [])
    key = qa_index.index_key(root, settings)
    plan = qa_pipeline.estimate(settings, pricing, opts, sources, allowed, key, value.question, history,
                                len(images), [value.method])["methods"][value.method]
    assistant = qa_store.add_message(session["id"], "assistant", "", value.method, "streaming",
                                     {"method_label": qa_pipeline.METHODS[value.method]})
    return {"settings": settings, "pricing": pricing, "opts": opts, "sources": sources, "allowed": allowed,
            "key": key, "method": value.method, "question": value.question,
            "images": images, "history": history, "session": session, "question_message": question,
            "assistant_message": assistant, "estimate": plan,
            "provider_label": PROVIDER_LABELS[settings.provider]}


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.post("/ask")
async def ask(value: QAAskInput, request: Request):
    ctx = await run_in_threadpool(_prepare, value)
    stream_id = uuid4().hex
    stop = threading.Event()
    with _STREAMS_LOCK:
        _STREAMS[stream_id] = stop
    events: "queue.Queue[tuple[str, object] | None]" = queue.Queue()

    def emit(event, data):
        events.put((event, data))

    def worker():
        try:
            qa_pipeline.run(ctx, emit, stop)
        except BaseException:  # noqa: BLE001 - the stream must always end cleanly
            emit("error", {"message": "Code Q&A stopped unexpectedly."})
        finally:
            with _STREAMS_LOCK:
                _STREAMS.pop(stream_id, None)
            events.put(None)

    emit("meta", {"stream_id": stream_id, "session": ctx["session"], "question_id": ctx["question_message"]["id"],
                  "message_id": ctx["assistant_message"]["id"], "method": ctx["method"],
                  "method_label": qa_pipeline.METHODS[ctx["method"]], "estimate": ctx["estimate"],
                  "deployment": ctx["settings"].deployment, "provider_label": ctx["provider_label"]})
    threading.Thread(target=worker, name=f"qa-{stream_id[:8]}", daemon=True).start()

    async def stream():
        try:
            while True:
                try:
                    item = events.get_nowait()
                except queue.Empty:
                    if await request.is_disconnected():
                        stop.set()  # browser closed or aborted the request
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
def stop_answer(value: QAStopInput):
    with _STREAMS_LOCK:
        event = _STREAMS.get(value.stream_id)
    if event is None:
        return {"stream_id": value.stream_id, "status": "finished"}
    event.set()
    return {"stream_id": value.stream_id, "status": "stopping"}


@router.get("/sessions")
def sessions():
    return qa_store.list_sessions()


@router.get("/sessions/{ident}")
def session(ident: str):
    item = qa_store.get_session(ident)
    if not item:
        raise HTTPException(404, "Chat not found.")
    return {"session": item, "messages": qa_store.messages(ident)}


@router.delete("/sessions/{ident}")
def delete_session(ident: str):
    if not qa_store.delete_session(ident):
        raise HTTPException(404, "Chat not found.")
    return {"deleted": True}


@router.post("/snippet")
def snippet(value: QASnippetInput):
    source = workspace.read_sources(value.workspace_id, [value.path])[0]
    return {"path": source.path, "content": source.text, "lines": source.lines, "language": language(source.path),
            "outline": outline(source.path, source.text)}
