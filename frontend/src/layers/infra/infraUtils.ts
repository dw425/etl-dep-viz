/**
 * Utility functions for L1A Infrastructure Topology view.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

/** A named database connection within a system node (e.g. "ORACLE_PROD", "TD_DW"). */
export interface ConnectionSubNode {
  /** Connection profile name from Informatica. */
  connection_name: string;
  /** Database type (e.g. "Oracle", "Teradata"). */
  dbtype: string;
  /** Database subtype if available. */
  dbsubtype?: string;
  /** Raw connection string (JDBC URL, host:port, etc.). */
  connection_string?: string;
  /** Parsed host/port/database from the connection string. */
  parsed_connection?: ParsedConnectionString;
  /** Number of sessions using this connection. */
  session_count: number;
  /** Session IDs that reference this connection. */
  session_ids: string[];
}

/** An infrastructure system node (Oracle, S3, Kafka, etc.) aggregated from connections/tables. */
export interface SystemNode {
  /** Unique system identifier (e.g. "oracle", "s3", "kafka"). */
  system_id: string;
  /** System type label. */
  system_type: string;
  /** Deployment environment: "on-prem", "aws", "azure", "gcp", or "unknown". */
  environment: string;
  /** Number of ETL sessions touching this system. */
  session_count: number;
  /** Number of tables belonging to this system. */
  table_count: number;
  /** Named connection profiles associated with this system. */
  connections: string[];
  /** Expanded connection sub-nodes with per-connection session counts. */
  sub_nodes: ConnectionSubNode[];
  /** Flat list of session IDs touching this system. */
  session_ids: string[];
}

/** An edge between two system nodes, representing data flow via ETL sessions. */
export interface SystemEdge {
  /** Source system_id. */
  source: string;
  /** Target system_id. */
  target: string;
  /** Number of sessions that move data along this edge. */
  session_count: number;
  /** Session IDs traversing this edge. */
  session_ids: string[];
  /** "directed" if one-way, "bidirectional" if sessions flow both directions. */
  direction: 'directed' | 'bidirectional';
}

/** Structured components extracted from a raw connection string. */
export interface ParsedConnectionString {
  /** Hostname or IP address. */
  host?: string;
  /** Port number as string. */
  port?: string;
  /** Database or service name. */
  database?: string;
  /** Original unparsed connection string. */
  raw: string;
}

// ── Connection string parsing ──────────────────────────────────────────────────

/**
 * Parses a connection string into host, port, and database components.
 * Supports JDBC Oracle, generic JDBC, simple host:port/db, and host:port formats.
 * @param raw - Raw connection string (JDBC URL, host:port, etc.)
 * @returns Parsed components, or undefined if input is empty
 */
export function parseConnectionString(raw: string | undefined): ParsedConnectionString | undefined {
  if (!raw || !raw.trim()) return undefined;
  const s = raw.trim();
  const result: ParsedConnectionString = { raw: s };

  // JDBC Oracle: jdbc:oracle:thin:@host:port/dbname or jdbc:oracle:thin:@host:port:SID
  const jdbcOracle = s.match(/jdbc:oracle:thin:@([^:]+):(\d+)[:/](\S+)/i);
  if (jdbcOracle) {
    result.host = jdbcOracle[1];
    result.port = jdbcOracle[2];
    result.database = jdbcOracle[3];
    return result;
  }

  // Generic JDBC: jdbc:type://host:port/db or jdbc:type:host:port/db
  const jdbcGeneric = s.match(/jdbc:\w+:(?:\/\/)?([^:/?]+)(?::(\d+))?(?:\/(\S+))?/i);
  if (jdbcGeneric) {
    result.host = jdbcGeneric[1];
    result.port = jdbcGeneric[2];
    result.database = jdbcGeneric[3];
    return result;
  }

  // Simple: host:port/database
  const simple = s.match(/^([^:/?]+):(\d+)\/(\S+)$/);
  if (simple) {
    result.host = simple[1];
    result.port = simple[2];
    result.database = simple[3];
    return result;
  }

  // Host:port only
  const hostPort = s.match(/^([^:/?]+):(\d+)$/);
  if (hostPort) {
    result.host = hostPort[1];
    result.port = hostPort[2];
    return result;
  }

  return result;
}

// ── System type mapping ────────────────────────────────────────────────────────

/**
 * Maps an Informatica dbtype string to a canonical system type identifier.
 * @param dbtype - Database type string from connection profile (e.g. "Oracle", "SQL Server")
 * @returns Canonical system type (e.g. "oracle", "sqlserver", "postgres")
 */
export function mapDbTypeToSystem(dbtype: string): string {
  const lower = (dbtype || '').toLowerCase();
  if (lower.includes('oracle')) return 'oracle';
  if (lower.includes('teradata')) return 'teradata';
  if (lower.includes('sql server') || lower.includes('mssql') || lower.includes('sqlserver')) return 'sqlserver';
  if (lower.includes('db2')) return 'db2';
  if (lower.includes('mysql')) return 'mysql';
  if (lower.includes('postgres')) return 'postgres';
  if (lower.includes('sybase')) return 'sybase';
  if (lower.includes('informix')) return 'informix';
  if (lower.includes('odbc')) return 'odbc';
  return lower || 'unknown';
}

