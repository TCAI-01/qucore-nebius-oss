"""The model provider (Nebius Token Factory) and optional embeddings; report formatting belongs to the user prompt.

Every chat and embedding call goes to Nebius Token Factory through the OpenAI SDK
(OpenAI-compatible /v1 API): NEBIUS_BASE_URL + NEBIUS_API_KEY, model = NEBIUS_MODEL (an NVIDIA
Nemotron model) and NEBIUS_EMBEDDING_MODEL for embeddings.
"""
from __future__ import annotations
import math
import re
from openai import OpenAI, APIConnectionError, APIStatusError, APITimeoutError
from . import cancellation
from .models import Settings
from .workspace import Source


class ReviewError(RuntimeError):
    pass


def make_client(s: Settings, embeddings=False) -> OpenAI:
    """OpenAI(base_url=<Nebius /v1>, api_key=NEBIUS_API_KEY) for chat and embeddings."""
    key = s.nebius_api_key.get_secret_value()
    if not s.nebius_endpoint or not key:
        raise ReviewError("Set the Nebius base URL and API key in Credentials.")
    if not embeddings and not s.nebius_model:
        raise ReviewError("Choose a Nebius model in Credentials.")
    return OpenAI(base_url=s.nebius_endpoint.rstrip("/") + "/", api_key=key, timeout=600.0, max_retries=2)


make_nebius_client = make_client


def _nebius_error(exc: Exception) -> ReviewError | None:
    """Errors from a Nebius request, recognised by the request host."""
    try:
        host = str(exc.request.url.host)
    except Exception:
        return None
    if "nebius" not in host:
        return None
    if isinstance(exc, APITimeoutError):
        return ReviewError("Nebius request timed out after retries. Try fewer files or run again.")
    if isinstance(exc, APIConnectionError):
        return ReviewError("Could not connect to Nebius Token Factory. Check the base URL and network access.")
    if isinstance(exc, APIStatusError):
        messages = {
            400: "Nebius rejected the request. Check the model ID, the token parameter and the output limit; "
                 "images need a vision model such as Nemotron-3-Nano-Omni.",
            401: "Nebius authentication failed. Check NEBIUS_API_KEY.",
            403: "Nebius denied access. Check that your key can use this model.",
            404: "Nebius model or API route not found. Check the model ID and the base URL (.../v1).",
            413: "The request is larger than this Nebius model accepts. Select fewer files or lower the context window.",
            422: "Nebius could not process the request parameters. Check the token parameter and output limit.",
            429: "Nebius rate or quota limit reached after retries. Try again later or reduce the selection.",
        }
        return ReviewError(messages.get(exc.status_code, f"Nebius returned HTTP {exc.status_code}. Check the model and try again."))
    return None


def provider_error(exc: Exception) -> ReviewError:
    nebius = _nebius_error(exc)
    if nebius:
        return nebius
    if isinstance(exc, APITimeoutError):
        return ReviewError("Nebius request timed out after retries. Try fewer files or run again.")
    if isinstance(exc, APIConnectionError):
        return ReviewError("Could not connect to Nebius Token Factory. Check the base URL and network access.")
    if isinstance(exc, APIStatusError):
        return ReviewError(f"The model endpoint returned HTTP {exc.status_code}. Check the base URL and model and try again.")
    return ReviewError("The model response could not be processed. Check the model supports Chat Completions.")


def rank_sources(s: Settings, sources: list[Source], prompt: dict, on_usage=None) -> tuple[list[Source], dict]:
    return cancellation.call("_rank_sources", (s, sources, prompt), on_usage)


