# Telivi configuration
from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # --- LLM settings ---
    default_model:    str  = "ollama/qwen3.5:9b"   # used for chat + agent
    enable_thinking:  bool = False

    # --- Optional API keys (leave empty if using Ollama) ---
    anthropic_api_key: Optional[str] = None
    openai_api_key:    Optional[str] = None
    groq_api_key:      Optional[str] = None

    # --- Ollama (local) ---
    ollama_base_url: str = "http://localhost:11434"

    # --- RAG settings ---
    rag_db_path:    str = "./rag_db"
    rag_chunk_size: int = 100    # smaller = each function gets its own chunk
    rag_top_k:      int = 4

    # --- Server settings ---
    host: str = "127.0.0.1"
    port: int = 8765

    class Config:
        env_file = ".env"


settings = Settings()
