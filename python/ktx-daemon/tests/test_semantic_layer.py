from __future__ import annotations

from ktx_daemon.semantic_layer import (
    SemanticLayerQueryRequest,
    ValidateSourcesRequest,
    query_semantic_layer,
    validate_semantic_layer,
)


ORDERS_SOURCE = {
    "name": "orders",
    "table": "public.orders",
    "grain": ["id"],
    "columns": [
        {"name": "id", "type": "number"},
        {"name": "status", "type": "string"},
        {"name": "amount", "type": "number"},
    ],
    "joins": [],
    "measures": [
        {"name": "order_count", "expr": "count(*)"},
        {"name": "revenue", "expr": "sum(amount)"},
    ],
}


def test_query_semantic_layer_generates_sql_and_plan() -> None:
    response = query_semantic_layer(
        SemanticLayerQueryRequest(
            sources=[ORDERS_SOURCE],
            dialect="postgres",
            query={
                "measures": ["orders.order_count"],
                "dimensions": ["orders.status"],
                "limit": 25,
            },
        )
    )

    assert response.dialect == "postgres"
    assert "public.orders" in response.sql
    assert "orders.status" in response.sql
    assert response.columns[0]["name"] == "orders.status"
    assert response.columns[1]["name"] == "orders.order_count"
    assert response.plan["sources_used"] == ["orders"]


def test_validate_semantic_layer_reports_duplicate_measure_names() -> None:
    invalid_source = {
        **ORDERS_SOURCE,
        "measures": [
            {"name": "revenue", "expr": "sum(amount)"},
            {"name": "revenue", "expr": "sum(amount)"},
        ],
    }

    response = validate_semantic_layer(
        ValidateSourcesRequest(sources=[invalid_source], dialect="postgres")
    )

    assert response.valid is False
    assert any("Duplicate measure" in error for error in response.errors)
    assert response.warnings == []
