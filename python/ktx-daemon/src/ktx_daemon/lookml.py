"""Parse LookML projects into resolved, KSL-ready structures.

Pipeline: parse files, collect constants, substitute constants, resolve
extends/refinements, resolve column references, and build measures/joins.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Literal

import lkml
import sqlglot
from pydantic import BaseModel
from sqlglot import exp

logger = logging.getLogger(__name__)

# ── Public models ──────────────────────────────────────────────────────

CONSTANT_RE = re.compile(r"@\{(\w+)\}")
TABLE_REF_RE = re.compile(r"^\s*\$\{TABLE\}\.(\w+)\s*$")
FIELD_REF_RE = re.compile(r"\$\{(\w+)\}")
VIEW_FIELD_REF_RE = re.compile(r"\$\{(\w+)\.(\w+)\}")
LIQUID_RE = re.compile(r"\{%.*?%\}")
AGGREGATE_FUNC_RE = re.compile(
    r"\b(min|max|sum|avg|count|count_distinct|median)\s*\(", re.IGNORECASE
)

LOOKML_TYPE_MAP: dict[str, str] = {
    "string": "string",
    "tier": "string",
    "zipcode": "string",
    "location": "string",
    "number": "number",
    "yesno": "boolean",
    "time": "time",
    "date": "time",
    "date_time": "time",
    "date_raw": "time",
    "date_date": "time",
    "date_week": "time",
    "date_month": "time",
    "date_quarter": "time",
    "date_year": "time",
    "duration": "number",
}

MEASURE_TYPE_MAP: dict[str, str] = {
    "count": "count(*)",
    "count_distinct": "count_distinct",
    "sum": "sum",
    "sum_distinct": "sum",
    "average": "avg",
    "average_distinct": "avg",
    "min": "min",
    "max": "max",
    "median": "median",
}


class LookMLFileInput(BaseModel):
    path: str
    content: str


class ParseLookMLRequest(BaseModel):
    files: list[LookMLFileInput]
    constant_overrides: dict[str, str] | None = None
    dialect: str = "postgres"


class SkippedItem(BaseModel):
    name: str
    item_type: str
    reason: str


class ParsedColumn(BaseModel):
    name: str
    lookml_name: str
    type: str
    role: str
    visibility: str
    description: str | None = None
    is_computed: bool = False
    expr: str | None = None


class ParsedMeasure(BaseModel):
    name: str
    expr: str
    filter: str | None = None
    description: str | None = None


class ParsedJoin(BaseModel):
    source_view: str
    to: str
    alias: str | None = None
    on: str
    relationship: str


class ParsedLookMLView(BaseModel):
    name: str
    source_type: Literal["table", "sql"]
    table_ref: str | None = None
    sql: str | None = None
    grain: list[str]
    columns: list[ParsedColumn]
    measures: list[ParsedMeasure]
    description: str | None = None
    skipped_dimensions: list[SkippedItem] = []
    skipped_measures: list[SkippedItem] = []


class ParseLookMLResponse(BaseModel):
    views: list[ParsedLookMLView]
    joins: list[ParsedJoin]
    skipped_views: list[SkippedItem]
    warnings: list[str]


# ── Internal types ─────────────────────────────────────────────────────


class _RawView:
    """Mutable intermediate view before resolution."""

    def __init__(self, name: str, data: dict[str, Any], source_file: str) -> None:
        self.name = name
        self.source_file = source_file
        self.extension_required: bool = data.get("extension") == "required"
        self.is_refinement: bool = name.startswith("+")
        self.sql_table_name: str | None = data.get("sql_table_name")
        self.label: str | None = data.get("label")
        self.description: str | None = data.get("description")

        self.extends: list[str] = _flatten_all(data.get("extends__all"))
        self.derived_table: dict[str, Any] | None = data.get("derived_table")

        self.dimensions: dict[str, dict[str, Any]] = {
            d["name"]: d for d in data.get("dimensions", [])
        }
        self.dimension_groups: dict[str, dict[str, Any]] = {
            dg["name"]: dg for dg in data.get("dimension_groups", [])
        }
        self.measures: dict[str, dict[str, Any]] = {
            m["name"]: m for m in data.get("measures", [])
        }


# ── Main entry point ──────────────────────────────────────────────────


def parse_lookml_project(request: ParseLookMLRequest) -> ParseLookMLResponse:
    """Parse and resolve a LookML project into KSL-ready structures."""
    constants = _collect_constants(request.files, request.constant_overrides or {})
    raw_views, raw_explores = _parse_all_files(request.files, constants)
    resolved = _resolve_inheritance(raw_views)
    views, skipped_views, warnings = _build_parsed_views(resolved, request.dialect)
    all_joins = _build_parsed_joins(raw_explores, resolved)

    # Filter out joins that reference skipped views (as source or target)
    emitted_view_names = {v.name for v in views}
    joins = [
        j
        for j in all_joins
        if j.source_view in emitted_view_names
        and (j.to in emitted_view_names or j.alias)
    ]

    return ParseLookMLResponse(
        views=views,
        joins=joins,
        skipped_views=skipped_views,
        warnings=warnings,
    )


# ── Parsing ────────────────────────────────────────────────────────────


def _collect_constants(
    files: list[LookMLFileInput], overrides: dict[str, str]
) -> dict[str, str]:
    """Extract constants from manifest.lkml and apply overrides."""
    constants: dict[str, str] = {}
    for f in files:
        if "manifest" in f.path.lower():
            parsed = lkml.load(f.content)
            for c in parsed.get("constants", []):
                constants[c["name"]] = c.get("value", "")
    constants.update(overrides)
    return constants


def _substitute_constants(text: str | None, constants: dict[str, str]) -> str | None:
    if text is None:
        return None
    return CONSTANT_RE.sub(lambda m: constants.get(m.group(1), m.group(0)), text)


def _substitute_constants_in_view(
    view_data: dict[str, Any], constants: dict[str, str]
) -> None:
    """In-place constant substitution across all SQL fields in a view dict."""
    for key in ("sql_table_name", "sql"):
        if key in view_data:
            view_data[key] = _substitute_constants(view_data[key], constants)

    dt = view_data.get("derived_table")
    if dt and "sql" in dt:
        dt["sql"] = _substitute_constants(dt["sql"], constants)

    for dim in view_data.get("dimensions", []):
        if "sql" in dim:
            dim["sql"] = _substitute_constants(dim["sql"], constants)
    for dg in view_data.get("dimension_groups", []):
        if "sql" in dg:
            dg["sql"] = _substitute_constants(dg["sql"], constants)
    for m in view_data.get("measures", []):
        if "sql" in m:
            m["sql"] = _substitute_constants(m["sql"], constants)


def _parse_all_files(
    files: list[LookMLFileInput], constants: dict[str, str]
) -> tuple[dict[str, _RawView], list[dict[str, Any]]]:
    """Parse all .lkml files and return raw views + explores."""
    all_views: dict[str, _RawView] = {}
    all_explores: list[dict[str, Any]] = []

    for f in files:
        try:
            parsed = lkml.load(f.content)
        except Exception:
            logger.warning("Failed to parse %s, skipping", f.path)
            continue

        for view_data in parsed.get("views", []):
            _substitute_constants_in_view(view_data, constants)
            name = view_data["name"]
            rv = _RawView(name, view_data, f.path)
            all_views[name] = rv

        for explore_data in parsed.get("explores", []):
            # Substitute constants in sql_on for joins
            for j in explore_data.get("joins", []):
                if "sql_on" in j:
                    j["sql_on"] = _substitute_constants(j["sql_on"], constants)
            all_explores.append(explore_data)

    return all_views, all_explores


# ── Inheritance resolution ─────────────────────────────────────────────


def _flatten_all(val: Any) -> list[str]:
    """Flatten lkml's nested extends__all / filters__all structures."""
    if val is None:
        return []
    if isinstance(val, list):
        result: list[str] = []
        for item in val:
            if isinstance(item, list):
                result.extend(_flatten_all(item))
            elif isinstance(item, str):
                result.append(item)
        return result
    return []


