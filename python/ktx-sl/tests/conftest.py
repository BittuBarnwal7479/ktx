from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
import sqlglot
import yaml

from semantic_layer.engine import SemanticEngine
from semantic_layer.loader import SourceLoader
from semantic_layer.models import SourceDefinition

SOURCES_DIR = Path(__file__).parent.parent / "sources" / "ecommerce"
TPCH_DIR = Path(__file__).parent.parent / "sources" / "tpch"


@pytest.fixture
def ecommerce_sources() -> dict[str, SourceDefinition]:
    loader = SourceLoader(SOURCES_DIR)
    return loader.load_all()


@pytest.fixture
def tpch_sources() -> dict[str, SourceDefinition]:
    loader = SourceLoader(TPCH_DIR)
    return loader.load_all()


# ── Shared test helpers ──────────────────────────────────────────────


def make_engine(
    sources_dict: dict[str, dict], dialect: str = "postgres"
) -> SemanticEngine:
    """Build a SemanticEngine from inline source dicts (writes temp YAML files)."""
    tmpdir = tempfile.mkdtemp()
    for name, data in sources_dict.items():
        with open(Path(tmpdir) / f"{name}.yaml", "w") as f:
            yaml.dump(data, f)
    return SemanticEngine(tmpdir, dialect=dialect)


def assert_valid_sql(sql: str):
    try:
        sqlglot.parse(sql)
    except Exception as e:
        pytest.fail(f"Generated SQL is not valid: {e}\n\nSQL:\n{sql}")


@pytest.fixture
def make_bq_fct_orders_engine() -> SemanticEngine:
    """BigQuery-dialect engine with fct_orders source mirroring the production YAML."""
    source = {
        "name": "fct_orders",
        "table": "analytics.fct_orders",
        "grain": ["order_id"],
        "columns": [
            {"name": "order_id", "type": "number"},
            {"name": "status", "type": "string"},
            {"name": "transaction_date", "type": "time"},
        ],
        "segments": [
            {"name": "non_cancelled", "expr": "status != 'cancelled'"},
            {
                "name": "last_30_days",
                "expr": "transaction_date >= timestamp(date_sub(current_date(), interval 30 day))",
            },
        ],
        "measures": [
            {
                "name": "daily_active_orders",
                "expr": "count(distinct order_id)",
                "segments": ["non_cancelled", "last_30_days"],
            },
        ],
    }
    return make_engine({"fct_orders": source}, dialect="bigquery")


@pytest.fixture
def make_engine_factory():
    """Factory fixture: pass a sources-dict + dialect, get a SemanticEngine."""

    def _make(
        sources_dict: dict[str, dict], dialect: str = "postgres"
    ) -> SemanticEngine:
        return make_engine(sources_dict, dialect=dialect)

    return _make
