"""Deterministic facts and scores for Solidify (no model calls).

* The review taxonomy: six groups and 23 principles (SOLID, OOP, design patterns,
  architecture/HLD, low-level design, engineering practices).
* Structure facts per file (size, classes, functions, largest symbol, god-class
  candidates) from the same outline parser Code Q&A uses.
* The import graph between the selected files (Python via ast; JavaScript/TypeScript
  via relative imports), fan-in/fan-out and circular dependencies (Tarjan SCC).
* Scores: findings are weighted by severity and turned into 0-100 scores per
  principle, per group and overall. The model reports findings; the arithmetic is
  done here so the numbers are consistent and explainable.
"""
from __future__ import annotations

import ast
import math
import posixpath
import re
from collections import defaultdict

from .qa_chunker import language, outline

SEVERITIES = ("critical", "high", "medium", "low", "info")
SEVERITY_RANK = {name: index for index, name in enumerate(SEVERITIES)}
SEVERITY_WEIGHT = {"critical": 18.0, "high": 10.0, "medium": 5.0, "low": 2.0, "info": 0.0}

GROUPS = [
    {"key": "solid", "short": "SOLID", "label": "SOLID principles", "weight": 0.25,
     "hint": "Single responsibility, open/closed, Liskov, interface segregation, dependency inversion"},
    {"key": "oop", "short": "OOP", "label": "Object-oriented design", "weight": 0.15,
     "hint": "Encapsulation, inheritance, polymorphism, abstraction"},
    {"key": "patterns", "short": "Patterns", "label": "Design patterns", "weight": 0.10,
     "hint": "Creational, structural and behavioral patterns: used, missing or misapplied"},
    {"key": "architecture", "short": "Architecture", "label": "Architecture (HLD)", "weight": 0.20,
     "hint": "Modularity, coupling and cohesion, layering and data flow, scalability"},
    {"key": "lld", "short": "LLD", "label": "Low-level design", "weight": 0.15,
     "hint": "Error handling and validation, interfaces and contracts, data structures"},
    {"key": "practices", "short": "Practices", "label": "Engineering practices", "weight": 0.15,
     "hint": "Security, performance, coding standards, testability"},
]
GROUP_INFO = {g["key"]: g for g in GROUPS}
GROUP_ORDER = {g["key"]: i for i, g in enumerate(GROUPS)}

_PRINCIPLES = [
    ("SRP", "solid", "Single Responsibility"), ("OCP", "solid", "Open/Closed"),
    ("LSP", "solid", "Liskov Substitution"), ("ISP", "solid", "Interface Segregation"),
    ("DIP", "solid", "Dependency Inversion"),
    ("ENCAPSULATION", "oop", "Encapsulation"), ("INHERITANCE", "oop", "Inheritance"),
    ("POLYMORPHISM", "oop", "Polymorphism"), ("ABSTRACTION", "oop", "Abstraction"),
    ("CREATIONAL", "patterns", "Creational patterns"), ("STRUCTURAL", "patterns", "Structural patterns"),
    ("BEHAVIORAL", "patterns", "Behavioral patterns"),
    ("MODULARITY", "architecture", "Modularity and boundaries"), ("COUPLING", "architecture", "Coupling and cohesion"),
    ("LAYERING", "architecture", "Layering and data flow"), ("SCALABILITY", "architecture", "Scalability"),
    ("ERROR_HANDLING", "lld", "Error handling and validation"), ("INTERFACES", "lld", "Interfaces and contracts"),
    ("DATA_STRUCTURES", "lld", "Data structures and algorithms"),
    ("SECURITY", "practices", "Security"), ("PERFORMANCE", "practices", "Performance"),
    ("CODING_STANDARDS", "practices", "Coding standards"), ("TESTABILITY", "practices", "Testability"),
]
PRINCIPLE_INFO = {key: {"key": key, "group": group, "label": label} for key, group, label in _PRINCIPLES}
PRINCIPLE_ORDER = {key: i for i, (key, _, _) in enumerate(_PRINCIPLES)}

