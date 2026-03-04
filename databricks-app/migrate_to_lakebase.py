"""Migrate data from local SQLite to Lakebase (PostgreSQL).

Usage:
    python3 databricks-app/migrate_to_lakebase.py

Requires:
    pip install psycopg2-binary sqlalchemy

Reads from the local SQLite database and writes to the Lakebase instance
configured in app.yaml. Uses the Databricks CLI token for authentication.
"""

import json
import os
import subprocess
import sys
import urllib.request

# ── Configuration ──────────────────────────────────────────────────────────

SQLITE_PATH = os.path.join(os.path.dirname(__file__), "..", "backend", "etl_dep_viz.db")

LAKEBASE_HOST = "instance-82144a08-ea5e-4dfc-8a6f-d39f235c7252.database.azuredatabricks.net"
LAKEBASE_PORT = 5432
LAKEBASE_DB = "etl_dep_viz"
LAKEBASE_USER = "dan@bpcs.com"

DATABRICKS_HOST = "https://adb-1866518241053589.9.azuredatabricks.net"
DATABRICKS_PROFILE = "blueprint_demos"

# Tables in dependency order (parents before children)
TABLES = [
    "user_profiles",
    "projects",
    "uploads",
    "activity_log",
    "session_records",
    "table_records",
    "connection_records",
    "connection_profiles",
    "vw_tier_layout",
    "vw_galaxy_nodes",
    "vw_explorer_detail",
    "vw_write_conflicts",
    "vw_read_chains",
    "vw_exec_order",
    "vw_matrix_cells",
    "vw_table_profiles",
    "vw_duplicate_groups",
    "vw_duplicate_members",
    "vw_constellation_chunks",
    "vw_constellation_points",
    "vw_constellation_edges",
    "vw_complexity_scores",
    "vw_wave_assignments",
    "vw_umap_coords",
    "vw_communities",
    "vw_wave_function",
    "vw_concentration_groups",
    "vw_concentration_members",
    "vw_ensemble",
]


def get_oauth_token():
    """Get an OAuth token using the Databricks CLI."""
    result = subprocess.run(
        ["databricks", "auth", "token", "--profile", DATABRICKS_PROFILE],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"Error getting token: {result.stderr}")
        sys.exit(1)
    # The output is JSON with an access_token field
    try:
        data = json.loads(result.stdout)
        return data["access_token"]
    except (json.JSONDecodeError, KeyError):
        # Some CLI versions just print the token directly
        return result.stdout.strip()


def main():
    import sqlite3
    import psycopg2
    from psycopg2.extras import execute_values

    # Connect to local SQLite
    print(f"Connecting to SQLite: {SQLITE_PATH}")
    sqlite_conn = sqlite3.connect(SQLITE_PATH)
    sqlite_conn.row_factory = sqlite3.Row

    # Get OAuth token for Lakebase
    print("Fetching OAuth token via Databricks CLI...")
    token = get_oauth_token()
    print(f"Got token ({len(token)} chars)")

    # Connect to Lakebase
    print(f"Connecting to Lakebase: {LAKEBASE_HOST}:{LAKEBASE_PORT}/{LAKEBASE_DB}")
    pg_conn = psycopg2.connect(
        host=LAKEBASE_HOST,
        port=LAKEBASE_PORT,
        dbname=LAKEBASE_DB,
        user=LAKEBASE_USER,
        password=token,
        sslmode="require",
    )
    pg_conn.autocommit = False
    pg_cur = pg_conn.cursor()

    # Migrate each table
    total_rows = 0
    for table in TABLES:
        sqlite_cur = sqlite_conn.execute(f'SELECT COUNT(*) FROM "{table}"')
        count = sqlite_cur.fetchone()[0]
        if count == 0:
            print(f"  {table}: empty, skipping")
            continue

        # Get column names from SQLite
        sqlite_cur = sqlite_conn.execute(f'PRAGMA table_info("{table}")')
        columns = [row[1] for row in sqlite_cur.fetchall()]

        # Read all rows from SQLite
        sqlite_cur = sqlite_conn.execute(f'SELECT * FROM "{table}"')
        rows = sqlite_cur.fetchall()

        # Clear existing data in Lakebase table
        pg_cur.execute(f'DELETE FROM "{table}"')

        # Insert in batches
        col_list = ", ".join(f'"{c}"' for c in columns)
        placeholders = ", ".join(["%s"] * len(columns))
        insert_sql = f'INSERT INTO "{table}" ({col_list}) VALUES %s'

        batch_size = 1000
        for i in range(0, len(rows), batch_size):
            batch = [tuple(row) for row in rows[i:i + batch_size]]
            execute_values(pg_cur, insert_sql, batch, template=f"({placeholders})")

        pg_conn.commit()

        # Reset sequence for tables with autoincrement id
        if "id" in columns:
            pg_cur.execute(f'SELECT MAX(id) FROM "{table}"')
            max_id = pg_cur.fetchone()[0]
            if max_id:
                pg_cur.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), {max_id})")
                pg_conn.commit()

        total_rows += count
        print(f"  {table}: {count} rows migrated")

    print(f"\nDone! Migrated {total_rows} total rows across {len(TABLES)} tables.")

    sqlite_conn.close()
    pg_cur.close()
    pg_conn.close()


if __name__ == "__main__":
    main()
