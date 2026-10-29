"""Read-only workspace snapshots. No target code is imported or executed."""
from __future__ import annotations

import hashlib
import os
import stat
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from threading import RLock
from uuid import uuid4

from . import config, ownership

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 12_000
# Folders that hold tool state, caches, dependencies or build output rather than
# source. They are not walked and never appear in the tree. (Files such as
# .gitignore, .gitattributes, .env.example and .github/ workflows still show.)
IGNORED_DIRS = {
    ".hg", ".svn", ".bzr", ".vscode", ".idea", ".vs", ".fleet", ".history",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".pytype", ".pyre", ".hypothesis",
    ".tox", ".nox", ".eggs", ".ipynb_checkpoints", "__pypackages__", "htmlcov", ".coverage_html",
    ".venv", "venv", ".conda", "site-packages", "node_modules", "bower_components", "jspm_packages",
    ".next", ".nuxt", ".svelte-kit", ".angular", ".parcel-cache", ".turbo", ".vite", ".cache", ".sass-cache",
    ".expo", ".docusaurus", ".serverless", ".terraform", ".gradle", ".dart_tool",
    "dist", "build", "target", "coverage", "obj", ".nyc_output", ".tmp",
}
IGNORED_DIR_SUFFIXES = (".egg-info", ".dist-info")
SECRET_NAMES = {".env", ".npmrc", ".pypirc", "id_rsa", "id_ed25519", "credentials", "credentials.json", "secrets.json"}
# Binary, database and cache artefacts are hidden from the tree entirely.
BINARY_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".icns", ".webp", ".tif", ".tiff", ".psd", ".heic",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar", ".jar", ".war", ".whl", ".egg", ".nupkg",
    ".exe", ".dll", ".so", ".dylib", ".a", ".lib", ".o", ".obj", ".class", ".wasm", ".bin", ".dat",
    ".pyc", ".pyo", ".pyd", ".lockb", ".pack", ".idx", ".map",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".mov", ".avi", ".mkv", ".webm",
    ".sqlite", ".sqlite3", ".db", ".db3", ".db-journal", ".db-wal", ".db-shm", ".mdb", ".accdb", ".duckdb",
    ".pkl", ".pickle", ".npy", ".npz", ".h5", ".hdf5", ".parquet", ".feather", ".onnx", ".pt", ".pth",
    ".ckpt", ".safetensors", ".log", ".tmp", ".swp", ".swo", ".bak", ".cache",
}
IGNORED_FILES = {".ds_store", "thumbs.db", "desktop.ini", ".coverage", "coverage.xml", ".python-version.bak"}


class WorkspaceError(ValueError):
    pass


@dataclass(frozen=True)
class Source:
    path: str
    text: str
    sha256: str
    lines: int
    size: int
    line_start: int = 1  # Chunks preserve original file line numbers.


@dataclass
class Workspace:
    root: Path
    allowed: set[str]
    owner: str | None = None  # who opened it when sign-in is on (None = local app)


class _Registry(dict):
    """Opened workspaces. `get` only returns workspaces the current person opened,
    so every module that looks a workspace up by ID is limited to its owner."""

    def get(self, key, default=None):
        item = super().get(key)
        if item is None or not ownership.can_see_owner(item.owner, "workspace"):
            return default
        _touch_github(item.root)
        return item


# A downloaded GitHub repository is deleted after QUCORE_GITHUB_IDLE_MINUTES without use
# (github_import.sweep). Every lookup of a workspace inside one counts as use: its copy folder
# (backend/data/github/work/<owner-key>/<copy>) gets a fresh modification time, at most twice a minute.
_TOUCHED: dict[str, float] = {}


def _touch_github(root: Path) -> None:
    try:
        work = (config.DATA / "github" / "work").resolve()
        rel = Path(root).relative_to(work)
    except (ValueError, OSError):
        return
    if len(rel.parts) < 2:
        return
    holder = work / rel.parts[0] / rel.parts[1]
    now = time.time()
    if now - _TOUCHED.get(str(holder), 0) < 30:
        return
    _TOUCHED[str(holder)] = now
    try:
        os.utime(holder)
    except OSError:
        pass


def forget_under(folder: Path) -> None:
    """Close every open workspace inside `folder` (its files are about to be deleted)."""
    try:
        base = Path(folder).resolve()
    except OSError:
        return
    with _lock:
        for ident, item in list(dict.items(_workspaces)):
            try:
                if item.root == base or item.root.is_relative_to(base):
                    dict.pop(_workspaces, ident, None)
            except (ValueError, OSError):
                pass


_lock = RLock()
_workspaces: _Registry = _Registry()
PER_OWNER = 32      # open workspaces kept per person (unchanged for the local app)
TOTAL_LIMIT = 2000  # across everyone, when sign-in is on


ENV_TEMPLATES = {".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults"}


def blocked_name(name: str) -> bool:
    """Real .env files and keys are listed but never sent to a model; templates are fine."""
    n = name.lower()
    if n in ENV_TEMPLATES or n.endswith(".example"):
        return False
    return n in SECRET_NAMES or n.startswith(".env.") or Path(n).suffix in {".pem", ".key", ".pfx", ".p12"}


def ignored_dir(name: str, path: Path | None = None) -> bool:
    low = name.lower()
    if low in IGNORED_DIRS or low.endswith(IGNORED_DIR_SUFFIXES):
        return True
    # Any virtual environment, whatever it is called (env/, .env/, py311/ ...).
    return path is not None and (path / "pyvenv.cfg").is_file()


