"""JIRA ticket generation — CSV/JSON export for migration tasks (Item 83)."""

from __future__ import annotations

import csv
import io
import json
from typing import Any


def generate_jira_csv(tier_data: dict, vector_results: dict | None = None) -> str:
    """Generate CSV importable by JIRA for migration task creation.

    Columns: Summary, Description, Priority, Labels, Story Points
    """
    sessions = tier_data.get('sessions', [])
    complexity_map = {}
    if vector_results and 'v11_complexity' in vector_results:
        for s in vector_results['v11_complexity'].get('scores', []):
            complexity_map[s['session_id']] = s

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        'Summary', 'Description', 'Issue Type', 'Priority',
        'Labels', 'Story Points', 'Component',
    ])

    # Sort by tier for logical grouping
    sorted_sessions = sorted(sessions, key=lambda s: (s.get('tier', 0), s.get('step', 0)))

    for s in sorted_sessions:
        sid = s['id']
        name = s.get('name', sid)
        tier = s.get('tier', 0)
        transforms = s.get('transforms', 0)
        lookups = s.get('lookupCount', 0)
        critical = s.get('critical', False)

        complexity = complexity_map.get(sid, {})
        bucket = complexity.get('bucket', 'Unknown')
        score = complexity.get('overall_score', 0)

        # Priority based on criticality and complexity
        if critical:
            priority = 'Critical'
        elif bucket in ('Very Complex', 'Complex'):
            priority = 'High'
        elif bucket == 'Medium':
            priority = 'Medium'
        else:
            priority = 'Low'

        # Story points based on complexity
        if bucket == 'Very Complex':
            points = 8
        elif bucket == 'Complex':
            points = 5
        elif bucket == 'Medium':
            points = 3
        else:
            points = 1

        summary = f"Migrate ETL: {name}"
        description = (
            f"Session: {name}\\n"
            f"Tier: {tier}\\n"
            f"Transforms: {transforms}\\n"
            f"Lookups: {lookups}\\n"
            f"Complexity: {bucket} ({score:.1f})\\n"
            f"Critical: {'Yes' if critical else 'No'}"
        )
        labels = f"tier-{tier} {bucket.lower().replace(' ', '-')}"
        if critical:
            labels += " critical"

        writer.writerow([
            summary, description, 'Task', priority,
            labels, points, f'Tier {tier}',
        ])

    return output.getvalue()


def generate_jira_json(tier_data: dict, vector_results: dict | None = None) -> list[dict]:
    """Generate JSON array of JIRA-ready ticket data."""
    sessions = tier_data.get('sessions', [])
    complexity_map = {}
    if vector_results and 'v11_complexity' in vector_results:
        for s in vector_results['v11_complexity'].get('scores', []):
            complexity_map[s['session_id']] = s

    tickets = []
    for s in sorted(sessions, key=lambda s: (s.get('tier', 0), s.get('step', 0))):
        sid = s['id']
        name = s.get('name', sid)
        tier = s.get('tier', 0)
        complexity = complexity_map.get(sid, {})
        bucket = complexity.get('bucket', 'Unknown')
        critical = s.get('critical', False)

        tickets.append({
            'summary': f"Migrate ETL: {name}",
            'session_id': sid,
            'tier': tier,
            'transforms': s.get('transforms', 0),
            'lookups': s.get('lookupCount', 0),
            'complexity_bucket': bucket,
            'complexity_score': complexity.get('overall_score', 0),
            'critical': critical,
            'priority': 'Critical' if critical else 'High' if bucket in ('Very Complex', 'Complex') else 'Medium' if bucket == 'Medium' else 'Low',
            'story_points': 8 if bucket == 'Very Complex' else 5 if bucket == 'Complex' else 3 if bucket == 'Medium' else 1,
            'labels': [f'tier-{tier}', bucket.lower().replace(' ', '-')] + (['critical'] if critical else []),
        })

    return tickets
