"""Syntax-aware code chunks for Code Q&A retrieval.

Chunks follow code structure (functions, classes, methods) the way code-search
tools such as Cursor do, instead of cutting at arbitrary character counts:

* Python is parsed with the standard ``ast`` module (decorators and docstrings
  stay with their function; large classes are split into methods).
* Other languages use definition-start heuristics (function/class/interface/
  struct/impl ... lines) plus leading comments/annotations.
* Anything else, or code between definitions, becomes line windows.

Every chunk keeps its original 1-based line range, so answers can cite exact
lines and the UI can open the snippet. Nothing is executed.
"""
from __future__ import annotations

import ast
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath

CHUNKER_VERSION = "qa-chunker-1"
MAX_CHUNK_LINES = 150
MIN_CHUNK_LINES = 6
WINDOW_LINES = 80
WINDOW_OVERLAP = 12

LANGUAGES = {
    ".py": "python", ".pyw": "python", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".jsx": "jsx", ".ts": "typescript", ".tsx": "tsx", ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
    ".cs": "csharp", ".go": "go", ".rb": "ruby", ".php": "php", ".scala": "scala", ".c": "c", ".h": "c",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".rs": "rust", ".swift": "swift",
    ".sql": "sql", ".html": "html", ".htm": "html", ".css": "css", ".scss": "scss", ".less": "less",
    ".xml": "xml", ".yml": "yaml", ".yaml": "yaml", ".json": "json", ".sh": "bash", ".bash": "bash",
    ".ps1": "powershell", ".vue": "vue", ".dart": "dart", ".tf": "hcl", ".vb": "vbnet", ".md": "markdown",
    ".toml": "toml", ".ini": "ini", ".cfg": "ini", ".gradle": "groovy", ".groovy": "groovy",
}

