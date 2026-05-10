from __future__ import annotations

from semantic_layer.engine import SemanticEngine
from semantic_layer.models import (
    JoinDeclaration,
    SourceColumn,
    SourceDefinition,
)
from semantic_layer.sql_table_extractor import (
    extract_table_refs,
    normalize_table,
    ref_matches_source_table,
)


def _table_src(
    name: str, table: str, columns: list[str] | None = None
) -> SourceDefinition:
    cols = columns or ["id"]
    return SourceDefinition(
        name=name,
        table=table,
        grain=["id"],
        columns=[SourceColumn(name=c, type="number") for c in cols],
    )


def _sql_src(
    name: str,
    sql: str,
    columns: list[str] | None = None,
    joins: list[JoinDeclaration] | None = None,
) -> SourceDefinition:
    cols = columns or ["id"]
    return SourceDefinition(
        name=name,
        sql=sql,
        grain=["id"],
        columns=[SourceColumn(name=c, type="number") for c in cols],
        joins=joins or [],
    )


class TestExtractTableRefs:
    def test_simple_select(self):
        refs = extract_table_refs("select id from analytics.marts.listings")
        assert refs == [("analytics", "marts", "listings")]

    def test_join_clause(self):
        sql = """
        select l.id from analytics.marts.listings l
        join analytics.marts.accounts a on l.account_id = a.id
        """
        assert extract_table_refs(sql) == [
            ("analytics", "marts", "listings"),
            ("analytics", "marts", "accounts"),
        ]

    def test_cte_alias_skipped(self):
        sql = """
        with d as (select id from staging.shipments)
        select * from d join staging.items_shipments i on d.id = i.shipment_id
        """
        # `d` is a CTE — must not appear. `staging.shipments` and
        # `staging.items_shipments` both should.
        refs = extract_table_refs(sql)
        assert ("staging", "shipments") in refs
        assert ("staging", "items_shipments") in refs
        assert all(ref != ("d",) for ref in refs)

    def test_dedup(self):
        sql = """
        select * from analytics.marts.listings l1
        join analytics.marts.listings l2 on l1.id = l2.id
        """
        assert extract_table_refs(sql) == [("analytics", "marts", "listings")]

    def test_unparseable_returns_empty(self):
        assert extract_table_refs("not valid sql !!!") == []


class TestRefMatching:
    def test_normalize_strips_quotes_and_lowercases(self):
        assert normalize_table('"ANALYTICS"."MARTS"."LISTINGS"') == (
            "analytics",
            "marts",
            "listings",
        )

    def test_full_match(self):
        assert ref_matches_source_table(
            ("analytics", "marts", "listings"), "ANALYTICS.MARTS.LISTINGS"
        )

    def test_two_part_suffix_matches_three_part_table(self):
        assert ref_matches_source_table(
            ("marts", "listings"), "ANALYTICS.MARTS.LISTINGS"
        )

    def test_bare_name_matches_three_part_table(self):
        assert ref_matches_source_table(("listings",), "ANALYTICS.MARTS.LISTINGS")

    def test_db_mismatch_blocks_match(self):
        assert not ref_matches_source_table(
            ("staging", "listings"), "ANALYTICS.MARTS.LISTINGS"
        )

    def test_longer_ref_does_not_match_shorter_table(self):
        assert not ref_matches_source_table(
            ("analytics", "marts", "listings"), "marts.listings"
        )


