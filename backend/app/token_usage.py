"""Local estimates and per-run pricing. No model calls during planning."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from dotenv import dotenv_values
from .config import ENV_FILE


class PlanningError(ValueError):
    pass


@dataclass(frozen=True)
class Options:
    encoding: str
    safety_tokens: int
    input_price: Decimal | None
    output_price: Decimal | None
    embedding_price: Decimal | None
    # Recorded with every run's cost (dashboard): which model and keys, and where the prices came from.
    provider: str = ""
    model: str = ""
    embedding_model: str = ""
    source: str = "env"            # "env" (backend/.env) or the live source (pricing.py): litellm
    price_key: str = ""            # the catalogue entry used, e.g. nebius/<model>
    keys: str = ""                 # "byok": your own Nebius key from backend/.env

    def prices(self):
        return {"currency": "USD", "input_per_million": str(self.input_price) if self.input_price is not None else None,
                "output_per_million": str(self.output_price) if self.output_price is not None else None,
                "embedding_per_million": str(self.embedding_price) if self.embedding_price is not None else None,
                "provider": self.provider, "model": self.model, "embedding_model": self.embedding_model,
                "source": self.source, "price_key": self.price_key, "keys": self.keys}


def options() -> Options:
    values = dotenv_values(ENV_FILE, interpolate=False)
    def rate(key):
        raw = values.get(key)
        if raw in (None, ""):
            return None
        try:
            number = Decimal(raw)
        except InvalidOperation as exc:
            raise PlanningError(f"{key} must be a non-negative USD amount.") from exc
        if not number.is_finite() or not 0 <= number <= 1000000:
            raise PlanningError(f"{key} must be a finite USD amount between 0 and 1000000.")
        return number
    try:
        margin = int(values.get("QUCORE_CONTEXT_SAFETY_TOKENS") or "4096")
    except ValueError as exc:
        raise PlanningError("QUCORE_CONTEXT_SAFETY_TOKENS must be an integer.") from exc
    if not 256 <= margin <= 100000:
        raise PlanningError("QUCORE_CONTEXT_SAFETY_TOKENS must be between 256 and 100000.")
    # Fallback prices (USD per million tokens) for models the live price catalogue does not know.
    input_price, output_price = rate("NEBIUS_INPUT_COST_PER_MILLION"), rate("NEBIUS_OUTPUT_COST_PER_MILLION")
    embedding_price = rate("NEBIUS_EMBEDDING_COST_PER_MILLION")
    meta = {"source": "env", "keys": "byok"}  # every call uses your own Nebius key (backend/.env)
    # Live prices (pricing.py, QUCORE_LIVE_PRICING): the current price of the model actually used, when the
    # stored catalogue knows it; otherwise the .env prices above, exactly as before.
    try:
        from . import pricing
        live = pricing.live_rates()
    except Exception:  # noqa: BLE001 - pricing must never stop a run
        live = None
    if live:
        meta.update(provider=live["provider"], model=live["model"], embedding_model=live["embedding_model"])
        chat, emb = live["chat"], live["embedding"]
        if chat and chat["input"] is not None and chat["output"] is not None:
            input_price, output_price = pricing.decimal(chat["input"]), pricing.decimal(chat["output"])
            meta.update(source=chat["source"], price_key=chat["key"])
        if emb and emb["input"] is not None:
            embedding_price = pricing.decimal(emb["input"])
    return Options(values.get("QUCORE_TOKEN_ENCODING") or "o200k_base", margin,
                   input_price, output_price, embedding_price, **meta)


@lru_cache(maxsize=4)
def encoder(name):
    try:
        import tiktoken
        return tiktoken.get_encoding(name)
    except Exception:
        # First-use vocabulary download may be unavailable offline. Do not use
        # chars/4 or pretend those are exact tokens; fall back conservatively.
        return None


class Counter:
    def __init__(self, config: Options):
        self.config = config
        self.encoding = encoder(config.encoding)
        self.method = config.encoding if self.encoding else "UTF-8 byte upper bound (tokenizer unavailable)"

    def count(self, value: str) -> int:
        if self.encoding:
            return len(self.encoding.encode(value, disallowed_special=()))
        return len(value.encode("utf-8"))

    def request(self, instructions: str, payload: str) -> int:
        # Tokenizer estimates are not provider billing measurements. Keep an
        # explicit allowance for message framing and deployment differences.
        return self.count(instructions) + self.count(payload) + self.config.safety_tokens


def price(tokens: int, rate: Decimal | None):
    return None if rate is None else float(Decimal(tokens) * rate / Decimal(1000000))


def empty_usage():
    return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0,
            "embedding_tokens": 0, "requests": 0, "embedding_requests": 0,
            "unreported_requests": 0}


def add_usage(total: dict, raw: dict | None, kind="llm"):
    total["requests" if kind == "llm" else "embedding_requests"] += 1
    if not raw:
        total["unreported_requests"] += 1
        return
    if kind == "embedding":
        total["embedding_tokens"] += raw.get("total_tokens", raw.get("prompt_tokens", 0)) or 0
        return
    incoming = raw.get("input_tokens", raw.get("prompt_tokens", 0)) or 0
    outgoing = raw.get("output_tokens", raw.get("completion_tokens", 0)) or 0
    total["input_tokens"] += incoming
    total["output_tokens"] += outgoing  # Includes reasoning tokens; do not add twice.
    total["total_tokens"] += incoming + outgoing


def cost(usage: dict, config: Options) -> dict:
    incoming = price(usage["input_tokens"], config.input_price)
    outgoing = price(usage["output_tokens"], config.output_price)
    embedding = price(usage["embedding_tokens"], config.embedding_price) if usage["embedding_tokens"] else 0.0
    known = sum(value for value in (incoming, outgoing, embedding) if value is not None)
    complete = all(value is not None for value in (incoming, outgoing, embedding)) and not usage["unreported_requests"]
    return {"input_usd": incoming, "output_usd": outgoing, "embedding_usd": embedding,
            "known_subtotal_usd": known, "total_usd": known if complete else None,
            "complete": complete, "rates": config.prices(),
            "basis": "Reported provider usage × configured rates. Not an invoice; retries without returned usage, cached discounts, and provider billing tiers are not reconciled."}
