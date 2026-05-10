"""End-to-end tests through the full SemanticEngine stack."""

import pytest
import sqlglot
import yaml
from pathlib import Path

from semantic_layer.engine import SemanticEngine
from semantic_layer.models import (
    JoinDeclaration,
    Provenance,
    SourceColumn,
    SourceDefinition,
)

SOURCES_DIR = str(Path(__file__).parent.parent / "sources" / "ecommerce")


@pytest.fixture
def engine():
    return SemanticEngine(SOURCES_DIR, dialect="postgres")


class TestEndToEnd:
    def test_simple_query(self, engine):
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result.sql
        assert result.dialect == "postgres"
        assert len(result.columns) >= 2
        sqlglot.parse(result.sql)

    def test_cross_source_query(self, engine):
        result = engine.query(
            {
                "measures": ["churn_risk.avg_risk"],
                "dimensions": ["churn_risk.customer_type", "regions.name"],
                "filters": ["regions.name = 'LATAM'"],
            }
        )
        assert "churn_risk" in result.sql
        assert "LATAM" in result.sql
        assert "WITH" in result.sql.upper()
        sqlglot.parse(result.sql)

    def test_pre_defined_measure(self, engine):
        result = engine.query(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
            }
        )
        # Revenue measure should have VERIFIED provenance
        rev_col = next(c for c in result.columns if c.name == "revenue")
        assert rev_col.provenance == Provenance.VERIFIED
        # Should have CASE WHEN for filter
        assert "CASE WHEN" in result.sql.upper()
        sqlglot.parse(result.sql)

    def test_time_granularity(self, engine):
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": [{"field": "orders.created_at", "granularity": "month"}],
            }
        )
        assert "DATE_TRUNC" in result.sql.upper()
        sqlglot.parse(result.sql)

    def test_derived_measures(self, engine):
        result = engine.query(
            {
                "measures": [
                    {"expr": "sum(orders.amount)", "name": "total_rev"},
                    {"expr": "sum(orders.cost)", "name": "total_cost"},
                    {"expr": "total_rev - total_cost", "name": "profit"},
                ],
                "dimensions": ["orders.status"],
            }
        )
        assert "profit" in result.sql
        # Verify the derived measure appears in columns
        profit_col = next(c for c in result.columns if c.name == "profit")
        assert profit_col.provenance == Provenance.COMPOSED
        sqlglot.parse(result.sql)

    def test_having_filter(self, engine):
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["sum(orders.amount) > 10000"],
            }
        )
        assert "HAVING" in result.sql.upper()
        sqlglot.parse(result.sql)

    def test_orders_through_bridge(self, engine):
        result = engine.query(
            {
                "measures": ["sum(order_items.quantity)"],
                "dimensions": ["products.category"],
            }
        )
        assert result.sql
        assert "order_items" in result.sql.lower()
        assert "products" in result.sql.lower()
        sqlglot.parse(result.sql)


class TestChasmTrapEndToEnd:
    def test_chasm_trap_full_pipeline(self):
        """Two measure sources (order_items + orders through different paths) → aggregate locality."""
        # Use a custom source setup for a clean chasm scenario
        from semantic_layer.engine import SemanticEngine
        import tempfile
        import yaml
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmpdir:
            customers = {
                "name": "customers",
                "table": "public.customers",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            }
            orders = {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    }
                ],
            }
            tickets = {
                "name": "tickets",
                "table": "public.tickets",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    }
                ],
            }
            for name, data in [
                ("customers", customers),
                ("orders", orders),
                ("tickets", tickets),
            ]:
                with open(Path(tmpdir) / f"{name}.yaml", "w") as f:
                    yaml.dump(data, f)

            engine = SemanticEngine(tmpdir, dialect="postgres")
            result = engine.query(
                {
                    "measures": ["sum(orders.amount)", "count(tickets.id)"],
                    "dimensions": ["customers.segment"],
                }
            )
            assert result.resolved_plan.has_fan_out
            assert "orders_agg" in result.sql
            assert "tickets_agg" in result.sql
            assert "FULL JOIN" in result.sql.upper()
            sqlglot.parse(result.sql)