def _merge_view(parent: _RawView, child: _RawView) -> None:
    """Merge parent fields into child (child takes precedence)."""
    # Dimensions: parent first, child overrides
    merged_dims = dict(parent.dimensions)
    merged_dims.update(child.dimensions)
    child.dimensions = merged_dims

    merged_dgs = dict(parent.dimension_groups)
    merged_dgs.update(child.dimension_groups)
    child.dimension_groups = merged_dgs

    merged_measures = dict(parent.measures)
    merged_measures.update(child.measures)
    child.measures = merged_measures

    # Inherit sql_table_name and derived_table if child doesn't have them
    if child.sql_table_name is None and parent.sql_table_name is not None:
        child.sql_table_name = parent.sql_table_name
    if child.derived_table is None and parent.derived_table is not None:
        child.derived_table = parent.derived_table
    if child.description is None and parent.description is not None:
        child.description = parent.description


def _apply_refinement(target: _RawView, refinement: _RawView) -> None:
    """Apply refinement fields to the target view. Metadata-only merge for existing fields."""
    for name, dim in refinement.dimensions.items():
        if name in target.dimensions:
            # Merge metadata: label, description, hidden, tags, group_label
            for key in ("label", "description", "hidden", "tags", "group_label"):
                if key in dim:
                    target.dimensions[name][key] = dim[key]
        else:
            target.dimensions[name] = dim

    for name, dg in refinement.dimension_groups.items():
        if name in target.dimension_groups:
            for key in ("label", "description", "hidden", "tags", "group_label"):
                if key in dg:
                    target.dimension_groups[name][key] = dg[key]
        else:
            target.dimension_groups[name] = dg

    for name, m in refinement.measures.items():
        if name in target.measures:
            for key in ("label", "description", "hidden", "tags", "group_label"):
                if key in m:
                    target.measures[name][key] = m[key]
        else:
            target.measures[name] = m

    if refinement.label:
        target.label = refinement.label
    if refinement.description:
        target.description = refinement.description


