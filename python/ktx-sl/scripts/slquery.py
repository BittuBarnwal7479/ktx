#!/usr/bin/env python3
"""Run a semantic layer query against the b2b_saas SQLite database.

Usage:
    uv run python scripts/slquery.py '{"measures":["count(opportunities.opportunity_id)"],"dimensions":["accounts.segment"]}'
    uv run python scripts/slquery.py '{"measures":["churn_risk.avg_risk_score"],"dimensions":["accounts.industry"]}'
    echo '{"measures":["sum(contracts.arr)"],"dimensions":["accounts.segment"]}' | uv run python scripts/slquery.py --stdin
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

from semantic_layer.engine import SemanticEngine

SOURCES_DIR = Path(__file__).resolve().parent.parent / "sources" / "b2b_saas"
DB_PATH = Path(
    os.environ.get("KTX_B2B_SQLITE_DB", "sample-data-generator/b2b_data.db")
).expanduser()

# sqlglot's sqlite dialect handles most transpilation, but has a few gaps.
# These fixups patch what sqlglot misses.
_SQLITE_FIXUPS = [
    # GROUP_CONCAT(DISTINCT x, sep) → GROUP_CONCAT(DISTINCT x) — sqlite
    # only allows 1 arg with DISTINCT
    (r"GROUP_CONCAT\(DISTINCT (\w+),\s*'[^']*'\)", r"GROUP_CONCAT(DISTINCT \1)"),
    # CURRENT_DATE - col  → integer days via julianday
    (
        r"CURRENT_DATE - DATE\((\w+)\)",
        r"CAST(julianday('now') - julianday(\1) AS INTEGER)",
    ),
    (r"CURRENT_DATE - (\w+)", r"CAST(julianday('now') - julianday(\1) AS INTEGER)"),
    # col - CURRENT_DATE  → integer days via julianday
    (r"(\w+) - CURRENT_DATE", r"CAST(julianday(\1) - julianday('now') AS INTEGER)"),
    # CURRENT_DATE > col  → julianday comparison
    (r"CURRENT_DATE > (\w+)", r"julianday('now') > julianday(\1)"),
    # NULLS LAST — not supported in sqlite
    (r"\s+NULLS LAST", ""),
]


def fixup_sqlite(sql: str) -> str:
    for pattern, repl in _SQLITE_FIXUPS:
        sql = re.sub(pattern, repl, sql)
    return sql


def main() -> None:
    p = argparse.ArgumentParser(description="Run SL query against b2b_saas SQLite DB")
    p.add_argument("query", nargs="?", help="JSON query string")
    p.add_argument("--stdin", action="store_true", help="Read JSON from stdin")
    p.add_argument(
        "--sql-only", action="store_true", help="Print SQL without executing"
    )
    p.add_argument("--db", default=str(DB_PATH), help="Path to SQLite database")
    p.add_argument(
        "--sources", default=str(SOURCES_DIR), help="Path to sources directory"
    )
    args = p.parse_args()

    if args.stdin:
        query_dict = json.loads(sys.stdin.read())
    elif args.query:
        query_dict = json.loads(args.query)
    else:
        p.error("Provide a JSON query string or use --stdin")

    # Use sqlite dialect — sqlglot handles STRING_AGG→GROUP_CONCAT,
    # DECIMAL→REAL, ::DATE→DATE(), etc.
    engine = SemanticEngine(args.sources, dialect="sqlite")
    result = engine.query(query_dict)
    sql = fixup_sqlite(result.sql)

    if args.sql_only:
        print(sql)
        return

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(sql).fetchall()
    except sqlite3.OperationalError as e:
        print(f"SQL error: {e}", file=sys.stderr)
        print(f"\nGenerated SQL:\n{sql}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()

    if not rows:
        print("(no rows)")
        return

    cols = rows[0].keys()
    widths = [max(len(str(c)), max(len(str(r[c])) for r in rows)) for c in cols]
    header = "  ".join(str(c).ljust(w) for c, w in zip(cols, widths))
    sep = "  ".join("-" * w for w in widths)
    print(header)
    print(sep)
    for r in rows:
        print("  ".join(str(r[c]).ljust(w) for c, w in zip(cols, widths)))


if __name__ == "__main__":
    main()
