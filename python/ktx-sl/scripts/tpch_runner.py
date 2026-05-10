#!/usr/bin/env python3
"""Run TPC-H queries end-to-end: generate data + semantic layer SQL + execute.

Usage:
    uv run python scripts/tpch_runner.py
"""

from __future__ import annotations

import json

import duckdb
import sqlglot

from semantic_layer.engine import SemanticEngine

TPCH_TABLES = [
    "region",
    "nation",
    "supplier",
    "customer",
    "part",
    "partsupp",
    "orders",
    "lineitem",
]


def setup_tpch(sf: float = 0.01) -> duckdb.DuckDBPyConnection:
    """Create in-memory DuckDB with TPC-H data at the given scale factor."""
    conn = duckdb.connect()
    conn.execute("INSTALL tpch; LOAD tpch")
    conn.execute(f"CALL dbgen(sf={sf})")
    # YAML files use public.<table> — create views to match
    conn.execute("CREATE SCHEMA IF NOT EXISTS public")
    for t in TPCH_TABLES:
        conn.execute(f"CREATE VIEW public.{t} AS SELECT * FROM main.{t}")
    return conn


def run_query(
    conn: duckdb.DuckDBPyConnection,
    engine: SemanticEngine,
    title: str,
    query_dict: dict,
) -> None:
    """Generate SQL via semantic layer, execute it, and print results."""
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")

    print("\n>> Request:")
    print(json.dumps(query_dict, indent=2))

    result = engine.query(query_dict)
    formatted_sql = sqlglot.transpile(
        result.sql, read=result.dialect, write=result.dialect, pretty=True
    )[0]
    print(f"\n-- dialect: {result.dialect}")
    print(formatted_sql)

    cursor = conn.execute(result.sql)
    col_names = [desc[0] for desc in cursor.description]
    rows = cursor.fetchall()

    # Simple table formatting
    widths = [
        max(len(str(c)), *(len(str(r[i])) for r in rows))
        for i, c in enumerate(col_names)
    ]
    header = "  ".join(str(c).ljust(w) for c, w in zip(col_names, widths))
    print(f"\n{header}")
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(str(v).ljust(w) for v, w in zip(row, widths)))
    print(f"\n({len(rows)} rows)")


def main() -> None:
    conn = setup_tpch()
    engine = SemanticEngine("sources/tpch", dialect="duckdb")

    # Q1: Pricing summary by return flag / line status
    run_query(
        conn,
        engine,
        "Q1: Pricing Summary",
        {
            "measures": [
                "lineitem.revenue",
                "lineitem.total_quantity",
                "lineitem.avg_discount",
                "lineitem.line_count",
            ],
            "dimensions": ["lineitem.l_returnflag", "lineitem.l_linestatus"],
        },
    )

    # Q5-style: Revenue by nation (4-hop join) with ASIA filter
    run_query(
        conn,
        engine,
        "Q5: Revenue by Nation (ASIA)",
        {
            "measures": ["lineitem.revenue"],
            "dimensions": ["nation.n_name"],
            "filters": ["region.r_name = 'ASIA'"],
        },
    )

    # Q3-style: Revenue by order month for BUILDING segment
    run_query(
        conn,
        engine,
        "Q3: Revenue by Month (BUILDING)",
        {
            "measures": ["lineitem.revenue"],
            "dimensions": [{"field": "orders.o_orderdate", "granularity": "month"}],
            "filters": ["customer.c_mktsegment = 'BUILDING'"],
            "limit": 12,
        },
    )

    # Q10-style: Returned revenue by customer (filtered measure)
    run_query(
        conn,
        engine,
        "Q10: Returned Revenue by Customer",
        {
            "measures": ["lineitem.returned_revenue"],
            "dimensions": ["customer.c_name"],
            "order_by": [{"field": "lineitem.returned_revenue", "direction": "desc"}],
            "limit": 10,
        },
    )

    # Multi-measure: revenue + charge + counts
    run_query(
        conn,
        engine,
        "Multi-measure: Revenue, Charge, Counts",
        {
            "measures": [
                "lineitem.revenue",
                "lineitem.charge",
                "orders.order_count",
            ],
            "dimensions": ["customer.c_mktsegment"],
        },
    )

    # Supply cost by nation (through partsupp bridge)
    run_query(
        conn,
        engine,
        "Supply Cost by Nation",
        {
            "measures": ["partsupp.total_supply_cost"],
            "dimensions": ["nation.n_name"],
            "limit": 10,
        },
    )


if __name__ == "__main__":
    main()
