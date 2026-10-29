"""Native "Select folder" dialog for the local UI.

Browsers never reveal a folder's absolute path, so the backend (which runs on
the user's own machine) opens the operating system's folder dialog and returns
the chosen path. On Windows this is the Explorer "Select Folder" dialog.

The dialog runs in a short-lived child process (tkinter, part of the standard
Python installer), isolated from the server's threads; no console window is
shown. Typing or pasting a path keeps working as before.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import Field

from .models import StrictModel

router = APIRouter(prefix="/api/system")
_BUSY = threading.Lock()
_TIMEOUT_SECONDS = 15 * 60

_DIALOG = r"""
import sys
import tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
try:
    root.attributes("-topmost", True)
except Exception:
    pass
root.update()
initial = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
path = filedialog.askdirectory(parent=root, initialdir=initial, mustexist=True,
                               title="Select the codebase folder")
root.destroy()
sys.stdout.write(path or "")
sys.stdout.flush()
"""


class PickFolderInput(StrictModel):
    initial: str = Field(default="", max_length=4096)  # folder the dialog starts in, if it exists


@router.post("/pick-folder")
def pick_folder(value: PickFolderInput):
    if not _BUSY.acquire(blocking=False):
        raise HTTPException(409, "A folder dialog is already open. Check the taskbar if it is hidden behind the browser.")
    try:
        initial = ""
        if value.initial.strip():
            candidate = Path(value.initial.strip()).expanduser()
            if candidate.is_dir():
                initial = str(candidate)
            elif candidate.parent.is_dir():
                initial = str(candidate.parent)
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW: no console flash on Windows
        try:
            result = subprocess.run([sys.executable, "-c", _DIALOG, initial], capture_output=True, env=env,
                                    timeout=_TIMEOUT_SECONDS, creationflags=flags)
        except subprocess.TimeoutExpired:
            raise HTTPException(408, "The folder dialog was open too long and was closed. Try again.") from None
        except OSError:
            raise HTTPException(500, "The folder dialog could not be started. Paste the folder path instead.") from None
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", "replace")
            if "No module named" in detail and "tkinter" in detail:
                message = "The folder dialog needs tkinter (included with the python.org installer). Paste the path instead."
            elif "display" in detail.lower():
                message = "No desktop is available to show a folder dialog on this machine. Paste the path instead."
            else:
                message = "The folder dialog could not be opened. Paste the folder path instead."
            raise HTTPException(500, message)
        chosen = result.stdout.decode("utf-8", "replace").strip()
        if not chosen:
            return {"path": None, "cancelled": True}
        return {"path": os.path.normpath(chosen), "cancelled": False}
    finally:
        _BUSY.release()
