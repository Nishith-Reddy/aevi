import os
import litellm
from litellm import acompletion
from config import settings

# Inject API keys into environment so LiteLLM can find them
if settings.anthropic_api_key:
    os.environ["ANTHROPIC_API_KEY"] = settings.anthropic_api_key
if settings.openai_api_key:
    os.environ["OPENAI_API_KEY"] = settings.openai_api_key
if settings.groq_api_key:
    os.environ["GROQ_API_KEY"] = settings.groq_api_key

# Point LiteLLM to local Ollama
os.environ["OLLAMA_API_BASE"] = settings.ollama_base_url

# Silently drop params that a model doesn't support
litellm.drop_params = True


async def stream_completion(messages: list[dict], model: str | None = None):
    """
    Streams response chunks back as an async generator.

    Usage:
        async for chunk in stream_completion(messages):
            print(chunk, end="")

    Model examples:
        "ollama/codellama"                    <- local, free
        "ollama/llama3.2"                     <- local, free
        "anthropic/claude-sonnet-4-20250514"  <- Anthropic API
        "openai/gpt-4o"                       <- OpenAI API
        "groq/llama3-70b-8192"                <- Groq API
    """
    from routers.models import get_active_model
    mdl = model or get_active_model()
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


async def complete(
    messages: list[dict],
    model: str | None = None,
    max_tokens: int = 256
) -> str:
    """
    Single non-streaming completion — used for inline code suggestions
    where we just need one quick response.
    """
    from routers.models import get_active_model
    mdl = model or get_active_model()
    response = await acompletion(
        model=mdl,
        messages=messages,
        stream=False,
        max_tokens=max_tokens,
    )
    return response.choices[0].message.content or ""