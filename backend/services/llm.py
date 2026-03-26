import os
import litellm
from litellm import acompletion
from config import settings

# --- Inject API keys ---
if settings.anthropic_api_key:
    os.environ["ANTHROPIC_API_KEY"] = settings.anthropic_api_key
if settings.openai_api_key:
    os.environ["OPENAI_API_KEY"] = settings.openai_api_key
if settings.groq_api_key:
    os.environ["GROQ_API_KEY"] = settings.groq_api_key
if settings.gemini_api_key:
    os.environ["GEMINI_API_KEY"] = settings.gemini_api_key

# --- Configure local provider base URLs via LiteLLM ---
if settings.ollama_base_url:
    os.environ["OLLAMA_API_BASE"] = settings.ollama_base_url
if settings.lm_studio_base_url:
    os.environ["OPENAI_API_BASE"] = settings.lm_studio_base_url
    os.environ["OPENAI_API_KEY"]  = os.environ.get("OPENAI_API_KEY", "lm-studio")
if settings.llamacpp_base_url:
    os.environ["OPENAI_API_BASE"] = settings.llamacpp_base_url
    os.environ["OPENAI_API_KEY"]  = os.environ.get("OPENAI_API_KEY", "llamacpp")
if settings.vllm_base_url:
    os.environ["VLLM_API_BASE"] = settings.vllm_base_url

# Silently drop params unsupported models don't understand (e.g. `think`)
litellm.drop_params = True


def _resolve_model(model: str) -> str:
    """
    Resolve a model string to the correct LiteLLM format.

    Prefixes understood:
        groq/         → Groq API (model id may itself contain a slash, e.g. groq/openai/gpt-oss-20b)
        gemini/       → Google Gemini via LiteLLM
        anthropic/    → Anthropic API
        openai/       → OpenAI API or OpenAI-compatible local server
        ollama/       → Ollama local server
        hosted_vllm/  → vLLM server
    """
    if not model:
        from routers.models import get_active_model
        return get_active_model()

    # Already prefixed — use as-is (includes groq/openai/gpt-oss-20b etc.)
    if "/" in model:
        return model

    # No prefix — infer from configured providers
    if settings.lm_studio_base_url or settings.llamacpp_base_url:
        return f"openai/{model}"
    if settings.vllm_base_url:
        return f"hosted_vllm/{model}"
    return f"ollama/{model}"


async def stream_completion(messages: list[dict], model: str | None = None):
    """Stream response chunks for any LiteLLM-supported provider."""
    mdl = _resolve_model(model or "")

    # Ensure the Gemini key is set in the environment at call time
    # (it may have been injected after module load via /api/keys)
    if mdl.startswith("gemini/") and settings.gemini_api_key:
        os.environ["GEMINI_API_KEY"] = settings.gemini_api_key

    response = await acompletion(
        model=mdl,
        messages=messages,
        stream=True,
        max_tokens=2048,
    )
    async for chunk in response:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta


async def complete(messages: list[dict], model: str | None = None, max_tokens: int = 256) -> str:
    """Single non-streaming completion — used for inline suggestions."""
    mdl = _resolve_model(model or "")

    if mdl.startswith("gemini/") and settings.gemini_api_key:
        os.environ["GEMINI_API_KEY"] = settings.gemini_api_key

    response = await acompletion(
        model=mdl,
        messages=messages,
        stream=False,
        max_tokens=max_tokens,
    )
    return response.choices[0].message.content or ""