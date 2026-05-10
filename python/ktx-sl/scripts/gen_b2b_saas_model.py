#!/usr/bin/env python3
"""Generate semantic layer YAML sources from demo DB metadata.

Usage:
    kubectl port-forward -n ktx-demo deployment/ktx-demo-db 5433:5432 &
    KTX_DEMO_DB_PASSWORD=local-demo-password python scripts/gen_b2b_saas_model.py
"""

import os
import psycopg2
import yaml

CONNECTION_ID = "256bc76b-cc47-4d5d-a9fc-5bcfb0364d44"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "sources", "b2b_saas")

DB_PARAMS = {
    "host": os.environ.get("KTX_DEMO_DB_HOST", "127.0.0.1"),
    "port": int(os.environ.get("KTX_DEMO_DB_PORT", "5433")),
    "user": os.environ.get("KTX_DEMO_DB_USER", "ktx-demo-user"),
    "password": os.environ.get("KTX_DEMO_DB_PASSWORD", ""),
    "dbname": os.environ.get("KTX_DEMO_DB_NAME", "ktx-demo-db"),
}

# Map DB types to semantic layer types
TYPE_MAP = {
    "INTEGER": "number",
    "FLOAT": "number",
    "NUMERIC": "number",
    "DECIMAL": "number",
    "BIGINT": "number",
    "SMALLINT": "number",
    "DOUBLE": "number",
    "REAL": "number",
    "VARCHAR": "string",
    "TEXT": "string",
    "CHAR": "string",
    "DATE": "time",
    "TIMESTAMP": "time",
    "TIMESTAMPTZ": "time",
    "DATETIME": "time",
    "TIME": "time",
    "BOOLEAN": "boolean",
    "BOOL": "boolean",
}

# Columns whose names suggest a time role
TIME_PATTERNS = {"_at", "_date", "date", "timestamp", "created", "updated"}


def is_time_column(name: str, db_type: str) -> bool:
    sl_type = TYPE_MAP.get(db_type.upper(), "string")
    if sl_type == "time":
        return True
    # VARCHAR columns with date-like names (e.g. created_at stored as VARCHAR)
    lower = name.lower()
    return any(p in lower for p in TIME_PATTERNS) and sl_type == "string"


def map_type(db_type: str, col_name: str) -> str:
    upper = db_type.upper()
    if upper in TYPE_MAP:
        base = TYPE_MAP[upper]
        # Override string→time for date-like column names
        if base == "string" and is_time_column(col_name, db_type):
            return "time"
        return base
    return "string"


def main():
    conn = psycopg2.connect(**DB_PARAMS)
    cur = conn.cursor()

    # 1. Fetch tables
    cur.execute(
        "SELECT id, name FROM source_tables WHERE connection_id = %s ORDER BY name",
        (CONNECTION_ID,),
    )
    tables = {row[0]: row[1] for row in cur.fetchall()}
    table_ids = tuple(tables.keys())

    # 2. Fetch columns
    cur.execute(
        """
        SELECT id, name, type, nullable, primary_key, table_id
        FROM source_columns
        WHERE table_id = ANY(%s::uuid[])
        ORDER BY table_id, primary_key DESC, name
        """,
        (list(table_ids),),
    )
    columns_by_table: dict[str, list] = {}
    col_id_to_info: dict[str, dict] = {}
    for row in cur.fetchall():
        col_id, col_name, col_type, nullable, is_pk, table_id = row
        info = {
            "id": col_id,
            "name": col_name,
            "type": col_type,
            "nullable": nullable,
            "primary_key": is_pk,
            "table_id": table_id,
        }
        col_id_to_info[col_id] = info
        columns_by_table.setdefault(table_id, []).append(info)

    # 3. Fetch links (joins)
    cur.execute(
        """
        SELECT from_table_id, from_column_id, to_table_id, to_column_id, relationship_type
        FROM column_links
        WHERE from_table_id = ANY(%s::uuid[]) OR to_table_id = ANY(%s::uuid[])
        """,
        (list(table_ids), list(table_ids)),
    )
    # Group links by from_table
    joins_by_table: dict[str, list] = {}
    for row in cur.fetchall():
        from_table_id, from_col_id, to_table_id, to_col_id, rel_type = row
        # Only include joins where both sides are in our connection
        if from_table_id not in tables or to_table_id not in tables:
            continue
        joins_by_table.setdefault(from_table_id, []).append(
            {
                "from_col_id": from_col_id,
                "to_table_id": to_table_id,
                "to_col_id": to_col_id,
                "relationship_type": rel_type,
            }
        )

    conn.close()

    # 4. Generate YAML files
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    for table_id, table_name in sorted(tables.items(), key=lambda x: x[1]):
        cols = columns_by_table.get(table_id, [])
        joins = joins_by_table.get(table_id, [])

        # Find primary key columns
        pk_cols = [c for c in cols if c["primary_key"]]
        if pk_cols:
            grain = [c["name"] for c in pk_cols]
        else:
            # Fallback: use row_id if present, else first column
            row_id_col = next((c for c in cols if c["name"] == "row_id"), None)
            if row_id_col:
                grain = ["row_id"]
            elif cols:
                grain = [cols[0]["name"]]
            else:
                grain = [table_name + "_id"]

        # Build column definitions
        yaml_columns = []
        for c in cols:
            sl_type = map_type(c["type"], c["name"])
            col_def: dict = {"name": c["name"], "type": sl_type}
            if is_time_column(c["name"], c["type"]):
                col_def["role"] = "time"
            yaml_columns.append(col_def)

        # Build join definitions
        yaml_joins = []
        # Track target sources to handle aliases for multiple joins to same target
        target_counts: dict[str, int] = {}
        for j in joins:
            to_name = tables.get(j["to_table_id"])
            if not to_name:
                continue
            target_counts[to_name] = target_counts.get(to_name, 0) + 1

        target_seen: dict[str, int] = {}
        for j in joins:
            to_name = tables.get(j["to_table_id"])
            from_col = col_id_to_info.get(j["from_col_id"], {}).get("name")
            to_col = col_id_to_info.get(j["to_col_id"], {}).get("name")
            if not (to_name and from_col and to_col):
                continue

            rel = j["relationship_type"].lower()

            join_def: dict = {
                "to": to_name,
                "on": f"{from_col} = {to_name}.{to_col}",
                "relationship": rel,
            }

            # Add alias if multiple joins to same target
            target_seen[to_name] = target_seen.get(to_name, 0) + 1
            if target_counts.get(to_name, 0) > 1:
                join_def["alias"] = f"{to_name}_{target_seen[to_name]}"

            yaml_joins.append(join_def)

        # Build source definition
        source: dict = {
            "name": table_name,
            "table": table_name,
        }
        if grain:
            source["grain"] = grain
        source["columns"] = yaml_columns
        if yaml_joins:
            source["joins"] = yaml_joins

        # Write YAML
        filepath = os.path.join(OUTPUT_DIR, f"{table_name}.yaml")
        with open(filepath, "w") as f:
            yaml.dump(
                source, f, default_flow_style=False, sort_keys=False, allow_unicode=True
            )

    print(f"Generated {len(tables)} source files in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
