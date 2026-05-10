"""Tests for the CLI interface (semantic_layer.cli)."""

from __future__ import annotations

import json
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import pytest

from semantic_layer.cli import main, print_plan
from semantic_layer.graph import JoinGraph
from semantic_layer.models import (
    JoinDeclaration,
    SemanticQuery,
    SourceColumn,
    SourceDefinition,
)
from semantic_layer.planner import QueryPlanner

SOURCES_DIR = str(Path(__file__).parent.parent / "sources" / "ecommerce")


# ── From test_edge_cases.py: TestCliParserArgs ───────────────────────


class TestCliParserArgs:
    def test_no_args_errors(self):
        with pytest.raises(SystemExit):
            main([])

    def test_sources_only_no_query(self, capsys):
        with pytest.raises(SystemExit):
            main(["--sources", SOURCES_DIR])

    def test_list_sources_no_measures_needed(self, capsys):
        main(["--sources", SOURCES_DIR, "--list-sources"])
        output = capsys.readouterr().out
        assert "orders" in output
        assert "customers" in output

    def test_plan_only_mode(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(orders.amount)"],
                        "dimensions": ["orders.status"],
                    }
                ),
                "--plan-only",
            ]
        )
        output = capsys.readouterr().out
        assert "Resolved Plan" in output
        assert "Anchor" in output

    def test_plan_and_sql(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(orders.amount)"],
                        "dimensions": ["orders.status"],
                    }
                ),
                "--plan",
            ]
        )
        output = capsys.readouterr().out
        assert "Resolved Plan" in output
        assert "SELECT" in output

    def test_compact_mode(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(orders.amount)"],
                        "dimensions": ["orders.status"],
                    }
                ),
                "--compact",
            ]
        )
        output = capsys.readouterr().out
        assert "SELECT" in output
        assert "-- dialect:" not in output

    def test_json_input(self, capsys):
        query_json = json.dumps(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        with patch("sys.stdin", StringIO(query_json)):
            main(["--sources", SOURCES_DIR, "--json"])
        output = capsys.readouterr().out
        assert "SELECT" in output

    def test_json_input_with_filters(self, capsys):
        query_json = json.dumps(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["orders.status = 'completed'"],
            }
        )
        with patch("sys.stdin", StringIO(query_json)):
            main(["--sources", SOURCES_DIR, "--json"])
        output = capsys.readouterr().out
        assert "completed" in output

    def test_json_input_with_order_by(self, capsys):
        query_json = json.dumps(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "order_by": [{"field": "orders.status", "direction": "desc"}],
            }
        )
        with patch("sys.stdin", StringIO(query_json)):
            main(["--sources", SOURCES_DIR, "--json"])
        output = capsys.readouterr().out
        assert "SELECT" in output

    def test_measures_with_alias(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": [
                            {"expr": "sum(orders.amount)", "name": "total_rev"}
                        ],
                        "dimensions": ["orders.status"],
                    }
                ),
            ]
        )
        output = capsys.readouterr().out
        assert "total_rev" in output

    def test_dimension_with_granularity_cli(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(orders.amount)"],
                        "dimensions": [
                            {"field": "orders.created_at", "granularity": "month"}
                        ],
                    }
                ),
            ]
        )
        output = capsys.readouterr().out
        assert "DATE_TRUNC" in output

    def test_multiple_filters_cli(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(orders.amount)"],
                        "dimensions": ["orders.status"],
                        "filters": [
                            "orders.status = 'completed'",
                            "orders.amount > 100",
                        ],
                    }
                ),
            ]
        )
        output = capsys.readouterr().out
        assert "WHERE" in output

    def test_limit_cli(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(orders.amount)"],
                        "dimensions": ["orders.status"],
                        "limit": 50,
                    }
                ),
            ]
        )
        output = capsys.readouterr().out
        assert "LIMIT 50" in output

    def test_dialect_cli(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(orders.amount)"],
                        "dimensions": ["orders.status"],
                    }
                ),
                "--dialect",
                "bigquery",
            ]
        )
        output = capsys.readouterr().out
        assert "bigquery" in output


# ── From test_edge_cases.py: TestCLISuggest ──────────────────────────