def hidden_file(name: str) -> bool:
    """Binary, database, cache and OS artefacts: not listed at all."""
    low = name.lower()
    if low in IGNORED_FILES or low.endswith((".min.js.map", ".min.css.map")):
        return True
    return any(low.endswith(suffix) for suffix in BINARY_SUFFIXES)


def inspect_file(path: Path) -> tuple[str | None, int]:
    try:
        if path.is_symlink() or not path.is_file():
            return "Link or special file", 0
        size = path.stat().st_size
        if blocked_name(path.name):
            return "Holds secrets - listed, never sent to the model", size
        if path.suffix.lower() in BINARY_SUFFIXES:
            return "Binary file", size
        if size > MAX_FILE_BYTES:
            return "File exceeds 8 MiB", size
        with path.open("rb") as stream:
            raw = stream.read(MAX_FILE_BYTES + 1)
        if len(raw) > MAX_FILE_BYTES:
            return "File exceeds 8 MiB", len(raw)
        if b"\x00" in raw:
            return "Binary file", size
        raw.decode("utf-8-sig")
        return None, size
    except UnicodeDecodeError:
        return "Not UTF-8 text", 0
    except OSError:
        return "Unreadable file", 0


def open_workspace(value: str):
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        raise WorkspaceError("Enter an absolute folder path on the machine running FastAPI.")
    try:
        root = candidate.resolve(strict=True)
    except OSError as exc:
        raise WorkspaceError("Folder does not exist or cannot be accessed.") from exc
    if not root.is_dir():
        raise WorkspaceError("The path must point to a folder.")
    allowed: set[str] = set()
    count = 0
    skipped = 0

    def walk(folder: Path, depth=0):
        nonlocal count, skipped
        if depth > 48:
            raise WorkspaceError("Folder depth exceeds 48. Open a smaller subfolder.")
        node = {"name": folder.name or str(folder), "path": folder.relative_to(root).as_posix(), "type": "dir", "children": []}
        try:
            entries = sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError as exc:
            raise WorkspaceError("A folder is unreadable. Open an accessible subfolder.") from exc
        for path in entries:
            is_dir = path.is_dir()
            if path.is_symlink() or (is_dir and ignored_dir(path.name, path)) or (not is_dir and hidden_file(path.name)):
                skipped += 1  # caches, tool folders, binaries and databases are not shown
                continue
            count += 1
            if count > MAX_ENTRIES:
                raise WorkspaceError("Workspace exceeds 12,000 entries. Open a smaller subfolder.")
            if is_dir:
                child = walk(path, depth + 1)
                if child["children"]:  # folders holding only ignored files add noise
                    node["children"].append(child)
            else:
                rel = path.relative_to(root).as_posix()
                reason, size = inspect_file(path)
                if reason == "Binary file":
                    skipped += 1  # binary content without a known extension
                    continue
                node["children"].append({"name": path.name, "path": rel, "type": "file", "size": size, "reason": reason})
                if reason is None:
                    allowed.add(rel)
        return node

    tree = walk(root)
    ident = uuid4().hex
    owner = ownership.current_owner()
    with _lock:
        # Limit session bookkeeping; old IDs fail clearly rather than change roots.
        # Each person's oldest workspace goes first, so people never evict each other's.
        mine = [key for key, item in dict.items(_workspaces) if item.owner == owner]
        if len(mine) >= PER_OWNER:
            _workspaces.pop(mine[0])
        if len(_workspaces) >= TOTAL_LIMIT:
            _workspaces.pop(next(iter(_workspaces)))
        _workspaces[ident] = Workspace(root, allowed, owner)
    return {"id": ident, "name": root.name, "root": str(root), "tree": tree, "selectable_count": len(allowed), "skipped_directories_or_links": skipped}


def read_sources(workspace_id: str, paths: list[str]) -> list[Source]:
    with _lock:
        workspace = _workspaces.get(workspace_id)
    if not workspace:
        raise WorkspaceError("Workspace expired or backend restarted. Open the folder again.")
    sources = []
    total = 0
    for value in sorted(set(paths)):
        rel = PurePosixPath(value)
        if value not in workspace.allowed or rel.is_absolute() or ".." in rel.parts:
            raise WorkspaceError("Selection includes a path outside the scanned workspace.")
        path = workspace.root.joinpath(*rel.parts)
        # Re-check all components: the tree may have changed after scanning.
        if any(parent.is_symlink() for parent in [path, *path.parents]):
            raise WorkspaceError(f"{value}: symbolic links cannot be reviewed.")
        try:
            if not path.resolve(strict=True).is_relative_to(workspace.root):
                raise WorkspaceError("Selected file escapes the workspace.")
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            fd = os.open(path, flags)
            with os.fdopen(fd, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise WorkspaceError(f"{value}: not a regular file.")
                raw = stream.read(MAX_FILE_BYTES + 1)
        except OSError as exc:
            raise WorkspaceError(f"{value}: file changed or is no longer readable. Rescan the folder.") from exc
        if blocked_name(path.name) or len(raw) > MAX_FILE_BYTES or b"\x00" in raw:
            raise WorkspaceError(f"{value}: file is excluded, binary, or too large.")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise WorkspaceError(f"{value}: only UTF-8 source files are supported.") from exc
        total += len(raw)
        if total > MAX_TOTAL_BYTES:
            raise WorkspaceError("Selection exceeds 64 MiB. Select fewer files.")
        sources.append(Source(value, text, hashlib.sha256(raw).hexdigest(), max(1, len(text.splitlines())), len(raw)))
    return sources


def workspace_name(ident: str) -> str:
    with _lock:
        item = _workspaces.get(ident)
        if not item:
            raise WorkspaceError("Workspace expired. Open the folder again.")
        return item.root.name
