"""Generate ktx-sl YAML source definitions from database schema scan data."""

from __future__ import annotations

import logging
import re
from typing import Any

from pydantic import BaseModel
from semantic_layer.models import (
    ColumnRole,
    JoinDeclaration,
    MeasureDefinition,
    SourceColumn,
    SourceDefinition,
)

logger = logging.getLogger(__name__)

_NUMBER_PATTERN = re.compile(
    r"int|integer|bigint|smallint|tinyint|numeric|decimal|float|double|real|number|money",
    re.IGNORECASE,
)
_TIME_PATTERN = re.compile(
    r"timestamp|datetime|date|time(?!stamp)",
    re.IGNORECASE,
)
_BOOLEAN_PATTERN = re.compile(r"bool|boolean|bit", re.IGNORECASE)
_ID_PATTERN = re.compile(
    r"^id$|_id$|^uuid$|_uuid$|_key$|_pk$|identifier$",
    re.IGNORECASE,
)

_RELATIONSHIP_MAP = {
    "MANY_TO_ONE": "many_to_one",
    "ONE_TO_MANY": "one_to_many",
    "ONE_TO_ONE": "one_to_one",
    "many_to_one": "many_to_one",
    "one_to_many": "one_to_many",
    "one_to_one": "one_to_one",
}

_RELATIONSHIP_INVERSE = {
    "many_to_one": "one_to_many",
    "one_to_many": "many_to_one",
    "one_to_one": "one_to_one",
}


class ColumnInput(BaseModel):
    name: str
    type: str
    primary_key: bool = False
    nullable: bool = True
    comment: str | None = None


class TableInput(BaseModel):
    name: str
    catalog: str | None = None
    db: str | None = None
    comment: str | None = None
    columns: list[ColumnInput]


class LinkInput(BaseModel):
    from_table: str
    from_column: str
    to_table: str
    to_column: str
    relationship_type: str


class GenerateSourcesRequest(BaseModel):
    tables: list[TableInput]
    links: list[LinkInput]
    dialect: str = "postgres"


class GenerateSourcesResponse(BaseModel):
    sources: list[dict[str, Any]]
    source_count: int


def _map_column_type(db_type: str) -> str:
    if _BOOLEAN_PATTERN.search(db_type):
        return "boolean"
    if _TIME_PATTERN.search(db_type):
        return "time"
    if _NUMBER_PATTERN.search(db_type):
        return "number"
    return "string"


def _build_table_ref(table: TableInput) -> str:
    parts = []
    if table.catalog:
        parts.append(table.catalog)
    if table.db:
        parts.append(table.db)
    parts.append(table.name)
    return ".".join(parts)


def _generate_measures(
    table_name: str,
    columns: list[ColumnInput],
    pk_columns: list[str],
) -> list[MeasureDefinition]:
    measures: list[MeasureDefinition] = []

    if pk_columns:
        pk = pk_columns[0]
        measures.append(
            MeasureDefinition(
                name="record_count",
                expr=f"count({pk})",
                description=f"Count of {table_name} records",
            )
        )

    for col in columns:
        if _map_column_type(col.type) != "number":
            continue
        if _ID_PATTERN.search(col.name):
            continue
        measures.append(
            MeasureDefinition(
                name=f"total_{col.name}",
                expr=f"sum({col.name})",
                description=f"Sum of {col.name}"
                + (f" \u2014 {col.comment}" if col.comment else ""),
            )
        )
        measures.append(
            MeasureDefinition(
                name=f"avg_{col.name}",
                expr=f"avg({col.name})",
                description=f"Average of {col.name}"
                + (f" \u2014 {col.comment}" if col.comment else ""),
            )
        )

    return measures


def generate_sources(request: GenerateSourcesRequest) -> list[dict[str, Any]]:
    links_by_from: dict[str, list[LinkInput]] = {}
    links_by_to: dict[str, list[LinkInput]] = {}
    for link in request.links:
        links_by_from.setdefault(link.from_table, []).append(link)
        links_by_to.setdefault(link.to_table, []).append(link)

    table_names = {table.name for table in request.tables}
    sources: list[dict[str, Any]] = []

    for table in request.tables:
        pk_columns = [column.name for column in table.columns if column.primary_key]
        grain = (
            pk_columns
            if pk_columns
            else [table.columns[0].name]
            if table.columns
            else ["id"]
        )

        sl_columns: list[SourceColumn] = []
        for column in table.columns:
            sl_type = _map_column_type(column.type)
            role = ColumnRole.TIME if sl_type == "time" else ColumnRole.DEFAULT
            sl_columns.append(
                SourceColumn(
                    name=column.name,
                    type=sl_type,
                    role=role,
                    description=column.comment,
                )
            )

        joins: list[JoinDeclaration] = []
        for link in links_by_from.get(table.name, []):
            if link.to_table not in table_names:
                logger.warning(
                    "Skipping link from %s.%s to %s.%s: target table not in scan",
                    link.from_table,
                    link.from_column,
                    link.to_table,
                    link.to_column,
                )
                continue

            relationship = _RELATIONSHIP_MAP.get(link.relationship_type, "many_to_one")
            joins.append(
                JoinDeclaration(
                    to=link.to_table,
                    on=f"{link.from_column} = {link.to_table}.{link.to_column}",
                    relationship=relationship,
                )
            )

        for link in links_by_to.get(table.name, []):
            if link.from_table not in table_names:
                logger.warning(
                    "Skipping reverse link from %s.%s to %s.%s: source table not in scan",
                    link.from_table,
                    link.from_column,
                    link.to_table,
                    link.to_column,
                )
                continue

            forward_relationship = _RELATIONSHIP_MAP.get(
                link.relationship_type, "many_to_one"
            )
            reverse_relationship = _RELATIONSHIP_INVERSE.get(
                forward_relationship, "one_to_many"
            )
            joins.append(
                JoinDeclaration(
                    to=link.from_table,
                    on=f"{link.to_column} = {link.from_table}.{link.from_column}",
                    relationship=reverse_relationship,
                )
            )

        to_counts: dict[str, int] = {}
        for join in joins:
            to_counts[join.to] = to_counts.get(join.to, 0) + 1
        if any(count > 1 for count in to_counts.values()):
            for join in joins:
                if to_counts[join.to] > 1:
                    fk_col = join.on.split(" = ")[0].strip().lower()
                    join.alias = f"{join.to}_{fk_col}"

        source = SourceDefinition(
            name=table.name,
            description=table.comment,
            table=_build_table_ref(table),
            grain=grain,
            columns=sl_columns,
            joins=joins,
            measures=_generate_measures(table.name, table.columns, pk_columns),
        )
        sources.append(source.model_dump(exclude_none=True))

    logger.info("Generated %d ktx-sl source definitions", len(sources))
    return sources


def generate_sources_response(
    request: GenerateSourcesRequest,
) -> GenerateSourcesResponse:
    sources = generate_sources(request)
    return GenerateSourcesResponse(sources=sources, source_count=len(sources))
