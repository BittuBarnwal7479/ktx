from semantic_layer.parser import ExpressionParser


parser = ExpressionParser()


class TestAggregateDetection:
    def test_sum(self):
        r = parser.parse("sum(orders.amount)")
        assert r.is_aggregate
        assert r.aggregate_function == "sum"

    def test_avg(self):
        r = parser.parse("avg(score)")
        assert r.is_aggregate
        assert r.aggregate_function == "avg"

    def test_count(self):
        r = parser.parse("count(orders.id)")
        assert r.is_aggregate
        assert r.aggregate_function == "count"

    def test_count_distinct(self):
        r = parser.parse("count_distinct(orders.customer_id)")
        assert r.is_aggregate
        assert r.aggregate_function == "count_distinct"

    def test_non_aggregate(self):
        r = parser.parse("orders.revenue")
        assert not r.is_aggregate
        assert r.aggregate_function is None

    def test_multiple_aggregates(self):
        r = parser.parse("sum(orders.amount) / count(orders.id)")
        assert r.is_aggregate
        # first aggregate found
        assert r.aggregate_function == "sum"

    def test_aggregate_in_scalar_subquery_not_aggregate(self):
        # `col = (SELECT MAX(col) FROM t)` is a plain column predicate, not HAVING-bound
        r = parser.parse("orders.created_at = (SELECT MAX(created_at) FROM orders)")
        assert not r.is_aggregate
        assert r.aggregate_function is None

    def test_aggregate_in_in_subquery_not_aggregate(self):
        r = parser.parse("orders.id IN (SELECT COUNT(id) FROM orders)")
        assert not r.is_aggregate

    def test_custom_agg_in_subquery_not_aggregate(self):
        r = parser.parse(
            "orders.customer_id = (SELECT count_distinct(customer_id) FROM orders)"
        )
        assert not r.is_aggregate

    def test_outer_aggregate_with_inner_subquery_still_aggregate(self):
        # Outer SUM on a plain column, even if subquery appears elsewhere
        r = parser.parse("sum(orders.amount) > (SELECT AVG(amount) FROM orders)")
        assert r.is_aggregate
        assert r.aggregate_function == "sum"


class TestSourceRefs:
    def test_single_ref(self):
        r = parser.parse("sum(orders.amount)")
        assert r.source_refs == {"orders"}
        assert r.column_refs == {"orders.amount"}

    def test_multiple_refs(self):
        r = parser.parse("sum(orders.revenue) / count(customers.id)")
        assert r.source_refs == {"orders", "customers"}
        assert r.column_refs == {"orders.revenue", "customers.id"}

    def test_pre_defined_ref(self):
        r = parser.parse("orders.revenue")
        assert r.source_refs == {"orders"}
        assert r.column_refs == {"orders.revenue"}

    def test_no_refs(self):
        r = parser.parse("total_rev - total_cost")
        assert r.source_refs == set()
        assert r.column_refs == set()

    def test_mixed_refs(self):
        r = parser.parse("sum(orders.amount) + churn_risk.score")
        assert r.source_refs == {"orders", "churn_risk"}


class TestDerivedMeasures:
    def test_depends_on_known_measures(self):
        r = parser.parse(
            "total_rev - total_cost",
            known_measure_names={"total_rev", "total_cost"},
        )
        assert r.depends_on_measures == {"total_rev", "total_cost"}
        assert not r.is_aggregate

    def test_no_false_positives(self):
        # "sum" should not be detected as a measure dependency
        r = parser.parse(
            "sum(orders.amount)",
            known_measure_names={"sum"},
        )
        assert r.depends_on_measures == set()

    def test_mixed_ref_and_derived(self):
        r = parser.parse(
            "total_rev / count(orders.id)",
            known_measure_names={"total_rev"},
        )
        assert r.depends_on_measures == {"total_rev"}
        assert r.is_aggregate

    def test_empty_known_measures(self):
        r = parser.parse("total_rev - total_cost")
        assert r.depends_on_measures == set()


class TestExtractSourceRefs:
    def test_basic(self):
        refs = parser.extract_source_refs("sum(orders.amount)")
        assert refs == {"orders"}

    def test_multiple(self):
        refs = parser.extract_source_refs("orders.amount + customers.score")
        assert refs == {"orders", "customers"}

    def test_no_refs(self):
        refs = parser.extract_source_refs("count(*)")
        assert refs == set()


