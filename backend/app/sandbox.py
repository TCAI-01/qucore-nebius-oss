"""Run a short Python or Node.js program in the Nebius sandbox.

Nebius sandbox (Credentials > Code sandbox), with the contree-sdk:
    os.environ["NEBIUS_API_KEY"] = ...; os.environ["NEBIUS_PROJECT_ID"] = ...
    image = ContreeSync().images.oci("python:3.12")      # the image in your project; imported from Docker Hub
                                                         # into the project on first use if it is not there yet
    image.run("python", args=["-c", code]).wait()        # Python demos (QUCORE_SANDBOX_IMAGE)
    image.run("node", args=["-e", code]).wait()          # Node.js demos (QUCORE_SANDBOX_NODE_IMAGE)
Used by QuSolids (runnable demonstrations of findings in Python and JavaScript / TypeScript files).
images.use() only refers to an image that already exists in the project, so a fresh project failed with
"not found"; images.oci() finds it or imports it once (the first run then takes longer).

The code never runs on this machine. The SDK call runs in its own Python process (a plain
subprocess that executes the same few lines as the sample, with the keys in its environment), which
this module supervises: Stop kills it at once, and a run that does not finish in time is ended with an
error instead of spinning. The process reports its stage and the result as one JSON line each.

The run is finished as soon as the result line arrives; QuCoRe never waits for the process to exit
(the SDK keeps background threads and HTTP connections that can keep an interpreter alive), and the
process ends itself with os._exit right after writing the result.

Runs are kept in memory only (the demonstration code and its output are not stored).
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from uuid import uuid4

from dotenv import dotenv_values

from . import config, limits

DEFAULT_IMAGE = "python:3.12"
DEFAULT_NODE_IMAGE = "node:22-slim"  # QUCORE_SANDBOX_NODE_IMAGE
RUNTIMES = {"python": "python", "node": "node"}  # runtime -> command run in the image (python -c / node -e)
DEADLINE = 240           # seconds QuCoRe waits in total before giving up
MAX_OUTPUT = 60000       # characters of stdout / stderr kept
MAX_RUNS = 60
MAX_ACTIVE = max(3, limits.per_feature())  # runs at once: at least 3, or QUCORE_RUNS_PER_FEATURE
LABELS = {"nebius": "Nebius sandbox"}
MARK = "@@QC "           # prefix of the lines the runner process prints for QuCoRe

_LOCK = threading.Lock()
_RUNS: dict[str, dict] = {}
_STOPS: dict[str, threading.Event] = {}
_PROCS: dict[str, "subprocess.Popen"] = {}


class SandboxError(ValueError):
    pass


def image_name() -> str:
    values = dotenv_values(config.ENV_FILE, interpolate=False) if config.ENV_FILE.exists() else {}
    return (values.get("QUCORE_SANDBOX_IMAGE") or DEFAULT_IMAGE).strip() or DEFAULT_IMAGE


def node_image_name() -> str:
    values = dotenv_values(config.ENV_FILE, interpolate=False) if config.ENV_FILE.exists() else {}
    return (values.get("QUCORE_SANDBOX_NODE_IMAGE") or DEFAULT_NODE_IMAGE).strip() or DEFAULT_NODE_IMAGE


def credentials(settings) -> dict:
    """The secrets the Nebius sandbox needs, or SandboxError saying what is missing."""
    key = settings.nebius_api_key.get_secret_value()
    project = (settings.nebius_project_id or "").strip()
    missing = [name for name, value in (("Nebius API key", key), ("Nebius project ID", project)) if not value]
    if missing:
        raise SandboxError(f"Add the {' and '.join(missing)} in Credentials (Nebius section and Code sandbox).")
    return {"provider": "nebius", "nebius_api_key": key, "nebius_project_id": project}


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if hasattr(value, "read"):
        try:
            return _text(value.read())
        except Exception:  # noqa: BLE001
            return ""
    return str(value)



# The program the runner process executes (python -u -c RUNNER). It reads one JSON request from stdin and
# prints "@@QC [kind, value]" lines. Nothing here is specific to the demonstration code.
RUNNER = r'''
import json, os, sys, time
def emit(kind, value):
    sys.stdout.write("@@QC " + json.dumps([kind, value], default=str) + "\n"); sys.stdout.flush()
def text(value):
    if value is None: return ""
    if isinstance(value, bytes): return value.decode("utf-8", "replace")
    if hasattr(value, "read"):
        try: return text(value.read())
        except Exception: return ""
    return str(value)
import logging
logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("contree_sdk").setLevel(logging.DEBUG)   # what the SDK is doing (shown as "Connection details")
logging.getLogger("httpx").setLevel(logging.INFO)          # one line per HTTP call and its status
req = json.loads(sys.stdin.read())
started = time.time()
try:
    from contree_sdk import ContreeSync
    emit("stage", "Connecting to Nebius")
    client = ContreeSync()
    emit("stage", "Preparing the image " + req["image"] + " (imported into your Nebius project on first use)")
    find = getattr(client.images, "oci", None) or client.images.use
    sandbox = find(req["image"])
    emit("stage", "Running the program on Nebius")
    command = req.get("command") or "python"
    flag = "-e" if command == "node" else "-c"
    result = sandbox.run(command, args=[flag, req["code"]]).wait()
    emit("stage", "Reading the output")
    emit("result", {"stdout": text(result.stdout), "stderr": text(result.stderr), "exit_code": result.exit_code})
except BaseException as exc:
    emit("error", type(exc).__name__ + ": " + str(exc))
emit("elapsed", int((time.time() - started) * 1000))
# Leave at once: the SDK keeps background threads and HTTP clients that can stop a normal interpreter exit,
# and QuCoRe already has everything it needs.
sys.stdout.flush(); sys.stderr.flush()
os._exit(0)
'''


def _clip(text: str) -> str:
    return text if len(text) <= MAX_OUTPUT else text[:MAX_OUTPUT] + f"\n… output truncated at {MAX_OUTPUT:,} characters"


def _mask(text: str, creds: dict) -> str:
    for secret in (creds.get("nebius_api_key"),):
        if secret:
            text = text.replace(secret, "***")
    return text


def _pump(stream, sink: "queue.Queue[str | None]") -> None:
    try:
        for line in iter(stream.readline, ""):
            sink.put(line)
    except (OSError, ValueError):
        pass
    finally:
        sink.put(None)


def _kill(run_id: str) -> None:
    process = _PROCS.pop(run_id, None)
    if process is not None and process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass


def _finalize(run_id: str, outcome: dict, elapsed: int | None = None) -> bool:
    """Record how a run ended, once. Stop and the watchdog in get() use this too, so a run can always be ended
    from outside even if its supervisor thread is stuck. False when the run had already ended."""
    with _LOCK:
        run = _RUNS.get(run_id)
        if run is None or run["status"] != "running":
            return False
        run.update({"stdout": "", "stderr": "", "exit_code": None, "stage": ""}, **outcome)
        run["duration_ms"] = elapsed if elapsed is not None else int((time.time() - run["started_at"]) * 1000)
        run["finished_at"] = time.time()
        event = _STOPS.pop(run_id, None)
    if event is not None:
        event.set()
    _kill(run_id)
    return True


def _supervise(run_id: str, creds: dict, code: str, image: str, command: str = "python") -> None:
    stop = _STOPS[run_id]
    began = time.time()
    outcome: dict = {"status": "failed", "error": "The sandbox worker stopped unexpectedly."}
    elapsed = None
    tail: list[str] = []
    process = None

    def progress(**fields):
        with _LOCK:
            run = _RUNS.get(run_id)
            if run is not None:
                run.update(fields)

    try:
        env = dict(os.environ)
        env["NEBIUS_API_KEY"] = creds["nebius_api_key"]
        env["NEBIUS_PROJECT_ID"] = creds["nebius_project_id"]
        process = subprocess.Popen([sys.executable, "-u", "-c", RUNNER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=env)
        _PROCS[run_id] = process
        progress(stage="Starting the sandbox worker")
        request = {"provider": creds["provider"], "code": code, "image": image, "timeout": DEADLINE, "command": command}
        try:
            process.stdin.write(json.dumps(request))
            process.stdin.close()
        except OSError:
            pass
        lines: "queue.Queue[str | None]" = queue.Queue()
        errors: "queue.Queue[str | None]" = queue.Queue()
        threading.Thread(target=_pump, args=(process.stdout, lines), daemon=True).start()
        threading.Thread(target=_pump, args=(process.stderr, errors), daemon=True).start()
        done = False
        while not done:
            if stop.is_set():
                outcome = {"status": "stopped", "error": "Stopped by user."}
                break
            if time.time() - began > DEADLINE:
                outcome = {"status": "timeout", "error": f"The sandbox did not finish within {DEADLINE} seconds, so the run was ended. "
                                                         "Check the connection details below and your provider project."}
                break
            while True:  # keep the last lines the process wrote to stderr (SDK warnings, tracebacks)
                try:
                    line = errors.get_nowait()
                except queue.Empty:
                    break
                if line:
                    tail.append(_mask(line.rstrip(), creds)[:300])
                    del tail[:-40]
                    progress(log=list(tail))
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if line is None:  # the process closed its output
                done = True
                break
            if not line.startswith(MARK):
                continue
            try:
                kind, value = json.loads(line[len(MARK):])
            except ValueError:
                continue
            if kind == "stage":
                progress(stage=value)
            elif kind == "elapsed":
                elapsed = value
            elif kind == "result":
                code_value = value.get("exit_code")
                outcome = {"status": "completed" if code_value in (0, None) else "failed",
                           "stdout": _clip(_text(value.get("stdout"))), "stderr": _clip(_text(value.get("stderr"))),
                           "exit_code": code_value, "error": None}
                break  # the output is here: show it now, whether or not the worker process has exited yet
            elif kind == "error":
                outcome = {"status": "failed", "error": _mask(str(value), creds)[:1500], "stdout": "", "stderr": "", "exit_code": None}
                break
        if done and outcome.get("error") == "The sandbox worker stopped unexpectedly." and tail:
            outcome["error"] = "The sandbox worker stopped unexpectedly:\n" + "\n".join(tail[-8:])
    except Exception as exc:  # noqa: BLE001 - the run must always end with a message, never spin
        outcome = {"status": "failed", "error": _mask(f"The sandbox worker could not run: {type(exc).__name__}: {exc}", creds)[:1500]}
    finally:
        _finalize(run_id, outcome, elapsed if elapsed is not None else int((time.time() - began) * 1000))
        if process is not None:
            try:
                process.wait(timeout=2)
            except (subprocess.TimeoutExpired, OSError):
                pass


def start(code: str, settings, runtime: str = "python") -> dict:
    """runtime 'python' (QUCORE_SANDBOX_IMAGE, default python:3.12) or 'node' (QUCORE_SANDBOX_NODE_IMAGE, default
    node:22-slim)."""
    code = code.replace("\r\n", "\n")
    if not code.strip():
        raise SandboxError("There is no code to run.")
    if runtime not in RUNTIMES:
        raise SandboxError(f"Unknown sandbox runtime: {runtime}.")
    creds = credentials(settings)
    image = node_image_name() if runtime == "node" else image_name()
    with _LOCK:
        if sum(1 for r in _RUNS.values() if r["status"] == "running") >= MAX_ACTIVE:
            raise SandboxError("Too many sandbox runs are active. Stop one or wait for it to finish.")
        finished = sorted((r for r in _RUNS.values() if r["status"] != "running"), key=lambda r: r.get("finished_at", 0))
        for old in finished[:max(0, len(_RUNS) - MAX_RUNS + 1)]:
            _RUNS.pop(old["id"], None)
        run_id = uuid4().hex
        _RUNS[run_id] = {"id": run_id, "status": "running", "provider": creds["provider"],
                         "provider_label": LABELS[creds["provider"]], "image": image, "runtime": runtime, "stdout": "", "stderr": "", "exit_code": None,
                         "error": None, "duration_ms": None, "started_at": time.time(), "stage": "Starting", "log": []}
        _STOPS[run_id] = threading.Event()
        snapshot = dict(_RUNS[run_id])
    threading.Thread(target=_supervise, args=(run_id, creds, code, image, RUNTIMES[runtime]), name=f"sandbox-{run_id[:8]}",
                     daemon=True).start()
    return snapshot


def get(run_id: str) -> dict | None:
    with _LOCK:
        run = _RUNS.get(run_id)
        overdue = run is not None and run["status"] == "running" and time.time() - run["started_at"] > DEADLINE + 10
    if overdue:  # the supervisor should have ended it by now: end it from here
        _finalize(run_id, {"status": "timeout", "error": f"The sandbox did not finish within {DEADLINE} seconds, so the run was ended."})
    with _LOCK:
        run = _RUNS.get(run_id)
        return dict(run) if run else None


def stop(run_id: str) -> dict | None:
    """End the run now (the worker process is killed); it never waits for the supervisor thread."""
    with _LOCK:
        known = run_id in _RUNS
    if not known:
        return None
    _finalize(run_id, {"status": "stopped", "error": "Stopped by user."})
    return get(run_id)
