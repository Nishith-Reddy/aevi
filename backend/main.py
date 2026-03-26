import os
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import completion, chat, agent, models
from services.rag import index_workspace, retrieve_context
from services.rag import remove_file_from_index
from config import settings

app = FastAPI(
    title="aevi",
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
    # --- API keys — set or clear depending on whether a value was provided ---
    if body.get("anthropic"):
        settings.anthropic_api_key = body["anthropic"]
        os.environ["ANTHROPIC_API_KEY"] = body["anthropic"]
    else:
        settings.anthropic_api_key = None
        os.environ.pop("ANTHROPIC_API_KEY", None)

    if body.get("openai"):
        settings.openai_api_key = body["openai"]
        os.environ["OPENAI_API_KEY"] = body["openai"]
    else:
        settings.openai_api_key = None
        os.environ.pop("OPENAI_API_KEY", None)

    if body.get("groq"):
        settings.groq_api_key = body["groq"]
        os.environ["GROQ_API_KEY"] = body["groq"]
    else:
        settings.groq_api_key = None
        os.environ.pop("GROQ_API_KEY", None)

    if body.get("gemini"):
        settings.gemini_api_key = body["gemini"]
        os.environ["GEMINI_API_KEY"] = body["gemini"]
        print(f"[keys] Gemini API key set ({len(body['gemini'])} chars)")
    else:
        settings.gemini_api_key = None
        os.environ.pop("GEMINI_API_KEY", None)
        print("[keys] Gemini API key cleared")

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


@app.get("/api/gemini/models")
async def list_gemini_models():
    """
    Fetch available Gemini models for the stored API key.
    Returns only generative text models that support generateContent.
    """
    import httpx
    key = settings.gemini_api_key
    if not key:
        return {"models": [], "error": "No Gemini API key configured"}
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": key},
            )
            r.raise_for_status()
            data = r.json()
            models = [
                m["name"].replace("models/", "")
                for m in data.get("models", [])
                if "generateContent" in m.get("supportedGenerationMethods", [])
                and "gemini" in m.get("name", "")
            ]
            return {"models": models}
    except Exception as e:
        return {"models": [], "error": str(e)}


@app.post("/api/index-file")
async def index_file(body: dict):
    """
    Index a single file into the vector store.
    Called when the user switches to a new file in VS Code.
    """
    file_path   = body.get("file_path", "").strip()
    workspace   = body.get("workspace_path", "").strip()
    if not file_path or not workspace:
        return {"error": "file_path and workspace_path are required"}

    from services.rag import _get_db, _embed_model, _chunk_text, SUPPORTED_EXTENSIONS
    import os

    ext = os.path.splitext(file_path)[1]
    if ext not in SUPPORTED_EXTENSIONS:
        return {"status": "skipped", "reason": "unsupported extension"}

    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
    except Exception as e:
        return {"error": str(e)}

    if not content.strip():
        return {"status": "skipped", "reason": "empty file"}

    db      = _get_db(workspace)
    records = []
    for i, chunk in enumerate(_chunk_text(content)):
        vector = _embed_model.encode(chunk).tolist()
        records.append({"path": file_path, "chunk_id": i, "text": chunk, "vector": vector})

    tbl_name = "code_chunks"
    if tbl_name not in db.table_names():
        db.create_table(tbl_name, records)
    else:
        tbl = db.open_table(tbl_name)
        # Remove stale chunks for this file first, then add fresh ones
        try:
            tbl.delete(f"path = '{file_path}'")
        except Exception:
            pass
        tbl.add(records)

    return {"status": "indexed", "file": file_path, "chunks": len(records)}


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


@app.post("/api/clear-index")
async def clear_index(body: dict):
    """
    Clear the vector DB for a workspace, optionally keeping one file's chunks.
    Called when the user clicks Clear in the chat UI.
    """
    workspace  = body.get("workspace_path", "").strip()
    keep_file  = body.get("keep_file", "").strip()
    if not workspace:
        return {"error": "workspace_path is required"}

    from services.rag import _get_db, _dbs
    try:
        db = _get_db(workspace)
        if "code_chunks" not in db.table_names():
            return {"status": "ok", "workspace": workspace, "kept": keep_file}

        if keep_file:
            # Delete everything except chunks belonging to the current file
            tbl = db.open_table("code_chunks")
            tbl.delete(f"path != '{keep_file}'")
        else:
            db.drop_table("code_chunks")
            _dbs.pop(workspace, None)

        return {"status": "ok", "workspace": workspace, "kept": keep_file or None}
    except Exception as e:
        return {"error": str(e)}


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