# Databricks notebook source
# MAGIC %md
# MAGIC # Migrate SQLite → Lakebase
# MAGIC Copies all data from the local ETL Dep Viz SQLite database into Lakebase.

# COMMAND ----------

import sqlite3
import psycopg2
from psycopg2.extras import execute_values
from databricks.sdk import WorkspaceClient

# COMMAND ----------

# Copy SQLite file from DBFS to local disk
dbutils.fs.cp("dbfs:/tmp/etl_dep_viz.db", "file:/tmp/etl_dep_viz.db")

# COMMAND ----------

# Configuration
SQLITE_PATH = "/tmp/etl_dep_viz.db"
LAKEBASE_HOST = "instance-82144a08-ea5e-4dfc-8a6f-d39f235c7252.database.azuredatabricks.net"
LAKEBASE_PORT = 5432
LAKEBASE_DB = "etl_dep_viz"

# Get OAuth token via Databricks SDK (works from notebooks)
w = WorkspaceClient()
user = spark.sql("SELECT current_user()").collect()[0][0]
token = w.tokens._api.do("POST", "/api/2.0/token/create", body={"lifetime_seconds": 3600, "comment": "lakebase-migrate"}).get("token_value", "")

# If that doesn't work, try the config token
if not token:
    token = w.config.token

print(f"Connecting as: {user}")
print(f"Token length: {len(token) if token else 0}")

# COMMAND ----------

# Tables in dependency order
TABLES = [
    "user_profiles", "projects", "uploads", "activity_log",
    "session_records", "table_records", "connection_records", "connection_profiles",
    "vw_tier_layout", "vw_galaxy_nodes", "vw_explorer_detail",
    "vw_write_conflicts", "vw_read_chains", "vw_exec_order",
    "vw_matrix_cells", "vw_table_profiles",
    "vw_duplicate_groups", "vw_duplicate_members",
    "vw_constellation_chunks", "vw_constellation_points", "vw_constellation_edges",
    "vw_complexity_scores", "vw_wave_assignments", "vw_umap_coords",
    "vw_communities", "vw_wave_function",
    "vw_concentration_groups", "vw_concentration_members", "vw_ensemble",
]

# COMMAND ----------

# Connect to SQLite
sqlite_conn = sqlite3.connect(SQLITE_PATH)
print(f"SQLite connected: {SQLITE_PATH}")

# Connect to Lakebase using Databricks personal access token
pg_conn = psycopg2.connect(
    host=LAKEBASE_HOST,
    port=LAKEBASE_PORT,
    dbname=LAKEBASE_DB,
    user=user,
    password=token,
    sslmode="require",
)
pg_conn.autocommit = False
pg_cur = pg_conn.cursor()
print(f"Lakebase connected: {LAKEBASE_HOST}/{LAKEBASE_DB}")

# COMMAND ----------

# Migrate each table
total_rows = 0

for table in TABLES:
    sqlite_cur = sqlite_conn.execute(f'SELECT COUNT(*) FROM "{table}"')
    count = sqlite_cur.fetchone()[0]
    if count == 0:
        print(f"  {table}: empty, skipping")
        continue

    # Get column names
    sqlite_cur = sqlite_conn.execute(f'PRAGMA table_info("{table}")')
    columns = [row[1] for row in sqlite_cur.fetchall()]

    # Read all rows
    sqlite_cur = sqlite_conn.execute(f'SELECT * FROM "{table}"')
    rows = sqlite_cur.fetchall()

    # Clear existing data
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

    # Reset sequence
    if "id" in columns:
        pg_cur.execute(f'SELECT MAX(id) FROM "{table}"')
        max_id = pg_cur.fetchone()[0]
        if max_id:
            pg_cur.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), {max_id})")
            pg_conn.commit()

    total_rows += count
    print(f"  {table}: {count} rows migrated")

print(f"\nDone! Migrated {total_rows} total rows.")

# COMMAND ----------

sqlite_conn.close()
pg_cur.close()
pg_conn.close()
print("Connections closed. Migration complete!")
