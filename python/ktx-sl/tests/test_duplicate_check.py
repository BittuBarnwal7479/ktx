"""Tests for semantic_layer.duplicate_check.validate_measure_duplicates."""

from __future__ import annotations

from semantic_layer.duplicate_check import validate_measure_duplicates
from semantic_layer.models import (
    MeasureDefinition,
    SourceColumn,
    SourceDefinition,
)


def _make_source(name: str, measures: list[MeasureDefinition]) -> SourceDefinition:
    return SourceDefinition(
        name=name,
        table=f"public.{name}",
        grain=["id"],
        columns=[SourceColumn(name="id", type="number")],
        measures=measures,
    )


def test_same_expr_different_filter_is_flagged() -> None:
    """The replay-trimmed case: count(*) twice, one with is_active filter."""
    source = _make_source(
        "fct_subscriptions",
        [
            MeasureDefinition(
                name="active_subscription_count",
                expr="count(*)",
                filter="is_active = true",
            ),
            MeasureDefinition(
                name="new_subscription_count",
                expr="count(*)",
            ),
        ],
    )
    errors = validate_measure_duplicates({"fct_subscriptions": source})
    assert len(errors) == 1
    assert "new_subscription_count" in errors[0]
    assert "active_subscription_count" in errors[0]
    assert "differs only by `filter`" in errors[0]


def test_same_expr_same_filter_is_flagged() -> None:
    """Two measures with identical expr and filter — flagged as duplicate pair."""
    source = _make_source(
        "fct_orders",
        [
            MeasureDefinition(
                name="order_count_a", expr="count(*)", filter="is_paid = true"
            ),
            MeasureDefinition(
                name="order_count_b", expr="count(*)", filter="is_paid = true"
            ),
        ],
    )
    errors = validate_measure_duplicates({"fct_orders": source})
    assert len(errors) == 1
    assert "same expression and filter" in errors[0]


def test_different_expr_is_not_flagged() -> None:
    """count(*) vs sum(amount) on same source — legitimately distinct measures."""
    source = _make_source(
        "fct_orders",
        [
            MeasureDefinition(name="order_count", expr="count(*)"),
            MeasureDefinition(name="total_revenue", expr="sum(amount)"),
            MeasureDefinition(name="avg_revenue", expr="avg(amount)"),
        ],
    )
    errors = validate_measure_duplicates({"fct_orders": source})
    assert errors == []


def test_measures_on_different_sources_not_compared() -> None:
    """Same expr on two different sources is not a duplicate."""
    a = _make_source("fct_a", [MeasureDefinition(name="total", expr="count(*)")])
    b = _make_source("fct_b", [MeasureDefinition(name="total", expr="count(*)")])
    errors = validate_measure_duplicates({"fct_a": a, "fct_b": b})
    assert errors == []


def test_whitespace_and_case_are_normalized() -> None:
    """COUNT(*) and count(*) and  count( * )  all compare equal."""
    source = _make_source(
        "fct_orders",
        [
            MeasureDefinition(name="a", expr="count(*)"),
            MeasureDefinition(name="b", expr="COUNT(*)"),
            MeasureDefinition(name="c", expr=" count( * ) "),
        ],
    )
    errors = validate_measure_duplicates({"fct_orders": source})
    # Three measures pairwise — should yield 3 errors (a vs b, a vs c, b vs c)
    assert len(errors) == 3


def test_unparseable_expr_is_skipped_not_errored() -> None:
    """A measure whose expr can't be parsed is ignored — don't block commit."""
    source = _make_source(
        "fct_orders",
        [
            MeasureDefinition(name="bad", expr="!!! not SQL !!!"),
            MeasureDefinition(name="good", expr="count(*)"),
        ],
    )
    # Should not raise, should not flag — the parser validator will catch the bad one elsewhere
    errors = validate_measure_duplicates({"fct_orders": source})
    assert errors == []


def test_non_commutative_args_not_treated_as_equivalent() -> None:
    """safe_divide(a, b) is NOT equivalent to safe_divide(b, a)."""
    source = _make_source(
        "fct_orders",
        [
            MeasureDefinition(
                name="ratio_ab", expr="safe_divide(count(*), sum(amount))"
            ),
            MeasureDefinition(
                name="ratio_ba", expr="safe_divide(sum(amount), count(*))"
            ),
        ],
    )
    errors = validate_measure_duplicates({"fct_orders": source})
    assert errors == []


def test_single_measure_source_no_comparison() -> None:
    source = _make_source(
        "fct_orders", [MeasureDefinition(name="total", expr="count(*)")]
    )
    errors = validate_measure_duplicates({"fct_orders": source})
    assert errors == []


def test_same_expr_different_segments_is_not_flagged() -> None:
    """Two measures with same expr but different named segments are by-design distinct."""
    source = _make_source(
        "fct_subscriptions",
        [
            MeasureDefinition(
                name="active_count", expr="count(*)", segments=["active"]
            ),
            MeasureDefinition(
                name="inactive_count", expr="count(*)", segments=["inactive"]
            ),
        ],
    )
    errors = validate_measure_duplicates({"fct_subscriptions": source})
    assert errors == []


def test_same_expr_same_segments_is_flagged() -> None:
    """Same expr + same segment set = a true duplicate."""
    source = _make_source(
        "fct_subscriptions",
        [
            MeasureDefinition(name="a_count", expr="count(*)", segments=["active"]),
            MeasureDefinition(name="b_count", expr="count(*)", segments=["active"]),
        ],
    )
    errors = validate_measure_duplicates({"fct_subscriptions": source})
    assert len(errors) == 1
    assert "same expression and filter" in errors[0]


def test_segment_difference_with_filter_difference_not_flagged() -> None:
    """Segments differ → distinct measures even if filter also differs."""
    source = _make_source(
        "fct_subscriptions",
        [
            MeasureDefinition(
                name="m1",
                expr="count(*)",
                segments=["active"],
                filter="protocol = 'TRT'",
            ),
            MeasureDefinition(name="m2", expr="count(*)", segments=["inactive"]),
        ],
    )
    errors = validate_measure_duplicates({"fct_subscriptions": source})
    assert errors == []


def test_bigquery_native_exprs_compared_correctly():
    """Two measures with identical BigQuery-native exprs must be flagged as duplicates."""
    from semantic_layer.duplicate_check import validate_measure_duplicates
    from semantic_layer.models import (
        MeasureDefinition,
        SourceColumn,
        SourceDefinition,
    )

    source = SourceDefinition(
        name="fct_orders",
        table="fct_orders",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="amount", type="number"),
        ],
        measures=[
            MeasureDefinition(
                name="safe_ratio_a",
                expr="SAFE_DIVIDE(sum(amount), count(*))",
            ),
            MeasureDefinition(
                name="safe_ratio_b",
                expr="SAFE_DIVIDE(sum(amount), count(*))",
            ),
        ],
    )
    errors = validate_measure_duplicates({"fct_orders": source}, dialect="bigquery")
    assert any("safe_ratio_a" in e and "safe_ratio_b" in e for e in errors), (
        f"Duplicate detection missed identical BigQuery-native exprs: {errors}"
    )
