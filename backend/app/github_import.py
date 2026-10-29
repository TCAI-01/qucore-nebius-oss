"""Open a public GitHub repository as a workspace (no git binary, no extra package).

Flow for POST /api/workspaces/github {"url": "...", "ref": ""}:
  1. Parse "owner/repo", "https://github.com/owner/repo(.git)" or ".../tree/<ref>".
  2. Ask the GitHub REST API for the repository (refusing private ones, even when
     QUCORE_GITHUB_TOKEN could read them) and resolve the branch, tag or commit to
     an exact commit SHA.
  3. Download that commit's tarball from codeload.github.com once into a shared
     cache (backend/data/github/cache/<owner>__<repo>__<sha>.tar.gz), streamed with
     a size cap. A public commit is identical for everyone, so the cache is shared.
  4. Extract it safely into a folder that belongs to the person who asked
     (backend/data/github/work/<owner-key>/...). Edits made through QuCoder or the
     change history land in that person's copy only.
  5. Open that folder with the normal workspace scanner.

Downloads (cached tarballs and extracted copies) not used for QUCORE_GITHUB_IDLE_MINUTES
(default 30) are deleted by a background sweep that runs every minute. Using a workspace counts
as activity (workspace.py touches the copy). The repository URL stays saved per person
(workspace_memory.py), so they only paste it again. QUCORE_GITHUB_IDLE_MINUTES='0' keeps the
older rule: delete after QUCORE_GITHUB_CACHE_HOURS.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tarfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath

from fastapi import APIRouter
from pydantic import BaseModel, Field

from . import config, env, ownership, workspace

ROOT = config.DATA / "github"
CACHE = ROOT / "cache"
WORK = ROOT / "work"
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
_REF = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")
_URL = re.compile(r"^(?:https?://)?(?:www\.)?github\.com/([^/\s]+)/([^/\s#?]+?)(?:\.git)?(?:/tree/([^\s#?]+))?/?(?:[#?].*)?$", re.I)
_SHORT = re.compile(r"^([^/\s]+)/([^/\s]+?)(?:\.git)?(?:@([^\s]+))?$")
_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()
_LAST_SWEEP = {"at": 0.0}


class GithubError(workspace.WorkspaceError):
    """Shown to the user as a 400 by the existing WorkspaceError handler."""


class GithubInput(BaseModel):
    url: str = Field(min_length=3, max_length=500)
    ref: str = Field(default="", max_length=200)
    fresh: bool = False


# ------------------------------------------------------------------ settings ----

def import_enabled() -> bool:
    return env.flag("QUCORE_GITHUB_IMPORT", True)


def _int_setting(key: str, default: int, low: int, high: int) -> int:
    try:
        return max(low, min(high, int(env.setting(key, str(default)))))
    except ValueError:
        return default


def _max_bytes() -> int:
    return _int_setting("QUCORE_GITHUB_MAX_MB", 100, 1, 2000) * 1024 * 1024


def _ttl_seconds() -> int:
    minutes = idle_minutes()
    if minutes > 0:
        return minutes * 60
    return _int_setting("QUCORE_GITHUB_CACHE_HOURS", 24, 1, 24 * 60) * 3600


def idle_minutes() -> int:
    """Minutes without use after which a downloaded repository is deleted (0 = QUCORE_GITHUB_CACHE_HOURS)."""
    return _int_setting("QUCORE_GITHUB_IDLE_MINUTES", 30, 0, 60 * 24 * 60)


def _headers(accept: str = "application/vnd.github+json") -> dict:
    headers = {"Accept": accept, "User-Agent": "QuCoRe", "X-GitHub-Api-Version": "2022-11-28"}
    token = env.setting("QUCORE_GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


# --------------------------------------------------------------------- parse ----

def parse(url: str, ref: str = "") -> tuple[str, str, str]:
    text = url.strip()
    match = _URL.match(text) or _SHORT.match(text)
    if not match:
        raise GithubError("Enter a public GitHub repository, for example https://github.com/owner/repo or owner/repo.")
    owner, repo, url_ref = match.group(1), match.group(2), (match.group(3) or "")
    ref = (ref or url_ref).strip().strip("/")
    if not _NAME.match(owner) or not _NAME.match(repo):
        raise GithubError("That does not look like a GitHub owner/repository name.")
    if ref and (not _REF.match(ref) or ".." in ref.split("/")):
        raise GithubError("The branch, tag or commit name has characters GitHub does not allow.")
    return owner, repo, ref


# ----------------------------------------------------------------------- api ----

def _get_json(url: str) -> dict:
    request = urllib.request.Request(url, headers=_headers())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read(2_000_000).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise GithubError("Repository, branch or commit not found, or the repository is not public.") from None
        if exc.code == 429 or (exc.code == 403 and exc.headers.get("x-ratelimit-remaining") == "0"):
            raise GithubError("GitHub's rate limit was reached. Try again later, or set QUCORE_GITHUB_TOKEN.") from None
        if exc.code in (401, 403):
            raise GithubError(f"GitHub refused the request ({exc.code}). Check QUCORE_GITHUB_TOKEN if one is set.") from None
        raise GithubError(f"GitHub answered with an error ({exc.code}).") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise GithubError("Could not reach GitHub from the server.") from exc
    except ValueError as exc:
        raise GithubError("GitHub sent an unreadable answer.") from exc


def resolve(owner: str, repo: str, ref: str) -> dict:
    meta = _get_json(f"https://api.github.com/repos/{owner}/{repo}")
    if meta.get("private") or meta.get("visibility") not in (None, "public"):
        raise GithubError("Only public repositories can be imported.")
    size_kb = int(meta.get("size") or 0)
    if size_kb * 1024 > _max_bytes() * 4:  # GitHub's size counts history too; this only stops the extreme cases
        raise GithubError(f"This repository is too large to import (limit QUCORE_GITHUB_MAX_MB={_max_bytes() // 1048576}).")
    wanted = ref or str(meta.get("default_branch") or "")
    if not wanted:
        raise GithubError("The repository has no default branch.")
    commit = _get_json(f"https://api.github.com/repos/{meta.get('owner', {}).get('login') or owner}/"
                       f"{meta.get('name') or repo}/commits/{urllib.request.quote(wanted, safe='/')}")
    sha = str(commit.get("sha") or "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise GithubError("Could not resolve that branch, tag or commit.")
    return {"owner": meta.get("owner", {}).get("login") or owner, "repo": meta.get("name") or repo,
            "ref": wanted, "sha": sha, "description": (meta.get("description") or "")[:300],
            "default_branch": meta.get("default_branch") or ""}


# -------------------------------------------------------------- cache & files ----

def _lock(key: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.Lock())


def _download(info: dict) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / f"{info['owner']}__{info['repo']}__{info['sha']}.tar.gz"
    with _lock(str(target)):
        if target.is_file():
            os.utime(target)
            return target
        url = f"https://codeload.github.com/{info['owner']}/{info['repo']}/tar.gz/{info['sha']}"
        request = urllib.request.Request(url, headers={"User-Agent": "QuCoRe"})
        temp = target.with_suffix(".part")
        limit, total = _max_bytes(), 0
        try:
            with urllib.request.urlopen(request, timeout=60) as response, temp.open("wb") as out:
                while True:
                    block = response.read(1024 * 256)
                    if not block:
                        break
                    total += len(block)
                    if total > limit:
                        raise GithubError(f"The repository download is larger than QUCORE_GITHUB_MAX_MB ({limit // 1048576} MB).")
                    out.write(block)
            temp.replace(target)
        except GithubError:
            temp.unlink(missing_ok=True)
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            temp.unlink(missing_ok=True)
            raise GithubError("Downloading the repository from GitHub failed. Try again.") from exc
        return target


def _extract(archive: Path, destination: Path) -> None:
    """Regular files and folders only; no links, devices, absolute or parent paths."""
    limit = _max_bytes() * 4
    total, count = 0, 0
    temp = destination.with_name(destination.name + ".part")
    shutil.rmtree(temp, ignore_errors=True)
    temp.mkdir(parents=True)
    try:
        with tarfile.open(archive, "r:gz") as tar:
            for member in tar:
                parts = PurePosixPath(member.name).parts
                if len(parts) < 2:
                    continue  # the archive's top folder (<repo>-<sha>/) itself
                rel = PurePosixPath(*parts[1:])
                if rel.is_absolute() or ".." in rel.parts or any(p in ("", ".") for p in rel.parts):
                    continue
                if not (member.isfile() or member.isdir()):
                    continue  # symbolic/hard links and special files are skipped
                count += 1
                if count > workspace.MAX_ENTRIES * 4:
                    raise GithubError("The repository has too many files to import.")
                path = temp.joinpath(*rel.parts)
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                    continue
                total += member.size
                if total > limit:
                    raise GithubError("The unpacked repository is too large to import.")
                path.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                if source is None:
                    continue
                with source, path.open("wb") as out:
                    shutil.copyfileobj(source, out, 1024 * 256)
        shutil.rmtree(destination, ignore_errors=True)
        temp.replace(destination)
    except tarfile.TarError as exc:
        shutil.rmtree(temp, ignore_errors=True)
        raise GithubError("The repository archive could not be read.") from exc
    except BaseException:
        shutil.rmtree(temp, ignore_errors=True)
        raise


def sweep(force: bool = False) -> None:
    """Delete tarballs and extracted copies that were not used for the cache period."""
    now = time.time()
    if not force and now - _LAST_SWEEP["at"] < 60:
        return
    _LAST_SWEEP["at"] = now
    cutoff = now - _ttl_seconds()
    for archive in CACHE.glob("*.tar.gz") if CACHE.is_dir() else []:
        try:
            if archive.stat().st_mtime < cutoff:
                archive.unlink(missing_ok=True)
        except OSError:
            pass
    if WORK.is_dir():
        for owner_dir in WORK.iterdir():
            for copy in owner_dir.iterdir() if owner_dir.is_dir() else []:
                try:
                    if copy.stat().st_mtime < cutoff:
                        workspace.forget_under(copy)  # open workspaces in this copy end ("open it again")
                        shutil.rmtree(copy, ignore_errors=True)
                except OSError:
                    pass
            try:
                owner_dir.rmdir()  # only succeeds when empty
            except OSError:
                pass


def sweeper() -> None:
    """Background loop (started at start-up): delete idle downloads every minute."""
    while True:
        try:
            sweep(True)
        except Exception:  # noqa: BLE001 - never stop the loop
            pass
        time.sleep(60)


def import_repo(value: GithubInput) -> dict:
    if not import_enabled():
        raise GithubError("Importing GitHub repositories is turned off (QUCORE_GITHUB_IMPORT).")
    owner, repo, ref = parse(value.url, value.ref)
    sweep()
    info = resolve(owner, repo, ref)
    archive = _download(info)
    holder = WORK / ownership.owner_key() / f"{info['owner']}__{info['repo']}__{info['sha'][:12]}"
    folder = holder / info["repo"]  # the workspace (and its reports) are named after the repository
    with _lock(str(holder)):
        if value.fresh or not folder.is_dir():
            holder.mkdir(parents=True, exist_ok=True)
            _extract(archive, folder)
        os.utime(holder)
    result = workspace.open_workspace(str(folder))
    result["source"] = {"kind": "github", "repo": f"{info['owner']}/{info['repo']}", "ref": info["ref"],
                        "sha": info["sha"], "url": f"https://github.com/{info['owner']}/{info['repo']}/tree/{info['sha']}",
                        "description": info["description"]}
    result["name"] = info["repo"]
    return result


router = APIRouter(prefix="/api/workspaces", tags=["github"])


@router.post("/github")
def open_github(value: GithubInput):
    result = import_repo(value)
    source = result.get("source") or {}
    owner, _, repo = str(source.get("repo") or "").partition("/")
    if owner and repo:  # reopened automatically on this person's next visit (workspace_memory.py)
        from . import workspace_memory
        workspace_memory.remember_github(owner, repo, source.get("ref") or "", source.get("sha") or "")
    return result
