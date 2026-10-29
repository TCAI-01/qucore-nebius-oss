"""Code changes with a small local "commit history".

A change is one proposed new version of one file. The lifecycle is:

  draft     computed in memory (a snippet applied, or full new content); nothing is stored
  saved     stored in backend/data/changes/<id>.json with the original and the new text; the
            file in the opened folder is NOT touched
  replaced  the new text was written over the file in the opened folder
  reverted  the original bytes were written back (or a created file was removed)

Replace and Revert refuse to overwrite a file that changed on disk since (unless forced),
only write inside the opened folder, and never touch secrets, binaries or ignored folders.
The original file is kept byte for byte, so Revert restores it exactly.
"""
from __future__ import annotations

import base64
import difflib
import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path, PurePosixPath
from uuid import uuid4

from . import config, file_store, ownership, store, workspace

ROOT = config.DATA / "changes"
MAX_TEXT = 2_000_000
_LOCK = threading.RLock()
_INDEX: dict[str, dict] = {}
_READY = False
_ID = re.compile(r"^[0-9a-f]{32}$")
SUMMARY_KEYS = ("id", "path", "title", "source", "status", "is_new", "stats", "created_at", "updated_at",
                "workspace_root", "workspace_name", "events")


class ChangeError(ValueError):
    def __init__(self, message: str, conflict: bool = False):
        super().__init__(message)
        self.conflict = conflict


# ------------------------------------------------------------------ files ----

def workspace_root(workspace_id: str) -> tuple[Path, str]:
    with workspace._lock:
        item = workspace._workspaces.get(workspace_id)
    if not item:
        raise ChangeError("Workspace expired or backend restarted. Open the folder again.")
    return item.root, item.root.name


def safe_path(root: Path, rel: str) -> Path:
    """The absolute path for a folder-relative file, or ChangeError. The file need not exist yet."""
    value = str(rel or "").replace("\\", "/").strip()
    pure = PurePosixPath(value)
    if not value or pure.is_absolute() or ".." in pure.parts or any(part in ("", ".") for part in pure.parts) \
            or re.match(r"^[A-Za-z]:", value):
        raise ChangeError("The file path must be relative to the opened folder.")
    name = pure.name
    if workspace.blocked_name(name) or workspace.hidden_file(name):
        raise ChangeError(f"{value}: secrets, binaries and generated files cannot be changed here.")
    if any(workspace.ignored_dir(part) for part in pure.parts[:-1]):
        raise ChangeError(f"{value}: files inside ignored folders (such as .git or node_modules) cannot be changed here.")
    root = root.resolve()
    path = root.joinpath(*pure.parts)
    probe = path
    while not probe.exists() and probe != root:
        probe = probe.parent
    walk = probe
    while walk != root and root in walk.parents:  # every component below the root
        if walk.is_symlink():
            raise ChangeError(f"{value}: symbolic links cannot be changed here.")
        walk = walk.parent
    if not probe.resolve().is_relative_to(root):
        raise ChangeError(f"{value}: the path escapes the opened folder.")
    return path


def read_file(path: Path) -> tuple[str, bytes]:
    """(text with \\n newlines, raw bytes). ChangeError for binary, huge or non-UTF-8 files."""
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ChangeError(f"{path.name}: the file could not be read.") from exc
    if len(raw) > workspace.MAX_FILE_BYTES or b"\x00" in raw:
        raise ChangeError(f"{path.name}: the file is binary or too large.")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ChangeError(f"{path.name}: only UTF-8 source files are supported.") from exc
    return text.replace("\r\n", "\n"), raw


def style_of(raw: bytes) -> tuple[str, bool]:
    crlf, lf = raw.count(b"\r\n"), raw.count(b"\n")
    return ("\r\n" if crlf and crlf * 2 >= lf else "\n"), raw.startswith(b"\xef\xbb\xbf")


