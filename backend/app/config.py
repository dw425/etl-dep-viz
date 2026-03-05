"""Application configuration for ETL Dependency Visualizer.

All settings are loaded from environment variables with the ``EDV_`` prefix
(e.g. ``EDV_LOG_LEVEL=DEBUG``).  Pydantic-settings handles type coercion and
default values so the app works out-of-the-box with sensible defaults.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Central configuration consumed by all backend modules.

    Attributes are grouped into three sections: server/infra, analysis tuning,
    and AI/chat integration.  Override any value by setting the corresponding
    ``EDV_<UPPER_NAME>`` environment variable.
    """

    # ── Server & Infrastructure ───────────────────────────────────────────
    cors_origins: list[str] = ["*"]                 # Allowed CORS origins; ["*"] = unrestricted
    max_upload_mb: int = 10240                      # Max upload body size in megabytes (default 10 GB)
    database_url: str = "sqlite:///./etl_dep_viz.db"  # SQLAlchemy connection string (SQLite default)
    log_level: str = "INFO"                         # Python logging level name
    log_buffer_size: int = 2000                     # Ring-buffer capacity for /api/health/logs

    # ── Analysis Tuning ───────────────────────────────────────────────────
    vector_timeout_seconds: int = 1800              # Hard timeout for the vector orchestrator (30 min)
    parse_timeout_seconds: int = 1800               # Hard timeout for XML/JSON parse (30 min)
    max_sessions_for_phase3: int = 15000            # Session count threshold for enabling Phase 3 vectors

    # ── Databricks App Deployment ────────────────────────────────────────
    lakebase_instance: str = ""                   # Lakebase instance name (empty = SQLite mode)
    databricks_app: bool = False                  # True when running as a Databricks App

    # ── Connection Pool Tuning (PostgreSQL only) ──────────────────────
    pool_size: int = 10                           # Base pool size (concurrent connections)
    pool_max_overflow: int = 20                   # Extra connections beyond pool_size
    pool_timeout: int = 30                        # Seconds to wait for a connection from pool
    pool_recycle: int = 2700                      # Recycle connections after N seconds (45 min)

    # ── Parse Settings ─────────────────────────────────────────────────
    session_display_mode: str = "full"            # "full" (default), "short", or "smart" (strip prefixes only)

    # ── AI Chat / Vector DB ───────────────────────────────────────────────
    embedding_mode: str = "local"               # "local", "openai", or "databricks"
    embedding_model: str = "all-MiniLM-L6-v2"   # sentence-transformers model name
    chroma_persist_dir: str = "./chroma_data"    # ChromaDB persistence directory
    llm_provider: str = "anthropic"             # LLM backend: "anthropic", "openai", or "databricks"
    llm_api_key: str = ""                       # User-provided API key (keep empty for local-only)
    llm_model: str = "claude-sonnet-4-20250514"  # Model identifier for chat completions
    auto_index_on_parse: bool = True            # Automatically index parsed data into ChromaDB
    databricks_llm_model: str = "databricks-meta-llama-3-3-70b-instruct"
    databricks_embedding_model: str = "databricks-bge-large-en"

    class Config:
        env_prefix = "EDV_"


# Module-level singleton used throughout the application
settings = Settings()
