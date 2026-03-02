/**
 * Utility functions for L1A Infrastructure Topology view.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ConnectionSubNode {
  connection_name: string;
  dbtype: string;
  dbsubtype?: string;
  connection_string?: string;
  parsed_connection?: ParsedConnectionString;
  session_count: number;
  session_ids: string[];
}

export interface SystemNode {
  system_id: string;
  system_type: string;
  environment: string;
  session_count: number;
  table_count: number;
  connections: string[];
  sub_nodes: ConnectionSubNode[];
  session_ids: string[];
}

export interface SystemEdge {
  source: string;
  target: string;
  session_count: number;
  session_ids: string[];
  direction: 'directed' | 'bidirectional';
}

export interface ParsedConnectionString {
  host?: string;
  port?: string;
  database?: string;
  raw: string;
}

// ── Connection string parsing ──────────────────────────────────────────────────

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

export function mapDbTypeToEnv(dbtype: string): string {
  const lower = (dbtype || '').toLowerCase();
  if (lower.includes('s3') || lower.includes('redshift') || lower.includes('aws')) return 'aws';
  if (lower.includes('azure') || lower.includes('synapse')) return 'azure';
  if (lower.includes('bigquery') || lower.includes('gcs')) return 'gcp';
  return 'on-prem';
}

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

export interface SchemaGroup {
  schema: string;
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
