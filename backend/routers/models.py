import httpx
import asyncio
from fastapi import APIRouter
from config import settings

router = APIRouter()

_active_model: str | None = None


def get_active_model() -> str:
    return _active_model or settings.default_model


async def _fetch_ollama_models() -> list[dict]:
    try:
        async with httpx.AsyncClient() as client:
            r    = await client.get(f"{settings.ollama_base_url}/api/tags", timeout=5.0)
            data = r.json()
            return [
                {
                    "name":   f"ollama/{m['name']}",
                    "size":   f"{m.get('size', 0) / 1e9:.1f} GB",
                    "source": "ollama",
                }
                for m in data.get("models", [])
            ]
    except Exception:
        return []


async def _fetch_openai_compatible_models(base_url: str, prefix: str, source: str) -> list[dict]:
    try:
        async with httpx.AsyncClient() as client:
            r    = await client.get(f"{base_url}/models", timeout=5.0)
            data = r.json()
            return [
                {
                    "name":   f"{prefix}/{m['id']}",
                    "size":   "",
                    "source": source,
                }
                for m in data.get("data", [])
            ]
    except Exception:
        return []


def _strip_prefix(model_id: str, prefix: str) -> str:
    """
    Ensure the model id does NOT already start with the provider prefix.
    e.g. Groq sometimes returns ids like 'openai/gpt-oss-20b' — we don't
    want those to become 'groq/openai/gpt-oss-20b'.
    """
    if model_id.startswith(f"{prefix}/"):
        return model_id
    # If it contains a foreign prefix (e.g. openai/ inside groq results), keep as-is
    if "/" in model_id:
        return model_id
    return f"{prefix}/{model_id}"


async def _fetch_anthropic_models() -> list[dict]:
    key = settings.anthropic_api_key
    if not key:
        return []
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                "https://api.anthropic.com/v1/models",
                headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
            )
            r.raise_for_status()
            data = r.json()
            return [
                {"name": f"anthropic/{m['id']}", "source": "anthropic"}
                for m in data.get("data", [])
                if "/" not in m["id"]   # skip any oddly-prefixed entries
            ]
    except Exception:
        return []


async def _fetch_openai_models() -> list[dict]:
    key = settings.openai_api_key
    if not key:
        return []
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {key}"},
            )
            r.raise_for_status()
            data = r.json()
            CHAT_PREFIXES = ("gpt-", "o1", "o3", "o4", "chatgpt")
            return [
                {"name": f"openai/{m['id']}", "source": "openai"}
                for m in data.get("data", [])
                if any(m["id"].startswith(p) for p in CHAT_PREFIXES)
                and "/" not in m["id"]
            ]
    except Exception:
        return []


async def _fetch_groq_models() -> list[dict]:
    key = settings.groq_api_key
    if not key:
        return []
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                "https://api.groq.com/openai/v1/models",
                headers={"Authorization": f"Bearer {key}"},
            )
            r.raise_for_status()
            data = r.json()
            models = []
            for m in data.get("data", []):
                mid = m["id"]
                # Some Groq models already have a provider prefix (e.g. openai/gpt-oss-20b,
                # meta-llama/llama-4-scout-17b-16e-instruct). Pass them through as-is to
                # LiteLLM under the groq/ namespace: groq/openai/gpt-oss-20b works correctly.
                name = f"groq/{mid}"
                models.append({"name": name, "source": "groq"})
            return models
    except Exception:
        return []


async def _fetch_gemini_models() -> list[dict]:
    key = settings.gemini_api_key
    if not key:
        return []
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            r = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": key},
            )
            r.raise_for_status()
            data = r.json()
            return [
                {
                    "name":   f"gemini/{m['name'].replace('models/', '')}",
                    "source": "gemini",
                }
                for m in data.get("models", [])
                if "generateContent" in m.get("supportedGenerationMethods", [])
                and "gemini" in m.get("name", "")
            ]
    except Exception:
        return []


@router.get("/models")
async def list_models():
    local_models = []
    api_models   = []

    # Local providers
    if settings.ollama_base_url:
        local_models += await _fetch_ollama_models()
    if settings.lm_studio_base_url:
        local_models += await _fetch_openai_compatible_models(
            settings.lm_studio_base_url, "openai", "lm-studio"
        )
    if settings.llamacpp_base_url:
        local_models += await _fetch_openai_compatible_models(
            settings.llamacpp_base_url, "openai", "llama.cpp"
        )
    if settings.vllm_base_url:
        local_models += await _fetch_openai_compatible_models(
            settings.vllm_base_url, "hosted_vllm", "vllm"
        )

    # Cloud API models — all fetched concurrently
    cloud_fetches = []
    if settings.anthropic_api_key:
        cloud_fetches.append(_fetch_anthropic_models())
    if settings.openai_api_key:
        cloud_fetches.append(_fetch_openai_models())
    if settings.groq_api_key:
        cloud_fetches.append(_fetch_groq_models())
    if settings.gemini_api_key:
        cloud_fetches.append(_fetch_gemini_models())

    if cloud_fetches:
        results = await asyncio.gather(*cloud_fetches, return_exceptions=True)
        for r in results:
            if isinstance(r, list):
                api_models += r

    return {
        "active": get_active_model(),
        "local":  local_models,
        "api":    api_models,
    }


@router.post("/models/select")
async def select_model(body: dict):
    global _active_model
    model = body.get("model", "").strip()
    if not model:
        return {"error": "model is required"}
    _active_model = model
    return {"status": "ok", "active": _active_model}


@router.post("/models/thinking")
async def toggle_thinking(body: dict):
    enabled = body.get("enabled", False)
    settings.enable_thinking = enabled
    return {"thinking": settings.enable_thinking}