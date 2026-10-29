"""Server-only .env configuration. No secrets are returned to the browser."""
from __future__ import annotations

import json
import os
import tempfile
import time
import urllib.request
from pathlib import Path
from threading import RLock
from dotenv import dotenv_values
from pydantic import ValidationError
from .models import NEBIUS_EMBEDDING_MODELS, NEBIUS_MODELS, PROVIDER_LABELS, Settings

BACKEND = Path(__file__).resolve().parents[1]
# Hosting: QUCORE_ENV_FILE / QUCORE_DATA_DIR (process environment variables, for
# example a mounted volume) move the .env file and the data folder. Unset, they are
# backend/.env and backend/data exactly as before.
ENV_FILE = Path(os.environ.get("QUCORE_ENV_FILE") or BACKEND / ".env").expanduser()
DATA = Path(os.environ.get("QUCORE_DATA_DIR") or BACKEND / "data").expanduser()
REPORTS = DATA / "reports"
LOCK = RLock()

# Settings field -> backend/.env key. Nebius Token Factory is the only model provider.
ENV_KEYS = {
    "nebius_endpoint": "NEBIUS_BASE_URL",
    "nebius_api_key": "NEBIUS_API_KEY",
    "nebius_model": "NEBIUS_MODEL",
    "nebius_chat_token_parameter": "NEBIUS_CHAT_TOKEN_PARAMETER",
    "context_window": "NEBIUS_CONTEXT_WINDOW",
    "max_output_tokens": "NEBIUS_MAX_OUTPUT_TOKENS",
    "nebius_embedding_model": "NEBIUS_EMBEDDING_MODEL",
    "nebius_project_id": "NEBIUS_PROJECT_ID",   # Nebius sandbox (QuSolids demos)
}
SECRET_FIELDS = ("nebius_api_key",)
NEBIUS_PROVIDER = "nebius"


def _stored_values() -> dict:
    env = dotenv_values(ENV_FILE, interpolate=False) if ENV_FILE.exists() else {}
    return {field: env[key] for field, key in ENV_KEYS.items() if env.get(key) not in (None, "")}


def read_settings() -> Settings:
    """Settings exactly as stored in .env. Strict: used for review runs."""
    with LOCK:
        return Settings.model_validate(_stored_values())


def _error_text(exc: ValidationError) -> list[str]:
    out = []
    for error in exc.errors():
        field = error["loc"][0] if error.get("loc") else ""
        message = str(error.get("msg", "Invalid value")).removeprefix("Value error, ")
        out.append(f"{ENV_KEYS[field]}: {message}" if field in ENV_KEYS else message)
    return out


def tolerant_settings() -> tuple[Settings, list[str]]:
    """Settings for the UI even when backend/.env was hand-edited with a bad value.

    Invalid entries fall back to their defaults and are reported, so the
    Credentials screen can still open and fix them instead of the whole app failing.
    """
    with LOCK:
        values = _stored_values()
    problems: list[str] = []
    for _ in range(6):
        try:
            return Settings.model_validate(values), problems
        except ValidationError as exc:
            problems.extend(_error_text(exc))
            fields = {e["loc"][0] for e in exc.errors() if e.get("loc")}
            if not fields:  # a cross-field limit problem: drop the limit fields
                fields = {f for f in values if f in ("context_window", "max_output_tokens")}
            if not fields & set(values):
                break
            for field in fields:
                values.pop(field, None)
    return Settings(), problems


# ------------------------------------------------------- Nebius model catalog ----
# Nebius model IDs are case-sensitive (e.g. "nvidia/nemotron-3-super-120b-a12b").
# The live list from <base>/models (OpenAI-compatible) is the source of truth: the
# dropdowns show its exact IDs, and a configured ID that differs only in letter case
# is corrected before each call. If the list cannot be fetched, nothing changes.
_CATALOG_TTL = 600
_CATALOG: dict[str, tuple[float, list[str] | None]] = {}


def nebius_catalog(s: Settings) -> list[str] | None:
    """Model IDs served by the configured Nebius endpoint, or None if unknown."""
    key = s.nebius_api_key.get_secret_value()
    base = (s.nebius_endpoint or "").rstrip("/")
    if not key or not base:
        return None
    cached = _CATALOG.get(base)
    if cached and time.time() - cached[0] < _CATALOG_TTL:
        return cached[1]
    ids: list[str] | None = None
    try:
        request = urllib.request.Request(base + "/models", headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=8) as response:
            body = json.loads(response.read(5_000_000).decode("utf-8"))
        ids = sorted({str(item["id"]) for item in body.get("data", []) if isinstance(item, dict) and item.get("id")}) or None
    except Exception:  # noqa: BLE001 - offline, bad key, unexpected shape: keep the static lists
        ids = None
    # A failed fetch is retried after a minute rather than the full ten.
    _CATALOG[base] = (time.time() - (0 if ids else _CATALOG_TTL - 60), ids)
    return ids


