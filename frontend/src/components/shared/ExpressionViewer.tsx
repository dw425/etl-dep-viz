/**
 * ExpressionViewer — Syntax-highlighted Informatica expression viewer.
 * Highlights Informatica functions, field references, parameters.
 */

import { useMemo } from 'react';

interface Props {
  expression: string;
  onFieldClick?: (fieldName: string) => void;
}

const INFA_FUNCTIONS = new Set([
  'IIF', 'DECODE', 'LOOKUP', 'LKP', 'TO_DATE', 'TO_CHAR', 'TO_INTEGER', 'TO_DECIMAL',
  'TO_BIGINT', 'TO_FLOAT', 'SUBSTR', 'CONCAT', 'LTRIM', 'RTRIM', 'LPAD', 'RPAD',
  'UPPER', 'LOWER', 'INITCAP', 'LENGTH', 'INSTR', 'REPLACE', 'REG_REPLACE',
  'TRUNC', 'ROUND', 'MOD', 'ABS', 'POWER', 'SQRT', 'CEIL', 'FLOOR',
  'SYSDATE', 'SYSTIMESTAMP', 'SESSSTARTTIME', 'ADD_TO_DATE', 'DATE_DIFF',
  'IS_DATE', 'IS_NUMBER', 'IS_SPACES', 'ISNULL',
  'SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'FIRST', 'LAST', 'MEDIAN',
  'ERROR', 'ABORT', 'SET_DATE_PART', 'GET_DATE_PART',
  'IN', 'AND', 'OR', 'NOT', 'TRUE', 'FALSE', 'NULL',
  'MOVINGSUM', 'MOVINGAVG', 'CUME', 'PERCENTILE',
  'NVL', 'NVL2', 'COALESCE',
]);

function highlightExpression(
  expr: string,
  onFieldClick?: (fieldName: string) => void,
): JSX.Element[] {
  const tokens: JSX.Element[] = [];
  const regex = /('(?:[^'\\]|\\.)*'|\$\$\w+|\$PM\w+|\b\d+\.?\d*\b|\b[A-Za-z_]\w*\b|[^\s])/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let key = 0;

  while ((match = regex.exec(expr)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(<span key={key++}>{expr.slice(lastIndex, match.index)}</span>);
    }
    const token = match[0];
    if (token.startsWith("'")) {
      tokens.push(<span key={key++} style={{ color: '#10B981' }}>{token}</span>);
    } else if (token.startsWith('$$') || token.startsWith('$PM')) {
      tokens.push(<span key={key++} style={{ color: '#F472B6', fontWeight: 600 }}>{token}</span>);
    } else if (/^\d/.test(token)) {
      tokens.push(<span key={key++} style={{ color: '#F97316' }}>{token}</span>);
    } else if (INFA_FUNCTIONS.has(token.toUpperCase())) {
      tokens.push(<span key={key++} style={{ color: '#A78BFA', fontWeight: 600 }}>{token}</span>);
    } else if (/^[A-Z_]\w*$/i.test(token) && !INFA_FUNCTIONS.has(token.toUpperCase())) {
      // Likely a field reference
      tokens.push(
        <span
          key={key++}
          style={{ color: '#60A5FA', cursor: onFieldClick ? 'pointer' : 'default', textDecoration: onFieldClick ? 'underline' : 'none' }}
          onClick={() => onFieldClick?.(token)}
        >
          {token}
        </span>
      );
    } else {
      tokens.push(<span key={key++} style={{ color: '#e2e8f0' }}>{token}</span>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < expr.length) {
    tokens.push(<span key={key++}>{expr.slice(lastIndex)}</span>);
  }
  return tokens;
}

export default function ExpressionViewer({ expression, onFieldClick }: Props) {
  const highlighted = useMemo(
    () => highlightExpression(expression, onFieldClick),
    [expression, onFieldClick],
  );

  if (!expression) return null;

  return (
    <pre style={{
      padding: '8px 12px', margin: 0, fontSize: 11, fontFamily: 'monospace',
      background: '#0f172a', borderRadius: 6, border: '1px solid #334155',
      color: '#e2e8f0', lineHeight: '1.6', whiteSpace: 'pre-wrap',
      overflowX: 'auto',
    }}>
      {highlighted}
    </pre>
  );
}
