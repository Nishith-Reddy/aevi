"""
Semantic routing engine for the agent.

A "router" is a directed-acyclic graph that maps an incoming task to a model.
The graph has four node types:

    input       — the entrypoint. There is exactly one.
    classifier  — branches the flow by semantic similarity. Each outgoing handle
                  is labelled and carries a list of example phrases. The
                  incoming task is embedded and routed down the handle whose
                  examples are closest in embedding space.
    model       — a terminal that pins a specific provider/model id.
    output      — visual sink; ignored at runtime.

Multiple routers can be stored side-by-side. Each lives in its own file under
``~/.aevi/routers/<id>.json`` with the shape:

    {
        "id":      "<id>",
        "name":    "<display name>",
        "enabled": true,
        "nodes":   [...],
        "edges":   [...],
    }
"""
import json
import re
import uuid
from pathlib import Path
from typing import Any

import numpy as np

from services.rag import _embed_model


AEVI_DIR    = Path.home() / ".aevi"
ROUTERS_DIR = AEVI_DIR / "routers"
LEGACY_PATH = AEVI_DIR / "routing-graph.json"


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "router"


def _empty_router(router_id: str = "default", name: str = "Default") -> dict[str, Any]:
    return {"id": router_id, "name": name, "enabled": False, "nodes": [], "edges": []}


def _router_path(router_id: str) -> Path:
    return ROUTERS_DIR / f"{router_id}.json"


def _migrate_legacy() -> None:
    """One-time migration: convert the old single-graph file into a 'default' router."""
    if ROUTERS_DIR.exists() and any(ROUTERS_DIR.glob("*.json")):
        return
    if not LEGACY_PATH.exists():
        return
    try:
        with open(LEGACY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return
        ROUTERS_DIR.mkdir(parents=True, exist_ok=True)
        migrated = _empty_router("default", "Default")
        migrated.update({
            "enabled": bool(data.get("enabled", False)),
            "nodes":   data.get("nodes", []),
            "edges":   data.get("edges", []),
        })
        with open(_router_path("default"), "w", encoding="utf-8") as f:
            json.dump(migrated, f, indent=2)
    except Exception:
        pass


def list_routers() -> list[dict[str, Any]]:
    """Return a lightweight summary of each saved router (no nodes/edges)."""
    _migrate_legacy()
    if not ROUTERS_DIR.exists():
        return []
    out: list[dict[str, Any]] = []
    for p in sorted(ROUTERS_DIR.glob("*.json")):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        out.append({
            "id":      data.get("id") or p.stem,
            "name":    data.get("name") or p.stem,
            "enabled": bool(data.get("enabled", False)),
        })
    return out


def load_router(router_id: str) -> dict[str, Any] | None:
    _migrate_legacy()
    p = _router_path(router_id)
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        data.setdefault("id", router_id)
        data.setdefault("name", router_id)
        data.setdefault("enabled", False)
        data.setdefault("nodes", [])
        data.setdefault("edges", [])
        return data
    except Exception:
        return None


def save_router(router_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    ROUTERS_DIR.mkdir(parents=True, exist_ok=True)
    data = {
        "id":      router_id,
        "name":    payload.get("name") or router_id,
        "enabled": bool(payload.get("enabled", False)),
        "nodes":   payload.get("nodes", []),
        "edges":   payload.get("edges", []),
    }
    with open(_router_path(router_id), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return data


def create_router(name: str) -> dict[str, Any]:
    base = _slug(name)
    candidate = base
    i = 1
    while _router_path(candidate).exists():
        i += 1
        candidate = f"{base}-{i}"
    return save_router(candidate, {"name": name, "enabled": False, "nodes": [], "edges": []})


def delete_router(router_id: str) -> bool:
    p = _router_path(router_id)
    if not p.exists():
        return False
    try:
        p.unlink()
        return True
    except Exception:
        return False


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def _node_by_id(graph: dict[str, Any], node_id: str) -> dict | None:
    for n in graph.get("nodes", []):
        if n.get("id") == node_id:
            return n
    return None


def _outgoing(graph: dict[str, Any], node_id: str) -> list[dict]:
    return [e for e in graph.get("edges", []) if e.get("source") == node_id]


def _classify(task: str, routes: list[dict]) -> str | None:
    """Return the id (label) of the route closest to `task` in embedding space."""
    usable = [r for r in routes if r.get("examples")]
    if not usable:
        return None

    task_vec = np.array(_embed_model.encode(task))
    best_label = None
    best_score = -1.0
    for r in usable:
        sims = []
        for ex in r["examples"]:
            text = (ex or "").strip()
            if not text:
                continue
            ex_vec = np.array(_embed_model.encode(text))
            sims.append(_cosine(task_vec, ex_vec))
        if not sims:
            continue
        score = max(sims)
        if score > best_score:
            best_score = score
            best_label = r.get("label")
    return best_label


def route(task: str, graph: dict[str, Any]) -> dict[str, Any]:
    """
    Walk the graph starting from the input node and return:
        { "model": "groq/...", "path": ["input-1", "classifier-1", "model-2"], "reason": "..." }
    """
    if not graph.get("enabled"):
        return {"model": None, "path": [], "reason": "routing disabled"}

    nodes = graph.get("nodes", [])
    if not nodes:
        return {"model": None, "path": [], "reason": "empty graph"}

    entry = next((n for n in nodes if n.get("type") == "input"), None)
    if not entry:
        return {"model": None, "path": [], "reason": "no input node"}

    visited: set[str] = set()
    path: list[str] = []
    current: dict | None = entry

    while current and current["id"] not in visited:
        visited.add(current["id"])
        path.append(current["id"])

        ntype = current.get("type")

        if ntype == "model":
            model_id = (current.get("data") or {}).get("model")
            return {"model": model_id or None, "path": path, "reason": "matched model node"}

        if ntype == "classifier":
            routes = (current.get("data") or {}).get("routes", [])
            label = _classify(task, routes)
            edges = _outgoing(graph, current["id"])
            chosen_edge = None
            if label is not None:
                chosen_edge = next(
                    (e for e in edges if (e.get("sourceHandle") or "") == label),
                    None,
                )
            if chosen_edge is None and edges:
                chosen_edge = edges[0]
            if chosen_edge is None:
                return {"model": None, "path": path, "reason": "classifier has no outgoing edges"}
            current = _node_by_id(graph, chosen_edge["target"])
            continue

        edges = _outgoing(graph, current["id"])
        if not edges:
            return {"model": None, "path": path, "reason": f"{ntype} node has no outgoing edges"}
        current = _node_by_id(graph, edges[0]["target"])

    return {"model": None, "path": path, "reason": "graph terminated without a model"}
