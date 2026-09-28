#!/usr/bin/env bash
# W3 browser acceptance for the frontend bundle optimisation.
#
# Uses the p2-batch3 isolated resources (Redis 6399 / API 8019 / Vite 5189,
# database acepass_acceptance_p2_batch3, media var/private-media-p2-batch3) and
# holds var/locks/browser-acceptance.lock for the whole run, because only one
# real-browser run may happen at a time. The lock is released by an EXIT trap, so
# a failing suite cannot leave it behind.
#
# Usage: bash perfprobe/run-acceptance.sh [extra playwright args...]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

mkdir -p var/locks
LOCK="${ROOT}/var/locks/browser-acceptance.lock"
until mkdir "${LOCK}" 2>/dev/null; do
  echo "waiting-for-browser-lock"
  sleep 20
done
# Absolute path on purpose: the body below `cd`s into frontend/, and a relative
# rmdir from there silently leaves the lock behind (observed on the first run).
release() {
  rmdir "${LOCK}" 2>/dev/null && echo "released browser-acceptance.lock"
}
trap release EXIT INT TERM

bash scripts/dev/reset-p2-batch3-browser.sh

cd "${ROOT}/frontend"
POSTGRES_DB=acepass_acceptance_p2_batch3 \
REDIS_URL=redis://127.0.0.1:6399/0 \
DJANGO_SETTINGS_MODULE=config.settings.dev \
ACEPASS_INLINE_TASKS=false \
ACEPASS_PRIVATE_MEDIA_ROOT="${ROOT}/var/private-media-p2-batch3" \
POSTGRES_CONN_MAX_AGE=0 \
ACEPASS_BROWSER_API_PORT=8019 \
ACEPASS_BROWSER_WEB_PORT=5189 \
  node_modules/.bin/playwright test --config playwright.acceptance.config.ts --grep-invert "@stub" "$@"
status=$?

echo "PLAYWRIGHT_EXIT=${status}"
exit "${status}"
