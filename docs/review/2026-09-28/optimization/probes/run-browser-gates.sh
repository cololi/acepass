#!/usr/bin/env bash
# W4 browser gates, run under the single-runner lock.
#
#   1. main acceptance suite  (--grep-invert "@stub")            -> expect 78 passed
#   2. archived counter-examples (same DB, no globalSetup)        -> expect 2 passed
#   3. reset again, stub-only run (--grep "@stub")                -> expect 8 passed
#
# The lock is `var/locks/browser-acceptance.lock` (mkdir is atomic). It is
# released by the EXIT trap even if a step fails.
set -uo pipefail

ROOT="/Users/cololi/Documents/AcePass"
LOGS="${ROOT}/docs/review/2026-09-28/optimization/logs"
DB="acepass_acceptance_p2_batch3"
MEDIA="${ROOT}/var/private-media-p2-batch3"
LOCK="${ROOT}/var/locks/browser-acceptance.lock"

cd "${ROOT}"
mkdir -p var/locks
attempt=0
until mkdir "${LOCK}" 2>/dev/null; do
  attempt=$((attempt + 1))
  echo "waiting-for-browser-lock (attempt ${attempt})"
  sleep 20
done
echo "lock acquired: ${LOCK}"
trap 'rmdir "${LOCK}" 2>/dev/null && echo "lock released"' EXIT

export POSTGRES_DB="${DB}"
export REDIS_URL="redis://127.0.0.1:6399/0"
export DJANGO_SETTINGS_MODULE="config.settings.dev"
export ACEPASS_INLINE_TASKS="false"
export ACEPASS_PRIVATE_MEDIA_ROOT="${MEDIA}"
export POSTGRES_CONN_MAX_AGE="0"
export ACEPASS_BROWSER_API_PORT="8019"
export ACEPASS_BROWSER_WEB_PORT="5189"

echo "=== step 1: reset + main suite ==="
bash scripts/dev/reset-p2-batch3-browser.sh
(
  cd frontend
  node_modules/.bin/playwright test --config playwright.acceptance.config.ts --grep-invert "@stub"
) > "${LOGS}/22-gate-browser-main.txt" 2>&1
echo "MAIN_EXIT=$?" | tee -a "${LOGS}/22-gate-browser-main.txt"

echo "=== step 2: archived counter-examples on the same DB (ports 6394/8014/5184) ==="
export REDIS_URL="redis://127.0.0.1:6394/0"
export ACEPASS_BROWSER_API_PORT="8014"
export ACEPASS_BROWSER_WEB_PORT="5184"
(
  cd "${ROOT}"
  frontend/node_modules/.bin/playwright test \
    --config docs/review/2026-09-27/p01-independent/playwright.remaining.config.cjs
) > "${LOGS}/23-gate-browser-archived.txt" 2>&1
echo "ARCHIVED_EXIT=$?" | tee -a "${LOGS}/23-gate-browser-archived.txt"

echo "=== step 3: reset + stub-only run ==="
export REDIS_URL="redis://127.0.0.1:6399/0"
export ACEPASS_BROWSER_API_PORT="8019"
export ACEPASS_BROWSER_WEB_PORT="5189"
export ACEPASS_AI_PROVIDER="stub"
export ACEPASS_RUNTIME_MODE="demo"
bash scripts/dev/reset-p2-batch3-browser.sh
(
  cd frontend
  node_modules/.bin/playwright test --config playwright.acceptance.config.ts --grep "@stub"
) > "${LOGS}/24-gate-browser-stub.txt" 2>&1
echo "STUB_EXIT=$?" | tee -a "${LOGS}/24-gate-browser-stub.txt"

echo "=== tail summaries ==="
for f in 22-gate-browser-main.txt 23-gate-browser-archived.txt 24-gate-browser-stub.txt; do
  printf "%-32s " "$f"
  grep -E "^[0-9]+ (passed|failed)|passed|failed" "${LOGS}/${f}" | tail -1
done
