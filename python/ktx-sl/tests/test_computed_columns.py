"""Tests for computed column (expr) support on table sources."""

from __future__ import annotations


from semantic_layer.models import SourceColumn

from .conftest import assert_valid_sql, make_engine


def _lineitem_source(**overrides):
    base = {
        "name": "lineitem",
        "table": "public.lineitem",
        "grain": ["l_orderkey", "l_linenumber"],
        "columns": [
            {"name": "l_orderkey", "type": "number"},
            {"name": "l_linenumber", "type": "number"},
            {"name": "l_extendedprice", "type": "number"},
            {"name": "l_discount", "type": "number"},
            {"name": "l_quantity", "type": "number"},
            {"name": "l_returnflag", "type": "string"},
            {
                "name": "net_price",
                "type": "number",
                "expr": "l_extendedprice * (1 - l_discount)",
            },
        ],
    }
    base.update(overrides)
    return base


class TestComputedColumnDimension:
    def test_computed_column_in_select_and_group_by(self):
        engine = make_engine({"lineitem": _lineitem_source()})
        result = engine.query(
            {
                "measures": ["sum(lineitem.l_quantity)"],
                "dimensions": ["lineitem.net_price"],
            }
        )
        assert_valid_sql(result.sql)
        assert "l_extendedprice" in result.sql
        assert "l_discount" in result.sql
        assert "AS net_price" in result.sql

    def test_date_trunc_on_computed_column(self):
        engine = make_engine(
            {
                "events": {
                    "name": "events",
                    "table": "public.events",
                    "grain": ["id"],
                    "columns": [
                        {"name": "id", "type": "number"},
                        {"name": "created_at", "type": "time", "role": "time"},
                        {"name": "offset_hours", "type": "number"},
                        {
                            "name": "local_time",
                            "type": "time",
                            "role": "time",
                            "expr": "created_at + offset_hours * INTERVAL '1 hour'",
                        },
                        {"name": "value", "type": "number"},
                    ],
                }
            }
        )
        result = engine.query(
            {
                "measures": ["sum(events.value)"],
                "dimensions": [{"field": "events.local_time", "granularity": "month"}],
            }
        )
        assert_valid_sql(result.sql)
        assert "DATE_TRUNC" in result.sql
        assert "created_at" in result.sql
        assert "offset_hours" in result.sql


class TestComputedColumnInMeasure:
    def test_runtime_aggregate_on_computed_column(self):
        engine = make_engine({"lineitem": _lineitem_source()})
        result = engine.query(
            {
                "measures": ["sum(lineitem.net_price)"],
                "dimensions": [],
            }
        )
        assert_valid_sql(result.sql)
        assert "SUM" in result.sql.upper()
        assert "l_extendedprice" in result.sql
        assert "l_discount" in result.sql

    def test_predefined_measure_referencing_computed_column(self):
        source = _lineitem_source(
            measures=[
                {"name": "total_net", "expr": "sum(net_price)"},
            ]
        )
        engine = make_engine({"lineitem": source})
        result = engine.query(
            {
                "measures": ["lineitem.total_net"],
                "dimensions": [],
            }
        )
        assert_valid_sql(result.sql)
        assert "l_extendedprice" in result.sql
        assert "l_discount" in result.sql


class TestComputedColumnInFilter:
    def test_computed_column_in_where_filter(self):
        engine = make_engine({"lineitem": _lineitem_source()})
        result = engine.query(
            {
                "measures": ["sum(lineitem.l_extendedprice)"],
                "dimensions": [],
                "filters": ["lineitem.net_price > 100"],
            }
        )
        assert_valid_sql(result.sql)
        assert "WHERE" in result.sql
        assert "l_extendedprice" in result.sql
        assert "l_discount" in result.sql


class TestComputedColumnWithJoins:
    def test_join_on_uses_physical_columns(self):
        engine = make_engine(
            {
                "orders": {
                    "name": "orders",
                    "table": "public.orders",
                    "grain": ["id"],
                    "columns": [
                        {"name": "id", "type": "number"},
                        {"name": "customer_id", "type": "number"},
                        {"name": "amount", "type": "number"},
                        {"name": "discount", "type": "number"},
                        {
                            "name": "net_amount",
                            "type": "number",
                            "expr": "amount * (1 - discount)",
                        },
                    ],
                    "joins": [
                        {
                            "to": "customers",
                            "on": "customer_id = customers.id",
                            "relationship": "many_to_one",
                        }
                    ],
                },
                "customers": {
                    "name": "customers",
                    "table": "public.customers",
                    "grain": ["id"],
                    "columns": [
                        {"name": "id", "type": "number"},
                        {"name": "segment", "type": "string"},
                    ],
                },
            }
        )
        result = engine.query(
            {
                "measures": ["sum(orders.net_amount)"],
                "dimensions": ["customers.segment"],
            }
        )
        assert_valid_sql(result.sql)
        # JOIN ON should use physical columns
        assert "orders.customer_id" in result.sql
        assert "customers.id" in result.sql
        # Measure should be expanded
        assert "orders.amount" in result.sql
        assert "orders.discount" in result.sql


class TestComputedColumnLocality:
    def test_computed_column_in_aggregate_locality(self):
        engine = make_engine(
            {
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
                        {"name": "price", "type": "number"},
                        {"name": "qty", "type": "number"},
                        {
                            "name": "total",
                            "type": "number",
                            "expr": "price * qty",
                        },
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
            }
        )
        result = engine.query(
            {
                "measures": ["sum(fact_a.total)", "sum(fact_b.val)"],
                "dimensions": ["hub.segment"],
            }
        )
        assert_valid_sql(result.sql)
        assert "_agg" in result.sql
        assert "fact_a.price" in result.sql
        assert "fact_a.qty" in result.sql


class TestComputedColumnModel:
    def test_source_column_with_expr(self):
        col = SourceColumn(
            name="net_price", type="number", expr="price * (1 - discount)"
        )
        assert col.expr == "price * (1 - discount)"

    def test_source_column_without_expr(self):
        col = SourceColumn(name="price", type="number")
        assert col.expr is None

    def test_source_column_expr_in_yaml_roundtrip(self):
        engine = make_engine(
            {
                "t": {
                    "name": "t",
                    "table": "public.t",
                    "grain": ["id"],
                    "columns": [
                        {"name": "id", "type": "number"},
                        {"name": "a", "type": "number"},
                        {"name": "b", "type": "number"},
                        {
                            "name": "c",
                            "type": "number",
                            "expr": "a + b",
                        },
                    ],
                }
            }
        )
        src = engine.sources["t"]
        c_col = next(c for c in src.columns if c.name == "c")
        assert c_col.expr == "a + b"


def test_bigquery_computed_column_with_timestamp_add(make_engine_factory):
    """Computed column authored with BigQuery-native TIMESTAMP_ADD must survive."""
    source = {
        "name": "events",
        "table": "events",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "event_at", "type": "time"},
            {"name": "tz_offset", "type": "number"},
            {
                "name": "local_hour",
                "type": "time",
                "expr": "TIMESTAMP_ADD(event_at, INTERVAL tz_offset HOUR)",
            },
        ],
        "measures": [{"name": "cnt", "expr": "count(*)"}],
    }
    engine = make_engine_factory({"events": source}, dialect="bigquery")
    result = engine.query(
        {
            "measures": ["events.cnt"],
            "dimensions": ["events.local_hour"],
            "filters": [],
        }
    )
    assert "TIMESTAMP_ADD" in result.sql.upper()
    assert "HOUR" in result.sql.upper()
