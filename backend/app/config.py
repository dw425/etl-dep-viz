"""Minimal configuration for ETL Dependency Visualizer."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    cors_origins: list[str] = ["*"]
    max_upload_mb: int = 10240
    database_url: str = "sqlite:///./etl_dep_viz.db"
    vector_timeout_seconds: int = 120
    log_level: str = "INFO"
    max_sessions_for_phase3: int = 5000
    parse_timeout_seconds: int = 600
    log_buffer_size: int = 500

    class Config:
        env_prefix = "EDV_"


settings = Settings()