def _exact_id(model: str, ids: list[str] | None) -> str:
    """The catalog's exact spelling of `model` (case-insensitive match), else `model` unchanged."""
    if not model or not ids or model in ids:
        return model
    lowered = model.lower()
    return next((i for i in ids if i.lower() == lowered), model)


def _catalog_options(static: list[dict], ids: list[str] | None, keep) -> list[dict]:
    """Static entries with their IDs corrected to the live spelling (entries Nebius does not
    serve are dropped), followed by other live models that `keep` selects."""
    if not ids:
        return static
    lowered = {i.lower(): i for i in ids}
    out, seen = [], set()
    for item in static:
        live = lowered.get(item["id"].lower())
        if live and live not in seen:
            out.append({**item, "id": live})
            seen.add(live)
    for i in ids:
        if i not in seen and keep(i.lower()):
            out.append({"id": i, "label": i.split("/", 1)[-1], "note": "Served by your Nebius endpoint"})
            seen.add(i)
    return out or static


def active_settings() -> Settings:
    """Settings with the Nebius model and embedding model resolved (exact catalog spelling)."""
    s = read_settings().active()
    ids = nebius_catalog(s)
    if ids:
        s = s.model_copy(update={"deployment": _exact_id(s.deployment, ids),
                                 "embedding_deployment": _exact_id(s.embedding_deployment, ids)})
    return s


def public_settings(settings: Settings | None = None) -> dict:
    problems: list[str] = []
    if settings is None:
        settings, problems = tolerant_settings()
    s = settings
    data = s.model_dump(exclude=set(SECRET_FIELDS))
    for field in SECRET_FIELDS:
        data["has_" + field] = bool(getattr(s, field).get_secret_value())
    active = s.active()
    from . import ui_config  # local import: ui_config reads backend/.env through env.py, which imports this module
    data["ui"] = ui_config.public()  # tabs, sample repositories and QuBot options (ui_config.py)
    data["providers"] = {NEBIUS_PROVIDER: {"label": PROVIDER_LABELS[NEBIUS_PROVIDER],
                                           "configured": s.provider_configured(), "deployment": s.nebius_model}}
    data["active"] = {"provider": s.provider, "label": PROVIDER_LABELS[s.provider],
                      "deployment": active.deployment, "context_window": active.context_window,
                      "max_output_tokens": active.max_output_tokens}
    # `configured` and `deployment` describe the model used by the rest of the UI.
    data["configured"] = s.provider_configured()
    data["active_deployment"] = active.deployment
    data["embedding_deployment"] = active.embedding_deployment
    data["env_errors"] = problems
    # Nebius dropdown catalogs (Credentials and the header switch), spelled exactly as
    # the endpoint serves them when its model list can be read.
    ids = nebius_catalog(s)
    data["nebius_models"] = _catalog_options(NEBIUS_MODELS, ids, lambda i: "nemotron" in i and "embed" not in i)
    data["nebius_embedding_models"] = _catalog_options(NEBIUS_EMBEDDING_MODELS, ids, lambda i: "embed" in i)
    if ids:
        data["nebius_model"] = _exact_id(s.nebius_model, ids)
        data["nebius_embedding_model"] = _exact_id(s.nebius_embedding_model, ids)
        data["active"]["deployment"] = data["active_deployment"] = _exact_id(active.deployment, ids)
        data["embedding_deployment"] = _exact_id(active.embedding_deployment, ids)
        data["providers"][NEBIUS_PROVIDER]["deployment"] = data["nebius_model"]
    return data


def _env_line(key: str, value: str) -> str:
    escaped = str(value or "").replace("\\", "\\\\").replace("'", "\\'")
    return f"{key}='{escaped}'"


