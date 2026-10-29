"""HTTP routes for code changes (used by Solidify, SonarCute, Code Review and QuCoder).

POST /api/changes/draft             compute a new version in memory (snippets applied, or full content)
POST /api/changes                   save a new version as a change ("commit"); the folder is not touched
GET  /api/changes                   history (optionally for one folder / file)
GET  /api/changes/{id}              one change with its original and new text
PUT  /api/changes/{id}              save an edited new version
POST /api/changes/{id}/replace      write the new version over the file in the folder
POST /api/changes/{id}/revert       restore the original file
GET  /api/changes/{id}/download     the new version as a file
DELETE /api/changes/{id}
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import Field

from . import changes
from .models import StrictModel

router = APIRouter(prefix="/api/changes")


class Snippet(StrictModel):
    before_code: str = Field(default="", max_length=200_000)
    after_code: str = Field(default="", max_length=200_000)
    line_start: int | None = Field(default=None, ge=1, le=10_000_000)
    line_end: int | None = Field(default=None, ge=1, le=10_000_000)


class DraftInput(StrictModel):
    workspace_id: str = Field(min_length=1, max_length=64)
    path: str = Field(min_length=1, max_length=4096)
    edits: list[Snippet] | None = Field(default=None, max_length=200)
    content: str | None = Field(default=None, max_length=changes.MAX_TEXT)
    is_new: bool = False


class SaveInput(StrictModel):
    workspace_id: str = Field(min_length=1, max_length=64)
    path: str = Field(min_length=1, max_length=4096)
    title: str = Field(default="", max_length=200)
    source: str = Field(default="", max_length=80)
    content: str = Field(max_length=changes.MAX_TEXT)
    is_new: bool = False


class UpdateInput(StrictModel):
    content: str = Field(max_length=changes.MAX_TEXT)


class ForceInput(StrictModel):
    force: bool = False


def _guard(action):
    try:
        return action()
    except changes.ChangeError as exc:
        raise HTTPException(409 if exc.conflict else 400, str(exc)) from None


@router.post("/draft")
def draft(value: DraftInput):
    if value.content is None and not value.edits:
        raise HTTPException(400, "Provide the snippets to apply or the full new content.")
    return _guard(lambda: changes.draft(value.workspace_id, value.path, [e.model_dump() for e in value.edits or []],
                                        value.content, value.is_new))


@router.post("", status_code=201)
def save(value: SaveInput):
    return _guard(lambda: changes.save(value.workspace_id, value.path, value.title, value.source, value.content, value.is_new))


@router.get("")
def history(root: str | None = None, path: str | None = None):
    return changes.summaries(root, path)


@router.get("/{ident}")
def get(ident: str):
    return _guard(lambda: changes.get(ident))


@router.put("/{ident}")
def update(ident: str, value: UpdateInput):
    return _guard(lambda: changes.update(ident, value.content))


@router.post("/{ident}/replace")
def replace(ident: str, value: ForceInput):
    return _guard(lambda: changes.replace(ident, value.force))


@router.post("/{ident}/revert")
def revert(ident: str, value: ForceInput):
    return _guard(lambda: changes.revert(ident, value.force))


@router.get("/{ident}/download")
def download(ident: str):
    rec = _guard(lambda: changes.get(ident))
    name = rec["path"].rsplit("/", 1)[-1]
    data = changes.encode(rec["modified"], rec.get("newline", "\n"), False)
    return Response(data, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.delete("/{ident}")
def delete(ident: str):
    return {"deleted": _guard(lambda: changes.delete(ident))}
