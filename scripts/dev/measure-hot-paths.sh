#!/usr/bin/env bash
# Query-budget / latency probe for AcePass read paths.
#
#   bash scripts/dev/measure-hot-paths.sh                 # every case
#   bash scripts/dev/measure-hot-paths.sh -k practice     # one case
#   PERFPROBE_OUT=var/perfprobe/after.json bash scripts/dev/measure-hot-paths.sh
#
# Runs on its own database (POSTGRES_DB defaults to acepass_perfprobe) so it can
# run next to a browser acceptance batch without touching it. CONN_MAX_AGE=0
# keeps the probe from holding idle connections against max_connections=100.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/backend"

LABEL="${PERFPROBE_LABEL:-$(date +%Y%m%d-%H%M%S)}"
OUT="${PERFPROBE_OUT:-$ROOT/var/perfprobe/$LABEL.json}"
mkdir -p "$(dirname "$OUT")"

echo "== perfprobe: label=$LABEL out=$OUT db=${POSTGRES_DB:-acepass_perfprobe} k=${*:-<all>} =="

POSTGRES_DB="${POSTGRES_DB:-acepass_perfprobe}" \
POSTGRES_CONN_MAX_AGE=0 \
PERFPROBE_OUT="$OUT" \
  .venv/bin/python -m pytest perfprobe -q -s "$@"

echo "== perfprobe done: $OUT =="
