import httpx
from fastapi import APIRouter
from config import settings

router = APIRouter()

# In-memory store for the active model selection
# This gets set when the user picks a model from the UI
_active_model: str | None = None


def get_active_model() -> str:
    """Returns the user-selected model, or the default from .env."""
    return _active_model or settings.default_model


@router.get("/models")
async def list_models():
    """
    Fetch all locally available Ollama models.
    Also includes any API models if keys are configured.

    Example response:
        {
            "active": "ollama/llama3.2",
            "local": [
                {"name": "ollama/llama3.2",  "size": "2.0 GB", "source": "ollama"},
                {"name": "ollama/codellama", "size": "3.8 GB", "source": "ollama"},
            ],
            "api": [
                {"name": "anthropic/claude-sonnet-4-20250514", "source": "anthropic"},
            ]
        }
    """
    local_models = []
    api_models   = []

    # --- Fetch local Ollama models ---
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"{settings.ollama_base_url}/api/tags",
                timeout=5.0
            )
            data = r.json()
            for m in data.get("models", []):
                size_bytes = m.get("size", 0)
                size_gb    = f"{size_bytes / 1e9:.1f} GB"
                local_models.append({
                    "name":   f"ollama/{m['name'].split(':')[0]}",
                    "size":   size_gb,
                    "source": "ollama",
                })
    except Exception:
        # Ollama not running or unreachable
        local_models = []

    # --- Add API models if keys are configured ---
    if settings.anthropic_api_key:
        api_models += [
            {"name": "anthropic/claude-sonnet-4-20250514", "source": "anthropic"},
            {"name": "anthropic/claude-haiku-4-5-20251001",  "source": "anthropic"},
        ]

    if settings.openai_api_key:
        api_models += [
            {"name": "openai/gpt-4o",      "source": "openai"},
            {"name": "openai/gpt-4o-mini", "source": "openai"},
        ]

    if settings.groq_api_key:
        api_models += [
            {"name": "groq/llama3-70b-8192",  "source": "groq"},
            {"name": "groq/mixtral-8x7b-32768", "source": "groq"},
        ]

    return {
        "active": get_active_model(),
        "local":  local_models,
        "api":    api_models,
    }


@router.post("/models/select")
async def select_model(body: dict):
    """
    Set the active model for this session.
    Called when the user picks a model from the VS Code sidebar.

    Example request:
        { "model": "ollama/llama3.2" }
    """
    global _active_model
    model = body.get("model", "").strip()
    if not model:
        return {"error": "model is required"}

    _active_model = model
    return {
        "status": "ok",
        "active": _active_model,
    }