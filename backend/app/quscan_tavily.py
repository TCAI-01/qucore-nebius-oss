"""Tavily access for QuScan: web search, page extraction and crawling, plus an OpenCVE table reader.

Uses the official SDK when it is installed (`pip install tavily-python`):

    from tavily import TavilyClient
    client = TavilyClient(api_key="tvly-...")
    client.search("...")                       # ranked results with title, url, content, score, published_date
    client.extract("https://...")              # {"results": [{"url", "raw_content"}], "failed_results": [...]}
    client.crawl("https://...", instructions="...")

and the same REST endpoints over HTTPS otherwise, so a missing SDK never blocks a scan.
The key is TAVILY_API_KEY in backend/.env (Credentials > Tavily).
"""
from __future__ import annotations

import re
import threading
from urllib.parse import quote_plus, urlparse

from dotenv import dotenv_values

from . import config

API = "https://api.tavily.com"
TIMEOUT = 60
OPENCVE_SEARCH = "https://app.opencve.io/cve/?q={query}"
_LOCK = threading.Lock()


class TavilyError(RuntimeError):
    pass


def api_key() -> str:
    values = dotenv_values(config.ENV_FILE, interpolate=False) if config.ENV_FILE.exists() else {}
    return str(values.get("TAVILY_API_KEY") or "").strip()


