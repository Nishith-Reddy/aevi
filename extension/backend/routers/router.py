from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.router import (
    create_router,
    delete_router,
    list_routers,
    load_router,
    route,
    save_router,
)

router = APIRouter()


class GraphPayload(BaseModel):
    name:    str | None = None
    enabled: bool = False
    nodes:   list[dict] = []
    edges:   list[dict] = []


class CreatePayload(BaseModel):
    name: str


class TestPayload(BaseModel):
    task:      str
    router_id: str | None = None
    graph:     dict | None = None  # if omitted, uses the saved router by id


@router.get("/router/list")
def get_router_list():
    return {"routers": list_routers()}


@router.post("/router/create")
def post_router_create(payload: CreatePayload):
    name = (payload.name or "").strip() or "Untitled"
    return create_router(name)


@router.post("/router/test")
def test_route(payload: TestPayload):
    """Preview which model the router would pick for a given task."""
    graph = payload.graph
    if graph is None and payload.router_id:
        graph = load_router(payload.router_id)
        if graph is None:
            raise HTTPException(status_code=404, detail=f"Router '{payload.router_id}' not found")
    if graph is None:
        raise HTTPException(status_code=400, detail="Either 'graph' or 'router_id' is required")
    # Tests bypass the enabled flag — the act of testing is the opt-in.
    graph = {**graph, "enabled": True}
    return route(payload.task, graph)


@router.get("/router/{router_id}")
def get_router(router_id: str):
    data = load_router(router_id)
    if data is None:
        raise HTTPException(status_code=404, detail=f"Router '{router_id}' not found")
    return data


@router.post("/router/{router_id}")
def post_router(router_id: str, payload: GraphPayload):
    saved = save_router(router_id, payload.model_dump())
    return {"status": "ok", "saved": saved}


@router.delete("/router/{router_id}")
def del_router(router_id: str):
    ok = delete_router(router_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Router '{router_id}' not found")
    return {"status": "ok"}