def _resolve_inheritance(raw_views: dict[str, _RawView]) -> dict[str, _RawView]:
    """Resolve extends and refinements. Returns only concrete views."""
    # Separate refinements from regular views
    refinements: list[_RawView] = []
    views: dict[str, _RawView] = {}

    for name, rv in raw_views.items():
        if rv.is_refinement:
            refinements.append(rv)
        else:
            views[name] = rv

    # Resolve extends (topological order via iterative resolution)
    resolved: set[str] = set()
    max_passes = len(views) + 1
    for _ in range(max_passes):
        progress = False
        for name, view in views.items():
            if name in resolved:
                continue
            if not view.extends:
                resolved.add(name)
                progress = True
                continue
            # Check if all parents are resolved
            parents_ready = all(p in resolved for p in view.extends)
            if parents_ready:
                for parent_name in view.extends:
                    parent = views.get(parent_name)
                    if parent:
                        _merge_view(parent, view)
                resolved.add(name)
                progress = True
        if not progress:
            break

    # Apply refinements
    for ref in refinements:
        target_name = ref.name.lstrip("+")
        target = views.get(target_name)
        if target:
            _apply_refinement(target, ref)
        else:
            logger.warning(
                "Refinement target '%s' not found for '%s'", target_name, ref.name
            )

    return views


# ── Alias view detection ──────────────────────────────────────────────


def _detect_alias_views(resolved: dict[str, _RawView]) -> dict[str, str]:
    """Detect views that are aliases of another view (same table_ref, extends parent).

    Returns dict of {alias_name: parent_name}.
    """
    # Build table_ref → first view name map (canonical view per table)
    table_to_canonical: dict[str, str] = {}
    for name, rv in resolved.items():
        if rv.extension_required or rv.is_refinement:
            continue
        if rv.sql_table_name and not rv.extends:
            table_ref = rv.sql_table_name.strip()
            if table_ref not in table_to_canonical:
                table_to_canonical[table_ref] = name

    # Find views that extend another, share the same table_ref,
    # and add no new fields (pure aliases used only for join renaming).
    alias_views: dict[str, str] = {}
    for name, rv in resolved.items():
        if rv.extension_required or rv.is_refinement:
            continue
        if rv.extends and rv.sql_table_name:
            table_ref = rv.sql_table_name.strip()
            canonical = table_to_canonical.get(table_ref)
            if canonical and canonical != name and _is_pure_alias(rv, resolved):
                alias_views[name] = canonical

    return alias_views


