"""Webhook notifications — Slack/Teams (Item 88)."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


async def send_webhook(
    url: str,
    event_type: str,
    payload: dict[str, Any],
    platform: str = 'slack',
) -> bool:
    """Send a webhook notification.

    Args:
        url: Webhook URL (Slack incoming webhook or Teams connector URL)
        event_type: Event type (upload_complete, analysis_complete, error)
        payload: Event data
        platform: 'slack' or 'teams'
    """
    if platform == 'slack':
        body = _format_slack(event_type, payload)
    elif platform == 'teams':
        body = _format_teams(event_type, payload)
    else:
        body = {'text': json.dumps(payload, indent=2)}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json=body)
            if resp.status_code < 300:
                logger.info("Webhook sent: %s → %s", event_type, url[:50])
                return True
            logger.warning("Webhook failed (%d): %s", resp.status_code, resp.text[:200])
            return False
    except Exception as exc:
        logger.warning("Webhook error: %s", exc)
        return False


def _format_slack(event_type: str, payload: dict) -> dict:
    """Format payload as Slack Block Kit message."""
    title = {
        'upload_complete': 'ETL Upload Complete',
        'analysis_complete': 'Vector Analysis Complete',
        'error': 'ETL Processing Error',
    }.get(event_type, event_type)

    emoji = {
        'upload_complete': ':white_check_mark:',
        'analysis_complete': ':chart_with_upwards_trend:',
        'error': ':x:',
    }.get(event_type, ':bell:')

    fields = []
    for key, val in payload.items():
        if key.startswith('_'):
            continue
        fields.append({
            'type': 'mrkdwn',
            'text': f"*{key.replace('_', ' ').title()}*\n{val}",
        })

    blocks = [
        {
            'type': 'header',
            'text': {'type': 'plain_text', 'text': f"{emoji} {title}"},
        },
        {
            'type': 'section',
            'fields': fields[:10],
        },
    ]

    return {'blocks': blocks}


def _format_teams(event_type: str, payload: dict) -> dict:
    """Format payload as Microsoft Teams Adaptive Card."""
    title = {
        'upload_complete': 'ETL Upload Complete',
        'analysis_complete': 'Vector Analysis Complete',
        'error': 'ETL Processing Error',
    }.get(event_type, event_type)

    facts = [
        {'title': k.replace('_', ' ').title(), 'value': str(v)}
        for k, v in payload.items()
        if not k.startswith('_')
    ]

    return {
        '@type': 'MessageCard',
        'summary': title,
        'themeColor': '0076D7' if 'error' not in event_type else 'FF0000',
        'sections': [{
            'activityTitle': title,
            'facts': facts[:10],
        }],
    }
