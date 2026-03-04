"""Databricks Foundation Model LLM client.

Calls Databricks serving endpoints for LLM inference using the workspace's
OAuth token (service principal). No external API keys required.

Usage:
    client = DatabricksLLM(model="databricks-meta-llama-3-1-70b-instruct")
    response = await client.generate(system_prompt, messages)
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request

logger = logging.getLogger("edv.databricks_llm")


def _get_databricks_token() -> tuple[str, str]:
    """Get Databricks host and OAuth token from environment.

    Uses the same service principal OAuth flow as Lakebase auth.
    Returns (host, token) tuple.
    """
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
        resp = urllib.request.urlopen(req)
        token = json.loads(resp.read())["access_token"]
        return host, token

    # Fallback: check for a static token (e.g., from Databricks CLI)
    token = os.environ.get("DATABRICKS_TOKEN", "")
    if token:
        return host, token

    raise RuntimeError("No Databricks credentials found (need DATABRICKS_CLIENT_ID/SECRET or DATABRICKS_TOKEN)")


class DatabricksLLM:
    """Databricks Foundation Model serving endpoint client."""

    def __init__(self, model: str = "databricks-meta-llama-3-1-70b-instruct"):
        self.model = model

    async def generate(self, system_prompt: str, messages: list[dict], max_tokens: int = 2048) -> str:
        """Call the Databricks Foundation Model endpoint.

        Args:
            system_prompt: System instruction for the model.
            messages: List of {"role": "user"/"assistant", "content": "..."} dicts.
            max_tokens: Maximum response tokens.

        Returns:
            The model's response text.
        """
        host, token = _get_databricks_token()

        url = f"{host}/serving-endpoints/{self.model}/invocations"

        # Foundation Model API expects OpenAI-compatible format
        all_messages = [{"role": "system", "content": system_prompt}] + messages

        payload = json.dumps({
            "messages": all_messages,
            "max_tokens": max_tokens,
        }).encode()

        req = urllib.request.Request(
            url, data=payload, method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
        )

        try:
            resp = urllib.request.urlopen(req)
            result = json.loads(resp.read())
            return result["choices"][0]["message"]["content"]
        except Exception as exc:
            logger.error("Databricks LLM call failed: %s", exc)
            raise
