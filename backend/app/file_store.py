"""Where QuCoRe's saved files live: backend/data on this computer (QUCORE_DATA_DIR moves the folder).

  analyses/<id>.json            SonarQube fixes, flow maps, UML, QuSolids and QuScan runs
  changes/<id>.json             QuCoder change history
  reports/<id>.pdf, <id>.json   QuCodRev reports
  reports/<id>.parts/*.json     per-batch review results (kept for recovery)
  qa/<key>.json                 QuBot index state (Merkle leaves)
  chroma/                       QuBot vectors (ChromaDB)
  github/                       downloaded public GitHub repositories (deleted after QUCORE_GITHUB_IDLE_MINUTES)
QUCORE_AUTO_DELETE (cleanup.py) can empty these folders automatically after a number of days.

Every failure is raised as an OSError (FileNotFoundError when a file does not exist).
"""
from __future__ import annotations

from pathlib import Path

from . import config


def remote() -> bool:
    """Files are always stored locally (kept for callers that ask)."""
    return False


def describe() -> str:
    return f"local folder ({config.DATA})"


def ensure_folder(folder: Path) -> None:
    Path(folder).mkdir(parents=True, exist_ok=True)


def write_bytes(path: Path, data: bytes) -> None:
    """Save a file in one step (written to <name>.tmp, then renamed over the old one)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_bytes(data)
    temp.replace(path)


def write_text(path: Path, text: str) -> None:
    write_bytes(path, text.encode("utf-8"))


def read_bytes(path: Path) -> bytes:
    return Path(path).read_bytes()


def read_text(path: Path) -> str:
    return read_bytes(path).decode("utf-8")


def delete(path: Path) -> None:
    """Remove a file if it exists."""
    Path(path).unlink(missing_ok=True)


def commit_file(temp: Path, target: Path) -> None:
    """Publish a file that was written under a temporary name (a PDF being built)."""
    Path(temp).replace(Path(target))


def list_files(folder: Path, suffix: str) -> list[Path]:
    """Files directly inside `folder` whose name ends with `suffix`."""
    return list(Path(folder).glob(f"*{suffix}"))


def read_many(paths: list[Path]) -> list[tuple[Path, str | None]]:
    """(path, text) for each file; text is None when it could not be read."""
    out = []
    for path in paths:
        try:
            out.append((path, read_text(path)))
        except (OSError, UnicodeDecodeError):
            out.append((path, None))
    return out