/**
 * Maps a dbtype string to a deployment environment.
 * @param dbtype - Database type string
 * @returns Environment: "aws", "azure", "gcp", or "on-prem"
 */
export function mapDbTypeToEnv(dbtype: string): string {
  const lower = (dbtype || '').toLowerCase();
  if (lower.includes('s3') || lower.includes('redshift') || lower.includes('aws')) return 'aws';
  if (lower.includes('azure') || lower.includes('synapse')) return 'azure';
  if (lower.includes('bigquery') || lower.includes('gcs')) return 'gcp';
  return 'on-prem';
}

/**
 * Infers the system type and environment from a table or object name using regex patterns.
 * This is the fallback detection mode when connection profiles are not available.
 * @param name - Table name, connection name, or object identifier
 * @returns system_id, system_type, and environment tuple
 */
export function inferSystem(name: string): { system_id: string; system_type: string; environment: string } {
  const lower = name.toLowerCase();

  const patterns: [RegExp, string, string][] = [
    [/oracle|ora_|orcl/i, 'oracle', 'on-prem'],
    [/teradata|td_|tera/i, 'teradata', 'on-prem'],
    [/postgres|pg_|pgsql/i, 'postgres', 'on-prem'],
    [/mysql|maria/i, 'mysql', 'on-prem'],
    [/sqlserver|mssql|tsql/i, 'sqlserver', 'on-prem'],
    [/s3:|s3_|aws_|amazon/i, 's3', 'aws'],
    [/redshift/i, 'redshift', 'aws'],
    [/dynamodb/i, 'dynamodb', 'aws'],
    [/azure|adls|blob/i, 'azure_storage', 'azure'],
    [/synapse/i, 'synapse', 'azure'],
    [/bigquery|bq_/i, 'bigquery', 'gcp'],
    [/gcs:/i, 'gcs', 'gcp'],
    [/kafka|confluent/i, 'kafka', 'on-prem'],
    [/hdfs|hadoop|hive/i, 'hdfs', 'on-prem'],
    [/ftp|sftp/i, 'ftp', 'on-prem'],
    [/http|rest|api/i, 'http', 'unknown'],
  ];

  for (const [regex, sysType, env] of patterns) {
    if (regex.test(lower)) {
      return { system_id: sysType, system_type: sysType, environment: env };
    }
  }

  return { system_id: 'unknown', system_type: 'unknown', environment: 'unknown' };
}

// ── Schema parsing from raw table names ────────────────────────────────────────

/** A group of tables that share the same schema/owner prefix. */
export interface SchemaGroup {
  /** Schema or owner name (e.g. "DW_OWNER"). "(default)" for unqualified names. */
  schema: string;
  /** Deduplicated, sorted list of table names within this schema. */
  tables: string[];
}

/** Parse OWNER.TABLE patterns from raw names, grouping by schema. */
export function groupBySchema(rawNames: string[]): SchemaGroup[] {
  const map = new Map<string, string[]>();
  for (const raw of rawNames) {
    const trimmed = raw.trim().toUpperCase();
    if (!trimmed) continue;
    // Strip connection prefix (CONN/..., CONN:...)
    let name = trimmed;
    if (name.includes('/')) name = name.split('/').pop()!;
    if (name.includes(':')) name = name.split(':').pop()!;
    // OWNER.TABLE → schema=OWNER, table=TABLE
    if (name.includes('.')) {
      const parts = name.split('.');
      const table = parts.pop()!;
      const schema = parts.join('.');
      if (schema && table) {
        (map.get(schema) ?? (map.set(schema, []), map.get(schema)!)).push(table);
        continue;
      }
    }
    // No schema
    (map.get('(default)') ?? (map.set('(default)', []), map.get('(default)')!)).push(name);
  }
  return Array.from(map.entries())
    .map(([schema, tables]) => ({ schema, tables: [...new Set(tables)].sort() }))
    .sort((a, b) => a.schema.localeCompare(b.schema));
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const ENV_COLORS: Record<string, string> = {
  'on-prem': '#F59E0B',
  aws: '#FF9900',
  azure: '#0078D4',
  gcp: '#4285F4',
  unknown: '#6B7280',
};

export const SYSTEM_ICONS: Record<string, string> = {
  oracle: '\u{1F536}',
  teradata: '\u{1F7E0}',
  postgres: '\u{1F418}',
  mysql: '\u{1F42C}',
  sqlserver: '\u{1F537}',
  db2: '\u{1F4CA}',
  sybase: '\u{1F4C0}',
  informix: '\u{1F4D2}',
  odbc: '\u{1F517}',
  s3: '\u{1F4E6}',
  redshift: '\u{1F534}',
  dynamodb: '\u26A1',
  azure_storage: '\u{1F4E6}',
  synapse: '\u{1F52E}',
  bigquery: '\u{1F50D}',
  gcs: '\u{1F4E6}',
  kafka: '\u{1F4E1}',
  hdfs: '\u{1F4BE}',
  ftp: '\u{1F4C2}',
  http: '\u{1F310}',
  unknown: '\u2B1C',
};
