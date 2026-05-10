#!/usr/bin/env bash
# Complex CTE Runtime Join Demo
#
# Shows how two SQL sources with internal CTEs (customer_lifetime_value, churn_risk)
# are joined at runtime through the join graph to a dimension table (regions),
# triggering chasm trap detection and aggregate locality.

set -euo pipefail
cd "$(dirname "$0")/.."

MODEL="demos/complex_cte_join.yaml"

echo "============================================"
echo " Demo 1: Chasm Trap — Two CTE metrics + regions dimension"
echo "============================================"
echo ""
echo "Query: Average LTV and average churn risk by region,"
echo "       for customers with churn score > 0.7"
echo ""

echo '{
  "measures": ["customer_lifetime_value.avg_ltv", "churn_risk.avg_risk"],
  "dimensions": ["regions.name"],
  "filters": ["churn_risk.score > 0.7"]
}' | uv run python -m semantic_layer.cli --model "$MODEL" --json --plan

echo ""
echo "============================================"
echo " Demo 2: Single CTE metric enriched with regions"
echo "============================================"
echo ""
echo "Query: LTV breakdown by region and customer segment,"
echo "       only customers with 6+ active months"
echo ""

echo '{
  "measures": [
    "customer_lifetime_value.avg_ltv",
    "customer_lifetime_value.avg_active_months",
    {"expr": "count(customer_lifetime_value.customer_id)", "name": "customer_count"}
  ],
  "dimensions": ["regions.name", "customers.segment"],
  "filters": ["customer_lifetime_value.active_months >= 6"]
}' | uv run python -m semantic_layer.cli --model "$MODEL" --json --plan

echo ""
echo "============================================"
echo " Demo 3: Runtime aggregation on CTE columns + cross-source join"
echo "============================================"
echo ""
echo "Query: P90 churn score and max LTV by region continent"
echo ""

echo '{
  "measures": [
    {"expr": "percentile(churn_risk.score, 0.9)", "name": "p90_churn"},
    {"expr": "max(customer_lifetime_value.ltv_estimate)", "name": "max_ltv"}
  ],
  "dimensions": ["regions.continent"]
}' | uv run python -m semantic_layer.cli --model "$MODEL" --json --plan
