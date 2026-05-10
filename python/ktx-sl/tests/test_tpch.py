"""TPC-H schema tests: loading, graph, planning, and SQL execution against DuckDB."""

from __future__ import annotations

from pathlib import Path

import pytest

from semantic_layer.engine import SemanticEngine
from semantic_layer.graph import JoinGraph
from semantic_layer.loader import SourceLoader
from semantic_layer.models import SourceDefinition

TPCH_DIR = Path(__file__).parent.parent / "sources" / "tpch"
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

try:
    import duckdb

    HAS_DUCKDB = True
except ImportError:
    HAS_DUCKDB = False


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def sources() -> dict[str, SourceDefinition]:
    return SourceLoader(TPCH_DIR).load_all()


@pytest.fixture(scope="module")
def graph(sources: dict[str, SourceDefinition]) -> JoinGraph:
    g = JoinGraph(sources)
    g.build()
    return g


@pytest.fixture(scope="module")
def engine() -> SemanticEngine:
    return SemanticEngine(str(TPCH_DIR), dialect="duckdb")


@pytest.fixture(scope="module")
def tpch_conn():
    if not HAS_DUCKDB:
        pytest.skip("duckdb not installed")
    conn = duckdb.connect()
    conn.execute("INSTALL tpch; LOAD tpch")
    conn.execute("CALL dbgen(sf=0.01)")
    conn.execute("CREATE SCHEMA IF NOT EXISTS public")
    for t in TPCH_TABLES:
        conn.execute(f"CREATE VIEW public.{t} AS SELECT * FROM main.{t}")
    return conn


# ── Loader Tests ─────────────────────────────────────────────────────


class TestTpchLoader:
    def test_all_sources_loaded(self, sources):
        assert set(sources.keys()) == set(TPCH_TABLES)

    def test_lineitem_columns(self, sources):
        li = sources["lineitem"]
        col_names = {c.name for c in li.columns}
        assert "l_orderkey" in col_names
        assert "l_extendedprice" in col_names
        assert "l_shipdate" in col_names
        assert len(li.columns) == 16

    def test_lineitem_composite_grain(self, sources):
        assert sources["lineitem"].grain == ["l_orderkey", "l_linenumber"]

    def test_partsupp_composite_grain(self, sources):
        assert sources["partsupp"].grain == ["ps_partkey", "ps_suppkey"]

    def test_lineitem_measures(self, sources):
        measure_names = {m.name for m in sources["lineitem"].measures}
        assert "revenue" in measure_names
        assert "returned_revenue" in measure_names
        assert "charge" in measure_names
        assert len(sources["lineitem"].measures) == 8

    def test_returned_revenue_has_filter(self, sources):
        m = next(
            m for m in sources["lineitem"].measures if m.name == "returned_revenue"
        )
        assert m.filter == "l_returnflag = 'R'"

    def test_lineitem_joins(self, sources):
        join_targets = {j.to for j in sources["lineitem"].joins}
        assert join_targets == {"orders", "part", "supplier"}

    def test_region_is_leaf(self, sources):
        assert sources["region"].joins == []
        assert sources["region"].measures == []

    def test_orders_measures(self, sources):
        measure_names = {m.name for m in sources["orders"].measures}
        assert measure_names == {"order_count", "total_price", "avg_order_value"}


# ── Graph Tests ──────────────────────────────────────────────────────


