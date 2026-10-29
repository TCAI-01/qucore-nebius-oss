"""QuScan: find every dependency a folder declares, locks or has installed.

Read-only. Nothing is executed and no network is used. Package names come only from the files found here.

Declared   requirements*.txt / *.in, constraints*.txt, pyproject.toml (PEP 621, Poetry, dependency groups),
           Pipfile, setup.cfg, package.json
Locked     Pipfile.lock, poetry.lock, uv.lock, pdm.lock, package-lock.json, npm-shrinkwrap.json, yarn.lock,
           pnpm-lock.yaml
Installed  Python virtual environments (any folder with pyvenv.cfg: *.dist-info/METADATA in site-packages)
           and node_modules (each top-level package's package.json, scoped packages included)

The result is one row per (ecosystem, normalised name). The version used for checks is, in order: installed,
locked, an exact pin in a declaration. A declared range is kept as "spec".
"""
from __future__ import annotations

import configparser
import json
import os
import re
try:                                   # Python 3.11+ standard library
    import tomllib
except ModuleNotFoundError:            # Python 3.10: the same parser, published as "tomli"
    try:
        import tomli as tomllib
    except ModuleNotFoundError:        # neither installed: TOML files are skipped with a note
        tomllib = None
from pathlib import Path

ECOSYSTEMS = {"pypi": "Python (PyPI)", "npm": "JavaScript (npm)"}
MAX_MANIFESTS = 300
MAX_PACKAGES = 6000
MAX_BYTES = 12 * 1024 * 1024
SKIP_DIRS = {".git", ".hg", ".svn", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".nox",
             ".idea", ".vscode", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", "dist", "build", "coverage",
             "htmlcov", ".gradle", ".terraform", "bower_components", "jspm_packages", "data"}

_REQ_LINE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$")
_EXACT_PY = re.compile(r"^===?\s*([A-Za-z0-9._+!-]+)$")
_SEMVER_EXACT = re.compile(r"^v?=?\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$")


def normalise(ecosystem: str, name: str) -> str:
    name = (name or "").strip()
    if ecosystem == "pypi":
        return re.sub(r"[-_.]+", "-", name).lower()
    return name.lower()


def _read(path: Path) -> str | None:
    try:
        if path.stat().st_size > MAX_BYTES:
            return None
        return path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return None


class Inventory:
    def __init__(self, root: Path):
        self.root = root
        self.packages: dict[tuple[str, str], dict] = {}
        self.manifests: list[dict] = []
        self.notes: list[str] = []

    def rel(self, path: Path) -> str:
        try:
            return path.relative_to(self.root).as_posix()
        except ValueError:
            return path.name

    def manifest(self, path: Path, kind: str, ecosystem: str, role: str, count: int) -> None:
        if count:
            self.manifests.append({"path": self.rel(path), "kind": kind, "ecosystem": ecosystem, "role": role, "count": count})

    def add(self, ecosystem: str, name: str, *, version: str | None = None, spec: str | None = None, role: str,
            source: str, direct: bool = True, section: str = "") -> bool:
        key = normalise(ecosystem, name)
        if not key or len(self.packages) >= MAX_PACKAGES and (ecosystem, key) not in self.packages:
            return False
        row = self.packages.setdefault((ecosystem, key), {
            "key": f"{ecosystem}:{key}", "ecosystem": ecosystem, "name": name.strip(), "id": key,
            "declared": None, "locked": None, "installed": None, "spec": None, "direct": False,
            "sources": [], "sections": [],
        })
        version = (version or "").strip().lstrip("v") or None
        if role == "declared":
            row["direct"] = row["direct"] or direct
            if spec and not row["spec"]:
                row["spec"] = spec.strip()
            exact = _exact_from_spec(ecosystem, spec or "")
            if exact and not row["declared"]:
                row["declared"] = exact
            row["name"] = name.strip() or row["name"]
        elif role == "locked":
            row["locked"] = row["locked"] or version
            row["direct"] = row["direct"] or direct
        elif role == "installed":
            row["installed"] = row["installed"] or version
        if source not in row["sources"]:
            row["sources"].append(source)
        if section and section not in row["sections"]:
            row["sections"].append(section)
        return True

    def result(self) -> dict:
        rows = []
        for row in self.packages.values():
            row = dict(row)
            row["version"] = row["installed"] or row["locked"] or row["declared"]
            row["version_from"] = ("installed" if row["installed"] else "locked" if row["locked"]
                                   else "pinned" if row["declared"] else "unpinned")
            # Something only seen in a lock file or an environment is a transitive dependency.
            rows.append(row)
        rows.sort(key=lambda r: (not r["direct"], r["ecosystem"], r["id"]))
        counts = {eco: sum(1 for r in rows if r["ecosystem"] == eco) for eco in ECOSYSTEMS}
        return {"root": str(self.root), "packages": rows, "manifests": sorted(self.manifests, key=lambda m: m["path"]),
                "counts": {"total": len(rows), "direct": sum(1 for r in rows if r["direct"]), **counts,
                           "manifests": len(self.manifests)},
                "notes": self.notes[:20]}


