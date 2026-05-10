"""Tests for named segments — reusable boolean predicates on a source.

Segments are AND-ed into the measure's effective filter via the same CASE WHEN
pathway used by `measure.filter`. They never become a global WHERE clause.
"""

from __future__ import annotations

import pytest

from .conftest import assert_valid_sql, make_engine


def _orders_source(**overrides):
    base = {
        "name": "orders",
        "table": "public.orders",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "amount", "type": "number"},
            {"name": "is_paid", "type": "boolean"},
            {"name": "is_refunded", "type": "string"},
            {"name": "customer_id", "type": "number"},
        ],
        "segments": [
            {
                "name": "paid_non_refunded",
                "expr": "is_paid = true and is_refunded = '0'",
                "description": "Settled, not reversed.",
            },
        ],
        "measures": [
            {
                "name": "total_revenue",
                "expr": "sum(amount)",
                "segments": ["paid_non_refunded"],
            },
        ],
    }
    base.update(overrides)
    return base


def _customers_source(**overrides):
    base = {
        "name": "customers",
        "table": "public.customers",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "is_vip", "type": "boolean"},
        ],
        "measures": [
            {"name": "customer_count", "expr": "count(distinct id)"},
        ],
    }
    base.update(overrides)
    return base


# ── Composition + golden SQL shape ───────────────────────────────────


class TestSegmentComposition:
    def test_measure_segment_lands_in_case_when_wrap(self):
        engine = make_engine({"orders": _orders_source()})
        result = engine.query({"measures": ["orders.total_revenue"]})
        assert_valid_sql(result.sql)
        sql_upper = result.sql.upper()
        # Filter must be inside CASE WHEN (the measure-filter pathway)
        assert "CASE WHEN" in sql_upper
        assert "is_paid" in result.sql.lower()
        assert "is_refunded" in result.sql.lower()
        # Should NOT show up as a global WHERE
        # (a WHERE clause may exist for other reasons — assert no segment expr in it)
        # Easiest: assert WHERE doesn't contain the segment's exact predicate.
        # Split before/after first WHERE keyword if any.
        assert "WHERE IS_PAID" not in sql_upper.replace(" = ", " = ")

    def test_measure_filter_and_segment_both_applied(self):
        src = _orders_source()
        src["measures"][0]["filter"] = "amount > 0"
        engine = make_engine({"orders": src})
        result = engine.query({"measures": ["orders.total_revenue"]})
        assert_valid_sql(result.sql)
        sql_lower = result.sql.lower()
        # Both predicates appear inside the measure's CASE WHEN wrap
        assert "amount > 0" in sql_lower
        assert "is_paid" in sql_lower
        assert "is_refunded" in sql_lower
        # AND composition: ensure both halves are joined
        assert " and " in sql_lower

    def test_query_time_segment_applies_to_measure(self):
        # Measure has no measure-bound segment; segment is applied at query time.
        src = _orders_source()
        src["measures"] = [{"name": "raw_revenue", "expr": "sum(amount)"}]
        engine = make_engine({"orders": src})
        result = engine.query(
            {
                "measures": ["orders.raw_revenue"],
                "segments": ["orders.paid_non_refunded"],
            }
        )
        assert_valid_sql(result.sql)
        sql_lower = result.sql.lower()
        assert "case when" in sql_lower
        assert "is_paid" in sql_lower
        assert "is_refunded" in sql_lower

    def test_measure_and_query_segments_compose(self):
        # Measure has paid_non_refunded; query adds 'high_value'.
        src = _orders_source()
        src["segments"].append(
            {"name": "high_value", "expr": "amount >= 100"},
        )
        engine = make_engine({"orders": src})
        result = engine.query(
            {
                "measures": ["orders.total_revenue"],
                "segments": ["orders.high_value"],
            }
        )
        assert_valid_sql(result.sql)
        sql_lower = result.sql.lower()
        # All three predicates present
        assert "is_paid" in sql_lower
        assert "is_refunded" in sql_lower
        assert "amount >= 100" in sql_lower


# ── Multi-source query: scope is per-measure, not global ─────────────