class TestTpchGraph:
    def test_all_sources_in_graph(self, graph):
        assert set(graph.adjacency.keys()) >= set(TPCH_TABLES)

    def test_lineitem_to_region_path(self, graph):
        """Shortest path: lineitem → supplier → nation → region (3 hops)."""
        path = graph.find_path("lineitem", "region")
        assert path is not None
        source_chain = [path.edges[0].from_source] + [e.to_source for e in path.edges]
        assert "lineitem" in source_chain
        assert "region" in source_chain
        assert len(path.edges) == 3

    def test_lineitem_to_part_direct(self, graph):
        path = graph.find_path("lineitem", "part")
        assert path is not None
        assert len(path.edges) == 1

    def test_part_to_supplier_via_lineitem(self, graph):
        """Shortest path: part → lineitem → supplier (2 hops, shorter than via partsupp)."""
        path = graph.find_path("part", "supplier")
        assert path is not None
        assert len(path.edges) == 2

    def test_partsupp_bridges_part_and_supplier(self, graph):
        """partsupp has direct edges to both part and supplier."""
        path_to_part = graph.find_path("partsupp", "part")
        path_to_supplier = graph.find_path("partsupp", "supplier")
        assert path_to_part is not None and len(path_to_part.edges) == 1
        assert path_to_supplier is not None and len(path_to_supplier.edges) == 1

    def test_graph_is_single_component(self, graph):
        components = graph.find_components()
        assert len(components) == 1


# ── Plan-only Tests (no DuckDB needed) ───────────────────────────────


class TestTpchPlanning:
    def test_q1_plan(self, engine):
        plan = engine.plan_only(
            {
                "measures": ["lineitem.revenue"],
                "dimensions": ["lineitem.l_returnflag", "lineitem.l_linestatus"],
            }
        )
        assert plan.anchor_source == "lineitem"
        assert len(plan.sources_used) == 1

    def test_q5_plan_multi_hop(self, engine):
        plan = engine.plan_only(
            {
                "measures": ["lineitem.revenue"],
                "dimensions": ["nation.n_name"],
                "filters": ["region.r_name = 'ASIA'"],
            }
        )
        assert "lineitem" in plan.sources_used
        assert "nation" in plan.sources_used
        assert "region" in plan.sources_used

    def test_filtered_measure_plan(self, engine):
        plan = engine.plan_only(
            {
                "measures": ["lineitem.returned_revenue"],
                "dimensions": ["customer.c_name"],
            }
        )
        assert any(m.filter for m in plan.measures)

    def test_time_granularity_plan(self, engine):
        plan = engine.plan_only(
            {
                "measures": ["lineitem.revenue"],
                "dimensions": [{"field": "orders.o_orderdate", "granularity": "month"}],
            }
        )
        col_names = [c.name for c in plan.columns]
        # Column may be named "o_orderdate" with granularity metadata
        assert "o_orderdate" in col_names
        dim_col = next(c for c in plan.columns if c.name == "o_orderdate")
        assert dim_col.granularity == "month"

    def test_suggest_valid_query(self, engine):
        result = engine.suggest(
            {
                "measures": ["lineitem.revenue"],
                "dimensions": ["lineitem.l_returnflag"],
            }
        )
        assert result["success"] is True

    def test_suggest_missing_source(self, engine):
        result = engine.suggest(
            {
                "measures": ["sum(lineitem.l_quantity)"],
                "dimensions": ["nonexistent.col"],
            }
        )
        assert result["success"] is False


# ── Execution Tests (require DuckDB) ────────────────────────────────