_ALIASES = {
    "SINGLE_RESPONSIBILITY": "SRP", "OPEN_CLOSED": "OCP", "OPEN_CLOSED_PRINCIPLE": "OCP",
    "LISKOV": "LSP", "LISKOV_SUBSTITUTION": "LSP", "INTERFACE_SEGREGATION": "ISP",
    "DEPENDENCY_INVERSION": "DIP", "DEPENDENCY_INJECTION": "DIP", "COHESION": "COUPLING",
    "LAYERS": "LAYERING", "SEPARATION_OF_CONCERNS": "LAYERING", "VALIDATION": "ERROR_HANDLING",
    "ERRORS": "ERROR_HANDLING", "ERROR": "ERROR_HANDLING", "API": "INTERFACES", "INTERFACE": "INTERFACES",
    "STANDARDS": "CODING_STANDARDS", "NAMING": "CODING_STANDARDS", "DUPLICATION": "CODING_STANDARDS",
    "MAINTAINABILITY": "CODING_STANDARDS", "READABILITY": "CODING_STANDARDS", "TESTING": "TESTABILITY",
    "TESTS": "TESTABILITY", "SCALING": "SCALABILITY", "COMPLEXITY": "CODING_STANDARDS",
    "CREATIONAL_PATTERNS": "CREATIONAL", "STRUCTURAL_PATTERNS": "STRUCTURAL", "BEHAVIOURAL": "BEHAVIORAL",
    "BEHAVIORAL_PATTERNS": "BEHAVIORAL", "DATA_STRUCTURE": "DATA_STRUCTURES", "ALGORITHMS": "DATA_STRUCTURES",
}


def normalize_principle(value) -> str:
    """Map whatever the model wrote to a taxonomy key (default: CODING_STANDARDS)."""
    key = re.sub(r"[^A-Za-z]+", "_", str(value or "")).strip("_").upper()
    if key in PRINCIPLE_INFO:
        return key
    if key in _ALIASES:
        return _ALIASES[key]
    for known in PRINCIPLE_INFO:
        if key and (key.startswith(known + "_") or known.startswith(key + "_")):
            return known
    return "CODING_STANDARDS"


# ------------------------------------------------------------------ structure ----

_CLASS_KINDS = {"class", "struct", "interface", "enum", "type", "impl"}


def file_metrics(sources) -> list[dict]:
    rows = []
    for src in sources:
        items = outline(src.path, src.text)
        classes = [i for i in items if i["kind"] in _CLASS_KINDS]
        size = lambda item: item["end"] - item["start"] + 1  # noqa: E731
        biggest = max(items, key=size, default=None)
        god = []
        for cls in classes:
            inside = [i for i in items if i is not cls and i["kind"] not in _CLASS_KINDS
                      and i["start"] >= cls["start"] and i["end"] <= cls["end"]]
            if size(cls) >= 300 or len(inside) >= 20:
                god.append({"name": cls["name"], "lines": size(cls), "methods": len(inside)})
        rows.append({
            "path": src.path, "lines": src.lines, "language": language(src.path) or "",
            "classes": len(classes), "functions": len([i for i in items if i["kind"] not in _CLASS_KINDS]),
            "largest": ({"name": biggest["name"], "kind": biggest["kind"], "lines": size(biggest)} if biggest else None),
            "long_symbols": len([i for i in items if size(i) > 80]), "god_classes": god,
        })
    return rows


# ------------------------------------------------------------------ imports ----

