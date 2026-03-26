import os
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import completion, chat, agent, models
from services.rag import index_workspace, retrieve_context
from services.rag import remove_file_from_index
from config import settings

app = FastAPI(
    title="Telivi",
    description="AI coding assistant backend — powers VS Code extension and CLI",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(completion.router, prefix="/api", tags=["completion"])
app.include_router(chat.router,       prefix="/api", tags=["chat"])
app.include_router(agent.router,      prefix="/api", tags=["agent"])
app.include_router(models.router,     prefix="/api", tags=["models"])


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model":  settings.default_model,
        "port":   settings.port,
    }


@app.post("/api/keys")
async def set_keys(body: dict):
    """
    Called by the VS Code extension on startup and whenever the user saves settings.
    Accepts API keys and a list of local provider URLs, applies them to the live
    settings object so LiteLLM picks them up without a restart.

    Expected body:
    {
        "anthropic": "sk-ant-...",
        "openai":    "sk-...",
        "groq":      "gsk_...",
        "providers": [
            {"name": "Ollama",    "url": "http://localhost:11434"},
            {"name": "LM Studio", "url": "http://localhost:1234/v1"}
        ]
    }
    """
    # --- API keys ---
    if body.get("anthropic"):
        settings.anthropic_api_key = body["anthropic"]
        os.environ["ANTHROPIC_API_KEY"] = body["anthropic"]

    if body.get("openai"):
        settings.openai_api_key = body["openai"]
        os.environ["OPENAI_API_KEY"] = body["openai"]

    if body.get("groq"):
        settings.groq_api_key = body["groq"]
        os.environ["GROQ_API_KEY"] = body["groq"]

    # --- Local provider URLs ---
    providers: list[dict] = body.get("providers", [])
    settings.local_providers = providers

    # Reset all shims first, then re-apply from the provider list
    settings.ollama_base_url    = ""
    settings.lm_studio_base_url = ""
    settings.llamacpp_base_url  = ""
    settings.vllm_base_url      = ""

    for p in providers:
        name = p.get("name", "").lower()
        url  = p.get("url", "").strip().rstrip("/")
        if not url:
            continue
        if "ollama" in name:
            settings.ollama_base_url = url
            os.environ["OLLAMA_API_BASE"] = url
        elif "lm studio" in name or "lmstudio" in name:
            settings.lm_studio_base_url = url
            os.environ["OPENAI_API_BASE"] = url
            os.environ.setdefault("OPENAI_API_KEY", "lm-studio")
        elif "llama" in name:
            settings.llamacpp_base_url = url
            os.environ["OPENAI_API_BASE"] = url
            os.environ.setdefault("OPENAI_API_KEY", "llamacpp")
        elif "vllm" in name:
            settings.vllm_base_url = url
            os.environ["VLLM_API_BASE"] = url
        else:
            # Generic OpenAI-compatible — treat as OpenAI base
            os.environ["OPENAI_API_BASE"] = url
            os.environ.setdefault("OPENAI_API_KEY", "local")

    return {"status": "ok"}


@app.post("/api/index")
async def index(body: dict):
    workspace = body.get("workspace_path", "").strip()
    if not workspace:
        return {"error": "workspace_path is required"}
    count = await index_workspace(workspace)
    return {"status": "indexed", "workspace": workspace, "indexed_chunks": count}


@app.post("/api/debug/retrieve")
async def debug_retrieve(body: dict):
    query     = body.get("query", "")
    workspace = body.get("workspace_path", "")
    if not query or not workspace:
        return {"error": "query and workspace_path are required"}
    context = await retrieve_context(query, workspace)
    chunks  = context.split("\n\n---\n\n") if context else []
    return {"query": query, "chunks_found": len(chunks), "chunks": chunks}


@app.post("/api/retrieve")
async def retrieve(body: dict):
    query     = body.get("query", "").strip()
    workspace = body.get("workspace_path", "").strip()
    if not query or not workspace:
        return {"chunks": [], "chunks_found": 0}
    context = await retrieve_context(query, workspace)
    chunks  = context.split("\n\n---\n\n") if context else []
    return {"chunks_found": len(chunks), "chunks": chunks}


@app.post("/api/remove-file")
async def remove_file(body: dict):
    file_path = body.get("file_path", "").strip()
    workspace = body.get("workspace_path", "").strip()
    if not file_path or not workspace:
        return {"error": "file_path and workspace_path are required"}
    removed = await remove_file_from_index(workspace, file_path)
    return {"status": "ok", "chunks_removed": removed}


if __name__ == "__main__":
    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=True)