@pytest.mark.skipif(not HAS_DUCKDB, reason="duckdb not installed")
class TestTpchExecution:
    def test_q1_pricing_summary(self, tpch_conn, engine):
        result = engine.query(
            {
                "measures": [
                    "lineitem.revenue",
                    "lineitem.total_quantity",
                    "lineitem.avg_discount",
                    "lineitem.line_count",
                ],
                "dimensions": ["lineitem.l_returnflag", "lineitem.l_linestatus"],
            }
        )
        rows = tpch_conn.execute(result.sql).fetchall()
        assert len(rows) > 0
        # TPC-H has exactly 4 combinations: A/F, N/F, N/O, R/F
        assert len(rows) <= 4

    def test_q5_revenue_by_nation_asia(self, tpch_conn, engine):
        """4-hop join with filter: lineitem→supplier→nation→region."""
        result = engine.query(
            {
                "measures": ["lineitem.revenue"],
                "dimensions": ["nation.n_name"],
                "filters": ["region.r_name = 'ASIA'"],
            }
        )
        rows = tpch_conn.execute(result.sql).fetchall()
        assert len(rows) > 0
        # ASIA has 5 nations
        assert len(rows) <= 5

    def test_q3_revenue_by_month(self, tpch_conn, engine):
        """DATE_TRUNC + multi-table filter."""
        result = engine.query(
            {
                "measures": ["lineitem.revenue"],
                "dimensions": [{"field": "orders.o_orderdate", "granularity": "month"}],
                "filters": ["customer.c_mktsegment = 'BUILDING'"],
                "limit": 12,
            }
        )
        rows = tpch_conn.execute(result.sql).fetchall()
        assert len(rows) > 0
        assert len(rows) <= 12

    def test_q10_returned_revenue(self, tpch_conn, engine):
        """Filtered measure with CASE WHEN."""
        result = engine.query(
            {
                "measures": ["lineitem.returned_revenue"],
                "dimensions": ["customer.c_name"],
                "limit": 10,
            }
        )
        rows = tpch_conn.execute(result.sql).fetchall()
        assert len(rows) > 0
        assert len(rows) <= 10

    def test_order_count(self, tpch_conn, engine):
        result = engine.query(
            {
                "measures": ["orders.order_count"],
                "dimensions": ["orders.o_orderstatus"],
            }
        )
        rows = tpch_conn.execute(result.sql).fetchall()
        assert len(rows) > 0
        # Sum of counts should equal total orders at SF=0.01
        total = sum(r[1] for r in rows)
        assert total == 15000  # SF=0.01 → 15000 orders

    def test_supply_cost_by_nation(self, tpch_conn, engine):
        """Bridge table path: partsupp → supplier → nation."""
        result = engine.query(
            {
                "measures": ["partsupp.total_supply_cost"],
                "dimensions": ["nation.n_name"],
            }
        )
        rows = tpch_conn.execute(result.sql).fetchall()
        assert len(rows) == 25  # 25 nations

    def test_avg_order_value(self, tpch_conn, engine):
        result = engine.query(
            {
                "measures": ["orders.avg_order_value"],
                "dimensions": ["customer.c_mktsegment"],
            }
        )
        rows = tpch_conn.execute(result.sql).fetchall()
        assert len(rows) == 5  # 5 market segments
        # avg values should be positive
        for row in rows:
            assert row[1] > 0

    def test_lineitem_charge(self, tpch_conn, engine):
        """Complex expression: sum(price * (1 - discount) * (1 + tax))."""
        result = engine.query(
            {
                "measures": ["lineitem.charge"],
                "dimensions": ["lineitem.l_returnflag"],
            }
        )
        rows = tpch_conn.execute(result.sql).fetchall()
        assert len(rows) > 0
        for row in rows:
            assert row[1] > 0

    def test_order_by_desc(self, tpch_conn, engine):
        result = engine.query(
            {
                "measures": ["lineitem.revenue"],
                "dimensions": ["nation.n_name"],
                "order_by": [{"field": "lineitem.revenue", "direction": "desc"}],
                "limit": 5,
            }
        )
        rows = tpch_conn.execute(result.sql).fetchall()
        assert len(rows) == 5
        # Revenue should be descending
        revenues = [r[1] for r in rows]
        assert revenues == sorted(revenues, reverse=True)

    def test_multiple_filters(self, tpch_conn, engine):
        result = engine.query(
            {
                "measures": ["lineitem.revenue"],
                "dimensions": ["orders.o_orderpriority"],
                "filters": [
                    "customer.c_mktsegment = 'BUILDING'",
                    "nation.n_name = 'FRANCE'",
                ],
            }
        )
        rows = tpch_conn.execute(result.sql).fetchall()
        assert len(rows) > 0
