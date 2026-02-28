"""Minimal configuration for ETL Dependency Visualizer."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    cors_origins: list[str] = ["*"]
    max_upload_mb: int = 200
    database_url: str = "sqlite:///./etl_dep_viz.db"

    class Config:
        env_prefix = "EDV_"


settings = Settings()