class TestCliSuggest:
    def test_suggest_valid_query(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(orders.amount)"],
                        "dimensions": ["orders.status"],
                    }
                ),
                "--suggest",
            ]
        )
        output = capsys.readouterr().out
        assert "valid" in output.lower()

    def test_suggest_invalid_query(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(nonexistent.amount)"],
                        "dimensions": ["orders.status"],
                    }
                ),
                "--suggest",
            ]
        )
        output = capsys.readouterr().out
        assert "failed" in output.lower() or "Suggestion" in output


# ── From test_edge_cases.py: TestCLIOrderBy ──────────────────────────


class TestCliOrderBy:
    def test_order_by_desc(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(orders.amount)"],
                        "dimensions": ["orders.status"],
                        "order_by": [
                            {"field": "sum(orders.amount)", "direction": "desc"}
                        ],
                    }
                ),
            ]
        )
        output = capsys.readouterr().out
        assert "DESC" in output

    def test_order_by_asc(self, capsys):
        main(
            [
                "--sources",
                SOURCES_DIR,
                "-q",
                json.dumps(
                    {
                        "measures": ["sum(orders.amount)"],
                        "dimensions": ["orders.status"],
                        "order_by": [{"field": "orders.status", "direction": "asc"}],
                    }
                ),
            ]
        )
        output = capsys.readouterr().out
        assert "ORDER BY" in output


# ── From test_brainstorm_cases.py: TestBrainstormCliOutput ───────────


def _build_chasm_sources() -> dict[str, SourceDefinition]:
    customers = SourceDefinition(
        name="customers",
        table="public.customers",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="segment", type="string"),
        ],
    )
    orders = SourceDefinition(
        name="orders",
        table="public.orders",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="customer_id", type="number"),
            SourceColumn(name="amount", type="number"),
        ],
        joins=[
            JoinDeclaration(
                to="customers",
                on="customer_id = customers.id",
                relationship="many_to_one",
            )
        ],
    )
    tickets = SourceDefinition(
        name="tickets",
        table="public.tickets",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="customer_id", type="number"),
            SourceColumn(name="cost", type="number"),
        ],
        joins=[
            JoinDeclaration(
                to="customers",
                on="customer_id = customers.id",
                relationship="many_to_one",
            )
        ],
    )
    return {"customers": customers, "orders": orders, "tickets": tickets}


def _write_sources(sources_dict: dict[str, dict]) -> str:
    import tempfile
    import yaml

    tmpdir = tempfile.mkdtemp()
    for name, data in sources_dict.items():
        with open(Path(tmpdir) / f"{name}.yaml", "w") as f:
            yaml.dump(data, f)
    return tmpdir


class TestCliPlanOutput:
    def test_print_plan_includes_join_locality_where_and_having(self, capsys):
        sources = _build_chasm_sources()
        graph = JoinGraph(sources)
        graph.build()
        planner = QueryPlanner(sources, graph)

        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment"],
            filters=["customers.segment = 'SMB'", "sum(orders.amount) > 10000"],
        )
        plan = planner.plan(query)

        print_plan(plan)
        output = capsys.readouterr().out

        assert "Resolved Plan" in output
        assert "Joins:" in output
        assert "Locality:" in output
        assert "WHERE:" in output
        assert "HAVING:" in output
        assert "customers.segment" in output

    def test_suggest_cli_surfaces_graph_errors(self, capsys):
        tmpdir = _write_sources(
            {
                "a": {
                    "name": "a",
                    "table": "t",
                    "grain": ["id"],
                    "columns": [{"name": "id", "type": "number"}],
                },
                "b": {
                    "name": "b",
                    "table": "t2",
                    "grain": ["id"],
                    "columns": [
                        {"name": "id", "type": "number"},
                        {"name": "val", "type": "number"},
                    ],
                },
            }
        )

        main(
            [
                "--sources",
                tmpdir,
                "-q",
                json.dumps({"measures": ["sum(a.id)"], "dimensions": ["b.val"]}),
                "--suggest",
            ]
        )
        output = capsys.readouterr().out

        assert "Query failed:" in output
        assert "Graph error:" in output
        assert "Disconnected components" in output
        assert "Suggestion:" in output

    def test_list_sources_includes_join_and_filtered_measure_details(self, capsys):
        main(["--sources", SOURCES_DIR, "--list-sources"])
        output = capsys.readouterr().out

        assert "joins:" in output
        assert "→ customers (many_to_one) on customer_id = customers.id" in output
        assert "revenue: sum(amount) (filter: status != 'refunded')" in output
