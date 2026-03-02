"""Minimal configuration for ETL Dependency Visualizer."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    cors_origins: list[str] = ["*"]
    max_upload_mb: int = 10240
    database_url: str = "sqlite:///./etl_dep_viz.db"
    vector_timeout_seconds: int = 1800
    log_level: str = "INFO"
    max_sessions_for_phase3: int = 15000
    parse_timeout_seconds: int = 1800
    log_buffer_size: int = 2000

    # AI Chat / Vector DB settings
    embedding_mode: str = "local"               # "local" or "openai"
    embedding_model: str = "all-MiniLM-L6-v2"   # sentence-transformers model
    chroma_persist_dir: str = "./chroma_data"
    llm_provider: str = "anthropic"             # "anthropic" or "openai"
    llm_api_key: str = ""                       # User-provided API key
    llm_model: str = "claude-sonnet-4-20250514"
    auto_index_on_parse: bool = True

    class Config:
        env_prefix = "EDV_"


settings = Settings()
