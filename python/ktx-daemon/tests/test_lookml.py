from __future__ import annotations

from ktx_daemon.lookml import (
    LookMLFileInput,
    ParseLookMLRequest,
    parse_lookml_project,
)


ORDER_VIEW = """
view: orders {
  sql_table_name: public.orders ;;

  dimension: id {
    primary_key: yes
    type: number
    sql: ${TABLE}.id ;;
  }

  dimension: user_id {
    type: number
    sql: ${TABLE}.user_id ;;
  }

  dimension: status {
    type: string
    sql: ${TABLE}.status ;;
  }

  measure: order_count {
    type: count
  }

  measure: revenue {
    type: sum
    sql: ${TABLE}.amount ;;
  }
}
"""


USER_VIEW = """
view: users {
  sql_table_name: public.users ;;

  dimension: id {
    primary_key: yes
    type: number
    sql: ${TABLE}.id ;;
  }
}
"""


ORDER_MODEL = """
explore: orders {
  join: users {
    relationship: many_to_one
    sql_on: ${orders.user_id} = ${users.id} ;;
  }
}
"""


DERIVED_VIEW = """
view: order_rollup {
  derived_table: {
    sql:
      SELECT status, SUM(amount) AS total_amount
      FROM public.orders
      GROUP BY status ;;
  }

  dimension: status {
    type: string
    sql: ${TABLE}.status ;;
  }
}
"""


def test_parse_lookml_project_returns_views_and_joins() -> None:
    response = parse_lookml_project(
        ParseLookMLRequest(
            files=[
                LookMLFileInput(path="views/orders.view.lkml", content=ORDER_VIEW),
                LookMLFileInput(path="views/users.view.lkml", content=USER_VIEW),
                LookMLFileInput(
                    path="models/ecommerce.model.lkml", content=ORDER_MODEL
                ),
            ],
            dialect="postgres",
        )
    )

    views = {view.name: view for view in response.views}
    assert sorted(views) == ["orders", "users"]
    assert views["orders"].source_type == "table"
    assert views["orders"].table_ref == "public.orders"
    assert views["orders"].grain == ["id"]
    assert [measure.name for measure in views["orders"].measures] == [
        "order_count",
        "revenue",
    ]
    assert views["orders"].measures[0].expr == "count(*)"
    assert views["orders"].measures[1].expr == "sum(amount)"
    assert response.joins[0].source_view == "orders"
    assert response.joins[0].to == "users"
    assert response.joins[0].relationship == "many_to_one"
    assert response.joins[0].on == "orders.user_id = users.id"
    assert response.skipped_views == []
    assert response.warnings == []


def test_parse_lookml_project_extracts_derived_table_columns() -> None:
    response = parse_lookml_project(
        ParseLookMLRequest(
            files=[
                LookMLFileInput(
                    path="views/order_rollup.view.lkml", content=DERIVED_VIEW
                )
            ],
            dialect="postgres",
        )
    )

    assert len(response.views) == 1
    view = response.views[0]
    assert view.name == "order_rollup"
    assert view.source_type == "sql"
    assert "SELECT status, SUM(amount) AS total_amount" in (view.sql or "")
    assert [column.name for column in view.columns] == ["status", "total_amount"]
    assert response.skipped_views == []
    assert response.warnings == []
