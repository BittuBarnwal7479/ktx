from __future__ import annotations

from semantic_layer.generator import SqlGenerator
from semantic_layer.graph import JoinGraph
from semantic_layer.loader import SourceLoader
from semantic_layer.models import (
    QueryResult,
    ResolvedPlan,
    SemanticQuery,
    SourceDefinition,
    ValidationReport,
)
from semantic_layer.planner import QueryPlanner
from semantic_layer.sql_table_extractor import (
    extract_table_refs,
    ref_matches_source_table,
)


class SemanticEngine:
    def __init__(self, sources_dir: str, dialect: str = "postgres"):
        self.loader = SourceLoader(sources_dir)
        self.sources = self.loader.load_all()
        self._init_engine(dialect)

    @classmethod
    def from_sources(
        cls, sources: dict[str, SourceDefinition], dialect: str = "postgres"
    ) -> SemanticEngine:
        """Create engine from pre-loaded source definitions."""
        obj = object.__new__(cls)
        obj.loader = None
        obj.sources = sources
        obj._init_engine(dialect)
        return obj

    def _init_engine(self, dialect: str) -> None:
        # Validate the dialect up-front with the user-facing "Unknown SQL
        # dialect" error, before JoinGraph.build() hits sqlglot's parser.
        SqlGenerator(dialect)
        self.graph = JoinGraph(self.sources, dialect=dialect)
        self.graph.build()
        self.planner = QueryPlanner(self.sources, self.graph, dialect=dialect)
        self.generator = SqlGenerator(dialect, alias_map=self.graph.alias_map)

    def query(self, query: dict | SemanticQuery) -> QueryResult:
        if isinstance(query, dict):
            query = SemanticQuery(**query)
        orphan_errors = self._collect_orphan_join_target_errors()
        if orphan_errors:
            raise ValueError("Cannot query semantic layer: " + "; ".join(orphan_errors))
        plan = self.planner.plan(query)
        sql = self.generator.generate(plan, self.sources)
        return QueryResult(
            resolved_plan=plan,
            sql=sql,
            dialect=self.generator.dialect,
            columns=plan.columns,
        )

    def validate(self, recently_touched: set[str] | None = None) -> ValidationReport:
        report = ValidationReport()
        self._check_orphan_join_targets(report)
        self._check_invalid_grain(report)
        self._check_sql_join_coverage(report, recently_touched=recently_touched)
        self._check_disconnected_components(report, recently_touched=recently_touched)
        return report

    def _collect_orphan_join_target_errors(self) -> list[str]:
        known = set(self.sources.keys())
        errors: list[str] = []
        for source in self.sources.values():
            for join in source.joins:
                if join.to not in known:
                    errors.append(
                        f"Source '{source.name}' joins to '{join.to}', "
                        f"but '{join.to}' is not defined"
                    )
        return errors

    def _check_orphan_join_targets(self, report: ValidationReport) -> None:
        report.errors.extend(self._collect_orphan_join_target_errors())

    def _check_invalid_grain(self, report: ValidationReport) -> None:
        for source in self.sources.values():
            column_names = {c.name for c in source.columns}
            for grain_col in source.grain:
                if grain_col not in column_names:
                    report.errors.append(
                        f"Source '{source.name}' has grain column '{grain_col}' "
                        f"that is not in its columns list"
                    )

    def _check_sql_join_coverage(
        self,
        report: ValidationReport,
        recently_touched: set[str] | None = None,
    ) -> None:
        """Block writes whose SQL references a known source's base table
        without declaring a join to that source.

        Scoped to `recently_touched` so existing fragmentation isn't flagged
        on every write. Only sources with `sql:` are checked. CTE
        self-references are filtered by the extractor.
        """
        if not recently_touched:
            return

        table_index: list[tuple[SourceDefinition, str]] = [
            (src, src.table) for src in self.sources.values() if src.table is not None
        ]
        if not table_index:
            return

        dialect = getattr(self.generator, "dialect", "postgres")

        for source_name in sorted(recently_touched):
            source = self.sources.get(source_name)
            if source is None or not source.is_sql_source or not source.sql:
                continue

            declared = {j.to.lower() for j in source.joins}
            refs = extract_table_refs(source.sql, dialect=dialect)

            missing: list[str] = []
            for ref in refs:
                hit_name: str | None = None
                for candidate, table_value in table_index:
                    if candidate.name == source.name:
                        continue
                    if ref_matches_source_table(ref, table_value):
                        hit_name = candidate.name
                        break
                if hit_name is None:
                    continue
                if hit_name.lower() in declared:
                    continue
                if hit_name not in missing:
                    missing.append(hit_name)

            if not missing:
                continue

            ref_list = ", ".join(missing)
            example = missing[0]
            grain_col = (
                self.sources[example].grain[0] if self.sources[example].grain else "id"
            )
            msg = (
                f"Source '{source.name}' SQL joins manifest table(s) [{ref_list}] "
                f"that are not declared in joins[]. Add a join entry for each, "
                f"e.g. {{to: {example}, on: '{source.name}.<your_fk> = "
                f"{example}.{grain_col}', relationship: many_to_one}}. If a "
                f"reference is intentionally absent, document it with a "
                f"`unmapped-table-*` wiki note and remove the SQL reference."
            )
            report.errors.append(msg)

    def _check_disconnected_components(
        self,
        report: ValidationReport,
        recently_touched: set[str] | None = None,
    ) -> None:
        components = self.graph.find_components()
        if len(components) <= 1:
            return

        sorted_components = sorted(
            components, key=lambda c: (-len(c), sorted(c)[0] if c else "")
        )
        lines = [
            f"Model has {len(components)} disconnected components. "
            f"Queries that span components will fail with 'No join path' errors:"
        ]
        for i, component in enumerate(sorted_components, start=1):
            names = sorted(component)
            if len(names) > 3:
                sample = ", ".join(names[:2])
                lines.append(
                    f"  - Component {i} ({len(names)} sources): {sample}, ... (+{len(names) - 2} more)"
                )
            else:
                lines.append(
                    f"  - Component {i} ({len(names)} sources): {', '.join(names)}"
                )
        report.warnings.append("\n".join(lines))

        if recently_touched:
            singleton_components = {next(iter(c)) for c in components if len(c) == 1}
            for source_name in sorted(recently_touched & singleton_components):
                report.per_source_warnings.setdefault(source_name, []).append(
                    f"Source '{source_name}' is now a singleton component (no joins to any "
                    f"other source). Queries that combine '{source_name}' with anything else "
                    f"will fail with 'No join path' errors. Run sl_discover for each table "
                    f"named in this source's SQL and add joins via sl_edit_source."
                )

    def plan_only(self, query: dict | SemanticQuery) -> ResolvedPlan:
        if isinstance(query, dict):
            query = SemanticQuery(**query)
        return self.planner.plan(query)

    def suggest(self, query: dict | SemanticQuery) -> dict:
        """Try to plan. If it fails, suggest config extensions with structured info."""
        if isinstance(query, dict):
            query = SemanticQuery(**query)
        try:
            plan = self.planner.plan(query)
            # Also validate that SQL generation succeeds
            try:
                self.generator.generate(plan, self.sources)
            except Exception as gen_err:
                return {
                    "success": False,
                    "error": f"SQL generation failed: {gen_err}",
                    "plan": plan,
                    "referenced_sources": sorted(set(plan.sources_used)),
                    "missing_sources": [],
                    "graph_errors": [],
                    "suggestions": [
                        {
                            "description": f"SQL generation error: {gen_err}",
                            "required_sources": [],
                            "required_joins": [],
                            "notes": [
                                "The query plan was valid but the SQL generator encountered an error.",
                                "This may indicate a limitation in the aggregate locality system.",
                            ],
                        }
                    ],
                }
            return {
                "success": True,
                "plan": plan,
                "suggestions": [],
            }
        except Exception as e:
            from semantic_layer.parser import ExpressionParser

            parser = ExpressionParser()

            # Collect all source references from the query
            referenced_sources: set[str] = set()
            all_exprs: list[str] = []
            for m in query.measures:
                if isinstance(m, str):
                    all_exprs.append(m)
                elif isinstance(m, dict):
                    all_exprs.append(m.get("expr", ""))
            for d in query.dimensions:
                if isinstance(d, str):
                    all_exprs.append(d)
                elif isinstance(d, dict):
                    all_exprs.append(d.get("field", ""))
            all_exprs.extend(query.filters)
            for expr in all_exprs:
                referenced_sources.update(parser.extract_source_refs(expr))

            # Identify missing sources
            known_sources = set(self.sources.keys())
            missing_sources = sorted(referenced_sources - known_sources)

            graph_errors = _format_component_errors(self.graph.find_components())
            suggestions = []

            if missing_sources:
                # Suggest source definitions for missing sources
                required_joins = []
                for ms in missing_sources:
                    # Infer potential join targets from column naming (e.g. orders → orders.id)
                    for known_name, known_src in self.sources.items():
                        candidate_fk = f"{known_name}_id"
                        # Check if the missing source might join to this known source
                        if any(c.name == candidate_fk for c in known_src.columns):
                            required_joins.append(
                                {
                                    "source": known_name,
                                    "to": ms,
                                    "on": f"{candidate_fk} = {ms}.id",
                                    "relationship": "many_to_one",
                                }
                            )
                suggestions.append(
                    {
                        "description": f"Define missing source(s): {', '.join(missing_sources)}",
                        "required_sources": missing_sources,
                        "required_joins": required_joins,
                        "notes": [
                            f"Create YAML definition(s) for: {', '.join(missing_sources)}",
                            "Each source needs at minimum: name, table (or sql), grain, and columns",
                        ],
                    }
                )

            if not missing_sources and len(referenced_sources) > 1:
                # Identify which specific pairs are disconnected
                present_sources = sorted(referenced_sources & known_sources)
                disconnected_pairs = []
                for i, src_a in enumerate(present_sources):
                    for src_b in present_sources[i + 1 :]:
                        path = self.graph.find_path(src_a, src_b)
                        if path is None:
                            disconnected_pairs.append((src_a, src_b))

                required_joins = []
                for src_a, src_b in disconnected_pairs:
                    required_joins.append(
                        {
                            "source": src_a,
                            "to": src_b,
                            "on": f"{src_b}_id = {src_b}.id",
                            "relationship": "many_to_one",
                        }
                    )

                suggestions.append(
                    {
                        "description": f"Add join path(s) connecting: {', '.join(present_sources)}",
                        "required_sources": [],
                        "required_joins": required_joins,
                        "notes": [
                            f"Disconnected pairs: {[f'{a} ↔ {b}' for a, b in disconnected_pairs]}"
                            if disconnected_pairs
                            else "Sources are connected but query failed for another reason",
                        ]
                        if disconnected_pairs
                        else [
                            "All sources are connected; check the error message for details",
                        ],
                    }
                )

            return {
                "success": False,
                "error": str(e),
                "referenced_sources": sorted(referenced_sources),
                "missing_sources": missing_sources,
                "graph_errors": graph_errors,
                "suggestions": suggestions,
            }


def _format_component_errors(components: list[set[str]]) -> list[str]:
    """Render multi-component topology as graph_error strings for `suggest()` / CLI."""
    if len(components) <= 1:
        return []
    sorted_components = sorted(
        components, key=lambda c: (-len(c), sorted(c)[0] if c else "")
    )
    lines = []
    for i, component in enumerate(sorted_components, start=1):
        names = sorted(component)
        if len(names) > 3:
            sample = ", ".join(names[:2])
            lines.append(
                f"Component {i} ({len(names)} sources): {sample}, ... (+{len(names) - 2} more)"
            )
        else:
            lines.append(f"Component {i} ({len(names)} sources): {', '.join(names)}")
    return [f"Disconnected components: {len(components)}"] + lines
