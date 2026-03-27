from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # --- Default model (any LiteLLM-supported model string) ---
    default_model: str = "ollama/qwen2.5-coder:7b"

    # --- Optional API keys (injected at runtime via /api/keys) ---
    anthropic_api_key: Optional[str] = None
    openai_api_key:    Optional[str] = None
    groq_api_key:      Optional[str] = None
    gemini_api_key:    Optional[str] = None

    # --- Local provider base URLs (injected at runtime via /api/keys) ---
    # List of {"name": str, "url": str} dicts, populated by the VS Code extension
    local_providers: list[dict] = []

    # Convenience shims kept for internal use — set from local_providers at runtime
    ollama_base_url:    str = "http://localhost:11434"
    lm_studio_base_url: str = ""
    llamacpp_base_url:  str = ""
    vllm_base_url:      str = ""

    # --- RAG settings ---
    rag_db_path:      str = "./rag_db"
    rag_chunk_size:   int = 100
    rag_top_k:        int = 4
    rag_max_files:    int = 200   # max files to index per workspace

    # --- Server settings ---
    host: str = "127.0.0.1"
    port: int = 8765

    class Config:
        env_file = ".env"


settings = Settings()