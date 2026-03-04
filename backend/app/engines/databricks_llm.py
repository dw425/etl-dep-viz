"""Databricks Foundation Model LLM client.

Calls Databricks serving endpoints for LLM inference using the workspace's
OAuth token (service principal). No external API keys required.

Usage:
    client = DatabricksLLM(model="databricks-meta-llama-3-1-70b-instruct")
    response = await client.generate(system_prompt, messages)
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.request

from app.engines.databricks_auth import get_databricks_token

logger = logging.getLogger("edv.databricks_llm")


class DatabricksLLM:
    """Databricks Foundation Model serving endpoint client."""

    def __init__(self, model: str = "databricks-meta-llama-3-1-70b-instruct"):
        self.model = model

    def _call_endpoint(self, system_prompt: str, messages: list[dict], max_tokens: int) -> str:
        """Synchronous call to the Databricks Foundation Model endpoint."""
        host, token = get_databricks_token()
        url = f"{host}/serving-endpoints/{self.model}/invocations"

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
            resp = urllib.request.urlopen(req, timeout=30)
            result = json.loads(resp.read())
            return result["choices"][0]["message"]["content"]
        except Exception as exc:
            logger.error("Databricks LLM call failed: %s", exc)
            raise

    async def generate(self, system_prompt: str, messages: list[dict], max_tokens: int = 2048) -> str:
        """Call the Databricks Foundation Model endpoint asynchronously.

        Wraps the blocking HTTP call in asyncio.to_thread to avoid
        blocking the event loop.
        """
        return await asyncio.to_thread(self._call_endpoint, system_prompt, messages, max_tokens)