def _is_pure_alias(rv: _RawView, resolved: dict[str, _RawView]) -> bool:
    """A view is a pure alias if it adds no new fields and does not override any
    inherited field's definition. Compare dict values, not just names — a child
    that redefines a measure/dimension must not be classified as alias-only."""
    parent_dims: dict[str, dict] = {}
    parent_dgs: dict[str, dict] = {}
    parent_meas: dict[str, dict] = {}
    for parent_name in rv.extends:
        parent = resolved.get(parent_name)
        if parent:
            parent_dims.update(parent.dimensions)
            parent_dgs.update(parent.dimension_groups)
            parent_meas.update(parent.measures)

    for name, d in rv.dimensions.items():
        if parent_dims.get(name) != d:
            return False
    for name, d in rv.dimension_groups.items():
        if parent_dgs.get(name) != d:
            return False
    for name, d in rv.measures.items():
        if parent_meas.get(name) != d:
            return False
    return True


# ── View → ParsedLookMLView conversion ────────────────────────────────


def _build_parsed_views(
    resolved: dict[str, _RawView],
    dialect: str,
) -> tuple[list[ParsedLookMLView], list[SkippedItem], list[str]]:
    views: list[ParsedLookMLView] = []
    skipped: list[SkippedItem] = []
    warnings: list[str] = []

    # Detect aliased views: views that extend another and share the same table_ref.
    # These are used only as join aliases (e.g., customer_nation extends nation).
    alias_view_names = _detect_alias_views(resolved)

    for name, rv in resolved.items():
        # Skip abstract base views
        if rv.extension_required:
            skipped.append(
                SkippedItem(
                    name=name,
                    item_type="view",
                    reason="abstract base view (extension: required)",
                )
            )
            continue

        # Skip alias-only views (handled via join aliases)
        if name in alias_view_names:
            skipped.append(
                SkippedItem(
                    name=name,
                    item_type="view",
                    reason=f"alias view (same table as '{alias_view_names[name]}', used as join alias)",
                )
            )
            continue

        # Determine source type
        has_explore_source = rv.derived_table and "explore_source" in rv.derived_table
        has_sql_dt = rv.derived_table and "sql" in rv.derived_table
        has_table_ref = rv.sql_table_name is not None

        if has_explore_source:
            skipped.append(
                SkippedItem(
                    name=name,
                    item_type="view",
                    reason="native derived table (explore_source not supported)",
                )
            )
            continue
        if not has_table_ref and not has_sql_dt:
            skipped.append(
                SkippedItem(
                    name=name,
                    item_type="view",
                    reason="no sql_table_name or derived_table.sql",
                )
            )
            continue

        source_type: Literal["table", "sql"] = "sql" if has_sql_dt else "table"
        table_ref = rv.sql_table_name.strip() if rv.sql_table_name else None
        raw_sql = rv.derived_table["sql"].strip() if has_sql_dt else None

        # Build field→column lookup for this view
        field_to_col = _build_field_column_map(rv)
        # For sql sources, extract columns (always parse as postgres — LookML source dialect)
        # then transpile to target dialect for the output SQL
        sqlglot_columns: dict[str, str] = {}
        sql_text = raw_sql
        if raw_sql:
            sqlglot_columns = _extract_sql_columns(raw_sql, "postgres", warnings, name)
            sql_text = _transpile_sql(raw_sql, "postgres", dialect, warnings, name)

        # Build columns
        columns: list[ParsedColumn] = []
        skipped_dims: list[SkippedItem] = []
        grain: list[str] = []

        for dim_name, dim in rv.dimensions.items():
            col = _convert_dimension(dim_name, dim, source_type, field_to_col)
            if isinstance(col, SkippedItem):
                skipped_dims.append(col)
            elif col is not None:
                columns.append(col)
                if dim.get("primary_key") == "yes":
                    grain.append(col.name)

        for dg_name, dg in rv.dimension_groups.items():
            col = _convert_dimension_group(dg_name, dg)
            if col is not None:
                columns.append(col)

        # For sql sources, fill in any columns from sqlglot that aren't already declared
        if source_type == "sql" and sqlglot_columns:
            existing_names = {c.name for c in columns}
            for col_name, col_type in sqlglot_columns.items():
                if col_name not in existing_names:
                    columns.append(
                        ParsedColumn(
                            name=col_name,
                            lookml_name=col_name,
                            type=col_type,
                            role="default",
                            visibility="public",
                        )
                    )

        # Build measures
        measures: list[ParsedMeasure] = []
        skipped_measures: list[SkippedItem] = []

        for m_name, m in rv.measures.items():
            result = _convert_measure(m_name, m, field_to_col, rv)
            if isinstance(result, SkippedItem):
                skipped_measures.append(result)
            elif result is not None:
                measures.append(result)

        views.append(
            ParsedLookMLView(
                name=name,
                source_type=source_type,
                table_ref=table_ref,
                sql=sql_text,
                grain=grain,
                columns=columns,
                measures=measures,
                description=rv.description or rv.label,
                skipped_dimensions=skipped_dims,
                skipped_measures=skipped_measures,
            )
        )

    return views, skipped, warnings