class TestMixedMeasures:
    def test_pre_defined_and_runtime(self, engine):
        """Pre-defined orders.revenue alongside runtime sum(orders.cost)."""
        result = engine.query(
            {
                "measures": [
                    "orders.revenue",
                    {"expr": "sum(orders.cost)", "name": "total_cost"},
                ],
                "dimensions": ["orders.status"],
            }
        )
        assert result.sql
        # Revenue is VERIFIED, cost is COMPOSED
        rev_col = next(c for c in result.columns if c.name == "revenue")
        cost_col = next(c for c in result.columns if c.name == "total_cost")
        assert rev_col.provenance == Provenance.VERIFIED
        assert cost_col.provenance == Provenance.COMPOSED
        sqlglot.parse(result.sql)

    def test_multiple_pre_defined(self, engine):
        """Both orders.revenue and orders.order_count are pre-defined."""
        result = engine.query(
            {
                "measures": ["orders.revenue", "orders.order_count"],
                "dimensions": ["orders.status"],
            }
        )
        assert all(
            c.provenance == Provenance.VERIFIED
            for c in result.columns
            if c.provenance != Provenance.DIMENSION
        )
        sqlglot.parse(result.sql)


class TestChainedDerived:
    def test_margin_chain(self, engine):
        """profit = rev - cost, margin = profit / rev — 3-level chain."""
        result = engine.query(
            {
                "measures": [
                    {"expr": "sum(orders.amount)", "name": "total_rev"},
                    {"expr": "sum(orders.cost)", "name": "total_cost"},
                    {"expr": "total_rev - total_cost", "name": "profit"},
                    {"expr": "profit / total_rev", "name": "margin"},
                ],
                "dimensions": ["orders.status"],
            }
        )
        assert "margin" in result.sql
        assert "profit" in result.sql
        sqlglot.parse(result.sql)


class TestCrossSourceRuntime:
    def test_runtime_aggregation_by_region(self, engine):
        """Runtime count(orders.id) grouped by regions.name — not pre-defined."""
        result = engine.query(
            {
                "measures": [{"expr": "count(orders.id)", "name": "order_count"}],
                "dimensions": ["regions.name"],
            }
        )
        assert "regions" in result.sql.lower()
        assert "COUNT" in result.sql.upper()
        sqlglot.parse(result.sql)


class TestGlobalAggregates:
    def test_no_dimensions(self, engine):
        """Measures without dimensions — should produce single-row result."""
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
            }
        )
        assert result.sql
        assert "GROUP BY" not in result.sql.upper()
        sqlglot.parse(result.sql)


