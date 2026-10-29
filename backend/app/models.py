from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


Provider = Literal["nebius"]
PROVIDER_LABELS = {"nebius": "Nebius Token Factory"}

# Nebius Token Factory: OpenAI-compatible API (OpenAI SDK, base_url + NEBIUS_API_KEY).
NEBIUS_DEFAULT_ENDPOINT = "https://api.tokenfactory.us-central1.nebius.com/v1"
# NVIDIA Nemotron models on Token Factory, in dropdown order. Any other ID can be entered as "Custom".
NEBIUS_MODELS = [
    {"id": "nvidia/Nemotron-3-Nano-30B-A3B", "label": "Nemotron-3-Nano-30B-A3B", "note": "Small, fast MoE"},
    {"id": "nvidia/Nemotron-3-Nano-Omni", "label": "Nemotron-3-Nano-Omni", "note": "Vision (images in Code Q&A)"},
    {"id": "nvidia/Nemotron-3-Super-120b-a12b", "label": "Nemotron-3-Super-120b-a12b", "note": "Long-context MoE"},
    {"id": "nvidia/Nemotron-3-Ultra-550b-a55b", "label": "Nemotron-3-Ultra-550b-a55b", "note": "Frontier reasoning (default)"},
    {"id": "nvidia/Nemotron-3.5-Lightning", "label": "Nemotron-3.5-Lightning", "note": "Low latency"},
    {"id": "nvidia/Nemotron-Nano-V2-12b", "label": "Nemotron-Nano-V2-12b", "note": "Compact, vision capable"},
    {"id": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "label": "NVIDIA-Nemotron-3-Nano-30B-A3B", "note": "Small, fast MoE"},
]
NEBIUS_DEFAULT_MODEL = "nvidia/Nemotron-3-Ultra-550b-a55b"
# Embedding model on Token Factory (semantic ordering and QuBot search). Fixed: always Qwen3-Embedding-8B, whatever
# NEBIUS_EMBEDDING_MODEL or a saved key says (it is not editable in the UI).
NEBIUS_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B"
NEBIUS_EMBEDDING_MODELS = [
    {"id": NEBIUS_EMBEDDING_MODEL, "label": "Qwen3 Embedding 8B"},
]