def _build_field_column_map(rv: _RawView) -> dict[str, str]:
    """Build a map from LookML field name → actual DB column name or resolved expression.

    For simple ${TABLE}.col dimensions, maps to the column name.
    For computed dimensions, resolves ${TABLE}.col refs inline so measures can reference them.
    """
    # First pass: collect direct column references
    field_to_col: dict[str, str] = {}
    for dim_name, dim in rv.dimensions.items():
        sql = dim.get("sql", "")
        match = TABLE_REF_RE.match(sql)
        if match:
            field_to_col[dim_name] = match.group(1)

    for dg_name, dg in rv.dimension_groups.items():
        sql = dg.get("sql", "")
        match = TABLE_REF_RE.match(sql)
        if match:
            field_to_col[dg_name] = match.group(1)
            for tf in dg.get("timeframes", []):
                field_to_col[f"{dg_name}_{tf}"] = match.group(1)

    # Second pass: resolve computed dimensions to their SQL with ${TABLE}.col replaced
    for dim_name, dim in rv.dimensions.items():
        if dim_name in field_to_col:
            continue
        sql = dim.get("sql", "")
        if sql:
            # Replace ${TABLE}.col → col
            resolved = re.sub(r"\$\{TABLE\}\.(\w+)", r"\1", sql.strip())
            # Replace ${field_name} with already-resolved column names
            resolved = FIELD_REF_RE.sub(
                lambda m: field_to_col.get(m.group(1), m.group(1)), resolved
            )
            field_to_col[dim_name] = resolved

    return field_to_col


def _convert_dimension(
    name: str,
    dim: dict[str, Any],
    source_type: str,
    field_to_col: dict[str, str],
) -> ParsedColumn | SkippedItem | None:
    """Convert a LookML dimension to a ParsedColumn, or skip it."""
    sql = dim.get("sql", "")

    # Skip Liquid templating
    if LIQUID_RE.search(sql):
        return SkippedItem(
            name=name, item_type="dimension", reason="Liquid templating not supported"
        )

    is_direct = TABLE_REF_RE.match(sql) is not None

    if is_direct:
        col_name = field_to_col.get(name, name)
        expr = None
    else:
        # Computed dimension: use LookML dim name, store resolved expression in expr
        col_name = name
        expr = field_to_col.get(name)
        if expr is None:
            expr = re.sub(r"\$\{TABLE\}\.(\w+)", r"\1", sql.strip())

    lookml_type = dim.get("type", "string")
    ksl_type = LOOKML_TYPE_MAP.get(lookml_type, "string")

    return ParsedColumn(
        name=col_name,
        lookml_name=name,
        type=ksl_type,
        role="default",
        visibility="hidden" if dim.get("hidden") == "yes" else "public",
        description=dim.get("description") or dim.get("label"),
        is_computed=not is_direct,
        expr=expr,
    )