def encode(text: str, newline: str, bom: bool) -> bytes:
    data = text.replace("\r\n", "\n").replace("\n", newline).encode("utf-8")
    return (b"\xef\xbb\xbf" + data) if bom else data


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".qucore-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def diff_stats(before: str, after: str) -> dict:
    added = removed = 0
    for line in difflib.unified_diff(before.split("\n"), after.split("\n"), lineterm="", n=0):
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return {"added": added, "removed": removed}


# ------------------------------------------------------------ applying edits ----

def _norm(value) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip("\n")


def _indent(line: str) -> str:
    return line[: len(line) - len(line.lstrip())]


def replace_once(text: str, before: str, after: str, line_hint: int | None = None) -> tuple[str | None, str]:
    """Replace `before` with `after` in `text`. Returns (new text or None, how/why)."""
    before, after = _norm(before), _norm(after)
    if not before.strip():
        return None, "The current code to replace is empty."
    positions = [m.start() for m in re.finditer(re.escape(before), text)]
    if positions:
        if len(positions) > 1 and line_hint:
            positions.sort(key=lambda p: abs(text.count("\n", 0, p) + 1 - line_hint))
        at = positions[0]
        return text[:at] + after + text[at + len(before):], "exact match" if len(positions) == 1 else "exact match (nearest of several)"
    lines, want = text.split("\n"), [l.strip() for l in before.split("\n")]
    spots = [i for i in range(len(lines) - len(want) + 1) if [l.strip() for l in lines[i:i + len(want)]] == want]
    if spots:
        if len(spots) > 1 and line_hint:
            spots.sort(key=lambda i: abs(i + 1 - line_hint))
        i = spots[0]
        old_indent, new_indent = _indent(before.split("\n")[0]), _indent(lines[i])
        fixed = [(new_indent + l[len(old_indent):]) if (l.startswith(old_indent) and old_indent != new_indent) else l
                 for l in after.split("\n")]
        return "\n".join(lines[:i] + fixed + lines[i + len(want):]), "matched ignoring indentation"
    if line_hint and 1 <= line_hint <= len(lines):  # last resort: a similar block at the reported place
        size = len(want)
        for start in sorted({max(0, line_hint - 1 - d) for d in range(0, 4)} | {max(0, line_hint - 1 + d) for d in range(0, 4)}):
            block = lines[start:start + size]
            if len(block) == size and difflib.SequenceMatcher(None, "\n".join(l.strip() for l in block), "\n".join(want)).ratio() >= 0.72:
                return "\n".join(lines[:start] + after.split("\n") + lines[start + size:]), "matched a similar block at the reported lines"
    return None, "The current code was not found in the file (it may have changed since the suggestion)."


def apply_edits(text: str, edits: list[dict]) -> tuple[str, list[dict]]:
    """Apply snippet edits in order. Returns (new text, one result per edit)."""
    results = []
    for number, edit in enumerate(edits, 1):
        new, how = replace_once(text, edit.get("before_code"), edit.get("after_code"), edit.get("line_start"))
        if new is None:
            results.append({"number": number, "ok": False, "message": how})
        else:
            text = new
            results.append({"number": number, "ok": True, "message": how})
    return text, results


# ------------------------------------------------------------------- drafts ----

def draft(workspace_id: str, rel: str, edits: list[dict] | None = None, content: str | None = None,
          is_new: bool = False) -> dict:
    root, _ = workspace_root(workspace_id)
    path = safe_path(root, rel)
    exists = path.is_file()
    if is_new and exists:
        raise ChangeError(f"{rel} already exists. Choose another name or change the existing file.")
    if not is_new and not exists:
        raise ChangeError(f"{rel} was not found in the opened folder.")
    original = "" if is_new else read_file(path)[0]
    results: list[dict] = []
    if content is not None:
        modified = _norm_text(content)
    else:
        modified, results = apply_edits(original, edits or [])
        if edits and not any(r["ok"] for r in results):
            raise ChangeError(results[0]["message"] if len(results) == 1 else
                              "None of the proposed changes could be located in the file: " + results[0]["message"])
    if len(modified) > MAX_TEXT or len(original) > MAX_TEXT:
        raise ChangeError("The file is too large to review as a change.")
    return {"path": rel, "is_new": is_new, "original": original, "modified": modified, "results": results,
            "stats": diff_stats(original, modified)}