class TestSqlJoinCoverage:
    def _build_engine(
        self,
        listings_table: str = "ANALYTICS.MARTS.LISTINGS",
        accounts_table: str = "ANALYTICS.MARTS.ACCOUNTS",
        new_source_sql: str | None = None,
        new_source_joins: list[JoinDeclaration] | None = None,
    ) -> SemanticEngine:
        listings = _table_src("LISTINGS", listings_table)
        accounts = _table_src("ACCOUNTS", accounts_table)
        sources = {"LISTINGS": listings, "ACCOUNTS": accounts}
        if new_source_sql is not None:
            sources["my_source"] = _sql_src(
                "my_source",
                sql=new_source_sql,
                joins=new_source_joins,
            )
        return SemanticEngine.from_sources(sources)

    def test_coverage_gap_emitted_as_error(self):
        sql = """
        select l.id, a.name
        from ANALYTICS.MARTS.LISTINGS l
        join ANALYTICS.MARTS.ACCOUNTS a on l.account_id = a.id
        """
        engine = self._build_engine(new_source_sql=sql, new_source_joins=[])

        report = engine.validate(recently_touched={"my_source"})

        assert not report.valid
        coverage_errors = [e for e in report.errors if "my_source" in e]
        assert any("LISTINGS" in e and "ACCOUNTS" in e for e in coverage_errors), (
            f"Expected coverage error mentioning LISTINGS and ACCOUNTS, got: {report.errors}"
        )

    def test_declared_join_satisfies_coverage(self):
        sql = """
        select l.id, a.name
        from ANALYTICS.MARTS.LISTINGS l
        join ANALYTICS.MARTS.ACCOUNTS a on l.account_id = a.id
        """
        joins = [
            JoinDeclaration(
                to="LISTINGS",
                on="my_source.listing_id = LISTINGS.id",
                relationship="many_to_one",
            ),
            JoinDeclaration(
                to="ACCOUNTS",
                on="my_source.account_id = ACCOUNTS.id",
                relationship="many_to_one",
            ),
        ]
        engine = self._build_engine(new_source_sql=sql, new_source_joins=joins)

        report = engine.validate(recently_touched={"my_source"})

        coverage_errors = [
            e for e in report.errors if "my_source" in e and "joins[]" in e
        ]
        assert coverage_errors == []

    def test_partial_coverage_lists_only_missing(self):
        sql = """
        select l.id, a.name
        from ANALYTICS.MARTS.LISTINGS l
        join ANALYTICS.MARTS.ACCOUNTS a on l.account_id = a.id
        """
        joins = [
            JoinDeclaration(
                to="LISTINGS",
                on="my_source.listing_id = LISTINGS.id",
                relationship="many_to_one",
            ),
        ]
        engine = self._build_engine(new_source_sql=sql, new_source_joins=joins)

        report = engine.validate(recently_touched={"my_source"})

        coverage_errors = [
            e for e in report.errors if "my_source" in e and "ACCOUNTS" in e
        ]
        assert coverage_errors, f"Expected ACCOUNTS gap, got: {report.errors}"
        assert all("LISTINGS]" not in e for e in coverage_errors), (
            f"LISTINGS should be satisfied: {report.errors}"
        )

    def test_unmapped_table_does_not_trigger_coverage_error(self):
        # SQL references staging.foo which has no manifest entry — the
        # check is silent. (The agent is still expected to write a wiki
        # note, but that's outside the validator's scope.)
        sql = "select id from staging.foo"
        engine = self._build_engine(new_source_sql=sql)

        report = engine.validate(recently_touched={"my_source"})

        assert not any("my_source" in e and "joins[]" in e for e in report.errors), (
            f"Unmapped table must not be flagged: {report.errors}"
        )

    def test_quoted_identifiers_match(self):
        sql = (
            'select * from "ANALYTICS"."MARTS"."LISTINGS" l '
            'join "ANALYTICS"."MARTS"."ACCOUNTS" a on l.account_id = a.id'
        )
        engine = self._build_engine(new_source_sql=sql, new_source_joins=[])

        report = engine.validate(recently_touched={"my_source"})

        assert any(
            "my_source" in e and "LISTINGS" in e and "ACCOUNTS" in e
            for e in report.errors
        ), f"Quoted identifiers should match: {report.errors}"

    def test_cte_self_reference_not_flagged(self):
        sql = """
        with d as (select id from ANALYTICS.MARTS.LISTINGS)
        select * from d
        """
        # LISTINGS is referenced inside the CTE — that still counts and
        # must be flagged (the manifest entry exists). `d` itself must
        # NOT be flagged as missing.
        engine = self._build_engine(new_source_sql=sql, new_source_joins=[])

        report = engine.validate(recently_touched={"my_source"})

        coverage_errors = [e for e in report.errors if "my_source" in e]
        assert any("LISTINGS" in e for e in coverage_errors)
        assert not any("'d'" in e or " d " in e for e in coverage_errors), (
            f"CTE alias 'd' must not be flagged: {coverage_errors}"
        )

    def test_two_part_suffix_match(self):
        # Source's SQL references `MARTS.LISTINGS` (2-part) — should match
        # the 3-part manifest entry `ANALYTICS.MARTS.LISTINGS`.
        sql = "select id from MARTS.LISTINGS"
        engine = self._build_engine(new_source_sql=sql, new_source_joins=[])

        report = engine.validate(recently_touched={"my_source"})

        assert any("my_source" in e and "LISTINGS" in e for e in report.errors), (
            f"Two-part suffix should match: {report.errors}"
        )

    def test_not_recently_touched_means_no_check(self):
        # Same buggy SQL as above, but the source isn't in
        # `recently_touched` — coverage check skipped.
        sql = """
        select l.id from ANALYTICS.MARTS.LISTINGS l
        join ANALYTICS.MARTS.ACCOUNTS a on l.account_id = a.id
        """
        engine = self._build_engine(new_source_sql=sql, new_source_joins=[])

        report = engine.validate(recently_touched=None)

        coverage_errors = [
            e for e in report.errors if "my_source" in e and "joins[]" in e
        ]
        assert coverage_errors == []

    def test_table_only_source_skipped(self):
        # A source with `table:` (no SQL) cannot be coverage-checked.
        listings = _table_src("LISTINGS", "ANALYTICS.MARTS.LISTINGS")
        bare = _table_src("bare", "public.bare", columns=["id"])
        engine = SemanticEngine.from_sources({"LISTINGS": listings, "bare": bare})

        report = engine.validate(recently_touched={"bare"})

        assert not any("bare" in e and "joins[]" in e for e in report.errors), (
            f"Table-only source must not be flagged: {report.errors}"
        )

    def test_self_reference_not_flagged(self):
        # If `my_source` somehow names its own table in the manifest, we
        # shouldn't flag itself.
        my_source = _sql_src("my_source", sql="select id from public.my_source")
        # Not realistic for SQL sources, but make sure self-refs are
        # filtered defensively.
        engine = SemanticEngine.from_sources({"my_source": my_source})

        report = engine.validate(recently_touched={"my_source"})

        assert not any("my_source" in e and "joins[]" in e for e in report.errors)
