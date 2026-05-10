"""Semantic-layer compute helpers for the KTX daemon package."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field
from semantic_layer.duplicate_check import validate_measure_duplicates
from semantic_layer.engine import SemanticEngine
from semantic_layer.models import QueryResult, SourceDefinition


class SemanticLayerQueryRequest(BaseModel):
    sources: list[dict[str, Any]]
    query: dict[str, Any]
    dialect: str = "postgres"


class SemanticLayerQueryResponse(BaseModel):
    sql: str
    dialect: str
    columns: list[dict[str, Any]]
    plan: dict[str, Any]


class ValidateSourcesRequest(BaseModel):
    sources: list[dict[str, Any]]
    dialect: str = "postgres"
    recently_touched: list[str] | None = None


class ValidateSourcesResponse(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    per_source_warnings: dict[str, list[str]] = Field(default_factory=dict)


def _load_sources(raw_sources: list[dict[str, Any]]) -> dict[str, SourceDefinition]:
    sources: dict[str, SourceDefinition] = {}
    for raw_source in raw_sources:
        source = SourceDefinition(**raw_source)
        if source.name in sources:
            raise ValueError(f"Duplicate source name '{source.name}'")
        sources[source.name] = source
    return sources


def _validate_duplicate_measure_names(source: SourceDefinition) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for measure in source.measures:
        if measure.name in seen:
            errors.append(
                f"Duplicate measure '{measure.name}' on source '{source.name}'"
            )
            continue
        seen.add(measure.name)
    return errors


def _response_columns(result: QueryResult) -> list[dict[str, Any]]:
    measure_names = {
        measure.name: measure.qualified_ref
        for measure in result.resolved_plan.measures
        if measure.qualified_ref
    }
    columns: list[dict[str, Any]] = []
    for column in result.columns:
        dumped = column.model_dump(mode="json")
        if column.provenance.value == "dimension" and column.expr:
            dumped["name"] = column.expr
        elif column.name in measure_names:
            dumped["name"] = measure_names[column.name]
        columns.append(dumped)
    return columns


def query_semantic_layer(
    request: SemanticLayerQueryRequest,
) -> SemanticLayerQueryResponse:
    sources = _load_sources(request.sources)
    engine = SemanticEngine.from_sources(sources, dialect=request.dialect)
    result = engine.query(request.query)
    return SemanticLayerQueryResponse(
        sql=result.sql,
        dialect=result.dialect,
        columns=_response_columns(result),
        plan=result.resolved_plan.model_dump(mode="json"),
    )


def validate_semantic_layer(request: ValidateSourcesRequest) -> ValidateSourcesResponse:
    errors: list[str] = []
    warnings: list[str] = []
    per_source_warnings: dict[str, list[str]] = {}
    sources: dict[str, SourceDefinition] = {}
    seen_names: set[str] = set()

    for raw_source in request.sources:
        raw_name = raw_source.get("name") if isinstance(raw_source, dict) else None
        try:
            source = SourceDefinition(**raw_source)
        except Exception as error:
            label = raw_name or "<unknown>"
            errors.append(f"Source '{label}' failed to parse: {error}")
            continue

        if source.name in seen_names:
            errors.append(f"Duplicate source name '{source.name}'")
            continue
        seen_names.add(source.name)
        sources[source.name] = source
        errors.extend(_validate_duplicate_measure_names(source))

    if sources:
        try:
            engine = SemanticEngine.from_sources(sources, dialect=request.dialect)
            report = engine.validate(
                recently_touched=set(request.recently_touched)
                if request.recently_touched
                else None
            )
            errors.extend(report.errors)
            warnings.extend(report.warnings)
            per_source_warnings.update(report.per_source_warnings)
            errors.extend(validate_measure_duplicates(sources, dialect=request.dialect))
        except Exception as error:
            errors.append(f"Validation failed: {error}")

    return ValidateSourcesResponse(
        valid=len(errors) == 0,
        errors=errors,
        warnings=warnings,
        per_source_warnings=per_source_warnings,
    )