def _norm_text(value: str) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    return text if text.endswith("\n") or not text else text + "\n"


# ------------------------------------------------------------------- store ----

def _file(ident: str) -> Path:
    if not _ID.match(ident or ""):
        raise KeyError(ident)
    return ROOT / f"{ident}.json"


def _write(rec: dict) -> None:
    file_store.ensure_folder(ROOT)
    # backend/data/changes/<id>.json (file_store.py)
    file_store.write_text(_file(rec["id"]), json.dumps(rec, ensure_ascii=False))
    _INDEX[rec["id"]] = {k: rec.get(k) for k in SUMMARY_KEYS}


def _ensure() -> None:
    global _READY
    with _LOCK:
        if _READY:
            return
        file_store.ensure_folder(ROOT)
        for file, text in file_store.read_many(file_store.list_files(ROOT, ".json")):
            try:
                if text is None:
                    continue
                rec = json.loads(text)
                if isinstance(rec, dict) and _ID.match(str(rec.get("id", ""))):
                    _INDEX[rec["id"]] = {k: rec.get(k) for k in SUMMARY_KEYS}
            except (OSError, ValueError):
                continue
        _READY = True


def _load(ident: str) -> dict:
    _ensure()
    if not ownership.allowed("change", ident):
        raise ChangeError("Change not found.")
    try:
        return json.loads(file_store.read_text(_file(ident)))
    except (OSError, ValueError, KeyError):
        raise ChangeError("Change not found.") from None


def _event(rec: dict, action: str, note: str = "") -> None:
    rec["events"].append({"at": store.now(), "action": action, "note": note})
    rec["updated_at"] = store.now()


def save(workspace_id: str, rel: str, title: str, source: str, content: str, is_new: bool) -> dict:
    """Store a new change (a "commit") for rel. The file in the folder is not touched."""
    root, name = workspace_root(workspace_id)
    path = safe_path(root, rel)
    exists = path.is_file()
    if is_new and exists:
        raise ChangeError(f"{rel} already exists.")
    if not is_new and not exists:
        raise ChangeError(f"{rel} was not found in the opened folder.")
    text, raw = ("", b"") if is_new else read_file(path)
    newline, bom = style_of(raw) if raw else ("\n", False)
    modified = _norm_text(content)
    if len(modified) > MAX_TEXT or len(raw) > MAX_TEXT:
        raise ChangeError("The file is too large to store as a change.")
    if modified == text and not is_new:
        raise ChangeError("There is no difference from the current file, so there is nothing to save.")
    rec = {
        "id": uuid4().hex, "path": rel.replace("\\", "/"), "title": (title or f"Change {rel}")[:200],
        "source": (source or "manual")[:80], "status": "saved", "is_new": is_new,
        "workspace_root": str(root), "workspace_name": name, "created_at": store.now(), "updated_at": store.now(),
        "original": text, "original_b64": base64.b64encode(raw).decode("ascii") if raw else "",
        "original_sha": sha(raw) if raw else None, "modified": modified, "newline": newline, "bom": bom,
        "stats": diff_stats(text, modified), "events": [], "applied_sha": None, "created_dirs": [],
    }
    _event(rec, "saved", "Saved as a new version; the file in the folder was not changed.")
    with _LOCK:
        _write(rec)
    ownership.claim("change", rec["id"])
    return public(rec)


def public(rec: dict, full: bool = True) -> dict:
    out = {k: rec.get(k) for k in SUMMARY_KEYS}
    if full:
        out.update(original=rec["original"], modified=rec["modified"], newline=rec.get("newline", "\n"))
    return out


def get(ident: str) -> dict:
    return public(_load(ident))