def _https_endpoint(value: str) -> tuple[str, str]:
    """HTTPS and no embedded credentials; query strings and fragments are dropped.

    Returns (origin + path, path).
    """
    from urllib.parse import urlparse
    value = str(value or "").strip().strip('"').strip("'")
    if not value:
        return "", ""
    if "://" not in value:
        value = "https://" + value
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Use an HTTPS Nebius endpoint (https://...) without credentials in the URL.")
    path = parsed.path.rstrip("/")
    return f"https://{parsed.netloc}{path}", path


class Settings(StrictModel):
    # Nebius Token Factory is the only model provider (OpenAI SDK against its OpenAI-compatible /v1 API).
    provider: Provider = "nebius"
    # Filled from the nebius_* fields by active(); planning, budgeting and reports read these names.
    deployment: str = ""
    embedding_deployment: str = ""
    api_style: Literal["chat"] = "chat"
    chat_token_parameter: Literal["max_tokens", "max_completion_tokens"] = "max_tokens"
    # Token limits of the chosen model (NEBIUS_CONTEXT_WINDOW / NEBIUS_MAX_OUTPUT_TOKENS).
    context_window: int = Field(default=128000, ge=8192, le=2000000)
    max_output_tokens: int = Field(default=16000, ge=1024, le=128000)
    # Bring your own key: NEBIUS_BASE_URL, NEBIUS_API_KEY, NEBIUS_MODEL, NEBIUS_EMBEDDING_MODEL.
    nebius_endpoint: str = NEBIUS_DEFAULT_ENDPOINT
    nebius_api_key: SecretStr = SecretStr("")
    nebius_model: str = NEBIUS_DEFAULT_MODEL
    nebius_chat_token_parameter: Literal["max_tokens", "max_completion_tokens"] = "max_tokens"
    nebius_embedding_model: str = NEBIUS_EMBEDDING_MODEL                # fixed: Qwen/Qwen3-Embedding-8B
    # Code sandbox (QuSolids demos): Nebius sandbox, NEBIUS_PROJECT_ID.
    nebius_project_id: str = ""
    sandbox_provider: Literal["nebius"] = "nebius"

    @field_validator("nebius_endpoint")
    @classmethod
    def nebius_endpoint_shape(cls, value: str) -> str:
        value, path = _https_endpoint(value)
        if not value:
            return value
        low = path.lower()
        for suffix in ("/chat/completions", "/completions", "/embeddings", "/models"):
            if low.endswith(suffix):  # a pasted request URL: keep the API base
                value, low = value[: len(value) - len(suffix)], low[: len(low) - len(suffix)]
                break
        if not low.endswith("/v1"):
            if low:
                raise ValueError("Use the Nebius API base URL ending in /v1, e.g. " + NEBIUS_DEFAULT_ENDPOINT)
            value += "/v1"
        return value

    @field_validator("deployment", "embedding_deployment", "nebius_model", "nebius_embedding_model", "nebius_project_id")
    @classmethod
    def trim_value(cls, value: str) -> str:
        value = value.strip()
        if any(ord(c) < 32 for c in value):
            raise ValueError("Control characters are not allowed.")
        return value

    @field_validator("nebius_embedding_model", mode="after")
    @classmethod
    def fixed_embedding_model(cls, value: str) -> str:
        return NEBIUS_EMBEDDING_MODEL  # embeddings always use Qwen3-Embedding-8B

    @model_validator(mode="after")
    def check_budget(self):
        if self.max_output_tokens + 4096 >= self.context_window:
            raise ValueError(f"The context window ({self.context_window:,}) must exceed the maximum "
                             f"output tokens ({self.max_output_tokens:,}) plus 4,096.")
        return self

    def provider_configured(self, provider: str = "nebius") -> bool:
        return bool(self.nebius_endpoint and self.nebius_model and self.nebius_api_key.get_secret_value())

    def active(self) -> "Settings":
        """A copy whose deployment, embedding model and token parameter are the Nebius ones."""
        return self.model_copy(update={"deployment": self.nebius_model, "api_style": "chat",
                                       "chat_token_parameter": self.nebius_chat_token_parameter,
                                       "embedding_deployment": NEBIUS_EMBEDDING_MODEL})


class ModelInput(StrictModel):
    """Header switch: choose a Nebius model (also makes Nebius the active provider)."""
    model: str = Field(min_length=1, max_length=200)

    @field_validator("model")
    @classmethod
    def model_shape(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(c) < 32 for c in value):
            raise ValueError("Choose a valid model ID.")
        return value


class PromptInput(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1, max_length=24000)

    @field_validator("name", "content")
    @classmethod
    def not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Must not be blank.")
        return value


class WorkspaceInput(StrictModel):
    path: str = Field(min_length=1, max_length=4096)


class ReviewInput(StrictModel):
    workspace_id: str
    files: list[str] = Field(min_length=1, max_length=1000)
    prompt_id: str
    use_embeddings: bool = False


# Required, bounded fields keep the model contract and report layout predictable.
class Finding(StrictModel):
    severity: Literal["critical", "high", "medium", "low", "info"]
    category: str = Field(max_length=100)
    title: str = Field(max_length=180)
    file: str = Field(max_length=4096)
    line_start: int = Field(ge=1)
    line_end: int = Field(ge=1)
    evidence: str = Field(max_length=2000)
    impact: str = Field(max_length=2400)
    recommendation: str = Field(max_length=3000)


class Strength(StrictModel):
    title: str = Field(max_length=180)
    file: str = Field(max_length=4096)
    line_start: int = Field(ge=1)
    line_end: int = Field(ge=1)
    explanation: str = Field(max_length=2400)


class ReviewResult(StrictModel):
    summary: str = Field(min_length=1, max_length=6000)
    findings: list[Finding] = Field(max_length=100)
    strengths: list[Strength] = Field(max_length=50)
    next_steps: list[str] = Field(max_length=25)
    limitations: list[str] = Field(max_length=25)