def _exact_from_spec(ecosystem: str, spec: str) -> str | None:
    spec = (spec or "").strip()
    if ecosystem == "pypi":
        match = _EXACT_PY.match(spec.split(";")[0].strip())
        return match.group(1) if match else None
    match = _SEMVER_EXACT.match(spec)
    return match.group(1) if match else None


# ------------------------------------------------------------------ Python ----

def _parse_requirement(line: str) -> tuple[str, str] | None:
    line = line.split(" #", 1)[0].strip()
    if not line or line.startswith(("#", "-", "git+", "http://", "https://", "file:", ".")):
        return None
    if "@" in line and "://" in line:          # name @ https://... (a direct reference)
        name = line.split("@", 1)[0].strip()
        return (name, "direct reference") if _REQ_LINE.match(name) else None
    match = _REQ_LINE.match(line)
    if not match:
        return None
    spec = match.group(3).split(";", 1)[0].strip().strip("()").replace(" ", "")
    return match.group(1), spec


def parse_requirements(inv: Inventory, path: Path, seen: set[Path]) -> None:
    if path in seen or len(seen) > 50:
        return
    seen.add(path)
    text = _read(path)
    if text is None:
        return
    count = 0
    lines = text.replace("\\\n", " ").splitlines()
    for raw in lines:
        line = raw.strip()
        include = re.match(r"^-(?:r|c)\s+(\S+)|^--(?:requirement|constraint)[ =](\S+)", line)
        if include:
            target = (path.parent / (include.group(1) or include.group(2))).resolve()
            if target.is_file() and inv.root in target.parents:
                parse_requirements(inv, target, seen)
            continue
        parsed = _parse_requirement(line)
        if parsed and inv.add("pypi", parsed[0], spec=parsed[1], role="declared", source=inv.rel(path)):
            count += 1
    inv.manifest(path, "requirements", "pypi", "declared", count)


def _poetry_spec(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("version") or ("direct reference" if any(k in value for k in ("git", "path", "url")) else ""))
    return ""


def poetry_to_pep440(spec: str) -> str:
    """Poetry's ^ / ~ / bare versions as PEP 440 specifiers, so they can be compared ("^1.4" -> ">=1.4,<2.0")."""
    parts = []
    for item in [x.strip() for x in str(spec or "").split(",") if x.strip()]:
        match = re.match(r"^(\^|~(?!=))\s*(\d+(?:\.\d+)*)", item)
        if match:
            numbers = [int(n) for n in match.group(2).split(".")]
            if match.group(1) == "^":
                index = next((i for i, n in enumerate(numbers) if n != 0), len(numbers) - 1)
            else:
                index = min(1, len(numbers) - 1) if len(numbers) > 1 else 0
            upper = numbers[:index + 1]
            upper[-1] += 1
            parts += [f">={match.group(2)}", "<" + ".".join(str(n) for n in upper + [0] * max(0, 2 - len(upper)))]
        elif re.match(r"^\d", item):
            parts.append("==" + item)
        elif item != "*":
            parts.append(item)
    return ",".join(parts)