# Definition starts for brace/keyword languages: (regex, kind). Group "name" is the symbol.
_GENERIC_DEFS = [
    (r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(?P<name>[A-Za-z_$][\w$]*)", "class"),
    (r"^\s*(?:export\s+)?(?:declare\s+)?interface\s+(?P<name>[A-Za-z_$][\w$]*)", "interface"),
    (r"^\s*(?:export\s+)?(?:declare\s+)?(?:type)\s+(?P<name>[A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=", "type"),
    (r"^\s*(?:export\s+)?(?:const\s+)?enum\s+(?P<name>[A-Za-z_$][\w$]*)", "enum"),
    (r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(?P<name>[A-Za-z_$][\w$]*)\s*\(", "function"),
    (r"^\s*(?:export\s+)?(?:const|let|var)\s+(?P<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?"
     r"(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|React\.memo|memo\(|forwardRef\()", "function"),
    (r"^\s*func\s+(?:\([^)]*\)\s*)?(?P<name>[A-Za-z_]\w*)\s*\(", "function"),                      # Go
    (r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(?P<name>[A-Za-z_]\w*)", "function"),          # Rust
    (r"^\s*(?:pub\s+)?(?:struct|trait)\s+(?P<name>[A-Za-z_]\w*)", "struct"),                         # Rust/Go
    (r"^\s*impl(?:<[^>]*>)?\s+(?P<name>[A-Za-z_][\w:<>, ]*)", "impl"),                               # Rust
    (r"^\s*type\s+(?P<name>[A-Za-z_]\w*)\s+(?:struct|interface)\b", "struct"),                      # Go
    (r"^\s*(?:public|private|protected|internal)?\s*(?:static\s+|final\s+|abstract\s+|sealed\s+|partial\s+)*"
     r"(?:class|record|struct|interface|enum)\s+(?P<name>[A-Za-z_]\w*)", "class"),                   # Java/C#/Kotlin
    (r"^\s*(?:public|private|protected|internal)\s+(?:static\s+|final\s+|async\s+|override\s+|virtual\s+|"
     r"abstract\s+|synchronized\s+)*[\w<>\[\],.? ]+\s+(?P<name>[A-Za-z_]\w*)\s*\([^;]*$", "method"),  # Java/C# methods
    (r"^\s*(?:suspend\s+)?fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(?P<name>[A-Za-z_]\w*)\s*\(", "function"),  # Kotlin
    (r"^\s*def\s+(?:self\.)?(?P<name>[A-Za-z_]\w*[?!=]?)", "function"),                              # Ruby
    (r"^\s*(?:module|class)\s+(?P<name>[A-Z]\w*)", "class"),                                        # Ruby
    (r"^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+(?P<name>[A-Za-z_]\w*)\s*\(", "function"),  # PHP
    (r"^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?)(?:TABLE|VIEW|FUNCTION|PROCEDURE|TRIGGER|INDEX)\s+"
     r"(?:IF\s+NOT\s+EXISTS\s+)?(?P<name>[\w.\"`\[\]]+)", "sql"),
]
_GENERIC_RE = [(re.compile(pattern, re.IGNORECASE if kind == "sql" else 0), kind) for pattern, kind in _GENERIC_DEFS]
_LEADING = re.compile(r"^\s*(//|#|/\*|\*|@|\[|--|\"\"\"|''')")
_KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "else", "new", "throw", "await", "typeof", "do"}


@dataclass
class Chunk:
    path: str
    start: int            # 1-based, inclusive
    end: int              # 1-based, inclusive
    text: str
    symbol: str = ""      # primary symbol, e.g. "Store.save"
    kind: str = "code"    # function | class | method | module | window ...
    language: str = ""
    symbols: list[str] = field(default_factory=list)

    @property
    def chunk_hash(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()

    @property
    def ident(self) -> str:
        return hashlib.sha1(f"{self.path}\n{self.start}\n{self.chunk_hash}".encode("utf-8")).hexdigest()

    def embed_text(self, limit: int = 12000) -> str:
        """Text sent to the embedding model: location + symbol context + code."""
        head = f"File: {self.path} (lines {self.start}-{self.end})"
        if self.symbol:
            head += f"\n{self.kind}: {self.symbol}"
        body = self.text if len(self.text) <= limit else self.text[:limit]
        return f"{head}\n{body}"


def language(path: str) -> str:
    name = PurePosixPath(path).name.lower()
    if name == "dockerfile":
        return "dockerfile"
    return LANGUAGES.get(PurePosixPath(name).suffix, "")


# ------------------------------------------------------------------ outline ----

def outline(path: str, text: str) -> list[dict]:
    """Symbols of a file with line ranges: [{name, kind, start, end, depth}]."""
    lines = text.splitlines()
    if language(path) == "python":
        try:
            tree = ast.parse(text)
        except (SyntaxError, ValueError):
            tree = None
        if tree is not None:
            out: list[dict] = []

            def visit(node, prefix="", depth=0):
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        start = min([child.lineno] + [d.lineno for d in child.decorator_list])
                        end = getattr(child, "end_lineno", child.lineno) or child.lineno
                        kind = "class" if isinstance(child, ast.ClassDef) else ("method" if prefix else "function")
                        name = f"{prefix}{child.name}"
                        out.append({"name": name, "kind": kind, "start": start, "end": end, "depth": depth})
                        if isinstance(child, ast.ClassDef):
                            visit(child, name + ".", depth + 1)
            visit(tree)
            return out
    starts = _definition_starts(lines)
    out = []
    for index, (line_no, name, kind, indent) in enumerate(starts):
        end = _block_end(lines, line_no, starts[index + 1][0] if index + 1 < len(starts) else len(lines) + 1)
        out.append({"name": name, "kind": kind, "start": line_no, "end": end, "depth": 1 if indent > 0 else 0})
    return out


def _definition_starts(lines: list[str]) -> list[tuple[int, str, str, int]]:
    found = []
    in_block_comment = False
    for number, line in enumerate(lines, 1):
        stripped = line.strip()
        if in_block_comment:
            if "*/" in stripped:
                in_block_comment = False
            continue
        if stripped.startswith("/*") and "*/" not in stripped:
            in_block_comment = True
            continue
        if not stripped or stripped.startswith(("//", "#", "*", "--")):
            continue
        for pattern, kind in _GENERIC_RE:
            match = pattern.match(line)
            if match:
                name = match.group("name").strip()
                if name.split("(")[0] in _KEYWORDS:
                    continue
                found.append((number, name, kind, len(line) - len(line.lstrip())))
                break
    return found


def _block_end(lines: list[str], start: int, limit: int) -> int:
    """End line of a block starting at `start` (brace matching, else indentation), before `limit`."""
    depth, seen = 0, False
    for number in range(start, min(limit, len(lines) + 1)):
        code = re.sub(r"(\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`[^`]*`|//.*$)", "", lines[number - 1])
        opens, closes = code.count("{"), code.count("}")
        if opens:
            seen = True
        depth += opens - closes
        if seen and depth <= 0:
            return number
    if not seen:  # indentation languages / declarations without braces
        base = len(lines[start - 1]) - len(lines[start - 1].lstrip())
        end = start
        for number in range(start + 1, min(limit, len(lines) + 1)):
            text = lines[number - 1]
            if text.strip() and (len(text) - len(text.lstrip())) <= base and not text.strip().startswith((")", "]", "}")):
                break
            if text.strip():
                end = number
        return end
    return max(start, min(limit, len(lines) + 1) - 1)


# ------------------------------------------------------------------ chunking ----

def _with_leading(lines: list[str], start: int, floor: int) -> int:
    """Pull decorators/annotations/doc comments directly above a definition into its chunk."""
    line = start
    while line - 1 > floor and line - 1 >= 1 and lines[line - 2].strip() and _LEADING.match(lines[line - 2]):
        line -= 1
    return line


def _windows(path, lines, start, end, lang, kind="module", symbol="") -> list[Chunk]:
    out = []
    first = start
    while first <= end:
        last = min(end, first + WINDOW_LINES - 1)
        text = "\n".join(lines[first - 1:last])
        if text.strip():
            out.append(Chunk(path, first, last, text, symbol, kind, lang))
        if last >= end:
            break
        first = last - WINDOW_OVERLAP + 1
    return out


def _python_spans(text: str) -> list[tuple[int, int, str, str]] | None:
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return None
    spans = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start = min([node.lineno] + [d.lineno for d in node.decorator_list])
            end = getattr(node, "end_lineno", node.lineno) or node.lineno
            if isinstance(node, ast.ClassDef) and end - start + 1 > MAX_CHUNK_LINES:
                members = [n for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
                head_end = (min([members[0].lineno] + [d.lineno for d in members[0].decorator_list]) - 1) if members else end
                spans.append((start, max(start, head_end), node.name, "class"))
                for member in members:
                    m_start = min([member.lineno] + [d.lineno for d in member.decorator_list])
                    m_end = getattr(member, "end_lineno", member.lineno) or member.lineno
                    spans.append((m_start, m_end, f"{node.name}.{member.name}", "method"))
            else:
                spans.append((start, end, node.name, "class" if isinstance(node, ast.ClassDef) else "function"))
    return spans


def _generic_spans(lines: list[str]) -> list[tuple[int, int, str, str]]:
    starts = _definition_starts(lines)
    if not starts:
        return []
    base = min(indent for _, _, _, indent in starts)
    top = [s for s in starts if s[3] <= base + 4]  # top level (allow one nesting level for exports/namespaces)
    spans = []
    for index, (line_no, name, kind, _) in enumerate(top):
        limit = top[index + 1][0] if index + 1 < len(top) else len(lines) + 1
        end = _block_end(lines, line_no, limit)
        spans.append((line_no, max(line_no, end), name, kind))
    return spans


def chunk_file(path: str, text: str) -> list[Chunk]:
    lines = text.splitlines()
    if not lines:
        return []
    lang = language(path)
    spans = _python_spans(text) if lang == "python" else None
    if spans is None:
        spans = _generic_spans(lines) if lang not in ("json", "yaml", "markdown", "xml", "ini", "toml", "css", "scss", "less") else []
    chunks: list[Chunk] = []
    cursor = 1
    for start, end, name, kind in sorted(spans):
        if start < cursor:  # nested/overlapping definitions are covered already
            continue
        start = _with_leading(lines, start, cursor - 1)
        if start > cursor:  # module-level code between definitions
            chunks.extend(_windows(path, lines, cursor, start - 1, lang))
        if end - start + 1 > MAX_CHUNK_LINES:
            chunks.extend(_windows(path, lines, start, end, lang, kind, name))
        else:
            body = "\n".join(lines[start - 1:end])
            chunks.append(Chunk(path, start, end, body, name, kind, lang, [name]))
        cursor = end + 1
    if cursor <= len(lines):
        chunks.extend(_windows(path, lines, cursor, len(lines), lang))
    return _merge_small(path, lines, [c for c in chunks if c.text.strip()], lang)


def _merge_small(path, lines, chunks: list[Chunk], lang) -> list[Chunk]:
    """Join tiny neighbouring chunks (imports, constants, one-liners) so each carries context."""
    out: list[Chunk] = []
    for chunk in chunks:
        previous = out[-1] if out else None
        small = chunk.end - chunk.start + 1 < MIN_CHUNK_LINES
        prev_small = previous is not None and previous.end - previous.start + 1 < MIN_CHUNK_LINES
        if previous and (small or prev_small) and chunk.start <= previous.end + 2 \
                and chunk.end - previous.start + 1 <= MAX_CHUNK_LINES:
            start, end = previous.start, max(previous.end, chunk.end)
            symbols = [s for s in previous.symbols + chunk.symbols if s]
            out[-1] = Chunk(path, start, end, "\n".join(lines[start - 1:end]), previous.symbol or chunk.symbol,
                            previous.kind if previous.symbol else chunk.kind, lang, symbols)
        else:
            out.append(chunk)
    return out


def import_block(path: str, text: str, limit: int = 25) -> tuple[int, int] | None:
    """Line range of the leading import/include block (context for snippets)."""
    pattern = re.compile(r"^\s*(import\s|from\s+\S+\s+import\s|#include\s|using\s|require\(|const\s+\w+\s*=\s*require\(|"
                         r"package\s|use\s)")
    lines = text.splitlines()
    first = last = None
    for number, line in enumerate(lines[:200], 1):
        if pattern.match(line):
            first = first or number
            last = number
        elif first and line.strip() and not line.strip().startswith(("#", "//", "*", "/*", ")", "}")):
            break
    if not first:
        return None
    return first, min(last, first + limit - 1)