class TestPlanOnly:
    def test_plan_returns_metadata(self, engine):
        plan = engine.plan_only(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert "orders" in plan.sources_used
        assert plan.anchor_source == "orders"
        assert not plan.has_fan_out
        assert len(plan.measures) == 1
        assert len(plan.dimensions) == 1


class TestSuggest:
    def test_success(self, engine):
        result = engine.suggest(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result["success"] is True

    def test_failure_with_suggestions(self, engine):
        result = engine.suggest(
            {
                "measures": ["sum(nonexistent.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result["success"] is False
        assert "error" in result
        assert len(result["suggestions"]) > 0


class TestSuggestDetailed:
    def test_suggest_disconnected_sources(self):
        """Suggest should report error when sources can't be connected."""
        import tempfile
        import yaml
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmpdir:
            src_a = {
                "name": "a",
                "table": "t",
                "grain": ["id"],
                "columns": [{"name": "id", "type": "number"}],
            }
            src_b = {
                "name": "b",
                "table": "t2",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "val", "type": "number"},
                ],
            }
            for name, data in [("a", src_a), ("b", src_b)]:
                with open(Path(tmpdir) / f"{name}.yaml", "w") as f:
                    yaml.dump(data, f)

            engine = SemanticEngine(tmpdir, dialect="postgres")
            result = engine.suggest(
                {
                    "measures": ["sum(a.id)"],
                    "dimensions": ["b.val"],
                }
            )
            assert result["success"] is False
            assert "error" in result
            assert len(result["suggestions"]) > 0


class TestDialects:
    def test_bigquery(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="bigquery")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result.dialect == "bigquery"
        assert result.sql

    def test_snowflake(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="snowflake")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result.dialect == "snowflake"
        assert result.sql

    def test_bigquery_time_granularity(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="bigquery")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": [{"field": "orders.created_at", "granularity": "month"}],
            }
        )
        assert result.dialect == "bigquery"
        assert result.sql
        # BigQuery should transpile the SQL
        sqlglot.parse(result.sql)


# ── From test_edge_cases.py: engine edge cases ──────────────────────


class TestEngineEdgeCases:
    @pytest.fixture
    def _engine(self):
        return SemanticEngine(SOURCES_DIR, dialect="postgres")

    def test_query_with_dict_input(self, _engine):
        result = _engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result.sql

    def test_query_with_semantic_query_input(self, _engine):
        from semantic_layer.models import SemanticQuery

        q = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.status"],
        )
        result = _engine.query(q)
        assert result.sql

    def test_plan_only_with_dict(self, _engine):
        plan = _engine.plan_only(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert plan.anchor_source == "orders"

    def test_suggest_with_valid_query(self, _engine):
        result = _engine.suggest(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result["success"] is True

    def test_suggest_with_invalid_source(self, _engine):
        result = _engine.suggest(
            {
                "measures": ["sum(nonexistent.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result["success"] is False

    def test_complex_cross_source_query(self, _engine):
        result = _engine.query(
            {
                "measures": ["sum(order_items.quantity)"],
                "dimensions": ["regions.name"],
            }
        )
        assert "regions" in result.sql.lower()
        assert "order_items" in result.sql.lower()
        sqlglot.parse(result.sql)

    def test_filter_only_sources(self, _engine):
        result = _engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["customers.segment = 'Enterprise'"],
            }
        )
        assert "customers" in result.sql.lower()
        assert "Enterprise" in result.sql
        sqlglot.parse(result.sql)

    def test_predefined_measure_with_runtime_same_source(self, _engine):
        result = _engine.query(
            {
                "measures": ["orders.revenue", "avg(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        sqlglot.parse(result.sql)
        assert "CASE WHEN" in result.sql

    def test_churn_risk_cross_source_latam(self, _engine):
        result = _engine.query(
            {
                "measures": ["churn_risk.avg_risk"],
                "dimensions": ["churn_risk.customer_type", "regions.name"],
                "filters": ["regions.name = 'LATAM'"],
            }
        )
        assert "LATAM" in result.sql
        assert "churn_risk" in result.sql
        assert "regions" in result.sql.lower()
        sqlglot.parse(result.sql)

    def test_products_dimension_with_order_items_measure(self, _engine):
        result = _engine.query(
            {
                "measures": ["sum(order_items.price)"],
                "dimensions": ["products.category", "products.name"],
            }
        )
        assert "products" in result.sql.lower()
        sqlglot.parse(result.sql)

    def test_all_ecommerce_sources_loaded(self, _engine):
        assert "orders" in _engine.sources
        assert "customers" in _engine.sources
        assert "regions" in _engine.sources
        assert "products" in _engine.sources
        assert "order_items" in _engine.sources
        assert "churn_risk" in _engine.sources


# ── From test_edge_cases.py: structured suggest ──────────────────────


class TestStructuredSuggest:
    def test_missing_source_returns_structured_suggestion(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.suggest(
            {
                "measures": ["sum(nonexistent.val)"],
                "dimensions": ["orders.status"],
            }
        )
        assert not result["success"]
        assert "nonexistent" in result["missing_sources"]
        assert len(result["suggestions"]) > 0
        suggestion = result["suggestions"][0]
        assert "required_sources" in suggestion
        assert "required_joins" in suggestion
        assert "notes" in suggestion
        assert "nonexistent" in suggestion["required_sources"]

    def test_disconnected_sources_returns_structured_suggestion(self):
        from semantic_layer.models import SourceColumn, SourceDefinition

        sources = {
            "src_a": SourceDefinition(
                name="src_a",
                table="public.src_a",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="val", type="number"),
                ],
            ),
            "src_b": SourceDefinition(
                name="src_b",
                table="public.src_b",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="name", type="string"),
                ],
            ),
        }
        engine = SemanticEngine.from_sources(sources)
        result = engine.suggest(
            {
                "measures": ["sum(src_a.val)"],
                "dimensions": ["src_b.name"],
            }
        )
        assert not result["success"]
        assert len(result["suggestions"]) > 0
        suggestion = result["suggestions"][0]
        assert "required_joins" in suggestion
        assert "notes" in suggestion

    def test_valid_query_returns_empty_suggestions(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.suggest(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result["success"]
        assert result["suggestions"] == []


# ── From test_brainstorm_cases.py ────────────────────────────────────


class TestGlobalAggregatesChasm:
    def test_cross_source_global_aggregates_use_cross_join_locality(self):
        import tempfile

        tmpdir = tempfile.mkdtemp()
        sources_dict = {
            "customers": {
                "name": "customers",
                "table": "public.customers",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            },
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
            "tickets": {
                "name": "tickets",
                "table": "public.tickets",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
                    {"name": "cost", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
        }
        for name, data in sources_dict.items():
            with open(Path(tmpdir) / f"{name}.yaml", "w") as f:
                yaml.dump(data, f)

        engine = SemanticEngine(tmpdir, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)", "sum(tickets.cost)"],
            }
        )

        assert result.resolved_plan.has_fan_out
        assert "orders_agg" in result.sql
        assert "tickets_agg" in result.sql
        assert "CROSS JOIN" in result.sql.upper()
        assert "FULL JOIN" not in result.sql.upper()
        assert "GROUP BY" not in result.sql.upper()
        sqlglot.parse(result.sql)

    def test_support_cost_pct_matches_cross_source_example(self):
        from semantic_layer.models import (
            JoinDeclaration,
            SemanticQuery,
            SourceColumn,
            SourceDefinition,
        )
        from semantic_layer.graph import JoinGraph
        from semantic_layer.planner import QueryPlanner
        from semantic_layer.generator import SqlGenerator

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
        sources = {"customers": customers, "orders": orders, "tickets": tickets}
        graph = JoinGraph(sources)
        graph.build()
        planner = QueryPlanner(sources, graph)
        generator = SqlGenerator(dialect="postgres")

        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "total_revenue"},
                {"expr": "sum(tickets.cost)", "name": "total_support_cost"},
                {
                    "expr": "total_support_cost / total_revenue * 100",
                    "name": "support_cost_pct",
                },
            ],
            dimensions=["customers.segment"],
            order_by=[{"field": "support_cost_pct", "direction": "desc"}],
        )
        plan = planner.plan(query)
        sql = generator.generate(plan, sources)

        assert plan.has_fan_out
        assert "orders_agg" in sql
        assert "tickets_agg" in sql
        assert "FULL JOIN" in sql.upper()
        assert "support_cost_pct" in sql
        assert "ORDER BY support_cost_pct DESC" in sql
        sqlglot.parse(sql)


class TestBrainstormExamples:
    def test_high_churn_risk_customers_from_latam(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": [
                    "churn_risk.avg_risk",
                    {"expr": "count(churn_risk.customer_id)", "name": "customer_count"},
                ],
                "dimensions": ["churn_risk.customer_type", "regions.name"],
                "filters": ["regions.name = 'LATAM'", "churn_risk.score > 0.7"],
                "order_by": [{"field": "churn_risk.avg_risk", "direction": "desc"}],
                "limit": 100,
            }
        )
        assert not result.resolved_plan.has_fan_out
        assert result.resolved_plan.sources_used == [
            "churn_risk",
            "customers",
            "regions",
        ]
        assert "COUNT(CHURN_RISK.CUSTOMER_ID) AS CUSTOMER_COUNT" in result.sql.upper()
        assert "WHERE regions.name = 'LATAM' AND churn_risk.score > 0.7" in result.sql
        assert "ORDER BY avg_risk DESC" in result.sql
        assert "ORDER BY churn_risk.avg_risk DESC" not in result.sql
        avg_risk = next(col for col in result.columns if col.name == "avg_risk")
        customer_count = next(
            col for col in result.columns if col.name == "customer_count"
        )
        assert avg_risk.provenance == Provenance.VERIFIED
        assert customer_count.provenance == Provenance.COMPOSED
        sqlglot.parse(result.sql)

    def test_median_order_value_by_region(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": [
                    {"expr": "median(orders.amount)", "name": "median_order"},
                    "orders.revenue",
                ],
                "dimensions": ["regions.name"],
                "order_by": [{"field": "median_order", "direction": "desc"}],
            }
        )
        assert not result.resolved_plan.has_fan_out
        assert result.resolved_plan.sources_used == ["customers", "orders", "regions"]
        assert "ORDER BY median_order DESC" in result.sql
        median_order = next(col for col in result.columns if col.name == "median_order")
        revenue = next(col for col in result.columns if col.name == "revenue")
        assert median_order.provenance == Provenance.COMPOSED
        assert revenue.provenance == Provenance.VERIFIED
        sqlglot.parse(result.sql)

    def test_revenue_trend_by_month(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": [
                    "orders.revenue",
                    {"expr": "count(orders.id)", "name": "order_count"},
                ],
                "dimensions": [{"field": "orders.created_at", "granularity": "month"}],
                "filters": ["orders.created_at >= '2025-01-01'"],
                "order_by": [{"field": "orders.created_at", "direction": "asc"}],
            }
        )
        assert (
            "DATE_TRUNC('month', orders.created_at) AS created_at_month" in result.sql
        )
        assert "WHERE orders.created_at >= '2025-01-01'" in result.sql
        assert "ORDER BY created_at_month" in result.sql
        assert "ORDER BY orders.created_at" not in result.sql
        revenue = next(col for col in result.columns if col.name == "revenue")
        order_count = next(col for col in result.columns if col.name == "order_count")
        assert revenue.provenance == Provenance.VERIFIED
        assert order_count.provenance == Provenance.COMPOSED
        sqlglot.parse(result.sql)

    def test_single_source_fanout_to_product_category_is_rejected(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        with pytest.raises(ValueError, match="cannot safely reach 'products'"):
            engine.query(
                {
                    "measures": ["churn_risk.avg_risk"],
                    "dimensions": ["products.category"],
                    "filters": ["churn_risk.score > 0.5"],
                }
            )


# ── From test_spec_gaps.py ───────────────────────────────────────────


class TestCountDistinctPK:
    def test_count_with_pk_in_simple_join(self):
        from conftest import make_engine, assert_valid_sql

        chasm = {
            "customers": {
                "name": "customers",
                "table": "public.customers",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            },
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
        }
        engine = make_engine(chasm)
        result = engine.query(
            {
                "measures": ["count(orders.id)"],
                "dimensions": ["customers.segment"],
            }
        )
        assert_valid_sql(result.sql)

    def test_count_distinct_pk_in_aggregate_locality(self):
        from conftest import make_engine, assert_valid_sql

        chasm = {
            "customers": {
                "name": "customers",
                "table": "public.customers",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            },
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
            "tickets": {
                "name": "tickets",
                "table": "public.tickets",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
        }
        engine = make_engine(chasm)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)", "count(tickets.id)"],
                "dimensions": ["customers.segment"],
            }
        )
        assert result.resolved_plan.has_fan_out
        assert "orders_agg" in result.sql
        assert "tickets_agg" in result.sql
        assert_valid_sql(result.sql)


