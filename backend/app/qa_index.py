"""Code Q&A index: vectors in local ChromaDB + in-memory BM25, kept in sync with a Merkle tree.

Storage
    backend/data/chroma/          ChromaDB (persistent, QUCORE_CHROMA_DIR), one collection per codebase
                                  + embedding model + chunker version.
    backend/data/qa/<key>.json    Merkle leaves {path: sha256} of what is indexed.

Sync (Cursor-style)
    The current file hashes are compared with the stored Merkle tree. Only files
    in changed subtrees are re-chunked; chunk embeddings are cached by chunk
    content hash, so an unchanged function inside an edited file is not
    re-embedded. Embedding and write-back happen only after all new vectors are
    ready, so a stopped sync never leaves the index half-updated.

Search
    Hybrid = 60% semantic (cosine similarity from Chroma, Nebius Token Factory embeddings) + 40% keyword
    (Okapi BM25 over code-aware tokens), each min-max normalised over the candidate set.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from collections import Counter as Tally, OrderedDict
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

from . import config, file_store, llm, qa_merkle, token_usage, workspace
from .qa_chunker import CHUNKER_VERSION, Chunk, chunk_file


class Stopped(Exception):
    """The user pressed Stop."""


# ----------------------------------------------------------------- options ----

def _float(values, key, default):
    try:
        return float(values.get(key) or default)
    except ValueError:
        return default


def _int(values, key, default, low, high):
    try:
        return max(low, min(high, int(values.get(key) or default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class QAOptions:
    semantic_weight: float
    keyword_weight: float
    top_files: int
    candidates: int
    snippet_tokens: int
    history_turns: int        # QUCORE_QA_HISTORY_TURNS: previous answers sent with "Include history"
    max_continuations: int
    chroma_dir: Path


def options() -> QAOptions:
    values = dotenv_values(config.ENV_FILE, interpolate=False) if config.ENV_FILE.exists() else {}
    semantic = _float(values, "QUCORE_QA_SEMANTIC_WEIGHT", 0.6)
    keyword = _float(values, "QUCORE_QA_KEYWORD_WEIGHT", 0.4)
    total = semantic + keyword
    if total <= 0 or semantic < 0 or keyword < 0:
        semantic, keyword, total = 0.6, 0.4, 1.0
    chroma_dir = Path(values.get("QUCORE_CHROMA_DIR") or (config.DATA / "chroma"))
    if not chroma_dir.is_absolute():
        chroma_dir = config.BACKEND / chroma_dir
    return QAOptions(
        semantic_weight=semantic / total, keyword_weight=keyword / total,
        top_files=_int(values, "QUCORE_QA_TOP_FILES", 10, 1, 50),
        candidates=_int(values, "QUCORE_QA_CANDIDATES", 50, 10, 300),
        snippet_tokens=_int(values, "QUCORE_QA_SNIPPET_TOKENS", 40000, 2000, 1000000),
        history_turns=_int(values, "QUCORE_QA_HISTORY_TURNS", 5, 0, 30),
        max_continuations=_int(values, "QUCORE_QA_MAX_CONTINUATIONS", 2, 0, 5),
        chroma_dir=chroma_dir,
    )


# ---------------------------------------------------------------- workspace ----

def workspace_info(workspace_id: str) -> tuple[str, set[str]]:
    """Root folder and selectable files of an opened workspace (read-only use)."""
    with workspace._lock:
        item = workspace._workspaces.get(workspace_id)
    if not item:
        raise workspace.WorkspaceError("Workspace expired or backend restarted. Open the folder again.")
    return str(item.root), set(item.allowed)


def semantic_available(s) -> bool:
    return bool(s.embedding_deployment)


def index_key(root: str, s) -> str:
    endpoint = s.nebius_endpoint or ""
    raw = f"{root}|{s.embedding_deployment}|{endpoint}|{CHUNKER_VERSION}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


# ---------------------------------------------------------------- chunks ----

_CHUNKS: "OrderedDict[tuple[str, str], list[Chunk]]" = OrderedDict()
_CHUNKS_LOCK = threading.Lock()


def chunks_for(source) -> list[Chunk]:
    key = (source.path, source.sha256)
    with _CHUNKS_LOCK:
        if key in _CHUNKS:
            _CHUNKS.move_to_end(key)
            return _CHUNKS[key]
    chunks = chunk_file(source.path, source.text)
    with _CHUNKS_LOCK:
        _CHUNKS[key] = chunks
        while len(_CHUNKS) > 20000:
            _CHUNKS.popitem(last=False)
    return chunks


# ---------------------------------------------------------------- chroma ----

_CLIENT = None
_CLIENT_LOCK = threading.Lock()
_INDEX_LOCKS: dict[str, threading.Lock] = {}


def _chroma():
    global _CLIENT
    with _CLIENT_LOCK:
        if _CLIENT is None:
            try:
                import chromadb
                from chromadb.config import Settings as ChromaSettings
            except ImportError as exc:  # pragma: no cover - environment dependent
                raise llm.ReviewError("Hybrid and Cursor-style Q&A need ChromaDB: pip install -r requirements.txt") from exc
            path = options().chroma_dir
            path.mkdir(parents=True, exist_ok=True)
            _CLIENT = chromadb.PersistentClient(path=str(path), settings=ChromaSettings(anonymized_telemetry=False))
        return _CLIENT


def collection(key: str):
    # Vectors are always supplied by QuCoRe (Nebius embeddings); no Chroma default model is downloaded.
    return _chroma().get_or_create_collection(name=f"qucore_qa_{key}", metadata={"hnsw:space": "cosine"},
                                              embedding_function=None)


def reset_client() -> None:
    """Forget the Chroma client (after the data folder was cleared, see cleanup.py)."""
    global _CLIENT
    with _CLIENT_LOCK:
        _CLIENT = None


def _state_path(key: str) -> Path:
    return config.DATA / "qa" / f"{key}.json"


def load_state(key: str) -> dict:
    path = _state_path(key)
    try:
        data = json.loads(file_store.read_text(path))
        if isinstance(data, dict) and isinstance(data.get("leaves"), dict) \
                and data.get("vector_store", "chroma") == "chroma":
            return data
    except (OSError, ValueError):
        pass
    return {"leaves": {}, "root": qa_merkle.root_hash({}), "chunks": 0}


def _save_state(key: str, state: dict) -> None:
    path = _state_path(key)
    text = json.dumps({**state, "vector_store": "chroma"}, indent=1)
    file_store.write_text(path, text)  # <key>.json.tmp then renamed


def _lock_for(key: str) -> threading.Lock:
    with _CLIENT_LOCK:
        return _INDEX_LOCKS.setdefault(key, threading.Lock())


def pending_changes(key: str, sources, allowed: set[str]) -> dict:
    """Merkle diff between the stored index and the current files in scope (no network)."""
    state = load_state(key)
    scope = {src.path for src in sources}
    old = {p: h for p, h in state["leaves"].items() if p in scope or p not in allowed}
    new = {src.path: src.sha256 for src in sources}
    return qa_merkle.diff(old, new)


def _batched(items, size):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def embed_texts(s, texts: list[str], usage: dict, stop, progress=None, label="Embedding") -> list[list[float]]:
    """Nebius Token Factory embeddings in batches of 16, reported into `usage` as embedding tokens."""
    if not s.embedding_deployment:
        raise llm.ReviewError("Set an embedding deployment in Credentials to use semantic search.")
    vectors: list[list[float]] = []
    awaiting = False
    try:
        with llm.make_client(s, embeddings=True) as client:
            for index, batch in enumerate(_batched(texts, 16)):
                if stop.is_set():
                    raise Stopped()
                if progress and len(texts) > 16:
                    progress(f"{label} {min(len(texts), index * 16 + len(batch)):,}/{len(texts):,} chunks")
                awaiting = True
                response = client.embeddings.create(model=s.embedding_deployment, input=batch, encoding_format="float")
                awaiting = False
                token_usage.add_usage(usage, response.usage.model_dump() if response.usage else None, "embedding")
                ordered = sorted(response.data, key=lambda item: item.index)
                if len(ordered) != len(batch):
                    raise llm.ReviewError("The embedding endpoint returned an incomplete batch.")
                for item in ordered:
                    vector = [float(x) for x in item.embedding]
                    if not vector or any(not math.isfinite(x) for x in vector):
                        raise llm.ReviewError("The embedding endpoint returned invalid vectors.")
                    vectors.append(vector)
    except (Stopped, llm.ReviewError):
        raise
    except Exception as exc:
        if awaiting:
            token_usage.add_usage(usage, None, "embedding")
        raise llm.provider_error(exc) from exc
    return vectors


def sync(s, key: str, sources, allowed: set[str], usage: dict, stop, progress) -> dict:
    """Bring the Chroma collection up to date for the files in scope (Merkle diff)."""
    with _lock_for(key):
        state = load_state(key)
        change = pending_changes(key, sources, allowed)
        summary = {"key": key, "added": len(change["added"]), "changed": len(change["changed"]),
                   "removed": len(change["removed"]), "visited_nodes": change["visited_nodes"],
                   "root": change["new_root"], "embedded_chunks": 0, "reused_chunks": 0}
        to_index = change["added"] + change["changed"]
        to_delete = change["changed"] + change["removed"]
        if not to_index and not to_delete:
            summary["indexed_files"] = len(state["leaves"])
            summary["up_to_date"] = True
            return summary
        progress(f"Merkle sync: {len(change['added'])} new, {len(change['changed'])} changed, "
                 f"{len(change['removed'])} removed file(s)")
        col = collection(key)
        by_path = {src.path: src for src in sources}
        new_chunks = [chunk for path in to_index for chunk in chunks_for(by_path[path])]
        # Embedding cache: identical chunk content anywhere in the index is reused.
        cached: dict[str, list[float]] = {}
        hashes = sorted({chunk.chunk_hash for chunk in new_chunks})
        for batch in _batched(hashes, 200):
            got = col.get(where={"chunk_hash": {"$in": batch}}, include=["embeddings", "metadatas"])
            embeddings = got.get("embeddings")
            if embeddings is None:
                continue
            for vector, meta in zip(embeddings, got.get("metadatas") or []):
                if meta and meta.get("chunk_hash") not in cached:
                    cached[meta["chunk_hash"]] = [float(x) for x in vector]
        pending = [chunk for chunk in new_chunks if chunk.chunk_hash not in cached]
        unique: dict[str, Chunk] = {}
        for chunk in pending:
            unique.setdefault(chunk.chunk_hash, chunk)
        if unique:
            vectors = embed_texts(s, [c.embed_text() for c in unique.values()], usage, stop, progress, "Embedding")
            for chunk_hash, vector in zip(unique.keys(), vectors):
                cached[chunk_hash] = vector
        if stop.is_set():
            raise Stopped()
        # Write-back only after every vector is ready.
        for batch in _batched(sorted(to_delete), 100):
            col.delete(where={"path": {"$in": batch}})
        for batch in _batched(new_chunks, 256):
            col.upsert(
                ids=[c.ident for c in batch],
                embeddings=[cached[c.chunk_hash] for c in batch],
                documents=[c.text for c in batch],
                metadatas=[{"path": c.path, "start": c.start, "end": c.end, "symbol": c.symbol or "",
                            "kind": c.kind, "language": c.language or "", "chunk_hash": c.chunk_hash}
                           for c in batch],
            )
        leaves = dict(state["leaves"])
        for path in change["removed"] + change["changed"]:
            leaves.pop(path, None)
        for path in to_index:
            leaves[path] = by_path[path].sha256
        state.update(leaves=leaves, root=qa_merkle.root_hash(leaves), chunks=col.count(),
                     embedding_deployment=s.embedding_deployment, chunker=CHUNKER_VERSION)
        _save_state(key, state)
        summary.update(embedded_chunks=len(unique), reused_chunks=len(new_chunks) - len(pending),
                       indexed_files=len(leaves), up_to_date=False)
        return summary


# ------------------------------------------------------------------ BM25 ----

_STOP = {"the", "and", "for", "that", "this", "with", "from", "are", "was", "how", "what", "where", "when", "which",
         "who", "why", "does", "did", "can", "could", "should", "would", "will", "into", "about", "there", "their",
         "then", "than", "them", "they", "you", "your", "our", "its", "has", "have", "had", "not", "but", "all",
         "any", "use", "used", "using", "code", "file", "files", "is", "in", "of", "to", "a", "an", "it", "on",
         "be", "as", "at", "by", "or", "if", "do", "me", "my", "we", "so", "up"}
_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+")
_SPLIT = re.compile(r"_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


def tokenize(text: str) -> list[str]:
    """Code-aware tokens: identifiers plus their camelCase / snake_case parts."""
    out = []
    for word in _WORD.findall(text or ""):
        low = word.lower()
        if len(low) > 1 and low not in _STOP:
            out.append(low)
        parts = [p for p in _SPLIT.split(word) if p]
        if len(parts) > 1:
            out.extend(p.lower() for p in parts if len(p) > 1 and p.lower() not in _STOP)
    return out


class BM25:
    def __init__(self, documents: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.k1, self.b = k1, b
        self.tf = [Tally(doc) for doc in documents]
        self.length = [len(doc) for doc in documents]
        self.avg = (sum(self.length) / len(self.length)) if self.length else 0.0
        df: Tally = Tally()
        for doc in self.tf:
            df.update(doc.keys())
        n = len(documents)
        self.idf = {term: math.log(1 + (n - freq + 0.5) / (freq + 0.5)) for term, freq in df.items()}

    def scores(self, query: list[str]) -> list[float]:
        terms = [t for t in dict.fromkeys(query) if t in self.idf]
        out = []
        for tf, length in zip(self.tf, self.length):
            score = 0.0
            norm = self.k1 * (1 - self.b + self.b * (length / self.avg if self.avg else 1))
            for term in terms:
                freq = tf.get(term)
                if freq:
                    score += self.idf[term] * freq * (self.k1 + 1) / (freq + norm)
            out.append(score)
        return out


_BM25: "OrderedDict[str, BM25]" = OrderedDict()


def _bm25_for(chunks: list[Chunk]) -> BM25:
    signature = hashlib.sha1("\n".join(c.ident for c in chunks).encode("utf-8")).hexdigest()
    with _CHUNKS_LOCK:
        if signature in _BM25:
            _BM25.move_to_end(signature)
            return _BM25[signature]
    index = BM25([tokenize(f"{c.path} {c.symbol} {c.text}") for c in chunks])
    with _CHUNKS_LOCK:
        _BM25[signature] = index
        while len(_BM25) > 4:
            _BM25.popitem(last=False)
    return index


# ----------------------------------------------------------------- search ----

def _minmax(values: list[float]) -> list[float]:
    if not values:
        return []
    low, high = min(values), max(values)
    if high - low < 1e-12:
        return [1.0 if high > 0 else 0.0 for _ in values]
    return [(v - low) / (high - low) for v in values]


def _unit(vector) -> list[float]:
    length = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / length for x in vector]


def hybrid_search(s, key: str, sources, question: str, usage: dict, stop, progress,
                  opts: QAOptions, extra: dict) -> list[dict]:
    """Ranked chunk hits: [{chunk, semantic, keyword, fused}], best first."""
    chunks = [chunk for src in sources for chunk in chunks_for(src)]
    if not chunks:
        return []
    by_id = {chunk.ident: chunk for chunk in chunks}
    keyword_raw = _bm25_for(chunks).scores(tokenize(question))
    keyword_top = sorted((i for i, v in enumerate(keyword_raw) if v > 0), key=lambda i: -keyword_raw[i])[:opts.candidates]
    semantic: dict[str, float] = {}
    semantic_on = semantic_available(s)
    if semantic_on:
        progress("Semantic search (ChromaDB)")
        query_vector = _unit(embed_texts(s, [question[:8000]], usage, stop)[0])
        col = collection(key)
        scope = sorted({src.path for src in sources})
        where = {"path": {"$in": scope}} if len(scope) <= 3000 else None
        count = col.count()
        if count:
            result = col.query(query_embeddings=[query_vector], n_results=min(count, opts.candidates * (1 if where else 3)),
                               where=where, include=["distances"])
            for ident, distance in zip(result["ids"][0], result["distances"][0]):
                if ident in by_id:
                    semantic[ident] = max(-1.0, min(1.0, 1.0 - float(distance)))
        missing = [chunks[i].ident for i in keyword_top if chunks[i].ident not in semantic]
        for batch in _batched(missing, 200):
            got = col.get(ids=batch, include=["embeddings"])
            embeddings = got.get("embeddings")
            if embeddings is None:
                continue
            for ident, vector in zip(got["ids"], embeddings):
                vec = _unit([float(x) for x in vector])
                semantic[ident] = sum(a * b for a, b in zip(query_vector, vec))
    candidate_ids = list(dict.fromkeys([i for i in sorted(semantic, key=lambda k: -semantic[k])][:opts.candidates]
                                       + [chunks[i].ident for i in keyword_top]))
    if not candidate_ids:
        return []
    index_of = {chunk.ident: i for i, chunk in enumerate(chunks)}
    sem_raw = [semantic.get(ident, 0.0) for ident in candidate_ids]
    kw_raw = [keyword_raw[index_of[ident]] for ident in candidate_ids]
    sem_n, kw_n = _minmax(sem_raw), _minmax(kw_raw)
    w_sem, w_kw = (opts.semantic_weight, opts.keyword_weight) if semantic_on else (0.0, 1.0)
    hits = [{"chunk": by_id[ident], "semantic": round(sem_raw[i], 4), "keyword": round(kw_raw[i], 4),
             "fused": round(w_sem * sem_n[i] + w_kw * kw_n[i], 4)}
            for i, ident in enumerate(candidate_ids)]
    hits.sort(key=lambda h: (-h["fused"], h["chunk"].path, h["chunk"].start))
    extra.update(semantic_weight=w_sem, keyword_weight=w_kw, candidates=len(hits), semantic=semantic_on,
                 chunks_in_scope=len(chunks))
    return hits
