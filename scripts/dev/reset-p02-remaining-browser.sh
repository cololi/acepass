#!/usr/bin/env bash
# Recreate the isolated browser-acceptance environment used while verifying the
# C01-C05 repair round. Dedicated database, Redis instance, media directory and
# ports only; the developer database and the 8000/5173 services are never touched.
#
# Usage: bash scripts/dev/reset-p02-remaining-browser.sh [db_name] [redis_port]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="${1:-acepass_acceptance_p02_remaining_browser}"
REDIS_PORT="${2:-6394}"
MEDIA="${ROOT}/var/private-media-p02-remaining-browser"

case "${DB}" in
  acepass_acceptance_*|acepass_browser_audit_*) ;;
  *) echo "refusing: ${DB} is not a dedicated acceptance database name" >&2; exit 2 ;;
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
