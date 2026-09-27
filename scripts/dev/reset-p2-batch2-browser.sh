#!/usr/bin/env bash
# Recreate the isolated browser-acceptance environment for P2 batch 2
# (content sealing and family merge, AI variant proposals with independent
# validation).
#
# Dedicated database, dedicated Redis instance, dedicated media directory only.
# The developer database, the 8000/5173 services and the default Redis are never
# touched. Earlier batches use different names/ports so the runs can never erase
# each other's evidence.
#
# Usage: bash scripts/dev/reset-p2-batch2-browser.sh [db_name] [redis_port]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${1:-acepass_acceptance_p2_batch2}"
REDIS_PORT="${2:-6398}"
MEDIA="${ROOT}/var/private-media-p2-batch2"

case "${DB}" in
  acepass_acceptance_*|acepass_browser_audit_*) ;;
  *) echo "refusing: ${DB} is not a dedicated acceptance database name" >&2; exit 2 ;;
esac
case "${REDIS_PORT}" in
  6394|6395|6396|6397|6398|6380|6381) ;;
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
