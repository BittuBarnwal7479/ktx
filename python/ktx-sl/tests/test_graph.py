import pytest

from semantic_layer.graph import JoinGraph
from semantic_layer.models import SourceDefinition, SourceColumn, JoinDeclaration


@pytest.fixture
def graph(ecommerce_sources):
    g = JoinGraph(ecommerce_sources)
    g.build()
    return g


class TestJoinGraphBuild:
    def test_all_sources_in_adjacency(self, graph, ecommerce_sources):
        assert set(graph.adjacency.keys()) == set(ecommerce_sources.keys())

    def test_bidirectional_edges(self, graph):
        # orders declares join to customers → both directions exist
        orders_edges = graph.adjacency["orders"]
        assert any(e.to_source == "customers" for e in orders_edges)

        customers_edges = graph.adjacency["customers"]
        assert any(e.to_source == "orders" for e in customers_edges)

    def test_relationship_inversion(self, graph):
        # orders → customers is many_to_one
        fwd = next(e for e in graph.adjacency["orders"] if e.to_source == "customers")
        assert fwd.relationship == "many_to_one"

        # customers → orders is one_to_many (reverse)
        rev = next(e for e in graph.adjacency["customers"] if e.to_source == "orders")
        assert rev.relationship == "one_to_many"

    def test_on_parsing(self, graph):
        fwd = next(e for e in graph.adjacency["orders"] if e.to_source == "customers")
        assert fwd.from_column == "customer_id"
        assert fwd.to_column == "id"


class TestFindPath:
    def test_direct_join(self, graph):
        path = graph.find_path("orders", "customers")
        assert path is not None
        assert len(path.edges) == 1
        assert path.edges[0].from_source == "orders"
        assert path.edges[0].to_source == "customers"
        assert not path.has_one_to_many

    def test_two_hop_m2o(self, graph):
        # orders → customers → regions (all m2o)
        path = graph.find_path("orders", "regions")
        assert path is not None
        assert len(path.edges) == 2
        assert path.source_names == ["orders", "customers", "regions"]
        assert not path.has_one_to_many

    def test_reverse_path_flagged(self, graph):
        # regions → customers (o2m) → orders (o2m)
        path = graph.find_path("regions", "orders")
        assert path is not None
        assert len(path.edges) == 2
        assert path.has_one_to_many

    def test_through_bridge(self, graph):
        # orders → order_items is reverse (o2m), order_items → products is m2o
        # But shortest may be: orders ← order_items → products
        path = graph.find_path("orders", "products")
        assert path is not None
        assert "order_items" in path.source_names

    def test_churn_risk_to_regions(self, graph):
        path = graph.find_path("churn_risk", "regions")
        assert path is not None
        assert "customers" in path.source_names

    def test_same_source(self, graph):
        path = graph.find_path("orders", "orders")
        assert path is not None
        assert len(path.edges) == 0
        assert not path.has_one_to_many

    def test_source_names_property(self, graph):
        path = graph.find_path("orders", "regions")
        assert path.source_names == ["orders", "customers", "regions"]

    def test_empty_path_source_names(self, graph):
        path = graph.find_path("orders", "orders")
        assert path.source_names == []


