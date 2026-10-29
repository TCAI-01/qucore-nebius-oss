"""Streaming QuBot / QuCoder answers from Nebius Token Factory (Chat Completions), with images.

The provider call runs in a spawned child process (the same approach as
app.cancellation), so Stop terminates the network call immediately instead of
waiting for the SDK. The child streams text deltas and usage back over a pipe.

If an answer reaches the output-token limit, the child automatically asks the
model to continue exactly where it stopped (QUCORE_QA_MAX_CONTINUATIONS times),
so the user receives a complete answer.

Message format used here (provider-neutral):
    [{"role": "user" | "assistant", "text": str, "images": [{"media_type", "data"}]}]
"""
from __future__ import annotations

import multiprocessing

CONTINUE_PROMPT = ("Your previous answer was cut off by the output limit. Continue exactly where it stopped, "
                   "without repeating anything already written and without any preamble. If you were inside a "
                   "code block, reopen it with the same language first.")


class Stopped(Exception):
    pass


# ---------------------------------------------------------------- per provider ----

def _chat_messages(system, messages):
    out = [{"role": "system", "content": system}]
    for m in messages:
        if m["role"] == "user" and m.get("images"):
            parts = [{"type": "text", "text": m["text"]}]
            for image in m["images"]:
                parts.append({"type": "image_url", "image_url": {"url": f"data:{image['media_type']};base64,{image['data']}"}})
            out.append({"role": "user", "content": parts})
        else:
            out.append({"role": m["role"], "content": m["text"]})
    return out


class _ThinkFilter:
    """Hides <think>...</think> reasoning while streaming (some Nemotron models inline it)."""
    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self):
        self.buffer = ""
        self.inside = False

    @staticmethod
    def _partial(text: str, tag: str) -> int:
        """Length of the longest suffix of `text` that could start `tag`."""
        low = text.lower()
        for size in range(min(len(tag) - 1, len(low)), 0, -1):
            if tag.startswith(low[-size:]):
                return size
        return 0

    def feed(self, text: str) -> str:
        self.buffer += text
        out = []
        while self.buffer:
            low = self.buffer.lower()
            if self.inside:
                index = low.find(self.CLOSE)
                if index < 0:
                    self.buffer = self.buffer[len(self.buffer) - self._partial(self.buffer, self.CLOSE):]
                    break
                self.buffer = self.buffer[index + len(self.CLOSE):].lstrip("\n")
                self.inside = False
            else:
                index = low.find(self.OPEN)
                if index < 0:
                    keep = self._partial(self.buffer, self.OPEN)
                    out.append(self.buffer[:len(self.buffer) - keep])
                    self.buffer = self.buffer[len(self.buffer) - keep:]
                    break
                out.append(self.buffer[:index])
                self.buffer = self.buffer[index + len(self.OPEN):]
                self.inside = True
        return "".join(out)

    def flush(self) -> str:
        rest, self.buffer = ("" if self.inside else self.buffer), ""
        return rest


def _stream_once(s, system, messages, send):
    """Stream one provider call. Returns "stop" | "length" | "filtered" | "refused"."""
    from . import llm
    with llm.make_client(s) as client:
        stream = client.chat.completions.create(
            model=s.deployment, messages=_chat_messages(system, messages), stream=True,
            stream_options={"include_usage": True}, **{s.chat_token_parameter: s.max_output_tokens})
        finish, usage = "stop", None
        hide = _ThinkFilter()  # hide inline <think> reasoning (some Nemotron models)
        for chunk in stream:
            if getattr(chunk, "usage", None):
                usage = chunk.usage.model_dump()
            for choice in chunk.choices or []:
                delta = getattr(choice, "delta", None)
                if delta is not None and getattr(delta, "content", None):
                    visible = hide.feed(delta.content) if hide else delta.content
                    if visible:
                        send(("delta", visible))
                if getattr(choice, "finish_reason", None):
                    finish = {"length": "length", "content_filter": "filtered"}.get(choice.finish_reason, "stop")
        rest = hide.flush() if hide else ""
        if rest:
            send(("delta", rest))
        send(("usage", usage))
        return finish


def _child(pipe, s, system, messages, max_continuations):
    from . import llm
    started = False

    def send(item):
        nonlocal started
        if item[0] == "delta":
            started = True
        pipe.send(item)

    try:
        history = list(messages)
        answer = ""
        continuations = 0
        while True:
            pipe.send(("pending", None))
            parts = []

            def collect(item):
                if item[0] == "delta":
                    parts.append(item[1])
                send(item)

            finish = _stream_once(s, system, history, collect)
            answer += "".join(parts)
            if finish == "length" and continuations < max_continuations and answer.strip():
                continuations += 1
                pipe.send(("continuation", continuations))
                history = list(messages) + [{"role": "assistant", "text": answer},
                                            {"role": "user", "text": CONTINUE_PROMPT}]
                continue
            pipe.send(("finish", {"reason": finish, "continuations": continuations}))
            break
        pipe.send(("end", None))
    except llm.ReviewError as exc:
        pipe.send(("error", str(exc)))
    except Exception as exc:  # noqa: BLE001 - mapped to a readable provider message
        pipe.send(("error", str(llm.provider_error(exc))))
    finally:
        pipe.close()


# ------------------------------------------------------------------- parent ----

def stream_answer(s, system: str, messages: list[dict], stop, max_continuations: int = 2):
    """Yield ("delta", text) | ("usage", raw|None) | ("pending", None) | ("continuation", n) | ("finish", {...}).

    Raises Stopped when `stop` is set (the child process is terminated) and
    llm.ReviewError on provider failures.
    """
    from . import llm
    context = multiprocessing.get_context("spawn")
    reader, writer = context.Pipe(duplex=False)
    process = context.Process(target=_child, args=(writer, s, system, messages, max_continuations), daemon=True)
    process.start()
    writer.close()
    try:
        while True:
            if stop.is_set():
                raise Stopped()
            if reader.poll(0.05):
                try:
                    kind, value = reader.recv()
                except EOFError:
                    raise llm.ReviewError("The model request worker stopped unexpectedly.") from None
                if kind == "end":
                    return
                if kind == "error":
                    raise llm.ReviewError(value)
                yield kind, value
            elif not process.is_alive() and not reader.poll(0):
                raise llm.ReviewError("The model request worker stopped unexpectedly.")
    finally:
        if process.is_alive():
            process.terminate()
        process.join(timeout=1)
        if process.is_alive():
            process.kill()
            process.join(timeout=1)
        if not process.is_alive():
            process.close()
        reader.close()