def _rank_sources(s: Settings, sources: list[Source], prompt: dict, on_usage=None) -> tuple[list[Source], dict]:
    """Stream embedding batches; retain scores, not vectors for the whole repo."""
    if not s.embedding_deployment:
        raise ReviewError("Set an embedding deployment before enabling semantic ordering.")
    def chunks(text):
        return [text[i:i + 1500] for i in range(0, len(text), 1500)] or ["(empty file)"]
    def norm(vector):
        length = math.sqrt(sum(x * x for x in vector)) or 1.0
        return [x / length for x in vector]
    token_usage = 0
    width = None
    chunk_count = 0
    scores = []
    awaiting_usage = False
    try:
        with make_client(s, embeddings=True) as client:
            def vectors(texts):
                nonlocal token_usage, width, awaiting_usage
                for start in range(0, len(texts), 16):
                    batch = texts[start:start + 16]
                    awaiting_usage = True
                    if on_usage:
                        getattr(on_usage, "request_started", lambda: None)()
                    response = client.embeddings.create(model=s.embedding_deployment, input=batch, encoding_format="float")
                    awaiting_usage = False
                    if on_usage:
                        on_usage(response.usage.model_dump() if response.usage else None)
                    ordered = sorted(response.data, key=lambda item: item.index)
                    if [item.index for item in ordered] != list(range(len(batch))):
                        raise ReviewError("The embedding endpoint returned an incomplete batch.")
                    token_usage += response.usage.total_tokens if response.usage else 0
                    for item in ordered:
                        vector = item.embedding
                        if width is None:
                            width = len(vector)
                        if not width or len(vector) != width or any(not math.isfinite(x) for x in vector):
                            raise ReviewError("The embedding endpoint returned invalid vectors.")
                        yield vector
            query_sum = None
            for vector in vectors(chunks(prompt["content"])):
                query_sum = list(vector) if query_sum is None else [a + b for a, b in zip(query_sum, vector)]
            query = norm(query_sum)
            for source in sources:
                best = -1.0
                for vector in vectors(chunks(source.text)):
                    best = max(best, sum(a * b for a, b in zip(query, norm(vector))))
                    chunk_count += 1
                scores.append(best)
    except ReviewError:
        raise
    except Exception as exc:
        if awaiting_usage and on_usage:
            on_usage(None)
        raise provider_error(exc) from exc
    order = sorted(range(len(sources)), key=lambda i: (-scores[i], sources[i].path))
    return [sources[i] for i in order], {
        "enabled": True, "deployment": s.embedding_deployment,
        "chunks": chunk_count, "total_tokens": token_usage,
        "file_relevance": [{"file": sources[i].path, "similarity": round(scores[i], 4)} for i in order],
    }




def generate_text(s: Settings, instructions: str, payload: str, counter, on_usage):
    """Return the user-directed report without imposing a JSON report schema."""
    if counter.request(instructions, payload) + s.max_output_tokens > s.context_window:
        raise ReviewError("This request exceeds the context budget. No file was split or truncated.")
    return cancellation.call("_generate_text", (s, instructions, payload), on_usage)


def _generate_text(s: Settings, instructions: str, payload: str, on_usage):
    received = False
    try:
        with make_client(s) as client:
            response = client.chat.completions.create(
                model=s.deployment,
                messages=[{"role": "system", "content": instructions}, {"role": "user", "content": payload}],
                **{s.chat_token_parameter: s.max_output_tokens},
            )
            received = True
            on_usage(response.usage.model_dump() if response.usage else None)
            if not response.choices or response.choices[0].finish_reason != "stop":
                raise ReviewError("The response was incomplete, filtered, or reached its output budget. Increase output tokens or use smaller whole-file batches.")
            message = response.choices[0].message
            if getattr(message, "refusal", None):
                raise ReviewError("The model declined the review.")
            content = strip_reasoning(message.content or "")
        return _clean(content)
    except ReviewError:
        raise
    except Exception as exc:
        if not received:
            on_usage(None)  # Reported cost is incomplete, never claim zero cost.
        raise provider_error(exc) from exc


_THINK = re.compile(r"<think>.*?(?:</think>|$)", re.DOTALL | re.IGNORECASE)


def strip_reasoning(text: str) -> str:
    """Remove <think>...</think> reasoning that some Nemotron models put in the answer text."""
    if "<think>" not in text.lower() and "</think>" not in text.lower():
        return text
    text = _THINK.sub("", text)
    if "</think>" in text.lower():  # reasoning started before the visible text began
        text = text[text.lower().rindex("</think>") + len("</think>"):]
    return text.strip()


