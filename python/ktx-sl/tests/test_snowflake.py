"""Comprehensive Snowflake dialect tests covering all major SQL generation code paths."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlglot

from semantic_layer.engine import SemanticEngine
from semantic_layer.models import SourceColumn, SourceDefinition

SOURCES_DIR = str(Path(__file__).parent.parent / "sources" / "ecommerce")


def assert_valid_snowflake_sql(sql: str):
    """Assert SQL parses as valid Snowflake SQL."""
    try:
        result = sqlglot.parse(sql, read="snowflake")
        assert result and all(r is not None for r in result)
    except Exception as e:
        pytest.fail(f"SQL is not valid Snowflake: {e}\n\nSQL:\n{sql}")


@pytest.fixture
def sf_engine():
    return SemanticEngine(SOURCES_DIR, dialect="snowflake")


@pytest.fixture
def chasm_engine():
    """Engine with hub + two fact tables for chasm trap / aggregate locality tests."""
    sources = {
        "hub": SourceDefinition(
            name="hub",
            table="public.hub",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="segment", type="string"),
            ],
        ),
        "fact_a": SourceDefinition(
            name="fact_a",
            table="public.fact_a",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="val", type="number"),
                SourceColumn(name="created_at", type="time"),
            ],
            joins=[
                {"to": "hub", "on": "hub_id = hub.id", "relationship": "many_to_one"}
            ],
        ),
        "fact_b": SourceDefinition(
            name="fact_b",
            table="public.fact_b",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="val", type="number"),
            ],
            joins=[
                {"to": "hub", "on": "hub_id = hub.id", "relationship": "many_to_one"}
            ],
            measures=[{"name": "total_val", "expr": "sum(val)", "filter": "val > 0"}],
        ),
    }
    return SemanticEngine.from_sources(sources, dialect="snowflake")


# ── Basic query patterns ─────────────────────────────────────────────


class TestSnowflakeBasic:
    def test_simple_single_source(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        sql = result.sql
        assert result.dialect == "snowflake"
        assert_valid_snowflake_sql(sql)
        assert "GROUP BY" in sql

    def test_cross_source_m2o(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["customers.segment", "regions.name"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "JOIN" in sql

    def test_predefined_measure_with_filter(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "CASE WHEN" in sql
        assert "<>" in sql  # sqlglot transpiles != to <>
        assert "'refunded'" in sql

    def test_derived_measures(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": [
                    {"expr": "sum(orders.amount)", "name": "total_rev"},
                    {"expr": "sum(orders.cost)", "name": "total_cost"},
                    {"expr": "total_rev - total_cost", "name": "profit"},
                ],
                "dimensions": ["customers.segment"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "profit" in sql.lower()
        assert "total_rev" in sql
        assert "total_cost" in sql

    def test_include_empty_false(self, sf_engine):
        result_left = sf_engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["customers.segment"],
                "include_empty": True,
            }
        )
        result_inner = sf_engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["customers.segment"],
                "include_empty": False,
            }
        )
        assert_valid_snowflake_sql(result_left.sql)
        assert_valid_snowflake_sql(result_inner.sql)
        assert "LEFT JOIN" in result_left.sql.upper()
        assert "LEFT JOIN" not in result_inner.sql.upper()


# ── Time granularity ─────────────────────────────────────────────────


class TestSnowflakeTimeGranularity:
    @pytest.mark.parametrize("granularity", ["day", "week", "month", "quarter", "year"])
    def test_date_trunc_uppercase(self, sf_engine, granularity):
        result = sf_engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": [
                    {"field": "orders.created_at", "granularity": granularity}
                ],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        # Snowflake DATE_TRUNC uses uppercase granularity
        assert f"DATE_TRUNC('{granularity.upper()}'" in sql


# ── Filters ──────────────────────────────────────────────────────────


class TestSnowflakeFilters:
    def test_having_filter(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["sum(orders.amount) > 10000"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "HAVING" in sql
        assert "10000" in sql

    def test_where_and_having(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": [
                    "orders.status != 'cancelled'",
                    "sum(orders.amount) > 1000",
                ],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "WHERE" in sql
        assert "HAVING" in sql


# ── SQL sources / CTEs ───────────────────────────────────────────────


class TestSnowflakeCTE:
    def test_sql_source_as_cte(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": ["avg(churn_risk.score)"],
                "dimensions": ["churn_risk.customer_type"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "WITH" in sql
        assert "churn_risk" in sql

    def test_cross_source_with_sql_source(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": ["avg(churn_risk.score)"],
                "dimensions": ["regions.name"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "WITH" in sql
        assert "JOIN" in sql

    def test_sql_source_with_datediff(self):
        """DATEDIFF in SQL source must survive transpilation (not become AGE)."""
        sources = {
            "cohorts": SourceDefinition(
                name="cohorts",
                sql="SELECT id, DATEDIFF(WEEK, start_date, end_date) AS n FROM t",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="n", type="number"),
                ],
            ),
        }
        engine = SemanticEngine.from_sources(sources, dialect="snowflake")
        result = engine.query({"measures": ["sum(cohorts.n)"], "dimensions": []})
        assert_valid_snowflake_sql(result.sql)
        assert "DATEDIFF" in result.sql.upper()
        assert "AGE" not in result.sql.upper()

    def test_sql_source_with_datediff_in_ctes(self):
        """DATEDIFF inside inner CTEs must survive CTE promotion."""
        sources = {
            "retention": SourceDefinition(
                name="retention",
                sql=(
                    "WITH spine AS ("
                    "  SELECT DISTINCT cohort_week,"
                    "    DATEDIFF(WEEK, cohort_week, period_week) AS n"
                    "  FROM adopters"
                    ") SELECT cohort_week, n, COUNT(*) AS cnt FROM spine GROUP BY 1, 2"
                ),
                grain=["cohort_week", "n"],
                columns=[
                    SourceColumn(name="cohort_week", type="time"),
                    SourceColumn(name="n", type="number"),
                    SourceColumn(name="cnt", type="number"),
                ],
            ),
        }
        engine = SemanticEngine.from_sources(sources, dialect="snowflake")
        result = engine.query(
            {"measures": ["sum(retention.cnt)"], "dimensions": ["retention.n"]}
        )
        assert_valid_snowflake_sql(result.sql)
        assert "DATEDIFF" in result.sql.upper()
        # Inner CTE should be promoted with prefix
        assert "retention__spine" in result.sql


# ── Aggregate functions ──────────────────────────────────────────────


class TestSnowflakeAggregateFunctions:
    def test_median_percentile_cont(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": [{"expr": "median(orders.amount)", "name": "median_order"}],
                "dimensions": ["orders.status"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "PERCENTILE_CONT" in sql
        assert "WITHIN GROUP" in sql

    def test_percentile(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": [{"expr": "percentile(orders.amount, 0.9)", "name": "p90"}],
                "dimensions": ["orders.status"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "PERCENTILE_CONT" in sql
        assert "0.9" in sql

    def test_count_distinct(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": ["count_distinct(orders.customer_id)"],
                "dimensions": ["orders.status"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "COUNT(DISTINCT" in sql


# ── Aggregate locality / chasm traps ─────────────────────────────────


class TestSnowflakeAggregateLocality:
    def test_chasm_trap_full_join(self, chasm_engine):
        result = chasm_engine.query(
            {
                "measures": ["sum(fact_a.val)", "sum(fact_b.val)"],
                "dimensions": ["hub.segment"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "FULL JOIN" in sql.upper()
        assert "COALESCE" in sql.upper()
        assert "fact_a_agg" in sql
        assert "fact_b_agg" in sql

    def test_chasm_trap_predefined_filtered_measure(self, chasm_engine):
        result = chasm_engine.query(
            {
                "measures": ["sum(fact_a.val)", "fact_b.total_val"],
                "dimensions": ["hub.segment"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "CASE WHEN" in sql
        assert "total_val" in sql

    def test_chasm_trap_derived_measure(self, chasm_engine):
        result = chasm_engine.query(
            {
                "measures": [
                    {"expr": "sum(fact_a.val)", "name": "total_a"},
                    {"expr": "sum(fact_b.val)", "name": "total_b"},
                    {"expr": "total_a + total_b", "name": "grand_total"},
                ],
                "dimensions": ["hub.segment"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "grand_total" in sql
        assert "COALESCE" in sql.upper()

    def test_chasm_trap_derived_ratio_nullif(self, chasm_engine):
        result = chasm_engine.query(
            {
                "measures": [
                    {"expr": "sum(fact_a.val)", "name": "total_a"},
                    {"expr": "sum(fact_b.val)", "name": "total_b"},
                    {"expr": "total_a / total_b", "name": "ratio"},
                ],
                "dimensions": ["hub.segment"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "NULLIF" in sql.upper()
        assert "ratio" in sql

    def test_chasm_trap_having(self, chasm_engine):
        result = chasm_engine.query(
            {
                "measures": ["sum(fact_a.val)", "sum(fact_b.val)"],
                "dimensions": ["hub.segment"],
                "filters": ["sum(fact_a.val) > 100"],
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "100" in sql
        # HAVING in locality mode becomes WHERE on outer query
        assert "WHERE" in sql


# ── ORDER BY + LIMIT ─────────────────────────────────────────────────


class TestSnowflakeOrderByLimit:
    def test_order_by_desc_with_limit(self, sf_engine):
        result = sf_engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "order_by": [{"field": "sum(orders.amount)", "direction": "desc"}],
                "limit": 10,
            }
        )
        sql = result.sql
        assert_valid_snowflake_sql(sql)
        assert "DESC" in sql.upper()
        assert "LIMIT 10" in sql


# ── Snowflake reserved words as identifiers ──────────────────────────


class TestSnowflakeReservedWords:
    """Snowflake-specific reserved words (sample, qualify) must be quoted."""

    @pytest.mark.parametrize("source_name", ["sample", "qualify"])
    def test_snowflake_reserved_word_as_source_name(self, source_name):
        sources = {
            source_name: SourceDefinition(
                name=source_name,
                table=f"public.{source_name}s",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="val", type="number"),
                ],
            ),
        }
        engine = SemanticEngine.from_sources(sources, dialect="snowflake")
        result = engine.query(
            {
                "measures": [f"sum({source_name}.val)"],
                "dimensions": [],
            }
        )
        assert_valid_snowflake_sql(result.sql)
        assert "SUM" in result.sql.upper()

    @pytest.mark.parametrize("col_name", ["sample", "qualify"])
    def test_snowflake_reserved_word_as_column_name(self, col_name):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name=col_name, type="number"),
                ],
            ),
        }
        engine = SemanticEngine.from_sources(sources, dialect="snowflake")
        result = engine.query(
            {
                "measures": [f"sum(orders.{col_name})"],
                "dimensions": [],
            }
        )
        assert_valid_snowflake_sql(result.sql)
        assert "SUM" in result.sql.upper()
