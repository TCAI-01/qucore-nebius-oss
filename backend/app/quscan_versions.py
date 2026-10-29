"""Version checks for QuScan: is the version a project uses inside an affected range?

pypi  PEP 440 versions and specifiers ("<1.84.0", ">=1.0,<1.5", "==2.3.1") through `packaging`.
npm   node-semver ranges ("<1.12.0", ">=1.0.0 <1.4.2", "^1.2.0", "~3.1", "1.x", "1.0.0 - 1.2.0", "a || b").

Every function answers None when it cannot decide, so callers never guess.
"""
from __future__ import annotations

import re

try:
    from packaging.specifiers import InvalidSpecifier, SpecifierSet
    from packaging.version import InvalidVersion, Version
except ImportError:  # pragma: no cover - packaging ships with pip, but stay usable without it
    SpecifierSet = Version = None
    InvalidSpecifier = InvalidVersion = ValueError

_WORDS = {"all", "all versions", "*", "any", "every version"}
_UNKNOWN = {"", "unknown", "n/a", "na", "none", "null", "-", "?"}


# ------------------------------------------------------------------- pypi ----

def _py_version(text: str):
    if Version is None:
        return None
    try:
        return Version(str(text).strip().lstrip("v"))
    except (InvalidVersion, TypeError):
        return None


def _py_spec(text: str):
    text = str(text or "").strip().replace(" ", "")
    if not text or SpecifierSet is None:
        return None
    if re.match(r"^\d", text):          # a bare version means exactly that version
        text = "==" + text
    text = text.replace("&&", ",").replace(";", ",")
    try:
        return SpecifierSet(text)
    except InvalidSpecifier:
        return None


# -------------------------------------------------------------------- npm ----

_SEMVER = re.compile(r"^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")


class _Semver:
    __slots__ = ("major", "minor", "patch", "pre")

    def __init__(self, major, minor, patch, pre=()):
        self.major, self.minor, self.patch, self.pre = major, minor, patch, pre

    def key(self):
        pre = tuple((0, int(p)) if p.isdigit() else (1, p) for p in self.pre)
        return (self.major, self.minor, self.patch, 0 if self.pre else 1, pre)

    def __lt__(self, other): return self.key() < other.key()
    def __le__(self, other): return self.key() <= other.key()
    def __gt__(self, other): return self.key() > other.key()
    def __ge__(self, other): return self.key() >= other.key()
    def __eq__(self, other): return isinstance(other, _Semver) and self.key() == other.key()
    def __hash__(self): return hash(self.key())

    def __str__(self):
        return f"{self.major}.{self.minor}.{self.patch}" + (f"-{'.'.join(self.pre)}" if self.pre else "")


def _sv(text: str) -> _Semver | None:
    match = _SEMVER.match(str(text or "").strip())
    if not match or any(g and g.lower() in ("x", "*") for g in match.groups()[:3]):
        return None
    major, minor, patch = (int(g) if g else 0 for g in match.groups()[:3])
    pre = tuple(match.group(4).split(".")) if match.group(4) else ()
    return _Semver(major, minor, patch, pre)


def _partial(text: str):
    """(major, minor, patch) with None for missing or wildcard parts, plus prerelease, or None."""
    match = _SEMVER.match(str(text or "").strip())
    if not match:
        return None
    parts = [None if (g is None or g.lower() in ("x", "*")) else int(g) for g in match.groups()[:3]]
    for i in range(1, 3):
        if parts[i - 1] is None:
            parts[i] = None
    return parts, (tuple(match.group(4).split(".")) if match.group(4) else ())


