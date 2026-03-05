"""Shared Databricks OAuth token management with caching.

Provides a single get_databricks_token() function used by both the LLM
and Embedding clients, with a 50-minute cache (tokens last 1 hour).

Supports 3 auth modes (tried in order):
  1. Databricks SDK auto-auth (works inside Databricks Apps automatically)
  2. OAuth client credentials (DATABRICKS_CLIENT_ID + SECRET)
  3. Static token (DATABRICKS_TOKEN)
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.request

logger = logging.getLogger("edv.databricks_auth")

_token_cache: dict = {"token": None, "host": None, "expires_at": 0}
_token_lock = threading.Lock()

# Cache tokens for 50 minutes (they last 1 hour)
_TOKEN_TTL = 50 * 60


def get_databricks_token() -> tuple[str, str]:
    """Get cached Databricks host and OAuth token, refreshing if expired.

    Returns (host, token) tuple.
    """
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["host"], _token_cache["token"]

    with _token_lock:
        # Double-check inside lock
        if _token_cache["token"] and now < _token_cache["expires_at"]:
            return _token_cache["host"], _token_cache["token"]

        host = os.environ.get("DATABRICKS_HOST", "")
        if not host:
            host = os.environ.get("DATABRICKS_INSTANCE", "")
        if host and not host.startswith("https://"):
            host = f"https://{host}"

        # Method 1: Try Databricks SDK (works automatically inside Databricks Apps)
        try:
            from databricks.sdk import WorkspaceClient
            w = WorkspaceClient()
            sdk_host = w.config.host
            sdk_token = w.config.token
            if sdk_host and sdk_token:
                if not sdk_host.startswith("https://"):
                    sdk_host = f"https://{sdk_host}"
                _token_cache["token"] = sdk_token
                _token_cache["host"] = sdk_host
                _token_cache["expires_at"] = now + _TOKEN_TTL
                logger.info("Databricks auth via SDK (host=%s, TTL=%ds)", sdk_host, _TOKEN_TTL)
                return sdk_host, sdk_token
        except Exception as exc:
            logger.debug("Databricks SDK auth not available: %s", exc)

        if not host:
            raise RuntimeError(
                "DATABRICKS_HOST not set and Databricks SDK auto-auth unavailable"
            )

        # Method 2: OAuth client credentials
        client_id = os.environ.get("DATABRICKS_CLIENT_ID", "")
        client_secret = os.environ.get("DATABRICKS_CLIENT_SECRET", "")
        if client_id and client_secret:
            token_url = f"{host}/oidc/v1/token"
            data = f"grant_type=client_credentials&client_id={client_id}&client_secret={client_secret}&scope=all-apis"
            req = urllib.request.Request(
                token_url, data=data.encode(), method="POST",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            resp = urllib.request.urlopen(req, timeout=30)
            token = json.loads(resp.read())["access_token"]
            _token_cache["token"] = token
            _token_cache["host"] = host
            _token_cache["expires_at"] = now + _TOKEN_TTL
            logger.info("Databricks OAuth token refreshed (TTL=%ds)", _TOKEN_TTL)
            return host, token

        # Method 3: Static token from env
        token = os.environ.get("DATABRICKS_TOKEN", "")
        if token:
            _token_cache["token"] = token
            _token_cache["host"] = host
            _token_cache["expires_at"] = now + _TOKEN_TTL
            return host, token

        raise RuntimeError(
            "No Databricks credentials found. "
            "Running inside a Databricks App: ensure the service principal has the right permissions. "
            "Otherwise set DATABRICKS_CLIENT_ID/SECRET or DATABRICKS_TOKEN."
        )
