from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # --- Default model (uses local Ollama by default, no API key needed) ---
    default_model: str = "ollama/codellama"

    # --- Optional API keys (leave empty if using Ollama) ---
    anthropic_api_key: Optional[str] = None
    openai_api_key:    Optional[str] = None
    groq_api_key:      Optional[str] = None

    # --- Ollama (local) ---
    ollama_base_url: str = "http://localhost:11434"

    # --- RAG settings ---
    rag_db_path:    str = "./rag_db"
    rag_chunk_size: int = 400
    rag_top_k:      int = 5

    # --- Server settings ---
    host: str = "127.0.0.1"
    port: int = 8765

    class Config:
        env_file = ".env"


settings = Settings()