def _clean(content: str) -> str:
    if not (content or "").strip():
        raise ReviewError("The model returned an empty report.")
    # Recover a common model formatting mistake without touching the table:
    # an entire Markdown response accidentally wrapped in a Markdown fence.
    text = content.strip()
    lines = text.splitlines()
    if len(lines) >= 3 and lines[0].lower() in {"```markdown", "```md"} and lines[-1] == "```":
        text = "\n".join(lines[1:-1])
    return normalize_report(text)


_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_BOLD_HEADING = re.compile(r"^\s*(?:\*\*|__)([^*_\n][^*_\n]{0,78}?)(?:\*\*|__)\s*:?\s*$")


def normalize_report(text: str) -> str:
    """Give every model's report the same outline, without touching its content.

    Different models title and nest sections differently (an H1 title, "#" vs
    "##" sections, bold lines used as headings). The UI and the PDF rely on the
    outline - section index, one section per PDF page - so it is normalised:
    a lone leading H1 title is dropped (the report has its own header), bold-only
    lines become sub-headings, top-level sections become "##", and headings and
    tables get the blank line Markdown needs. Code blocks and table cells are
    left exactly as written.
    """
    lines = text.split("\n")
    fence = None
    kinds = []  # per line: "code" | "heading" | "text"
    for index, line in enumerate(lines):
        match = _FENCE.match(line)
        if fence:
            kinds.append("code")
            if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= len(fence):
                fence = None
            continue
        if match:
            fence = match.group(1)
            kinds.append("code")
            continue
        bold = _BOLD_HEADING.match(line)
        if bold and line.lstrip().startswith(("**", "__")):
            lines[index] = bold.group(1).strip().rstrip(":")
            kinds.append("bold")  # a whole line in bold used as a heading
        elif _HEADING.match(line):
            kinds.append("heading")
        else:
            kinds.append("text")

    levels = [(i, len(_HEADING.match(lines[i]).group(1))) for i, kind in enumerate(kinds) if kind == "heading"]
    h1 = [i for i, level in levels if level == 1]
    first = next((i for i, kind in enumerate(kinds) if kind in ("heading", "bold")), None)
    drop = None
    if len(h1) == 1 and first == h1[0]:
        drop = h1[0]  # a document title; the report already has its own header
    # Raw levels: real headings keep theirs; a bold pseudo-heading is a top-level
    # section unless a real heading precedes it, in which case it is one level below.
    # When the model opened with a bold "heading", it uses bold for its sections
    # throughout, so every bold heading is top level.
    markers = [i for i, kind in enumerate(kinds) if kind in ("heading", "bold") and i != drop]
    bold_style = bool(markers) and kinds[markers[0]] == "bold"
    raw: dict[int, int] = {}
    last_real = None
    for i, kind in enumerate(kinds):
        if i == drop:
            continue
        if kind == "heading":
            last_real = raw[i] = len(_HEADING.match(lines[i]).group(1))
        elif kind == "bold":
            raw[i] = 0 if bold_style or not last_real else last_real + 1  # 0 = top level
    real_levels = [level for level in raw.values() if level]
    base = min(real_levels) if real_levels else 2
    for i, level in raw.items():
        level = level or base
        title = _HEADING.match(lines[i]).group(2) if kinds[i] == "heading" else lines[i]
        lines[i] = "#" * max(2, min(6, level - base + 2)) + " " + title
        kinds[i] = "heading"

    out: list[str] = []
    for i, line in enumerate(lines):
        if i == drop:
            continue
        kind = kinds[i]
        starts_table = kind == "text" and line.lstrip().startswith("|") and \
            not (out and out[-1].lstrip().startswith("|"))
        opens_code = kind == "code" and (i == 0 or kinds[i - 1] != "code")
        if (kind == "heading" or starts_table or opens_code) and out and out[-1].strip():
            out.append("")
        out.append(line)
        if kind == "heading" and i + 1 < len(lines) and lines[i + 1].strip():
            out.append("")
    return "\n".join(out).strip()