class TestSuggestMode:
    def test_suggest_disconnected_returns_referenced_sources(self):
        from conftest import make_engine

        sources = {
            "a": {
                "name": "a",
                "table": "t",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "val", "type": "number"},
                ],
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
        engine = make_engine(sources)
        result = engine.suggest(
            {
                "measures": ["sum(a.val)"],
                "dimensions": ["b.val"],
            }
        )
        assert result["success"] is False
        assert "error" in result
        assert "referenced_sources" in result
        assert set(result["referenced_sources"]) == {"a", "b"}

    def test_suggest_missing_source_reports_name(self):
        from conftest import make_engine

        sources = {
            "a": {
                "name": "a",
                "table": "t",
                "grain": ["id"],
                "columns": [{"name": "id", "type": "number"}],
            },
        }
        engine = make_engine(sources)
        result = engine.suggest(
            {
                "measures": ["sum(nonexistent.val)"],
                "dimensions": ["a.id"],
            }
        )
        assert result["success"] is False
        assert "nonexistent" in result["error"]
        assert "missing_sources" in result
        assert "nonexistent" in result["missing_sources"]

    def test_suggest_success_returns_plan(self):
        from conftest import make_engine

        chasm = {
            "customers": {
                "name": "customers",
                "table": "public.customers",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            },
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
        }
        engine = make_engine(chasm)
        result = engine.suggest(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["customers.segment"],
            }
        )
        assert result["success"] is True
        assert result["suggestions"] == []