def parse_pyproject(inv: Inventory, path: Path) -> None:
    if tomllib is None:
        inv.notes.append(f"{inv.rel(path)} skipped: install tomli (pip install tomli) to read TOML files on Python 3.10.")
        return
    text = _read(path)
    if text is None:
        return
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        inv.notes.append(f"{inv.rel(path)} could not be parsed as TOML.")
        return
    count = 0
    project = data.get("project") or {}
    groups = [("dependencies", project.get("dependencies") or [])]
    groups += [(f"optional:{k}", v) for k, v in (project.get("optional-dependencies") or {}).items()]
    groups += [(f"group:{k}", v) for k, v in (data.get("dependency-groups") or {}).items()]
    for section, items in groups:
        for item in items if isinstance(items, list) else []:
            parsed = _parse_requirement(item) if isinstance(item, str) else None
            if parsed and inv.add("pypi", parsed[0], spec=parsed[1], role="declared", source=inv.rel(path), section=section):
                count += 1
    poetry = (data.get("tool") or {}).get("poetry") or {}
    poetry_groups = [("dependencies", poetry.get("dependencies") or {}), ("dev", poetry.get("dev-dependencies") or {})]
    poetry_groups += [(f"group:{k}", (v or {}).get("dependencies") or {}) for k, v in (poetry.get("group") or {}).items()]
    for section, deps in poetry_groups:
        for name, value in (deps.items() if isinstance(deps, dict) else []):
            if name.lower() == "python":
                continue
            spec = poetry_to_pep440(_poetry_spec(value))
            if inv.add("pypi", name, spec=spec, role="declared", source=inv.rel(path), section=section):
                count += 1
    inv.manifest(path, "pyproject.toml", "pypi", "declared", count)


def parse_pipfile(inv: Inventory, path: Path) -> None:
    if tomllib is None:
        inv.notes.append(f"{inv.rel(path)} skipped: install tomli (pip install tomli) to read TOML files on Python 3.10.")
        return
    text = _read(path)
    try:
        data = tomllib.loads(text or "")
    except tomllib.TOMLDecodeError:
        return
    count = 0
    for section in ("packages", "dev-packages"):
        for name, value in (data.get(section) or {}).items():
            spec = poetry_to_pep440(_poetry_spec(value))
            if inv.add("pypi", name, spec=spec, role="declared", source=inv.rel(path), section=section):
                count += 1
    inv.manifest(path, "Pipfile", "pypi", "declared", count)


def parse_setup_cfg(inv: Inventory, path: Path) -> None:
    parser = configparser.ConfigParser()
    try:
        parser.read_string(_read(path) or "")
    except configparser.Error:
        return
    count = 0
    raw = parser.get("options", "install_requires", fallback="")
    for line in raw.splitlines():
        parsed = _parse_requirement(line)
        if parsed and inv.add("pypi", parsed[0], spec=parsed[1], role="declared", source=inv.rel(path)):
            count += 1
    inv.manifest(path, "setup.cfg", "pypi", "declared", count)


def parse_pipfile_lock(inv: Inventory, path: Path) -> None:
    try:
        data = json.loads(_read(path) or "{}")
    except ValueError:
        return
    count = 0
    for section in ("default", "develop"):
        for name, value in (data.get(section) or {}).items():
            version = str((value or {}).get("version") or "").lstrip("=")
            if version and inv.add("pypi", name, version=version, role="locked", source=inv.rel(path), direct=False):
                count += 1
    inv.manifest(path, "Pipfile.lock", "pypi", "locked", count)


def parse_toml_lock(inv: Inventory, path: Path, kind: str) -> None:
    if tomllib is None:
        inv.notes.append(f"{inv.rel(path)} skipped: install tomli (pip install tomli) to read TOML files on Python 3.10.")
        return
    try:
        data = tomllib.loads(_read(path) or "")
    except tomllib.TOMLDecodeError:
        return
    count = 0
    for item in data.get("package") or []:
        if isinstance(item, dict) and item.get("name") and item.get("version"):
            source = item.get("source") or {}
            if isinstance(source, dict) and (source.get("editable") or source.get("virtual")):
                continue  # the project itself
            if inv.add("pypi", item["name"], version=str(item["version"]), role="locked", source=inv.rel(path), direct=False):
                count += 1
    inv.manifest(path, kind, "pypi", "locked", count)