class TestSegmentMultiSourceScope:
    def test_segment_does_not_apply_to_other_source_measures(self):
        # Query touches both orders and customers; segment is on orders only.
        # Assert that the segment predicate does NOT show up in the
        # customers CTE / WHERE on customers.
        engine = make_engine(
            {
                "orders": _orders_source(
                    joins=[
                        {
                            "to": "customers",
                            "on": "customer_id = customers.id",
                            "relationship": "many_to_one",
                        }
                    ],
                    measures=[
                        {"name": "raw_revenue", "expr": "sum(amount)"},
                    ],
                ),
                "customers": _customers_source(),
            }
        )
        result = engine.query(
            {
                "measures": [
                    "orders.raw_revenue",
                    "customers.customer_count",
                ],
                "segments": ["orders.paid_non_refunded"],
            }
        )
        assert_valid_sql(result.sql)
        sql_lower = result.sql.lower()
        # Segment predicate appears (it landed on orders)
        assert "is_paid" in sql_lower
        # The customers measure's pre-aggregation CTE / clause must not be filtered by the segment.
        # Heuristic: find each line that references count(distinct ... id) and assert no
        # "is_paid" or "is_refunded" in the same CASE WHEN block. The simpler assertion
        # is that there's no global WHERE applying the segment.
        # We assert the segment doesn't appear inside an aggregate against the customers source.
        # Concretely: count(...customers...) should not contain is_paid/is_refunded.
        # Walk the SQL and find COUNT(DISTINCT ... ID) — that aggregate must be unfiltered.
        import re

        count_aggs = re.findall(
            r"COUNT\s*\(\s*DISTINCT[^()]*\)", result.sql, flags=re.IGNORECASE
        )
        assert count_aggs, "expected at least one COUNT(DISTINCT ...) aggregate"
        for agg in count_aggs:
            assert "is_paid" not in agg.lower(), (
                f"customer_count aggregate must not be filtered by segment: {agg}"
            )


# ── Error cases ──────────────────────────────────────────────────────


class TestSegmentErrors:
    def test_unknown_bare_name_in_measure_segments(self):
        src = _orders_source()
        src["measures"][0]["segments"] = ["does_not_exist"]
        engine = make_engine({"orders": src})
        with pytest.raises(ValueError, match="unknown segment 'does_not_exist'"):
            engine.query({"measures": ["orders.total_revenue"]})

    def test_unknown_query_time_segment_name(self):
        engine = make_engine({"orders": _orders_source()})
        with pytest.raises(ValueError, match="unknown segment 'does_not_exist'"):
            engine.query(
                {
                    "measures": ["orders.total_revenue"],
                    "segments": ["orders.does_not_exist"],
                }
            )

    def test_unknown_query_time_segment_source(self):
        engine = make_engine({"orders": _orders_source()})
        with pytest.raises(ValueError, match="unknown source 'no_such_source'"):
            engine.query(
                {
                    "measures": ["orders.total_revenue"],
                    "segments": ["no_such_source.foo"],
                }
            )

    def test_query_time_segment_must_be_dotted(self):
        engine = make_engine({"orders": _orders_source()})
        with pytest.raises(ValueError, match="dotted"):
            engine.query(
                {
                    "measures": ["orders.total_revenue"],
                    "segments": ["paid_non_refunded"],  # missing source prefix
                }
            )

    def test_no_op_query_time_segment_errors(self):
        # Segment on customers, but no customers measure in the query.
        engine = make_engine(
            {
                "orders": _orders_source(
                    joins=[
                        {
                            "to": "customers",
                            "on": "customer_id = customers.id",
                            "relationship": "many_to_one",
                        }
                    ],
                    measures=[{"name": "raw_revenue", "expr": "sum(amount)"}],
                ),
                "customers": _customers_source(
                    segments=[{"name": "vips", "expr": "is_vip = true"}]
                ),
            }
        )
        with pytest.raises(ValueError, match="no matching"):
            engine.query(
                {
                    "measures": ["orders.raw_revenue"],
                    "segments": ["customers.vips"],
                }
            )


def test_bigquery_native_segment_referenced_by_measure(make_engine_factory):
    """Segment authored in BigQuery dialect, referenced by a measure,
    must not degrade the segment's native syntax when composed."""
    source = {
        "name": "fct_orders",
        "table": "fct_orders",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "status", "type": "string"},
            {"name": "ts", "type": "time"},
        ],
        "segments": [
            {"name": "non_cancelled", "expr": "status != 'cancelled'"},
            {
                "name": "last_30",
                "expr": "ts >= timestamp(date_sub(current_date(), interval 30 day))",
            },
        ],
        "measures": [
            {
                "name": "dau",
                "expr": "count(distinct id)",
                "segments": ["non_cancelled", "last_30"],
            }
        ],
    }
    engine = make_engine_factory({"fct_orders": source}, dialect="bigquery")
    result = engine.query(
        {"measures": ["fct_orders.dau"], "dimensions": [], "filters": []}
    )
    sql = result.sql
    assert "INTERVAL '30'" not in sql or "DAY" in sql.upper(), (
        f"INTERVAL unit lost in segment reference:\n{sql}"
    )