def _comparators(range_text: str) -> list[list[tuple[str, _Semver]]] | None:
    """A node-semver range as OR-ed groups of AND-ed (operator, version) comparators."""
    groups = []
    for part in re.split(r"\s*\|\|\s*", str(range_text or "").strip()):
        part = part.strip()
        if part in ("", "*", "x", "X", "latest"):
            groups.append([])
            continue
        hyphen = re.match(r"^(\S+)\s+-\s+(\S+)$", part)
        if hyphen:
            low, high = _partial(hyphen.group(1)), _partial(hyphen.group(2))
            if not low or not high:
                return None
            lo = _Semver(*(p or 0 for p in low[0]), low[1])
            (hm, hn, hp), _ = high
            if hp is not None:
                groups.append([(">=", lo), ("<=", _Semver(hm, hn, hp, high[1]))])
            elif hn is not None:
                groups.append([(">=", lo), ("<", _Semver(hm, hn + 1, 0, ("0",)))])
            else:
                groups.append([(">=", lo), ("<", _Semver(hm + 1, 0, 0, ("0",)))])
            continue
        group = []
        for token in re.findall(r"(?:[<>]=?|=|\^|~>?)?\s*v?[0-9xX*][0-9A-Za-z.+-]*", part.replace(",", " ")):
            token = token.replace(" ", "")
            op = re.match(r"^([<>]=?|=|\^|~>?)?", token).group(1) or ""
            parsed = _partial(token[len(op):])
            if not parsed:
                return None
            (major, minor, patch), pre = parsed
            if major is None:
                continue
            if op in ("^",):
                low = _Semver(major, minor or 0, patch or 0, pre)
                if major > 0:
                    high = _Semver(major + 1, 0, 0, ("0",))
                elif (minor or 0) > 0 or minor is None:
                    high = _Semver(0, (minor or 0) + 1, 0, ("0",)) if minor is not None else _Semver(1, 0, 0, ("0",))
                else:
                    high = _Semver(0, 0, (patch or 0) + 1, ("0",)) if patch is not None else _Semver(0, 1, 0, ("0",))
                group += [(">=", low), ("<", high)]
            elif op in ("~", "~>"):
                low = _Semver(major, minor or 0, patch or 0, pre)
                high = _Semver(major, (minor or 0) + 1, 0, ("0",)) if minor is not None else _Semver(major + 1, 0, 0, ("0",))
                group += [(">=", low), ("<", high)]
            elif op in ("", "=") and (minor is None or patch is None):
                low = _Semver(major, minor or 0, 0)
                high = _Semver(major + 1, 0, 0, ("0",)) if minor is None else _Semver(major, minor + 1, 0, ("0",))
                group += [(">=", low), ("<", high)]
            else:
                version = _Semver(major, minor or 0, patch or 0, pre)
                if op in ("<=", ">") and (minor is None or patch is None):
                    version = (_Semver(major + 1, 0, 0, ("0",)) if minor is None else _Semver(major, minor + 1, 0, ("0",)))
                    op = "<" if op == "<=" else ">="
                group.append((op or "=", version))
        groups.append(group)
    return groups


def _npm_match(version: _Semver, range_text: str) -> bool | None:
    groups = _comparators(range_text)
    if groups is None:
        return None
    for group in groups:
        ok = True
        for op, bound in group:
            if not {"<": version < bound, "<=": version <= bound, ">": version > bound, ">=": version >= bound,
                    "=": version == bound}[op]:
                ok = False
                break
        if ok:
            return True
    return False


# ------------------------------------------------------------------ shared ----

def parse(ecosystem: str, text: str):
    return _py_version(text) if ecosystem == "pypi" else _sv(text)


def in_range(ecosystem: str, version: str, range_text: str) -> bool | None:
    """True / False when the version is / is not in the range; None when either cannot be read."""
    text = str(range_text or "").strip()
    if text.lower() in _WORDS:
        return True
    if text.lower() in _UNKNOWN:
        return None
    if ecosystem == "pypi":
        v, spec = _py_version(version), _py_spec(text)
        if v is None or spec is None:
            return None
        return spec.contains(v, prereleases=True)
    v = _sv(version)
    return None if v is None else _npm_match(v, text)


def lowest_allowed(ecosystem: str, spec: str) -> str | None:
    """The smallest version a declared range allows (its lower bound), or None."""
    text = str(spec or "").strip()
    if not text:
        return None
    if ecosystem == "pypi":
        lows = re.findall(r"(?:>=|~=|===?)\s*([A-Za-z0-9.+!-]+)", text)
        return lows[0] if lows else None
    groups = _comparators(text)
    if not groups:
        return None
    lows = [str(b) for g in groups for op, b in g if op in (">=", "=")]
    return lows[0] if lows else None