def _convert_dimension_group(
    name: str,
    dg: dict[str, Any],
) -> ParsedColumn | None:
    """Convert a dimension_group to a single time column."""
    if dg.get("type") != "time":
        return None

    sql = dg.get("sql", "")
    match = TABLE_REF_RE.match(sql)
    col_name = match.group(1) if match else name

    return ParsedColumn(
        name=col_name,
        lookml_name=name,
        type="time",
        role="time",
        visibility="hidden" if dg.get("hidden") == "yes" else "public",
        description=dg.get("description") or dg.get("label"),
    )


def _convert_measure(
    name: str,
    m: dict[str, Any],
    field_to_col: dict[str, str],
    rv: _RawView,
) -> ParsedMeasure | SkippedItem | None:
    """Convert a LookML measure to a ParsedMeasure, or skip it."""
    measure_type = m.get("type", "")
    sql = m.get("sql", "")

    # Skip Liquid templating
    if sql and LIQUID_RE.search(sql):
        return SkippedItem(
            name=name, item_type="measure", reason="Liquid templating not supported"
        )

    # Skip cross-view references
    if sql and VIEW_FIELD_REF_RE.search(sql):
        return SkippedItem(
            name=name, item_type="measure", reason="cross-view measure reference"
        )

    # Handle count (no sql needed)
    if measure_type == "count" and not sql:
        expr = "count(*)"
    elif measure_type in MEASURE_TYPE_MAP:
        if measure_type == "count":
            # count with sql
            expr = "count(*)"
        else:
            func = MEASURE_TYPE_MAP[measure_type]
            # Resolve ${field_name} to column name
            resolved_col = _resolve_measure_sql(sql, field_to_col)
            if resolved_col is None:
                return SkippedItem(
                    name=name,
                    item_type="measure",
                    reason=f"could not resolve sql reference: {sql}",
                )
            expr = f"{func}({resolved_col})"
    elif measure_type == "date":
        resolved = _resolve_measure_sql(sql, field_to_col)
        if resolved is None:
            return SkippedItem(
                name=name,
                item_type="measure",
                reason=f"could not resolve sql reference for date measure: {sql}",
            )
        if _sql_contains_aggregate(resolved):
            expr = resolved
        else:
            func = "max" if "max" in name.lower() else "min"
            expr = f"{func}({resolved})"
    elif measure_type == "number":
        resolved = _resolve_derived_measure_sql(sql, field_to_col, rv)
        if resolved is None:
            return SkippedItem(
                name=name,
                item_type="measure",
                reason="computed measure (type: number) with unresolvable references",
            )
        expr = resolved
    else:
        return SkippedItem(
            name=name,
            item_type="measure",
            reason=f"unsupported measure type: {measure_type}",
        )

    # Handle filters
    filter_str = _resolve_measure_filter(m, field_to_col, rv)

    return ParsedMeasure(
        name=name,
        expr=expr,
        filter=filter_str,
        description=m.get("description") or m.get("label"),
    )


SINGLE_FIELD_REF_RE = re.compile(r"^\s*\$\{(\w+)\}\s*$")


def _resolve_measure_sql(sql: str, field_to_col: dict[str, str]) -> str | None:
    """Resolve ${field_name} and ${TABLE}.col references in measure SQL to column expressions."""
    if not sql:
        return None
    sql = sql.strip()

    # Simple ${TABLE}.col → col (exact match, entire string)
    table_match = TABLE_REF_RE.match(sql)
    if table_match:
        return table_match.group(1)

    # Simple ${field_name} → resolved column (exact match, entire string)
    field_match = SINGLE_FIELD_REF_RE.match(sql)
    if field_match:
        field_name = field_match.group(1)
        return field_to_col.get(field_name, field_name)

    # Complex expression with ${TABLE}.col or ${field} refs — resolve all inline
    resolved = _resolve_field_refs_in_sql(sql, field_to_col)
    if resolved != sql:
        return resolved

    return None


def _sql_contains_aggregate(sql: str) -> bool:
    """Check if an SQL expression already contains an aggregate function call."""
    return bool(AGGREGATE_FUNC_RE.search(sql))