class TestPredefinedMeasureChains:
    """BUG 2: Pre-defined measures that reference other pre-defined measures."""

    def test_predefined_chain_profit(self):
        """Query orders.profit where profit=revenue-total_cost, both pre-defined."""
        from conftest import make_engine, assert_valid_sql

        sources = {
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                    {"name": "cost", "type": "number"},
                    {"name": "status", "type": "string"},
                ],
                "measures": [
                    {
                        "name": "revenue",
                        "expr": "sum(amount)",
                        "filter": "status != 'refunded'",
                    },
                    {"name": "total_cost", "expr": "sum(cost)"},
                    {"name": "profit", "expr": "revenue - total_cost"},
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["orders.profit"],
                "dimensions": ["orders.status"],
            }
        )
        assert_valid_sql(result.sql)
        # profit should appear as a derived measure
        profit_measure = next(
            m for m in result.resolved_plan.measures if m.name == "profit"
        )
        assert profit_measure.is_derived
        # The dependencies (revenue, total_cost) should be auto-added
        measure_names = {m.name for m in result.resolved_plan.measures}
        assert "revenue" in measure_names
        assert "total_cost" in measure_names

    def test_predefined_chain_margin(self):
        """Multi-level chain: margin = profit / revenue, profit = revenue - total_cost."""
        from conftest import make_engine, assert_valid_sql

        sources = {
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                    {"name": "cost", "type": "number"},
                    {"name": "status", "type": "string"},
                ],
                "measures": [
                    {
                        "name": "revenue",
                        "expr": "sum(amount)",
                        "filter": "status != 'refunded'",
                    },
                    {"name": "total_cost", "expr": "sum(cost)"},
                    {"name": "profit", "expr": "revenue - total_cost"},
                    {"name": "margin", "expr": "profit / revenue"},
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["orders.margin"],
                "dimensions": ["orders.status"],
            }
        )
        assert_valid_sql(result.sql)
        # margin should be derived
        margin_measure = next(
            m for m in result.resolved_plan.measures if m.name == "margin"
        )
        assert margin_measure.is_derived
        # profit, revenue, total_cost should all be present
        measure_names = {m.name for m in result.resolved_plan.measures}
        assert "margin" in measure_names
        assert "profit" in measure_names
        assert "revenue" in measure_names
        assert "total_cost" in measure_names