def parse_venv(inv: Inventory, venv: Path) -> None:
    candidates = list(venv.glob("lib/python*/site-packages")) + list(venv.glob("Lib/site-packages"))
    count = 0
    for site in candidates:
        try:
            entries = list(site.iterdir())
        except OSError:
            continue
        for entry in entries:
            if not entry.name.endswith(".dist-info"):
                continue
            meta = _read(entry / "METADATA") or _read(entry / "PKG-INFO") or ""
            name = re.search(r"^Name:\s*(.+)$", meta, re.M)
            version = re.search(r"^Version:\s*(.+)$", meta, re.M)
            if name and version and inv.add("pypi", name.group(1).strip(), version=version.group(1).strip(),
                                             role="installed", source=inv.rel(site), direct=False):
                count += 1
    inv.manifest(venv, "virtual environment", "pypi", "installed", count)


# -------------------------------------------------------------- JavaScript ----

NPM_SECTIONS = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")


def parse_package_json(inv: Inventory, path: Path) -> None:
    try:
        data = json.loads(_read(path) or "{}")
    except ValueError:
        inv.notes.append(f"{inv.rel(path)} is not valid JSON.")
        return
    count = 0
    for section in NPM_SECTIONS:
        for name, spec in (data.get(section) or {}).items():
            if inv.add("npm", name, spec=str(spec), role="declared", source=inv.rel(path), section=section):
                count += 1
    inv.manifest(path, "package.json", "npm", "declared", count)


def parse_package_lock(inv: Inventory, path: Path) -> None:
    try:
        data = json.loads(_read(path) or "{}")
    except ValueError:
        return
    count = 0
    packages = data.get("packages")
    if isinstance(packages, dict):                       # lockfile v2 / v3
        for key, value in packages.items():
            if not key or "node_modules/" not in key or not isinstance(value, dict) or value.get("link"):
                continue
            name = value.get("name") or key.rsplit("node_modules/", 1)[1]
            if value.get("version") and inv.add("npm", name, version=str(value["version"]), role="locked",
                                                source=inv.rel(path), direct=False):
                count += 1
    else:                                                # lockfile v1
        def walk(deps):
            nonlocal count
            for name, value in (deps or {}).items():
                if isinstance(value, dict) and value.get("version") and inv.add(
                        "npm", name, version=str(value["version"]), role="locked", source=inv.rel(path), direct=False):
                    count += 1
                walk((value or {}).get("dependencies"))
        walk(data.get("dependencies"))
    inv.manifest(path, path.name, "npm", "locked", count)


def parse_yarn_lock(inv: Inventory, path: Path) -> None:
    text = _read(path) or ""
    count, names = 0, []
    for line in text.splitlines():
        if line and not line.startswith((" ", "#")) and line.rstrip().endswith(":"):
            names = []
            for part in line.rstrip(":").split(","):
                part = part.strip().strip('"')
                part = part.split("@npm:")[0] if "@npm:" in part else part
                at = part.rfind("@")
                name = part[:at] if at > 0 else part
                if name and name not in names:
                    names.append(name)
        else:
            match = re.match(r'^\s+version:?\s+"?([^"\s]+)"?', line)
            if match and names:
                for name in names:
                    if inv.add("npm", name, version=match.group(1), role="locked", source=inv.rel(path), direct=False):
                        count += 1
                names = []
    inv.manifest(path, "yarn.lock", "npm", "locked", count)


def parse_pnpm_lock(inv: Inventory, path: Path) -> None:
    text = _read(path) or ""
    count, inside = 0, False
    for line in text.splitlines():
        if re.match(r"^(packages|snapshots):\s*$", line):
            inside = True
            continue
        if inside and line and not line.startswith(" "):
            inside = False
        if not inside:
            continue
        match = re.match(r"^\s{2}'?/?((?:@[^/@\s]+/)?[^/@\s(]+)[@/]([0-9][^:(\s']*)", line)
        if match and inv.add("npm", match.group(1), version=match.group(2), role="locked", source=inv.rel(path), direct=False):
            count += 1
    inv.manifest(path, "pnpm-lock.yaml", "npm", "locked", count)


