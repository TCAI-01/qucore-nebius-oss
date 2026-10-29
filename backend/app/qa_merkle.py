"""Merkle tree over the codebase, used to keep the Code Q&A index in sync.

This is the technique Cursor uses for codebase indexing: every file is a leaf
(its content hash), every folder hashes its children, and the root summarises
the whole tree. To sync, the stored tree and the current tree are compared
from the root down; identical subtrees are skipped entirely, so only files that
were added, changed or removed are re-chunked and re-embedded.
"""
from __future__ import annotations

import hashlib


def _h(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def build(leaves: dict[str, str]) -> dict:
    """{path: content_sha256} -> nested {"hash", "children"|"leaf"} tree."""
    root: dict = {"children": {}}
    for path, digest in leaves.items():
        node = root
        parts = path.split("/")
        for part in parts[:-1]:
            node = node["children"].setdefault(part, {"children": {}})
        node["children"][parts[-1]] = {"leaf": digest}
    _hash(root)
    return root


def _hash(node: dict) -> str:
    if "leaf" in node:
        node["hash"] = _h("file:" + node["leaf"])
        return node["hash"]
    parts = [f"{name}:{_hash(child)}" for name, child in sorted(node["children"].items())]
    node["hash"] = _h("dir:" + "|".join(parts))
    return node["hash"]


def root_hash(leaves: dict[str, str]) -> str:
    return build(leaves)["hash"] if leaves else _h("empty")


def diff(old_leaves: dict[str, str], new_leaves: dict[str, str]) -> dict:
    """Walk both trees top-down, descending only into subtrees whose hashes differ.

    Returns {"added", "changed", "removed", "visited_nodes", "old_root", "new_root"}.
    """
    old, new = build(old_leaves), build(new_leaves)
    added, changed, removed = [], [], []
    visited = 0

    def files(node, prefix):
        if "leaf" in node:
            yield prefix
            return
        for name, child in node["children"].items():
            yield from files(child, f"{prefix}/{name}" if prefix else name)

    def walk(a, b, prefix):
        nonlocal visited
        visited += 1
        if a is None and b is None:
            return
        if a is not None and b is not None and a.get("hash") == b.get("hash"):
            return  # identical subtree: nothing below it changed
        if a is None:
            added.extend(files(b, prefix))
            return
        if b is None:
            removed.extend(files(a, prefix))
            return
        a_leaf, b_leaf = "leaf" in a, "leaf" in b
        if a_leaf and b_leaf:
            changed.append(prefix)
            return
        if a_leaf != b_leaf:  # a file became a folder or the reverse
            removed.extend(files(a, prefix))
            added.extend(files(b, prefix))
            return
        for name in sorted(set(a["children"]) | set(b["children"])):
            walk(a["children"].get(name), b["children"].get(name), f"{prefix}/{name}" if prefix else name)

    walk(old if old_leaves else None, new if new_leaves else None, "")
    return {"added": sorted(added), "changed": sorted(changed), "removed": sorted(removed),
            "visited_nodes": visited, "old_root": old["hash"] if old_leaves else _h("empty"),
            "new_root": new["hash"] if new_leaves else _h("empty")}