class TestSuggestValidation:
    """BUG 4: Suggest mode should also validate SQL generation."""

    def test_suggest_catches_generator_error(self):
        """Create a scenario where plan succeeds but generator fails --> suggest returns failure."""
        from conftest import make_engine

        # Two fact tables joining to same hub, but dim from a source that's unreachable
        # via safe (m2o) edges from any measure source --> generator should fail
        sources = {
            "hub": {
                "name": "hub",
                "table": "public.hub",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            },
            "fact_a": {
                "name": "fact_a",
                "table": "public.fact_a",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "hub_id", "type": "number"},
                    {"name": "val", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "hub",
                        "on": "hub_id = hub.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
            "fact_b": {
                "name": "fact_b",
                "table": "public.fact_b",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "hub_id", "type": "number"},
                    {"name": "val", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "hub",
                        "on": "hub_id = hub.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
            "leaf": {
                "name": "leaf",
                "table": "public.leaf",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "fact_a_id", "type": "number"},
                    {"name": "label", "type": "string"},
                ],
                "joins": [
                    {
                        "to": "fact_a",
                        "on": "fact_a_id = fact_a.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
        }
        engine = make_engine(sources)
        # This query has two measure sources (chasm trap) and a dimension from 'leaf'
        # which is only reachable from fact_a (not from fact_b) via safe edges
        # The planner will plan it, but the generator should fail for the leaf dimension
        result = engine.suggest(
            {
                "measures": ["sum(fact_a.val)", "sum(fact_b.val)"],
                "dimensions": ["leaf.label"],
            }
        )
        assert result["success"] is False
        assert "error" in result
        assert len(result["suggestions"]) > 0

    def test_suggest_success_includes_generation(self):
        """Valid query -- suggest returns success=True after both planning and generation."""
        from conftest import make_engine

        sources = {
            "hub": {
                "name": "hub",
                "table": "public.hub",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            },
            "fact_a": {
                "name": "fact_a",
                "table": "public.fact_a",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "hub_id", "type": "number"},
                    {"name": "val", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "hub",
                        "on": "hub_id = hub.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.suggest(
            {
                "measures": ["sum(fact_a.val)"],
                "dimensions": ["hub.segment"],
            }
        )
        assert result["success"] is True
        assert result["suggestions"] == []


class TestInvalidDialect:
    def test_invalid_dialect_on_engine(self):
        with pytest.raises(ValueError, match="Unknown SQL dialect"):
            SemanticEngine(SOURCES_DIR, dialect="not_a_real_dialect")

    def test_invalid_dialect_from_sources(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
            ),
        }
        with pytest.raises(ValueError, match="Unknown SQL dialect"):
            SemanticEngine.from_sources(sources, dialect="foobar")


class TestCrossReferenceValidation:
    def test_validate_reports_bad_join_target_as_error(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
                joins=[
                    JoinDeclaration(
                        to="nonexistent",
                        on="fk = nonexistent.id",
                        relationship="many_to_one",
                    )
                ],
            ),
        }
        # from_sources no longer hard-raises on orphan targets; the validator surfaces it.
        engine = SemanticEngine.from_sources(sources)
        report = engine.validate()
        assert not report.valid
        assert any("'nonexistent'" in e and "not defined" in e for e in report.errors)

    def test_from_sources_accepts_valid_join_target(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="customer_id", type="number"),
                ],
                joins=[
                    JoinDeclaration(
                        to="customers",
                        on="customer_id = customers.id",
                        relationship="many_to_one",
                    )
                ],
            ),
            "customers": SourceDefinition(
                name="customers",
                table="public.customers",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
            ),
        }
        engine = SemanticEngine.from_sources(sources)
        assert "customers" in engine.sources


