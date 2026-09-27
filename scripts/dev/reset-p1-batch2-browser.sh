#!/usr/bin/env bash
# Recreate the isolated browser-acceptance environment for the P1 second batch
# (prerequisite graph, tag suggestions, hybrid retrieval, FSRS memory cards).
#
# Dedicated database, dedicated Redis instance, dedicated media directory only.
# The developer database, the 8000/5173 services and the default Redis are never
# touched. The database name must start with an acceptance prefix; anything else
# is refused. The P1 first-batch environment (`acepass_acceptance_p1_batch`,
# ports 8014/5184) is intentionally a different name/port pair so the two runs
# can never erase each other's evidence.
#
# Usage: bash scripts/dev/reset-p1-batch2-browser.sh [db_name] [redis_port]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${1:-acepass_acceptance_p1_batch2}"
REDIS_PORT="${2:-6395}"
MEDIA="${ROOT}/var/private-media-p1-batch2"

case "${DB}" in
  acepass_acceptance_*|acepass_browser_audit_*) ;;
  *) echo "refusing: ${DB} is not a dedicated acceptance database name" >&2; exit 2 ;;
esac
case "${REDIS_PORT}" in
  6394|6395|6380|6381) ;;
  *) echo "refusing: redis port ${REDIS_PORT} is not a dedicated acceptance port" >&2; exit 2 ;;
esac

export PGPASSWORD="${POSTGRES_PASSWORD:-acepass_dev_pw}"
psql -h "${POSTGRES_HOST:-127.0.0.1}" -p "${POSTGRES_PORT:-5432}" \
  -U "${POSTGRES_USER:-acepass}" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}' AND pid<>pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS ${DB};" \
  -c "CREATE DATABASE ${DB} OWNER ${POSTGRES_USER:-acepass};" >/dev/null
rm -rf "${MEDIA}"
mkdir -p "${MEDIA}"
redis-cli -p "${REDIS_PORT}" flushall >/dev/null
echo "reset ${DB} / ${MEDIA} / redis ${REDIS_PORT}"