def compare(ecosystem: str, a: str, b: str) -> int | None:
    """-1 / 0 / 1 like a three-way compare, or None when a version cannot be read."""
    va, vb = parse(ecosystem, a), parse(ecosystem, b)
    if va is None or vb is None:
        return None
    return -1 if va < vb else 1 if va > vb else 0


def verdict(ecosystem: str, version: str | None, spec: str | None, affected: list[str], fixed: list[str]) -> dict:
    """How a project's version relates to the affected ranges and fixed versions found for a package.

    status: vulnerable | safe | at_risk (an unpinned range can resolve to an affected version) | unknown
    """
    affected = [a for a in (affected or []) if str(a or "").strip()]
    fixed = [f for f in (fixed or []) if parse(ecosystem, f) is not None]
    if not affected and not fixed:
        return {"status": "unknown", "reason": "No affected version range was found in the sources."}
    if version:
        hits = [in_range(ecosystem, version, r) for r in affected]
        if any(h is True for h in hits):
            match = affected[hits.index(True)]
            return {"status": "vulnerable", "reason": f"{version} is inside the affected range {match}."}
        if affected and all(h is False for h in hits):
            return {"status": "safe", "reason": f"{version} is outside every affected range ({'; '.join(affected)})."}
        newest_fix = max(fixed, key=lambda f: parse(ecosystem, f)) if fixed else None
        if newest_fix and compare(ecosystem, version, newest_fix) is not None:
            if compare(ecosystem, version, newest_fix) < 0 and not affected:
                return {"status": "vulnerable", "reason": f"{version} is older than the fixed version {newest_fix}."}
            if compare(ecosystem, version, newest_fix) >= 0:
                return {"status": "safe", "reason": f"{version} is at or above the fixed version {newest_fix}."}
        return {"status": "unknown", "reason": "The affected range could not be compared with " + version + "."}
    low = lowest_allowed(ecosystem, spec or "")
    if not spec:
        return {"status": "at_risk", "reason": "No version is pinned or locked, so any version, including an affected one, can be installed."}
    if low:
        hits = [in_range(ecosystem, low, r) for r in affected]
        if any(h is True for h in hits):
            return {"status": "at_risk", "reason": f"The declared range {spec} allows {low}, which is affected."}
    return {"status": "at_risk", "reason": f"The declared range {spec} is not pinned, so the installed version cannot be proven safe."}


def upgrade_commands(ecosystem: str, name: str, target: str, tools: list[str], pinned: bool) -> list[dict]:
    """Ready-to-run commands and manifest lines that move a package to `target`."""
    if not target:
        return []
    out = []
    if ecosystem == "pypi":
        for tool in tools:
            if tool == "uv":
                out.append({"label": "uv", "command": f'uv add "{name}>={target}"'})
            elif tool == "poetry":
                out.append({"label": "Poetry", "command": f'poetry add "{name}@^{target}"'})
            elif tool == "pipenv":
                out.append({"label": "Pipenv", "command": f'pipenv install "{name}>={target}"'})
            elif tool == "pdm":
                out.append({"label": "PDM", "command": f'pdm add "{name}>={target}"'})
            elif tool == "pip":
                out.append({"label": "pip", "command": f'pip install --upgrade "{name}>={target}"'})
        out.append({"label": "requirements.txt", "command": f"{name}=={target}" if pinned else f"{name}>={target}"})
    else:
        for tool in tools:
            if tool == "pnpm":
                out.append({"label": "pnpm", "command": f"pnpm add {name}@{target}"})
            elif tool == "yarn":
                out.append({"label": "Yarn", "command": f"yarn add {name}@{target}"})
            else:
                out.append({"label": "npm", "command": f"npm install {name}@{target}"})
        out.append({"label": "package.json", "command": f'"{name}": "{target if pinned else "^" + target}"'})
    return out
