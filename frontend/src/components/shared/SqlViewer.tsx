/**
 * SqlViewer — Syntax-highlighted SQL code viewer.
 * Highlights keywords, strings, numbers, comments. Collapsible with copy button.
 */

import { useState, useMemo } from 'react';

interface Props {
  sql: string;
  title?: string;
  defaultCollapsed?: boolean;
}

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'DROP',
  'ALTER', 'TABLE', 'INDEX', 'VIEW', 'MERGE', 'USING', 'WHEN', 'MATCHED',
  'THEN', 'AS', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL',
  'CROSS', 'UNION', 'ALL', 'DISTINCT', 'GROUP', 'BY', 'ORDER', 'HAVING',
  'LIMIT', 'OFFSET', 'CASE', 'END', 'ELSE', 'NULL', 'IS', 'LIKE', 'ASC',
  'DESC', 'WITH', 'RECURSIVE', 'TEMP', 'TEMPORARY', 'IF', 'REPLACE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'EXEC', 'EXECUTE', 'CALL', 'DECLARE',
  'CURSOR', 'FETCH', 'OPEN', 'CLOSE', 'GRANT', 'REVOKE', 'TRUNCATE',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NVL', 'CAST',
]);

function highlightSQL(sql: string): JSX.Element[] {
  const tokens: JSX.Element[] = [];
  // Simple tokenizer: split on boundaries
  const regex = /('(?:[^'\\]|\\.)*'|--[^\n]*|\/\*[\s\S]*?\*\/|\b\d+\.?\d*\b|\b[A-Za-z_]\w*\b|[^\s])/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let key = 0;

  while ((match = regex.exec(sql)) !== null) {
    // Add whitespace between tokens
    if (match.index > lastIndex) {
      tokens.push(<span key={key++}>{sql.slice(lastIndex, match.index)}</span>);
    }
    const token = match[0];
    if (token.startsWith("'") || token.startsWith('"')) {
      tokens.push(<span key={key++} style={{ color: '#10B981' }}>{token}</span>);
    } else if (token.startsWith('--') || token.startsWith('/*')) {
      tokens.push(<span key={key++} style={{ color: '#64748b', fontStyle: 'italic' }}>{token}</span>);
    } else if (/^\d/.test(token)) {
      tokens.push(<span key={key++} style={{ color: '#F97316' }}>{token}</span>);
    } else if (SQL_KEYWORDS.has(token.toUpperCase())) {
      tokens.push(<span key={key++} style={{ color: '#60A5FA', fontWeight: 600 }}>{token}</span>);
    } else {
      tokens.push(<span key={key++}>{token}</span>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < sql.length) {
    tokens.push(<span key={key++}>{sql.slice(lastIndex)}</span>);
  }
  return tokens;
}

export default function SqlViewer({ sql, title, defaultCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => sql.split('\n'), [sql]);
  const highlighted = useMemo(() => highlightSQL(sql), [sql]);

  const handleCopy = () => {
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ borderRadius: 8, border: '1px solid #334155', overflow: 'hidden', marginBottom: 8 }}>
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{
          padding: '6px 12px', background: '#1e293b', display: 'flex',
          justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8' }}>
          {collapsed ? '\u25B6' : '\u25BC'} {title || 'SQL'} ({lines.length} lines)
        </span>
        <button
          onClick={e => { e.stopPropagation(); handleCopy(); }}
          style={{
            fontSize: 10, color: copied ? '#10B981' : '#64748b',
            background: 'transparent', border: 'none', cursor: 'pointer',
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      {!collapsed && (
        <div style={{ display: 'flex', background: '#0f172a', overflow: 'auto', maxHeight: 400 }}>
          <div style={{
            padding: '8px 8px 8px 12px', borderRight: '1px solid #334155',
            color: '#475569', fontSize: 11, fontFamily: 'monospace', textAlign: 'right',
            userSelect: 'none', lineHeight: '1.6',
          }}>
            {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
          </div>
          <pre style={{
            padding: '8px 12px', margin: 0, fontSize: 11, fontFamily: 'monospace',
            color: '#e2e8f0', lineHeight: '1.6', whiteSpace: 'pre-wrap', flex: 1,
          }}>
            {highlighted}
          </pre>
        </div>
      )}
    </div>
  );
}
