import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import completion, chat, agent, models
from services.rag import index_workspace
from config import settings

app = FastAPI(
    title="Telivi",
    description="AI coding assistant backend — powers VS Code extension and CLI",
    version="0.1.0",
)

# Allow requests from VS Code extension and local CLI
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register all routers
app.include_router(completion.router, prefix="/api", tags=["completion"])
app.include_router(chat.router,       prefix="/api", tags=["chat"])
app.include_router(agent.router,      prefix="/api", tags=["agent"])
app.include_router(models.router,     prefix="/api", tags=["models"])


@app.get("/health")
def health():
    """Quick check to verify the server is running."""
    return {
        "status": "ok",
        "model":  settings.default_model,
        "port":   settings.port,
    }


@app.post("/api/index")
async def index(body: dict):
    """
    Index a workspace for RAG.
    Called by the VS Code extension when a folder is opened.

    Example request:
        { "workspace_path": "/Users/you/myproject" }
    """
    workspace = body.get("workspace_path", "").strip()
    if not workspace:
        return {"error": "workspace_path is required"}

    count = await index_workspace(workspace)
    return {
        "status":         "indexed",
        "workspace":      workspace,
        "indexed_chunks": count,
    }


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=True,   # auto-restart on file changes during development
    )