def _resolve_derived_measure_sql(
    sql: str,
    field_to_col: dict[str, str],
    rv: _RawView,
) -> str | None:
    """Resolve a type:number measure's SQL, replacing ${field} refs with
    measure names (for measure refs) or column expressions (for dimension refs).

    Returns the resolved expression, or None if any reference is unresolvable.
    """
    if not sql:
        return None

    if VIEW_FIELD_REF_RE.search(sql):
        return None

    def _replace_ref(match: re.Match[str]) -> str:
        field_name = match.group(1)
        if field_name == "TABLE":
            return match.group(0)
        if field_name in rv.measures:
            return field_name
        if field_name in field_to_col:
            return field_to_col[field_name]
        return match.group(0)

    resolved = re.sub(r"\$\{TABLE\}\.(\w+)", r"\1", sql.strip())
    resolved = FIELD_REF_RE.sub(_replace_ref, resolved)

    if FIELD_REF_RE.search(resolved):
        return None

    return resolved


def _resolve_measure_filter(
    m: dict[str, Any],
    field_to_col: dict[str, str],
    rv: _RawView,
) -> str | None:
    """Convert LookML measure filters to a KSL filter string."""
    filters_all = m.get("filters__all")
    if not filters_all:
        return None

    filter_parts: list[str] = []
    for group in _iter_filter_groups(filters_all):
        for field_name, value in group.items():
            # Try to resolve the filter field to its underlying SQL
            dim = rv.dimensions.get(field_name)
            if dim and dim.get("type") == "yesno":
                # yesno: the sql IS the boolean expression — resolve ${field} refs in it
                dim_sql = _resolve_field_refs_in_sql(
                    dim.get("sql", "").strip(), field_to_col
                )
                if value == "yes":
                    filter_parts.append(dim_sql)
                else:
                    filter_parts.append(f"NOT ({dim_sql})")
            else:
                col = field_to_col.get(field_name, field_name)
                filter_parts.append(f"{col} = '{value}'")

    return " AND ".join(filter_parts) if filter_parts else None


def _resolve_field_refs_in_sql(sql: str, field_to_col: dict[str, str]) -> str:
    """Replace ${field_name} and ${TABLE}.col references in SQL with actual column names."""
    # First replace ${TABLE}.col
    sql = re.sub(r"\$\{TABLE\}\.(\w+)", r"\1", sql)
    # Then replace ${field_name}
    sql = FIELD_REF_RE.sub(lambda m: field_to_col.get(m.group(1), m.group(1)), sql)
    return sql


def _iter_filter_groups(filters_all: Any) -> list[dict[str, str]]:
    """Iterate through lkml's filters__all nested structure."""
    result: list[dict[str, str]] = []
    if isinstance(filters_all, list):
        for item in filters_all:
            if isinstance(item, dict):
                result.append(item)
            elif isinstance(item, list):
                for sub in item:
                    if isinstance(sub, dict):
                        result.append(sub)
    return result


# ── sqlglot: transpile and extract columns from derived table SQL ─────


def _transpile_sql(
    sql: str,
    source_dialect: str,
    target_dialect: str,
    warnings: list[str],
    view_name: str,
) -> str:
    """Transpile SQL from source dialect to target dialect using sqlglot."""
    if source_dialect == target_dialect:
        return sql
    try:
        results = sqlglot.transpile(sql, read=source_dialect, write=target_dialect)
        return results[0] if results else sql
    except Exception as e:
        warnings.append(
            f"sqlglot transpile failed for view '{view_name}' "
            f"({source_dialect} → {target_dialect}): {e}"
        )
        return sql


def _extract_sql_columns(
    sql: str, dialect: str, warnings: list[str], view_name: str
) -> dict[str, str]:
    """Extract output column names and inferred types from a SELECT statement."""
    try:
        tree = sqlglot.parse_one(sql, read=dialect)
    except Exception as e:
        warnings.append(f"sqlglot parse failed for view '{view_name}': {e}")
        return {}

    columns: dict[str, str] = {}
    for expr_node in tree.expressions:
        alias = expr_node.alias
        if not alias and isinstance(expr_node, exp.Column):
            alias = expr_node.name
        if alias:
            col_type = _infer_column_type(expr_node)
            columns[alias.lower()] = col_type

    return columns


