from __future__ import annotations

from ktx_daemon.source_generation import (
    ColumnInput,
    GenerateSourcesRequest,
    LinkInput,
    TableInput,
    generate_sources,
    generate_sources_response,
)


def test_generate_sources_maps_tables_columns_measures_and_joins() -> None:
    response = generate_sources_response(
        GenerateSourcesRequest(
            tables=[
                TableInput(
                    name="orders",
                    db="public",
                    comment="Orders table",
                    columns=[
                        ColumnInput(
                            name="id",
                            type="integer",
                            primary_key=True,
                            nullable=False,
                            comment="Order ID",
                        ),
                        ColumnInput(name="customer_id", type="integer"),
                        ColumnInput(
                            name="amount", type="decimal", comment="Order amount"
                        ),
                        ColumnInput(name="created_at", type="timestamp"),
                        ColumnInput(name="status", type="varchar"),
                    ],
                ),
                TableInput(
                    name="customers",
                    db="public",
                    columns=[
                        ColumnInput(name="id", type="integer", primary_key=True),
                        ColumnInput(name="email", type="varchar"),
                    ],
                ),
            ],
            links=[
                LinkInput(
                    from_table="orders",
                    from_column="customer_id",
                    to_table="customers",
                    to_column="id",
                    relationship_type="MANY_TO_ONE",
                )
            ],
        )
    )

    assert response.source_count == 2
    sources = {source["name"]: source for source in response.sources}
    assert sources["orders"]["description"] == "Orders table"
    assert sources["orders"]["table"] == "public.orders"
    assert sources["orders"]["grain"] == ["id"]
    assert sources["orders"]["columns"] == [
        {
            "name": "id",
            "type": "number",
            "visibility": "public",
            "role": "default",
            "description": "Order ID",
        },
        {
            "name": "customer_id",
            "type": "number",
            "visibility": "public",
            "role": "default",
        },
        {
            "name": "amount",
            "type": "number",
            "visibility": "public",
            "role": "default",
            "description": "Order amount",
        },
        {"name": "created_at", "type": "time", "visibility": "public", "role": "time"},
        {"name": "status", "type": "string", "visibility": "public", "role": "default"},
    ]
    assert sources["orders"]["joins"] == [
        {
            "to": "customers",
            "on": "customer_id = customers.id",
            "relationship": "many_to_one",
        }
    ]
    assert [measure["name"] for measure in sources["orders"]["measures"]] == [
        "record_count",
        "total_amount",
        "avg_amount",
    ]
    assert sources["orders"]["measures"][0]["expr"] == "count(id)"
    assert sources["orders"]["measures"][1]["expr"] == "sum(amount)"
    assert sources["orders"]["measures"][2]["expr"] == "avg(amount)"
    assert sources["customers"]["joins"] == [
        {
            "to": "orders",
            "on": "id = orders.customer_id",
            "relationship": "one_to_many",
        }
    ]


def test_generate_sources_aliases_multiple_joins_to_same_table() -> None:
    sources = generate_sources(
        GenerateSourcesRequest(
            tables=[
                TableInput(
                    name="orders",
                    columns=[
                        ColumnInput(name="id", type="integer", primary_key=True),
                        ColumnInput(name="buyer_id", type="integer"),
                        ColumnInput(name="seller_id", type="integer"),
                    ],
                ),
                TableInput(
                    name="users",
                    columns=[ColumnInput(name="id", type="integer", primary_key=True)],
                ),
            ],
            links=[
                LinkInput(
                    from_table="orders",
                    from_column="buyer_id",
                    to_table="users",
                    to_column="id",
                    relationship_type="many_to_one",
                ),
                LinkInput(
                    from_table="orders",
                    from_column="seller_id",
                    to_table="users",
                    to_column="id",
                    relationship_type="many_to_one",
                ),
            ],
        )
    )

    orders = next(source for source in sources if source["name"] == "orders")
    assert orders["joins"] == [
        {
            "to": "users",
            "on": "buyer_id = users.id",
            "relationship": "many_to_one",
            "alias": "users_buyer_id",
        },
        {
            "to": "users",
            "on": "seller_id = users.id",
            "relationship": "many_to_one",
            "alias": "users_seller_id",
        },
    ]