def write_env_values(updates: dict[str, str | None]) -> None:
    """Change only the given keys in backend/.env, in place (None removes the key).

    Comments, blank lines, the order of the keys and every other line stay exactly as they
    were; a key not in the file yet is added at the end. Atomic replacement, restrictive
    POSIX permissions, no shell evaluation.
    """
    import io
    from dotenv.parser import parse_stream

    text = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.exists() else ""
    out: list[str] = []
    seen: set[str] = set()
    for binding in parse_stream(io.StringIO(text)):
        raw = binding.original.string
        if binding.error or binding.key is None or binding.key not in updates:
            out.append(raw)
            continue
        seen.add(binding.key)
        value = updates[binding.key]
        body = raw.lstrip()
        lead = raw[:len(raw) - len(body)]  # blank lines kept with this entry by the parser
        if value is None:
            out.append(lead)
            continue
        prefix = "export " if body.startswith("export ") else ""
        out.append(f"{lead}{prefix}{_env_line(binding.key, value)}\n")
    added = [_env_line(k, v) + "\n" for k, v in updates.items() if v is not None and k not in seen]
    if added and out and not out[-1].endswith("\n"):
        out.append("\n")
    result = "".join(out + added)
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".env-", dir=ENV_FILE.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(result)
        os.chmod(tmp, 0o600)
        try:
            os.replace(tmp, ENV_FILE)
        except OSError:
            # A file bind-mounted by Docker cannot be replaced by rename: write the same text in place.
            with open(ENV_FILE, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(result)
    finally:
        Path(tmp).unlink(missing_ok=True)


def _write_env(settings: Settings) -> None:
    env = dict(dotenv_values(ENV_FILE, interpolate=False)) if ENV_FILE.exists() else {}
    updates: dict[str, str] = {}
    for field, key in ENV_KEYS.items():
        value = getattr(settings, field)
        text = value.get_secret_value() if hasattr(value, "get_secret_value") else str(value)
        if key in env:
            if (env[key] or "") != text:
                updates[key] = text  # only lines whose value really changed are rewritten
        else:
            default = Settings.model_fields[field].default
            default = default.get_secret_value() if hasattr(default, "get_secret_value") else default
            if text != ("" if default is None else str(default)):
                updates[key] = text  # a missing key is added only when it differs from the default
    if updates:
        write_env_values(updates)


class SettingsSaveError(ValueError):
    """Readable, field-named reasons a save was refused (the .env is left unchanged)."""


INT_FIELDS = {name for name, info in Settings.model_fields.items() if info.annotation is int}


def save_settings(payload: dict) -> dict:
    """Merge the fields sent by the UI into the current .env and write it.

    Only the fields present in ``payload`` change, so edits made by hand in
    backend/.env are kept unless the same field is edited in the UI. Unknown and
    read-only keys are ignored. Blank secrets keep the stored key; ``clear_<key>``
    removes it. A blank number means "unchanged".
    """
    if not isinstance(payload, dict):
        raise SettingsSaveError("Settings must be sent as a JSON object.")
    with LOCK:
        current, _ = tolerant_settings()
        values = current.model_dump()
        for field in ENV_KEYS:
            if field not in payload:
                continue
            value = payload[field]
            if field in SECRET_FIELDS:
                if isinstance(value, str) and value.strip():
                    values[field] = value.strip()
                continue
            if field in INT_FIELDS:
                if value in ("", None):
                    continue
                try:
                    value = int(float(value))
                except (TypeError, ValueError):
                    raise SettingsSaveError(f"{ENV_KEYS[field]}: enter a whole number.") from None
            values[field] = value.strip() if isinstance(value, str) else value
        for field in SECRET_FIELDS:
            if payload.get("clear_" + field) is True:
                values[field] = ""
        try:
            settings = Settings.model_validate(values)
        except ValidationError as exc:
            raise SettingsSaveError(" ".join(_error_text(exc))) from None
        _write_env(settings)
        return public_settings(settings)


def set_model(model: str) -> dict:
    """Header switch: choose the Nemotron model (NEBIUS_MODEL)."""
    with LOCK:
        values = tolerant_settings()[0].model_dump()
        values["nebius_model"] = model
        settings = Settings.model_validate(values)
        _write_env(settings)
        return public_settings(settings)


def server_options() -> dict:
    env = dotenv_values(ENV_FILE, interpolate=False) if ENV_FILE.exists() else {}
    def value(key: str) -> str:  # a hosting platform's variables win over backend/.env
        return os.environ.get(key) or env.get(key) or ""
    origins = value("QUCORE_ALLOWED_ORIGINS") or "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000"
    # QUCORE_ALLOWED_HOSTS: host names the server answers to (your domain when hosted).
    hosts = value("QUCORE_ALLOWED_HOSTS") or "localhost,127.0.0.1,[::1]"
    return {"origins": [v.strip() for v in origins.split(",") if v.strip()],
            "hosts": [v.strip() for v in hosts.split(",") if v.strip()]}