class TestUnqualifiedMeasureResolution:
    """Bare measure names (e.g. 'revenue') should auto-resolve when unambiguous."""

    def test_bare_name_resolves_uniquely(self, engine):
        result = engine.query(
            {"measures": ["revenue"], "dimensions": ["orders.status"]}
        )
        assert result.sql
        assert "CASE WHEN" in result.sql.upper()  # revenue has a filter
        sqlglot.parse(result.sql)

    def test_bare_name_with_dimensions(self, engine):
        result = engine.query(
            {"measures": ["revenue"], "dimensions": ["customers.segment"]}
        )
        assert result.sql
        sqlglot.parse(result.sql)

    def test_bare_and_qualified_coexist(self, engine):
        result = engine.query(
            {
                "measures": ["revenue", "sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result.sql
        sqlglot.parse(result.sql)

    def test_bare_name_ambiguous_raises(self):
        from conftest import make_engine

        sources = {
            "store_a": {
                "name": "store_a",
                "table": "public.store_a",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "measures": [{"name": "revenue", "expr": "sum(amount)"}],
            },
            "store_b": {
                "name": "store_b",
                "table": "public.store_b",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "measures": [{"name": "revenue", "expr": "sum(amount)"}],
            },
        }
        engine = make_engine(sources)
        with pytest.raises(ValueError, match="ambiguous"):
            engine.query({"measures": ["revenue"], "dimensions": []})

    def test_bare_name_not_found_raises(self, engine):
        with pytest.raises(ValueError, match="does not reference any source"):
            engine.query({"measures": ["nonexistent_measure"], "dimensions": []})

    def test_bare_aggregate_not_resolved(self, engine):
        with pytest.raises(ValueError, match="does not reference any source"):
            engine.query({"measures": ["sum(amount)"], "dimensions": []})