def _infer_column_type(node: exp.Expression) -> str:
    """Infer KSL column type from a sqlglot AST node."""
    # Check if it's an aggregate
    inner = node.unalias() if hasattr(node, "unalias") else node

    if isinstance(inner, (exp.Count, exp.Sum, exp.Avg, exp.Min, exp.Max)):
        return "number"
    if isinstance(inner, exp.Anonymous):
        func_name = inner.name.upper() if hasattr(inner, "name") else ""
        if func_name in ("COUNT", "SUM", "AVG", "MIN", "MAX", "COUNT_DISTINCT"):
            return "number"

    # Check for CASE expressions (usually string or number)
    if isinstance(inner, exp.Case):
        return "string"

    # Check for date functions
    if isinstance(
        inner,
        (
            exp.DateTrunc,
            exp.DateAdd,
            exp.DateSub,
            exp.CurrentDate,
            exp.CurrentTimestamp,
        ),
    ):
        return "time"

    # Default: assume number for aggregates, string otherwise
    if inner.find(exp.AggFunc):
        return "number"

    return "string"


# ── Joins ──────────────────────────────────────────────────────────────


def _build_parsed_joins(
    raw_explores: list[dict[str, Any]],
    resolved_views: dict[str, _RawView],
) -> list[ParsedJoin]:
    """Convert explore join definitions to ParsedJoin list."""
    joins: list[ParsedJoin] = []
    seen: set[tuple[str, str, str | None]] = set()  # (source, target, alias)

    for explore in raw_explores:
        explore_base = explore.get("view_name") or explore.get("name", "")

        for join_data in explore.get("joins", []):
            join_name = join_data.get("name", "")
            from_view = join_data.get("from")
            target_view = from_view or join_name
            alias = join_name if from_view else None
            relationship = join_data.get("relationship", "many_to_one")
            sql_on = join_data.get("sql_on", "")

            # Parse sql_on to extract source view and resolved condition
            source_view, on_clause = _parse_sql_on(
                sql_on, explore_base, join_name, resolved_views
            )

            key = (source_view, target_view, alias)
            if key in seen:
                continue
            seen.add(key)

            joins.append(
                ParsedJoin(
                    source_view=source_view,
                    to=target_view,
                    alias=alias,
                    on=on_clause,
                    relationship=relationship,
                )
            )

    return joins


def _parse_sql_on(
    sql_on: str,
    explore_base: str,
    join_name: str,
    resolved_views: dict[str, _RawView],
) -> tuple[str, str]:
    """Parse a sql_on expression to extract the source view and KSL-format on clause.

    Returns (source_view, on_clause).
    """
    refs = VIEW_FIELD_REF_RE.findall(sql_on)
    if not refs:
        return explore_base, sql_on.strip()

    # Resolve each ${view.field} to view.actual_column
    def resolve_ref(match: re.Match[str]) -> str:
        view_name = match.group(1)
        field_name = match.group(2)
        rv = resolved_views.get(view_name)
        if rv:
            # Look up actual column name
            dim = rv.dimensions.get(field_name)
            if dim:
                table_match = TABLE_REF_RE.match(dim.get("sql", ""))
                if table_match:
                    return f"{view_name}.{table_match.group(1)}"
            # Check dimension_groups
            for dg_name, dg in rv.dimension_groups.items():
                if field_name == dg_name or field_name.startswith(f"{dg_name}_"):
                    dg_match = TABLE_REF_RE.match(dg.get("sql", ""))
                    if dg_match:
                        return f"{view_name}.{dg_match.group(1)}"
        return f"{view_name}.{field_name}"

    on_clause = VIEW_FIELD_REF_RE.sub(resolve_ref, sql_on).strip()

    # Determine source view: first referenced view that isn't the join target
    source_view = explore_base
    for view_name, _ in refs:
        if view_name != join_name:
            source_view = view_name
            break
    return source_view, on_clause
