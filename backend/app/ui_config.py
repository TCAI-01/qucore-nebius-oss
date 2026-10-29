"""What the app shows: the four tools, the home page samples and QuBot options.

The app has one layout: four tabs — QuReview (QuCodRev, QuSonar, QuSolids and QuFlow as modes), QuCoder,
QuBot and QuScan — with a home page.

QUCORE_TABS               optional comma list limiting the tabs shown: review, coder, qa, quscan (empty = all four).
QUCORE_SAMPLE_REPOS       comma list of public GitHub repositories for the home page,
                          as owner/repo or owner/repo@branch (no defaults in code).
QUCORE_QA_DEFAULT_METHOD  QuBot's first method: default, hybrid or cursor (default: cursor).
QUCORE_GITHUB_IMPORT      'true' (default): "Import a public GitHub repository" is shown.
QUCORE_QA_HISTORY_TURNS   previous QuBot answers sent with "Include history" (default 5).
"""
from __future__ import annotations

import re

from . import env

TABS = ("review", "coder", "qa", "quscan")
QA_METHODS = ("default", "hybrid", "cursor")
_REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}(@[A-Za-z0-9._/-]{1,200})?$")


def tabs() -> list[str]:
    raw = [t.strip().lower() for t in env.setting("QUCORE_TABS").split(",") if t.strip()]
    chosen = [t for t in TABS if t in raw] if raw else list(TABS)
    return chosen or list(TABS)


def sample_repos() -> list[dict]:
    out = []
    for item in env.setting("QUCORE_SAMPLE_REPOS").split(","):
        item = item.strip()
        if not item or not _REPO.match(item):
            continue
        repo, _, ref = item.partition("@")
        out.append({"repo": repo, "ref": ref, "label": repo.split("/", 1)[1]})
    return out[:6]


def public() -> dict:
    method = env.setting("QUCORE_QA_DEFAULT_METHOD", "cursor").lower()
    return {"tabs": tabs(), "sample_repos": sample_repos(),
            "qa_default_method": method if method in QA_METHODS else "cursor",
            "github_import": env.flag("QUCORE_GITHUB_IMPORT", True),
            "qa_history_turns": env.integer("QUCORE_QA_HISTORY_TURNS", 5, 0, 30)}