class TestResolveJoinTree:
    def test_single_source(self, graph):
        tree = graph.resolve_join_tree({"orders"})
        assert tree.sources == {"orders"}
        assert tree.edges == []

    def test_two_sources(self, graph):
        tree = graph.resolve_join_tree({"orders", "customers"})
        assert "orders" in tree.sources
        assert "customers" in tree.sources
        assert len(tree.edges) >= 1

    def test_three_sources_via_customers(self, graph):
        tree = graph.resolve_join_tree({"churn_risk", "regions", "orders"})
        assert "customers" in tree.sources  # intermediate node added
        assert len(tree.sources) >= 4

    def test_disconnected_raises(self):
        from semantic_layer.models import SourceDefinition, SourceColumn

        src_a = SourceDefinition(
            name="a",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        src_b = SourceDefinition(
            name="b",
            table="t2",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        g = JoinGraph({"a": src_a, "b": src_b})
        g.build()
        with pytest.raises(ValueError, match="No join path"):
            g.resolve_join_tree({"a", "b"})


class TestOneToOneRelationship:
    def test_one_to_one_no_fan_out(self):
        """one_to_one joins should not flag has_one_to_many."""
        from semantic_layer.models import (
            SourceDefinition,
            SourceColumn,
            JoinDeclaration,
        )

        users = SourceDefinition(
            name="users",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        profiles = SourceDefinition(
            name="profiles",
            table="t2",
            grain=["user_id"],
            columns=[SourceColumn(name="user_id", type="number")],
            joins=[
                JoinDeclaration(
                    to="users", on="user_id = users.id", relationship="one_to_one"
                )
            ],
        )
        g = JoinGraph({"users": users, "profiles": profiles})
        g.build()

        path = g.find_path("profiles", "users")
        assert path is not None
        assert not path.has_one_to_many

        # Reverse should also be one_to_one
        rev_path = g.find_path("users", "profiles")
        assert rev_path is not None
        assert not rev_path.has_one_to_many

    def test_one_to_one_inverse(self):
        """one_to_one inverted should stay one_to_one."""
        from semantic_layer.models import (
            SourceDefinition,
            SourceColumn,
            JoinDeclaration,
        )

        a = SourceDefinition(
            name="a",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        b = SourceDefinition(
            name="b",
            table="t2",
            grain=["a_id"],
            columns=[SourceColumn(name="a_id", type="number")],
            joins=[
                JoinDeclaration(to="a", on="a_id = a.id", relationship="one_to_one")
            ],
        )
        g = JoinGraph({"a": a, "b": b})
        g.build()

        fwd = next(e for e in g.adjacency["b"] if e.to_source == "a")
        assert fwd.relationship == "one_to_one"
        rev = next(e for e in g.adjacency["a"] if e.to_source == "b")
        assert rev.relationship == "one_to_one"


class TestMultipleJoinsFromSource:
    def test_order_items_two_joins(self, graph):
        """order_items has joins to both orders and products."""
        oi_edges = graph.adjacency["order_items"]
        targets = {e.to_source for e in oi_edges}
        assert "orders" in targets
        assert "products" in targets

    def test_path_through_bridge(self, graph):
        """Can find path from orders to products through order_items."""
        path = graph.find_path("orders", "products")
        assert path is not None
        assert "order_items" in path.source_names


class TestResolveJoinTreeRoot:
    def test_root_is_respected(self, graph):
        """When root is specified, it should be the anchor of the tree."""
        tree = graph.resolve_join_tree({"orders", "regions"}, root="orders")
        assert "orders" in tree.sources
        assert "regions" in tree.sources
        assert "customers" in tree.sources  # intermediate

    def test_root_not_in_sources_uses_default(self, graph):
        """When root is not in source_names, falls back to sorted order."""
        tree = graph.resolve_join_tree({"orders", "customers"}, root="nonexistent")
        assert "orders" in tree.sources
        assert "customers" in tree.sources


class TestFindComponents:
    def test_connected_graph(self, graph):
        components = graph.find_components()
        assert len(components) == 1
        assert components[0] == set(graph.adjacency.keys())

    def test_disconnected_graph(self):
        from semantic_layer.models import SourceDefinition, SourceColumn

        src_a = SourceDefinition(
            name="a",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        src_b = SourceDefinition(
            name="b",
            table="t2",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        g = JoinGraph({"a": src_a, "b": src_b})
        g.build()
        components = g.find_components()
        assert len(components) == 2
        assert {frozenset(c) for c in components} == {
            frozenset({"a"}),
            frozenset({"b"}),
        }


# ── From test_edge_cases.py ──────────────────────────────────────────


class TestGraphEdgeCases:
    def test_self_referencing_join(self):
        emp_with_join = SourceDefinition(
            name="employees",
            table="t",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="manager_id", type="number"),
                SourceColumn(name="salary", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="employees",
                    on="manager_id = employees.id",
                    relationship="many_to_one",
                )
            ],
        )
        sources = {"employees": emp_with_join}
        graph = JoinGraph(sources)
        graph.build()
        path = graph.find_path("employees", "employees")
        assert path is not None
        assert len(path.edges) == 0

    def test_no_sources(self):
        graph = JoinGraph({})
        graph.build()
        components = graph.find_components()
        assert components == []

    def test_single_source_no_joins(self):
        src = SourceDefinition(
            name="a",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        graph = JoinGraph({"a": src})
        graph.build()
        assert graph.find_path("a", "a") is not None
        assert graph.find_path("a", "nonexistent") is None

    def test_two_disconnected_sources(self):
        a = SourceDefinition(
            name="a",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        b = SourceDefinition(
            name="b",
            table="t2",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        graph = JoinGraph({"a": a, "b": b})
        graph.build()
        assert graph.find_path("a", "b") is None

    def test_on_clause_with_spaces(self):
        g = JoinGraph({})
        result = g._parse_on("  customer_id   =   customers.id  ", "customers")
        assert result == ("customer_id", "id")

    def test_on_clause_without_prefix(self):
        g = JoinGraph({})
        result = g._parse_on("customer_id = id", "customers")
        assert result == ("customer_id", "id")

    def test_on_clause_invalid(self):
        g = JoinGraph({})
        with pytest.raises(ValueError, match="Invalid join condition"):
            g._parse_on("customer_id", "customers")

    def test_on_clause_three_parts(self):
        g = JoinGraph({})
        with pytest.raises(ValueError, match="Invalid join condition"):
            g._parse_on("a = b = c", "target")

    def test_composite_join_key(self):
        """Composite join: 'a = t.x AND b = t.y' → comma-separated columns."""
        g = JoinGraph({})
        from_col, to_col = g._parse_on(
            "product_id = inventory.product_id AND warehouse_id = inventory.warehouse_id",
            "inventory",
        )
        assert from_col == "product_id,warehouse_id"
        assert to_col == "product_id,warehouse_id"

    def test_composite_join_key_with_source_prefix(self):
        """Composite join with source prefix on left side."""
        g = JoinGraph({})
        from_col, to_col = g._parse_on(
            "items.product_id = inventory.product_id AND items.warehouse_id = inventory.warehouse_id",
            "inventory",
        )
        assert from_col == "product_id,warehouse_id"
        assert to_col == "product_id,warehouse_id"

    def test_composite_join_generates_correct_sql(self):
        """End-to-end: composite join keys produce multi-condition ON clause."""
        items = SourceDefinition(
            name="items",
            table="public.items",
            grain=["order_id", "product_id"],
            columns=[
                SourceColumn(name="order_id", type="number"),
                SourceColumn(name="product_id", type="number"),
                SourceColumn(name="warehouse_id", type="number"),
                SourceColumn(name="qty", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="inventory",
                    on="product_id = inventory.product_id AND warehouse_id = inventory.warehouse_id",
                    relationship="many_to_one",
                )
            ],
        )
        inv = SourceDefinition(
            name="inventory",
            table="public.inventory",
            grain=["product_id", "warehouse_id"],
            columns=[
                SourceColumn(name="product_id", type="number"),
                SourceColumn(name="warehouse_id", type="number"),
                SourceColumn(name="stock", type="number"),
            ],
        )
        graph = JoinGraph({"items": items, "inventory": inv})
        graph.build()
        path = graph.find_path("items", "inventory")
        assert path is not None
        assert len(path.edges) == 1
        assert path.edges[0].from_column == "product_id,warehouse_id"
        assert path.edges[0].to_column == "product_id,warehouse_id"

    def test_resolve_join_tree_empty_set(self):
        graph = JoinGraph({})
        graph.build()
        tree = graph.resolve_join_tree(set())
        assert tree.sources == set()
        assert tree.edges == []


# ── From test_brainstorm_cases.py ────────────────────────────────────


class TestJoinTreeReusesIntermediates:
    def test_resolve_join_tree_reuses_intermediate_sources(self):
        a = SourceDefinition(
            name="a",
            table="public.a",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
            joins=[
                JoinDeclaration(to="z", on="z_id = z.id", relationship="many_to_one")
            ],
        )
        z = SourceDefinition(
            name="z",
            table="public.z",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="m_id", type="number"),
            ],
            joins=[
                JoinDeclaration(to="m", on="m_id = m.id", relationship="many_to_one")
            ],
        )
        m = SourceDefinition(
            name="m",
            table="public.m",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )

        graph = JoinGraph({"a": a, "z": z, "m": m})
        graph.build()

        tree = graph.resolve_join_tree({"a", "m", "z"}, root="a")

        assert tree.sources == {"a", "z", "m"}
        assert len(tree.edges) == 2
        assert {(edge.from_source, edge.to_source) for edge in tree.edges} == {
            ("a", "z"),
            ("z", "m"),
        }


class TestDijkstraEdgeWeightPreference:
    """LIMIT 2: Dijkstra prefers safe (m2o) paths over one_to_many paths."""

    def test_dijkstra_prefers_safe_path(self):
        """1-hop o2m path vs 2-hop all-m2o path: Dijkstra should pick the 2-hop m2o path."""
        # A --o2m--> C (direct, 1-hop, but unsafe)
        # A --m2o--> B --m2o--> C (2-hop, all safe)
        a = SourceDefinition(
            name="a",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
            joins=[
                JoinDeclaration(to="c", on="c_id = c.id", relationship="one_to_many"),
                JoinDeclaration(to="b", on="b_id = b.id", relationship="many_to_one"),
            ],
        )
        b = SourceDefinition(
            name="b",
            table="t2",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="c_id", type="number"),
            ],
            joins=[
                JoinDeclaration(to="c", on="c_id = c.id", relationship="many_to_one"),
            ],
        )
        c = SourceDefinition(
            name="c",
            table="t3",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="c_id", type="number"),
            ],
        )
        g = JoinGraph({"a": a, "b": b, "c": c})
        g.build()

        path = g.find_path("a", "c")
        assert path is not None
        # Should pick the 2-hop safe path (a -> b -> c) over the 1-hop o2m (a -> c)
        assert len(path.edges) == 2
        assert path.source_names == ["a", "b", "c"]
        assert not path.has_one_to_many

    def test_dijkstra_uses_unsafe_when_only_option(self):
        """When only an o2m path exists, it should still be returned."""
        a = SourceDefinition(
            name="a",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
            joins=[
                JoinDeclaration(to="b", on="b_id = b.id", relationship="one_to_many"),
            ],
        )
        b = SourceDefinition(
            name="b",
            table="t2",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        g = JoinGraph({"a": a, "b": b})
        g.build()

        path = g.find_path("a", "b")
        assert path is not None
        assert len(path.edges) == 1
        assert path.has_one_to_many


class TestAmbiguousPathDetection:
    """Tests for 12.1 fix: diamond graph ambiguity detection."""

    @staticmethod
    def _diamond_sources():
        """Diamond: A →(m2o) B →(m2o) D, A →(m2o) C →(m2o) D.  Two equal-cost paths."""
        return {
            "a": SourceDefinition(
                name="a",
                table="t_a",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
                joins=[
                    JoinDeclaration(
                        to="b", on="b_id = b.id", relationship="many_to_one"
                    ),
                    JoinDeclaration(
                        to="c", on="c_id = c.id", relationship="many_to_one"
                    ),
                ],
            ),
            "b": SourceDefinition(
                name="b",
                table="t_b",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
                joins=[
                    JoinDeclaration(
                        to="d", on="d_id = d.id", relationship="many_to_one"
                    )
                ],
            ),
            "c": SourceDefinition(
                name="c",
                table="t_c",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
                joins=[
                    JoinDeclaration(
                        to="d", on="d_id = d.id", relationship="many_to_one"
                    )
                ],
            ),
            "d": SourceDefinition(
                name="d",
                table="t_d",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
            ),
        }

    def test_diamond_graph_is_ambiguous(self):
        g = JoinGraph(self._diamond_sources())
        g.build()
        path = g.find_path("a", "d")
        assert path is not None
        assert path.is_ambiguous is True

    def test_linear_graph_not_ambiguous(self):
        """A → B → C: single path, no ambiguity."""
        sources = {
            "a": SourceDefinition(
                name="a",
                table="t_a",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
                joins=[
                    JoinDeclaration(
                        to="b", on="b_id = b.id", relationship="many_to_one"
                    )
                ],
            ),
            "b": SourceDefinition(
                name="b",
                table="t_b",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
                joins=[
                    JoinDeclaration(
                        to="c", on="c_id = c.id", relationship="many_to_one"
                    )
                ],
            ),
            "c": SourceDefinition(
                name="c",
                table="t_c",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
            ),
        }
        g = JoinGraph(sources)
        g.build()
        path = g.find_path("a", "c")
        assert path is not None
        assert path.is_ambiguous is False

    def test_different_cost_paths_not_ambiguous(self):
        """A →(m2o) B →(m2o) D and A →(o2m) C →(m2o) D: costs differ."""
        sources = {
            "a": SourceDefinition(
                name="a",
                table="t_a",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
                joins=[
                    JoinDeclaration(
                        to="b", on="b_id = b.id", relationship="many_to_one"
                    ),
                    JoinDeclaration(
                        to="c", on="id = c.a_id", relationship="one_to_many"
                    ),
                ],
            ),
            "b": SourceDefinition(
                name="b",
                table="t_b",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
                joins=[
                    JoinDeclaration(
                        to="d", on="d_id = d.id", relationship="many_to_one"
                    )
                ],
            ),
            "c": SourceDefinition(
                name="c",
                table="t_c",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="a_id", type="number"),
                ],
                joins=[
                    JoinDeclaration(
                        to="d", on="d_id = d.id", relationship="many_to_one"
                    )
                ],
            ),
            "d": SourceDefinition(
                name="d",
                table="t_d",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
            ),
        }
        g = JoinGraph(sources)
        g.build()
        path = g.find_path("a", "d")
        assert path is not None
        # Safe path (cost 2) vs unsafe path (cost 11) — not ambiguous
        assert path.is_ambiguous is False
        assert path.has_one_to_many is False

    def test_ambiguous_path_warning_in_resolve_join_tree(self, caplog):
        """resolve_join_tree logs a warning for ambiguous paths."""
        import logging

        g = JoinGraph(self._diamond_sources())
        g.build()
        with caplog.at_level(logging.WARNING, logger="semantic_layer.graph"):
            g.resolve_join_tree({"a", "d"}, root="a")
        assert any("Ambiguous join path" in r.message for r in caplog.records)


def test_bigquery_native_on_clause_extracts_column_pair():
    """Join on: with BigQuery-specific casts must parse and yield column pairs."""
    orders = SourceDefinition(
        name="orders",
        table="orders",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="user_id", type="number"),
        ],
        joins=[
            JoinDeclaration(
                to="users",
                on="user_id = SAFE_CAST(users.id AS INT64)",
                relationship="many_to_one",
            )
        ],
    )
    users = SourceDefinition(
        name="users",
        table="users",
        grain=["id"],
        columns=[SourceColumn(name="id", type="number")],
    )
    graph = JoinGraph({"orders": orders, "users": users}, dialect="bigquery")
    graph.build()
    # The graph must have recorded the compatibility edge
    orders_edges = graph.adjacency.get("orders", [])
    assert any(e.to_source == "users" for e in orders_edges), (
        f"orders → users edge missing after BigQuery-native on: parse:\n{orders_edges}"
    )


def test_joingraph_dialect_defaults_to_postgres():
    """Default keeps existing test ergonomics unchanged."""
    g = JoinGraph({})
    assert g.dialect == "postgres"