_JS_IMPORT = re.compile(r"""(?:from\s+|require\(\s*|import\(\s*|import\s+)['"](\.[^'"]+)['"]""")
_JS_EXT = ("", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs")
_JS_LANGS = {"javascript", "jsx", "typescript", "tsx"}


def _python_targets(src, paths: set[str], by_dotted: dict[str, set[str]]) -> set[str]:
    try:
        tree = ast.parse(src.text)
    except (SyntaxError, ValueError):
        return set()
    folder = src.path.rsplit("/", 1)[0].split("/") if "/" in src.path else []
    out: set[str] = set()

    def pick(dotted: str):
        found = by_dotted.get(dotted)
        return next(iter(found)) if found and len(found) == 1 else None

    def relative(level: int, module: str, names: list[str]):
        if level - 1 > len(folder):
            return
        base = folder[: len(folder) - (level - 1)]
        mod = module.split(".") if module else []
        for candidate in ("/".join(base + mod) + ".py", "/".join(base + mod + ["__init__.py"])):
            if candidate in paths:
                out.add(candidate)
        for name in names:
            for candidate in ("/".join(base + mod + [name]) + ".py", "/".join(base + mod + [name, "__init__.py"])):
                if candidate in paths:
                    out.add(candidate)

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                target = pick(alias.name)
                if target:
                    out.add(target)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                relative(node.level, node.module or "", [a.name for a in node.names])
            elif node.module:
                target = pick(node.module)
                if target:
                    out.add(target)
                for alias in node.names:
                    sub = pick(node.module + "." + alias.name)
                    if sub:
                        out.add(sub)
    return out


def _js_targets(src, paths: set[str]) -> set[str]:
    folder = src.path.rsplit("/", 1)[0] if "/" in src.path else ""
    out: set[str] = set()
    for match in _JS_IMPORT.finditer(src.text):
        base = posixpath.normpath(posixpath.join(folder, match.group(1)))
        if base.startswith(".."):
            continue
        for candidate in [base + ext for ext in _JS_EXT] + [base + "/index" + ext for ext in _JS_EXT[1:]]:
            if candidate in paths:
                out.add(candidate)
                break
    return out


def _cycles(adj: dict[str, list[str]]) -> list[list[str]]:
    """Strongly connected components with more than one file (iterative Tarjan)."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    out: list[list[str]] = []
    counter = 0
    for root in adj:
        if root in index:
            continue
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        work = [(root, iter(adj[root]))]
        while work:
            node, neighbours = work[-1]
            descended = False
            for nxt in neighbours:
                if nxt not in index:
                    index[nxt] = low[nxt] = counter
                    counter += 1
                    stack.append(nxt)
                    on_stack.add(nxt)
                    work.append((nxt, iter(adj[nxt])))
                    descended = True
                    break
                if nxt in on_stack:
                    low[node] = min(low[node], index[nxt])
            if descended:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                component = []
                while True:
                    member = stack.pop()
                    on_stack.discard(member)
                    component.append(member)
                    if member == node:
                        break
                if len(component) > 1:
                    out.append(sorted(component))
    return out


def dependency_graph(sources) -> dict:
    paths = {s.path for s in sources}
    by_dotted: dict[str, set[str]] = defaultdict(set)
    for path in paths:
        if path.endswith(".py"):
            parts = path[:-3].split("/")
            if parts[-1] == "__init__":
                parts = parts[:-1]
            for i in range(len(parts)):
                by_dotted[".".join(parts[i:])].add(path)
    supported = False
    edges: set[tuple[str, str]] = set()
    for src in sources:
        lang = language(src.path)
        if lang == "python":
            targets = _python_targets(src, paths, by_dotted)
        elif lang in _JS_LANGS:
            targets = _js_targets(src, paths)
        else:
            continue
        supported = True
        edges.update((src.path, t) for t in targets if t != src.path)
    adj: dict[str, list[str]] = {p: [] for p in sorted(paths)}
    fan_in: dict[str, int] = defaultdict(int)
    for a, b in sorted(edges):
        adj[a].append(b)
        fan_in[b] += 1
    nodes = [{"path": p, "fan_in": fan_in.get(p, 0), "fan_out": len(adj[p])} for p in adj]
    nodes = [n for n in nodes if n["fan_in"] or n["fan_out"]]
    nodes.sort(key=lambda n: (-(n["fan_in"] + n["fan_out"]), n["path"]))
    return {"supported": supported, "edges": len(edges), "nodes": nodes[:40],
            "cycles": _cycles(adj)[:10]}


def facts_markdown(metrics: list[dict], deps: dict, limit: int = 80) -> str:
    """Compact, tool-computed facts handed to the model with the code."""
    degree = {n["path"]: n for n in deps.get("nodes", [])}
    rows = sorted(metrics, key=lambda m: -m["lines"])[:limit]
    lines = ["## Structure facts (computed by tools, not model-generated)", "",
             "| File | Lines | Classes | Functions | Largest symbol | Fan-in | Fan-out |", "|---|---|---|---|---|---|---|"]
    for m in rows:
        big = m["largest"]
        d = degree.get(m["path"])
        lines.append(f"| {m['path']} | {m['lines']} | {m['classes']} | {m['functions']} | "
                     f"{(big['name'] + ' (' + str(big['lines']) + ' lines)') if big else '-'} | "
                     f"{d['fan_in'] if d else (0 if deps.get('supported') else '-')} | "
                     f"{d['fan_out'] if d else (0 if deps.get('supported') else '-')} |")
    if len(metrics) > limit:
        lines.append(f"| ... {len(metrics) - limit} more smaller files | | | | | | |")
    god = [(m["path"], g) for m in metrics for g in m["god_classes"]]
    if god:
        lines += ["", "God-class candidates: " + "; ".join(
            f"{g['name']} in {p} ({g['lines']} lines, {g['methods']} members)" for p, g in god[:12])]
    if deps.get("cycles"):
        lines += ["", "Circular dependencies between files: " + " | ".join(" <-> ".join(c) for c in deps["cycles"][:6])]
    elif deps.get("supported"):
        lines += ["", "Circular dependencies between files: none found."]
    else:
        lines += ["", "Import graph: not computed for these languages."]
    return "\n".join(lines)


# ------------------------------------------------------------------- scoring ----

def grade(score: float | None) -> str:
    if score is None:
        return "-"
    return "A" if score >= 90 else "B" if score >= 80 else "C" if score >= 70 else "D" if score >= 55 else "F"


def _scale(total_lines: int) -> float:
    return 25.0 + 15.0 * math.sqrt(max(total_lines, 200) / 1000.0)


def _to_score(weight: float, scale: float) -> int:
    return int(round(100.0 / (1.0 + weight / scale)))


def compute_scores(findings: list[dict], total_lines: int, enabled: list[str]) -> dict:
    """0-100 scores: 100 / (1 + severity-weighted findings / size scale)."""
    scale = _scale(total_lines)
    by_principle: dict[str, list[dict]] = defaultdict(list)
    for finding in findings:
        by_principle[finding["principle"]].append(finding)
    principles, groups = [], []
    for key, info in PRINCIPLE_INFO.items():
        if info["group"] not in enabled:
            continue
        items = by_principle.get(key, [])
        weight = sum(SEVERITY_WEIGHT[f["severity"]] for f in items)
        principles.append({"key": key, "group": info["group"], "label": info["label"],
                           "score": _to_score(weight, scale), "findings": len(items)})
    total, weights = 0.0, 0.0
    for group in GROUPS:
        if group["key"] not in enabled:
            groups.append({"key": group["key"], "short": group["short"], "label": group["label"],
                           "score": None, "findings": 0, "evaluated": False, "weight": group["weight"]})
            continue
        items = [f for f in findings if PRINCIPLE_INFO[f["principle"]]["group"] == group["key"]]
        weight = sum(SEVERITY_WEIGHT[f["severity"]] for f in items)
        score = _to_score(weight, scale)
        groups.append({"key": group["key"], "short": group["short"], "label": group["label"], "score": score,
                       "findings": len(items), "evaluated": True, "weight": group["weight"]})
        total += score * group["weight"]
        weights += group["weight"]
    overall = int(round(total / weights)) if weights else None
    return {"overall": {"score": overall, "grade": grade(overall)}, "groups": groups, "principles": principles}