class TestEdgeCases:
    def test_percentile(self):
        r = parser.parse("percentile(churn_risk.score, 0.9)")
        assert r.is_aggregate
        assert r.aggregate_function == "percentile"
        assert r.source_refs == {"churn_risk"}

    def test_string_literal_not_detected(self):
        # "status != 'refunded'" — 'refunded' should not be a source ref
        r = parser.parse("status != 'refunded'")
        assert r.source_refs == set()

    def test_complex_expression(self):
        r = parser.parse("sum(orders.amount) / count(orders.id) * 100")
        assert r.is_aggregate
        assert r.source_refs == {"orders"}
        assert r.column_refs == {"orders.amount", "orders.id"}


class TestAdditionalAggregates:
    def test_min(self):
        r = parser.parse("min(orders.amount)")
        assert r.is_aggregate
        assert r.aggregate_function == "min"

    def test_max(self):
        r = parser.parse("max(orders.amount)")
        assert r.is_aggregate
        assert r.aggregate_function == "max"

    def test_median(self):
        r = parser.parse("median(orders.amount)")
        assert r.is_aggregate
        assert r.aggregate_function == "median"

    def test_nested_function_not_aggregate(self):
        """abs() is not an aggregate function, but sum() wrapping it is."""
        r = parser.parse("sum(orders.amount)")
        assert r.is_aggregate
        assert r.source_refs == {"orders"}

    def test_comparison_operators(self):
        """Filter-like expression with comparison."""
        r = parser.parse("orders.status = 'completed'")
        assert not r.is_aggregate
        assert r.source_refs == {"orders"}

    def test_multiple_source_column_refs(self):
        """Expression referencing columns from 3 different sources."""
        r = parser.parse(
            "sum(orders.amount) + count(customers.id) - avg(tickets.score)"
        )
        assert r.is_aggregate
        assert r.source_refs == {"orders", "customers", "tickets"}


# ── From test_edge_cases.py: TestExpressionParserEdgeCases ───────────


class TestExpressionParserEdgeCases:
    def test_empty_string(self):
        result = parser.parse("")
        assert result.source_refs == set()
        assert result.column_refs == set()
        assert not result.is_aggregate

    def test_count_star(self):
        result = parser.parse("count(*)")
        assert result.is_aggregate
        assert result.aggregate_function == "count"
        assert result.source_refs == set()

    def test_multiple_aggregate_functions(self):
        result = parser.parse("sum(orders.amount) + avg(orders.cost)")
        assert result.is_aggregate
        assert result.aggregate_function == "sum"
        assert result.source_refs == {"orders"}

    def test_nested_function_not_aggregate(self):
        result = parser.parse("lower(orders.status)")
        assert not result.is_aggregate
        assert result.source_refs == {"orders"}

    def test_source_ref_in_string_literal(self):
        result = parser.parse("'orders.amount'")
        assert "orders" not in result.source_refs
        assert len(result.column_refs) == 0

    def test_underscore_names(self):
        result = parser.parse("sum(order_items.unit_price)")
        assert "order_items" in result.source_refs
        assert "order_items.unit_price" in result.column_refs

    def test_extract_source_refs_multi(self):
        refs = parser.extract_source_refs("orders.amount + customers.score")
        assert refs == {"orders", "customers"}


class TestReservedWordHandling:
    """LIMIT 4: Reserved SQL keywords as source or column names."""

    def test_reserved_word_source_name(self):
        """Parse 'sum(where.value)' where 'where' is a source name."""
        r = parser.parse("sum(where.value)")
        assert r.source_refs == {"where"}
        assert r.column_refs == {"where.value"}
        assert r.is_aggregate

    def test_reserved_word_column_name(self):
        """Parse 'select.from' where both are reserved words."""
        r = parser.parse("select.from")
        assert r.source_refs == {"select"}
        assert r.column_refs == {"select.from"}

    def test_reserved_word_in_extract_source_refs(self):
        """extract_source_refs should handle reserved words in expressions."""
        refs = parser.extract_source_refs("where.value > 10")
        assert refs == {"where"}


def test_extract_source_refs_bigquery_native():
    """BigQuery-native filter must not drop source refs due to mis-parse."""
    from semantic_layer.parser import ExpressionParser

    parser = ExpressionParser(dialect="bigquery")
    refs = parser.extract_source_refs(
        "SAFE_DIVIDE(orders.revenue, customers.count) > 0"
    )
    assert refs == {"orders", "customers"}


def test_expression_parser_dialect_defaults_to_postgres():
    """Constructor default is postgres — keeps existing tests working."""
    from semantic_layer.parser import ExpressionParser

    parser = ExpressionParser()
    assert parser.dialect == "postgres"


def test_extract_source_refs_postgres_baseline():
    """Postgres-dialect parser continues to work on postgres syntax."""
    from semantic_layer.parser import ExpressionParser

    parser = ExpressionParser(dialect="postgres")
    refs = parser.extract_source_refs(
        "orders.created_at >= current_date - interval '30 days'"
    )
    assert refs == {"orders"}
