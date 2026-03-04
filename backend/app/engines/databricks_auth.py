"""Shared Databricks OAuth token management with caching.

Provides a single get_databricks_token() function used by both the LLM
and Embedding clients, with a 50-minute cache (tokens last 1 hour).
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
        client_id = os.environ.get("DATABRICKS_CLIENT_ID", "")
        client_secret = os.environ.get("DATABRICKS_CLIENT_SECRET", "")

        if not host:
            raise RuntimeError("DATABRICKS_HOST not set")
        if not host.startswith("https://"):
            host = f"https://{host}"

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

        # Fallback: static token from env
        token = os.environ.get("DATABRICKS_TOKEN", "")
        if token:
            _token_cache["token"] = token
            _token_cache["host"] = host
            _token_cache["expires_at"] = now + _TOKEN_TTL
            return host, token

        raise RuntimeError(
            "No Databricks credentials found (need DATABRICKS_CLIENT_ID/SECRET or DATABRICKS_TOKEN)"
        )
