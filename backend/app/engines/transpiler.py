"""Expression-to-SQL transpiler — converts Informatica expressions to SQL.

Rule-based transpiler for common Informatica expression functions to
standard SQL (Databricks SQL / Spark SQL). Falls back to LLM-assisted
transpilation for complex/nested expressions.

Usage:
    transpiler = ExpressionTranspiler()
    sql = transpiler.transpile("IIF(ISNULL(COL1), 'N/A', COL1)")
    # => "CASE WHEN COL1 IS NULL THEN 'N/A' ELSE COL1 END"
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger("edv.transpiler")


# Rule definitions: (pattern, replacement, description)
_RULES: list[tuple[re.Pattern, str, str]] = [
    # IIF(cond, true_val, false_val) → CASE WHEN cond THEN true_val ELSE false_val END
    (
        re.compile(r'IIF\s*\(\s*(.+?)\s*,\s*(.+?)\s*,\s*(.+?)\s*\)', re.IGNORECASE),
        r'CASE WHEN \1 THEN \2 ELSE \3 END',
        "IIF → CASE WHEN",
    ),
    # ISNULL(expr) → expr IS NULL
    (
        re.compile(r'ISNULL\s*\(\s*(.+?)\s*\)', re.IGNORECASE),
        r'\1 IS NULL',
        "ISNULL → IS NULL",
    ),
    # NVL(expr, default) → COALESCE(expr, default)
    (
        re.compile(r'NVL\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)', re.IGNORECASE),
        r'COALESCE(\1, \2)',
        "NVL → COALESCE",
    ),
    # NVL2(expr, not_null_val, null_val) → CASE WHEN expr IS NOT NULL THEN not_null_val ELSE null_val END
    (
        re.compile(r'NVL2\s*\(\s*(.+?)\s*,\s*(.+?)\s*,\s*(.+?)\s*\)', re.IGNORECASE),
        r'CASE WHEN \1 IS NOT NULL THEN \2 ELSE \3 END',
        "NVL2 → CASE WHEN",
    ),
    # LTRIM/RTRIM(str) → LTRIM/RTRIM(str)  (same in SQL, but add TRIM for LTRIM+RTRIM)
    # SUBSTR(str, start, len) → SUBSTRING(str, start, len)
    (
        re.compile(r'SUBSTR\s*\(', re.IGNORECASE),
        r'SUBSTRING(',
        "SUBSTR → SUBSTRING",
    ),
    # INSTR(str, substr) → LOCATE(substr, str)  (Spark SQL)
    (
        re.compile(r'INSTR\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)', re.IGNORECASE),
        r'LOCATE(\2, \1)',
        "INSTR → LOCATE",
    ),
    # TO_CHAR(expr, format) → DATE_FORMAT(expr, format) for dates
    (
        re.compile(r'TO_CHAR\s*\(\s*(.+?)\s*,\s*(.+?)\s*\)', re.IGNORECASE),
        r'DATE_FORMAT(\1, \2)',
        "TO_CHAR → DATE_FORMAT",
    ),
    # TO_DATE(str, format) → TO_DATE(str, format)  (same in Spark SQL)
    # TO_INTEGER(expr) → CAST(expr AS INT)
    (
        re.compile(r'TO_INTEGER\s*\(\s*(.+?)\s*\)', re.IGNORECASE),
        r'CAST(\1 AS INT)',
        "TO_INTEGER → CAST AS INT",
    ),
    # TO_DECIMAL(expr) → CAST(expr AS DECIMAL)
    (
        re.compile(r'TO_DECIMAL\s*\(\s*(.+?)\s*\)', re.IGNORECASE),
        r'CAST(\1 AS DECIMAL)',
        "TO_DECIMAL → CAST AS DECIMAL",
    ),
    # TO_FLOAT(expr) → CAST(expr AS DOUBLE)
    (
        re.compile(r'TO_FLOAT\s*\(\s*(.+?)\s*\)', re.IGNORECASE),
        r'CAST(\1 AS DOUBLE)',
        "TO_FLOAT → CAST AS DOUBLE",
    ),
    # SYSDATE → CURRENT_TIMESTAMP()
    (
        re.compile(r'\bSYSDATE\b', re.IGNORECASE),
        r'CURRENT_TIMESTAMP()',
        "SYSDATE → CURRENT_TIMESTAMP",
    ),
    # SYSTIMESTAMP → CURRENT_TIMESTAMP()
    (
        re.compile(r'\bSYSTIMESTAMP\b', re.IGNORECASE),
        r'CURRENT_TIMESTAMP()',
        "SYSTIMESTAMP → CURRENT_TIMESTAMP",
    ),
    # LPAD(str, len, pad) → LPAD(str, len, pad)  (same)
    # RPAD(str, len, pad) → RPAD(str, len, pad)  (same)
    # CONCAT(a, b) → CONCAT(a, b)  (same)
    # || → CONCAT (Informatica uses || for string concatenation)
    (
        re.compile(r'\s*\|\|\s*'),
        r', ',
        "|| → CONCAT args (wrap with CONCAT manually)",
    ),
    # REG_EXTRACT(str, pattern, group) → REGEXP_EXTRACT(str, pattern, group)
    (
        re.compile(r'REG_EXTRACT\s*\(', re.IGNORECASE),
        r'REGEXP_EXTRACT(',
        "REG_EXTRACT → REGEXP_EXTRACT",
    ),
    # REG_REPLACE(str, pattern, replace) → REGEXP_REPLACE(str, pattern, replace)
    (
        re.compile(r'REG_REPLACE\s*\(', re.IGNORECASE),
        r'REGEXP_REPLACE(',
        "REG_REPLACE → REGEXP_REPLACE",
    ),
    # ABS, ROUND, TRUNC, UPPER, LOWER, LENGTH — same in SQL
    # $$param → :param or ${param} (parameterized)
    (
        re.compile(r'\$\$(\w+)'),
        r'${\1}',
        "$$param → ${param}",
    ),
]


class ExpressionTranspiler:
    """Rule-based Informatica expression to SQL transpiler."""

    def transpile(self, expression: str) -> dict:
        """Transpile an Informatica expression to SQL.

        Returns:
            dict with:
              - sql: The transpiled SQL expression
              - rules_applied: List of rule descriptions that were applied
              - confidence: 'high' if all patterns matched, 'medium' if partial, 'low' if complex
              - original: The original expression
        """
        if not expression or not expression.strip():
            return {"sql": "", "rules_applied": [], "confidence": "high", "original": ""}

        sql = expression.strip()
        rules_applied = []

        # Apply rules iteratively (some rules may create patterns for other rules)
        for _pass in range(3):  # max 3 passes for nested patterns
            changed = False
            for pattern, replacement, desc in _RULES:
                new_sql = pattern.sub(replacement, sql)
                if new_sql != sql:
                    rules_applied.append(desc)
                    sql = new_sql
                    changed = True
            if not changed:
                break

        # Handle DECODE(val, match1, result1, ..., default)
        decode_match = re.search(r'DECODE\s*\((.+)\)', sql, re.IGNORECASE)
        if decode_match:
            args = self._split_args(decode_match.group(1))
            if len(args) >= 3:
                val = args[0]
                cases = []
                i = 1
                while i + 1 < len(args):
                    cases.append(f"WHEN {val} = {args[i]} THEN {args[i+1]}")
                    i += 2
                default = args[i] if i < len(args) else "NULL"
                case_sql = "CASE " + " ".join(cases) + f" ELSE {default} END"
                sql = re.sub(r'DECODE\s*\(.+\)', case_sql, sql, flags=re.IGNORECASE)
                rules_applied.append("DECODE → CASE WHEN")

        # Determine confidence
        remaining_infa = len(re.findall(r'\b(?:IIF|ISNULL|NVL2?|DECODE|SUBSTR|INSTR|TO_CHAR|TO_INTEGER|TO_DECIMAL|TO_FLOAT|SYSDATE)\b', sql, re.IGNORECASE))
        if remaining_infa == 0:
            confidence = "high"
        elif remaining_infa <= 2:
            confidence = "medium"
        else:
            confidence = "low"

        return {
            "sql": sql,
            "rules_applied": list(set(rules_applied)),
            "confidence": confidence,
            "original": expression.strip(),
        }

    def transpile_batch(self, expressions: list[str]) -> list[dict]:
        """Transpile multiple expressions."""
        return [self.transpile(expr) for expr in expressions]

    @staticmethod
    def _split_args(s: str) -> list[str]:
        """Split comma-separated arguments respecting parentheses nesting."""
        args = []
        depth = 0
        current = []
        for ch in s:
            if ch == '(' :
                depth += 1
            elif ch == ')':
                depth -= 1
            elif ch == ',' and depth == 0:
                args.append(''.join(current).strip())
                current = []
                continue
            current.append(ch)
        if current:
            args.append(''.join(current).strip())
        return args