def summaries(root: str | None = None, rel: str | None = None, limit: int = 200) -> list[dict]:
    _ensure()
    with _LOCK:
        items = [dict(v) for v in _INDEX.values()]
    mine = ownership.visible("change", [i.get("id") for i in items])
    items = [i for i in items if i.get("id") in mine]
    if root:
        items = [i for i in items if i.get("workspace_root") == root]
    if rel:
        items = [i for i in items if i.get("path") == rel]
    items.sort(key=lambda i: i.get("created_at") or "", reverse=True)
    return items[:limit]


def update(ident: str, content: str) -> dict:
    with _LOCK:
        rec = _load(ident)
        if rec["status"] == "replaced":
            raise ChangeError("This change is applied to the file. Revert it before editing it.")
        modified = _norm_text(content)
        if len(modified) > MAX_TEXT:
            raise ChangeError("The file is too large to store as a change.")
        if modified == rec["modified"]:
            return public(rec)
        rec["modified"] = modified
        rec["stats"] = diff_stats(rec["original"], modified)
        _event(rec, "edited", "The new version was edited and saved.")
        _write(rec)
        return public(rec)


def _disk(root: Path, rel: str):
    path = safe_path(root, rel)
    return path, (path.read_bytes() if path.is_file() else None)


def replace(ident: str, force: bool = False) -> dict:
    with _LOCK:
        rec = _load(ident)
        if rec["status"] == "replaced":
            raise ChangeError("This change is already applied to the file.")
        root = Path(rec["workspace_root"])
        if not root.is_dir():
            raise ChangeError("The folder this change belongs to no longer exists.")
        path, current = _disk(root, rec["path"])
        if rec["is_new"]:
            if current is not None and not force:
                raise ChangeError(f"{rec['path']} now exists in the folder. Replace it anyway?", conflict=True)
        elif current is None:
            if not force:
                raise ChangeError(f"{rec['path']} is no longer in the folder. Create it anyway?", conflict=True)
        elif sha(current) != rec["original_sha"] and not force:
            raise ChangeError(f"{rec['path']} was changed on disk after this change was created. Replace it anyway?", conflict=True)
        created = []
        parent = path.parent
        while not parent.exists() and parent != root:
            created.append(str(parent.relative_to(root)).replace("\\", "/"))
            parent = parent.parent
        data = encode(rec["modified"], rec.get("newline", "\n"), rec.get("bom", False))
        write_atomic(path, data)
        rec.update(status="replaced", applied_sha=sha(data), created_dirs=created)
        _event(rec, "replaced", f"{rec['path']} was replaced with the new version.")
        _write(rec)
        return public(rec)


def revert(ident: str, force: bool = False) -> dict:
    with _LOCK:
        rec = _load(ident)
        if rec["status"] != "replaced":
            raise ChangeError("Only a change that was applied to the file can be reverted.")
        root = Path(rec["workspace_root"])
        path, current = _disk(root, rec["path"])
        if current is not None and sha(current) != rec["applied_sha"] and not force:
            raise ChangeError(f"{rec['path']} was changed again after this change was applied. Revert anyway?", conflict=True)
        if rec["is_new"]:
            path.unlink(missing_ok=True)
            for rel in sorted(rec.get("created_dirs") or [], key=len, reverse=True):
                try:
                    (root / rel).rmdir()
                except OSError:
                    pass
        else:
            write_atomic(path, base64.b64decode(rec["original_b64"]))
        rec["status"] = "reverted"
        _event(rec, "reverted", f"{rec['path']} was restored to how it was.")
        _write(rec)
        return public(rec)


def delete(ident: str) -> bool:
    with _LOCK:
        rec = _load(ident)
        if rec["status"] == "replaced":
            raise ChangeError("This change is applied to the file. Revert it before deleting it.")
        file_store.delete(_file(ident))
        _INDEX.pop(ident, None)
    ownership.forget("change", ident)
    return True