def parse_node_modules(inv: Inventory, folder: Path) -> None:
    count = 0
    try:
        entries = list(folder.iterdir())
    except OSError:
        return
    for entry in entries:
        if entry.name.startswith(".") or not entry.is_dir():
            continue
        targets = [entry]
        if entry.name.startswith("@"):
            try:
                targets = [child for child in entry.iterdir() if child.is_dir()]
            except OSError:
                targets = []
        for target in targets:
            try:
                data = json.loads(_read(target / "package.json") or "{}")
            except ValueError:
                continue
            if data.get("name") and data.get("version") and inv.add(
                    "npm", data["name"], version=str(data["version"]), role="installed", source=inv.rel(folder), direct=False):
                count += 1
    inv.manifest(folder, "node_modules", "npm", "installed", count)


# ------------------------------------------------------------------ walker ----

FILE_PARSERS = {
    "pyproject.toml": parse_pyproject, "pipfile": parse_pipfile, "setup.cfg": parse_setup_cfg,
    "pipfile.lock": parse_pipfile_lock, "package.json": parse_package_json, "package-lock.json": parse_package_lock,
    "npm-shrinkwrap.json": parse_package_lock, "yarn.lock": parse_yarn_lock, "pnpm-lock.yaml": parse_pnpm_lock,
}
TOML_LOCKS = {"poetry.lock": "poetry.lock", "uv.lock": "uv.lock", "pdm.lock": "pdm.lock"}


def _is_requirements(name: str) -> bool:
    low = name.lower()
    return low.endswith((".txt", ".in")) and (low.startswith(("requirements", "constraints")) or "requirements" in low)


def discover(root: str | Path) -> dict:
    root = Path(root).resolve()
    inv = Inventory(root)
    seen_requirements: set[Path] = set()
    manifests = 0
    for current, dirs, files in os.walk(root):
        here = Path(current)
        if "pyvenv.cfg" in files and here != root:
            parse_venv(inv, here)
            dirs[:] = []
            continue
        keep = []
        for name in dirs:
            path = here / name
            if path.is_symlink():
                continue
            if name == "node_modules":
                parse_node_modules(inv, path)
                continue
            if (path / "pyvenv.cfg").is_file():
                parse_venv(inv, path)
                continue
            if name.lower() in SKIP_DIRS or name.endswith((".egg-info", ".dist-info")) or name == "site-packages":
                continue
            keep.append(name)
        dirs[:] = keep
        for name in files:
            if manifests >= MAX_MANIFESTS:
                inv.notes.append(f"Stopped after {MAX_MANIFESTS} dependency files.")
                return inv.result()
            low, path = name.lower(), here / name
            if low in FILE_PARSERS:
                FILE_PARSERS[low](inv, path)
                manifests += 1
            elif low in TOML_LOCKS:
                parse_toml_lock(inv, path, TOML_LOCKS[low])
                manifests += 1
            elif _is_requirements(name):
                parse_requirements(inv, path.resolve(), seen_requirements)
                manifests += 1
    return inv.result()


def tools_for(ecosystem: str, sources: list[str]) -> list[str]:
    """The package manager(s) that manage a package, from the files it was found in."""
    names = {source.rsplit("/", 1)[-1].lower() for source in sources}
    if ecosystem == "npm":
        found = [tool for tool, file in (("pnpm", "pnpm-lock.yaml"), ("yarn", "yarn.lock"), ("npm", "package-lock.json"),
                                         ("npm", "npm-shrinkwrap.json")) if file in names]
        return list(dict.fromkeys(found)) or ["npm"]
    found = [tool for tool, file in (("uv", "uv.lock"), ("poetry", "poetry.lock"), ("pipenv", "pipfile.lock"),
                                     ("pipenv", "pipfile"), ("pdm", "pdm.lock")) if file in names]
    if any(n.endswith((".txt", ".in")) or n == "site-packages" or n == "setup.cfg" for n in names) or not found:
        found.append("pip")
    return list(dict.fromkeys(found))
