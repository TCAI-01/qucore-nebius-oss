"""Cancel a run, including a synchronous SDK call blocked in network I/O.

Only provider calls run in a child process. Existing planning, prompts, result
handling and persistence stay in the worker. Terminating the child closes its
HTTP connections and prevents SDK retries; provider-side billing after a
disconnect remains controlled by the provider.
"""
from __future__ import annotations

import multiprocessing
import threading

_LOCK = threading.Lock()
_RUNS: dict[str, threading.Event] = {}
_LOCAL = threading.local()


class Cancelled(BaseException):
    """Bypass ordinary per-file failure/retry handlers."""


def register(ident: str) -> None:
    with _LOCK:
        _RUNS[ident] = threading.Event()


def attach(ident: str) -> None:
    with _LOCK:
        _LOCAL.event = _RUNS[ident]


def finish(ident: str) -> None:
    _LOCAL.event = None
    with _LOCK:
        _RUNS.pop(ident, None)


def stop(ident: str) -> bool:
    with _LOCK:
        event = _RUNS.get(ident)
        if event is None:
            return False
        event.set()
        return True


def check() -> None:
    event = getattr(_LOCAL, "event", None)
    if event is not None and event.is_set():
        raise Cancelled()


def _provider_call(pipe, name, args):
    from . import llm
    def consume(raw):
        pipe.send(("usage", raw))
    consume.request_started = lambda: pipe.send(("pending", None))
    try:
        result = getattr(llm, name)(*args, on_usage=consume)
        pipe.send(("result", result))
    except llm.ReviewError as exc:
        pipe.send(("error", str(exc)))
    except Exception:
        pipe.send(("error", "The model response could not be processed."))
    finally:
        pipe.close()


def call(name: str, args: tuple, on_usage):
    from . import llm
    if getattr(_LOCAL, "event", None) is None:
        return getattr(llm, name)(*args, on_usage=on_usage)
    check()
    # Spawn works on Windows too and does not inherit the web server's sockets.
    context = multiprocessing.get_context("spawn")
    reader, writer = context.Pipe(duplex=False)
    process = context.Process(target=_provider_call, args=(writer, name, args), daemon=True)
    started = False
    awaiting_usage = True
    try:
        process.start()
        started = True
        writer.close()
        while True:
            check()
            if reader.poll(0.1):
                try:
                    kind, value = reader.recv()
                except EOFError:
                    raise llm.ReviewError("The model request worker stopped unexpectedly.") from None
                if kind == "pending":
                    awaiting_usage = True
                elif kind == "usage":
                    awaiting_usage = False
                    if on_usage:
                        on_usage(value)
                elif kind == "error":
                    raise llm.ReviewError(value)
                else:
                    check()
                    return value
            elif not process.is_alive():
                raise llm.ReviewError("The model request worker stopped unexpectedly.")
    except Cancelled:
        # Stop network activity before invoking persistence callbacks.
        if started and process.is_alive():
            process.terminate()
            process.join(timeout=1)
            if process.is_alive():
                process.kill()
        if awaiting_usage and on_usage:
            on_usage(None)
        raise
    finally:
        if started:
            if process.is_alive():
                process.terminate()
            process.join(timeout=1)
            if process.is_alive():
                process.kill()
                process.join(timeout=1)
            if not process.is_alive():
                process.close()
        reader.close()
        writer.close()