class Tavily:
    """A small, thread-safe wrapper that counts requests (Tavily bills per request and depth)."""

    def __init__(self, key: str | None = None):
        self.key = (key or api_key()).strip()
        if not self.key:
            raise TavilyError("Add your Tavily API key in Credentials > Tavily web search.")
        self.calls = {"search": 0, "extract": 0, "crawl": 0, "failed": 0}
        self._sdk = None
        try:
            from tavily import TavilyClient  # official SDK
            self._sdk = TavilyClient(api_key=self.key)
        except Exception:  # noqa: BLE001 - fall back to the REST API
            self._sdk = None

    def _count(self, kind: str) -> None:
        with _LOCK:
            self.calls[kind] += 1

    def _post(self, path: str, body: dict) -> dict:
        import httpx
        try:
            response = httpx.post(f"{API}{path}", json=body, timeout=TIMEOUT,
                                  headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        except httpx.HTTPError as exc:
            raise TavilyError(f"Tavily could not be reached ({type(exc).__name__}).") from None
        if response.status_code in (401, 403):
            raise TavilyError("Tavily rejected the API key. Check it in Credentials > Tavily web search.")
        if response.status_code == 429:
            raise TavilyError("Tavily rate limit or plan quota reached. Try again later or lower the scan size.")
        if response.status_code == 432 or response.status_code == 433:
            raise TavilyError("Your Tavily plan or credit limit has been reached.")
        if response.status_code >= 400:
            raise TavilyError(f"Tavily returned HTTP {response.status_code}.")
        return response.json()

    def _call(self, kind: str, sdk_call, path: str, body: dict) -> dict:
        self._count(kind)
        try:
            if self._sdk is not None:
                return sdk_call() or {}
            return self._post(path, body)
        except TavilyError:
            self._count("failed")
            raise
        except Exception as exc:  # noqa: BLE001 - SDK errors carry their own message; keep the key out of it
            self._count("failed")
            message = str(exc).replace(self.key, "***")[:300]
            if re.search(r"unauthori[sz]ed|invalid api key|401|403", message, re.I):
                raise TavilyError("Tavily rejected the API key. Check it in Credentials > Tavily web search.") from None
            if re.search(r"429|rate limit|quota|credit", message, re.I):
                raise TavilyError("Tavily rate limit or credit limit reached. Try again later or lower the scan size.") from None
            raise TavilyError(f"Tavily request failed: {message}") from None

    def search(self, query: str, *, topic: str = "general", depth: str = "basic", max_results: int = 5,
               time_range: str | None = None, include_answer: bool = True, include_domains: list[str] | None = None) -> dict:
        body = {"query": query[:400], "topic": topic, "search_depth": depth, "max_results": max(1, min(int(max_results), 20)),
                "include_answer": "basic" if include_answer else False, "include_raw_content": False,
                "include_favicon": True}
        if time_range and time_range != "none":
            body["time_range"] = time_range
        if include_domains:
            body["include_domains"] = include_domains

        def sdk():
            args = {k: v for k, v in body.items() if k != "query"}
            return self._sdk.search(query[:400], **args)
        return self._call("search", sdk, "/search", body)

    def extract(self, urls: list[str], *, depth: str = "basic") -> dict:
        urls = [u for u in urls if u][:20]
        body = {"urls": urls, "extract_depth": depth, "format": "markdown", "include_favicon": True}
        return self._call("extract", lambda: self._sdk.extract(urls, extract_depth=depth, format="markdown",
                                                               include_favicon=True), "/extract", body)

    def crawl(self, url: str, *, instructions: str, limit: int = 8, max_depth: int = 1) -> dict:
        body = {"url": url, "instructions": instructions, "limit": limit, "max_depth": max_depth,
                "extract_depth": "basic", "format": "markdown"}
        return self._call("crawl", lambda: self._sdk.crawl(url, instructions=instructions, limit=limit,
                                                           max_depth=max_depth, extract_depth="basic",
                                                           format="markdown"), "/crawl", body)


# --------------------------------------------------------------- results ----

def domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower().removeprefix("www.")
    except ValueError:
        return ""


def clean_results(response: dict, limit_chars: int) -> list[dict]:
    """Tavily search results as plain dicts with the fields QuScan keeps."""
    out = []
    for item in (response or {}).get("results") or []:
        url = str(item.get("url") or "")
        if not url.startswith("http"):
            continue
        content = re.sub(r"\n{3,}", "\n\n", str(item.get("raw_content") or item.get("content") or ""))[:limit_chars]
        out.append({"url": url, "title": str(item.get("title") or domain(url))[:300], "content": content,
                    "score": round(float(item.get("score") or 0), 3), "published_date": str(item.get("published_date") or ""),
                    "favicon": str(item.get("favicon") or ""), "domain": domain(url)})
    return out


def opencve_url(name: str) -> str:
    return OPENCVE_SEARCH.format(query=quote_plus(name))


_CVE_ROW = re.compile(r"\|\s*\[?(CVE-\d{4}-\d{4,})\]?(?:\([^)]*\))?\s*\|(.*?)\|(.*?)\|\s*(\d{4}-\d{2}-\d{2})?\s*\|\s*([^|]*)\|")
_CVSS = re.compile(r"(\d+(?:\.\d+)?)\s*(Critical|High|Medium|Low|None)?", re.I)


def _plain(cell: str) -> str:
    cell = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", cell)
    return re.sub(r"\s+", " ", cell.replace("\\_", "_")).strip(" |")


def parse_opencve(markdown: str, name: str) -> list[dict]:
    """CVE rows from an OpenCVE search page (as Tavily extracts it), kept only when the product matches the package.

    OpenCVE search is full-text, so a row is kept when the package name appears in its vendor or product cells.
    """
    rows = []
    text = str(markdown or "")
    wanted = re.sub(r"[^a-z0-9]", "", name.lower().split("/")[-1])
    for match in _CVE_ROW.finditer(text):
        cve, vendors, products, updated, cvss = match.groups()
        product_text = re.sub(r"[^a-z0-9]", "", (_plain(vendors) + _plain(products)).lower())
        if wanted and wanted not in product_text:
            continue
        rest = text[match.end():match.end() + 4000]
        desc = re.match(r"\s*\n?\|\s*(.+?)\s*\|", rest)
        score = _CVSS.match(cvss.strip()) if cvss and cvss.strip() not in ("N/A", "") else None
        rows.append({"id": cve, "updated": updated or "", "cvss": float(score.group(1)) if score else None,
                     "severity": (score.group(2) or "").lower() if score else "",
                     "products": _plain(products)[:200], "summary": _plain(desc.group(1))[:2400] if desc else "",
                     "url": f"https://app.opencve.io/cve/{cve}"})
    seen, unique = set(), []
    for row in rows:
        if row["id"] not in seen:
            seen.add(row["id"])
            unique.append(row)
    return unique
