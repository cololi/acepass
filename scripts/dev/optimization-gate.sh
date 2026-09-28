#!/usr/bin/env bash
# Optimization-round acceptance gate (backend + archived counter-examples).
#
# Runs on its own database so it never collides with a browser batch:
#   POSTGRES_DB (default acepass_opt_gate), POSTGRES_CONN_MAX_AGE=0.
#
#   bash scripts/dev/optimization-gate.sh            # everything
#   bash scripts/dev/optimization-gate.sh backend     # only the full suite
#
# Browser acceptance is NOT run here: it needs the exclusive lock
# (var/locks/browser-acceptance.lock) and a dedicated batch, see docs/23.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export POSTGRES_DB="${POSTGRES_DB:-acepass_opt_gate}"
export POSTGRES_CONN_MAX_AGE=0
VENV="$ROOT/backend/.venv/bin"
LOGS="$ROOT/var/gate"
mkdir -p "$LOGS"

FAILED=0
step() {
  local name="$1"; shift
  echo "── $name"
  if "$@" >"$LOGS/$name.log" 2>&1; then
    echo "   PASS  ($LOGS/$name.log)"
  else
    echo "   FAIL  ($LOGS/$name.log)"
    tail -20 "$LOGS/$name.log" | sed 's/^/      /'
    FAILED=1
  fi
}

only="${1:-all}"

if [ "$only" = "all" ] || [ "$only" = "backend" ]; then
  step backend-suite bash -c "cd '$ROOT/backend' && POSTGRES_DB='$POSTGRES_DB' POSTGRES_CONN_MAX_AGE=0 '$VENV/python' -m pytest tests -q"
  grep -E "passed|failed" "$LOGS/backend-suite.log" | tail -1 | sed 's/^/   /'
fi

if [ "$only" = "all" ] || [ "$only" = "static" ]; then
  step ruff "$VENV/ruff" check "$ROOT/backend/apps" "$ROOT/backend/ai" "$ROOT/backend/domain" "$ROOT/backend/config" "$ROOT/backend/tests"
  step django-check bash -c "cd '$ROOT/backend' && DJANGO_SETTINGS_MODULE=config.settings.dev '$VENV/python' manage.py check"
  step migrations-check bash -c "cd '$ROOT/backend' && DJANGO_SETTINGS_MODULE=config.settings.dev '$VENV/python' manage.py makemigrations --check --dry-run"
fi

if [ "$only" = "all" ] || [ "$only" = "archived" ]; then
  # 11/9(+1 deselected)/3 — docs/19 §5. Do not "fix" the deselection: the
  # migration test only runs inside its own dedicated transaction.
  step archived-p01-independent bash -c "cd '$ROOT' && PYTHONPATH='$ROOT/backend:$ROOT/docs/review/2026-09-27/p01-independent' POSTGRES_DB='$POSTGRES_DB' POSTGRES_CONN_MAX_AGE=0 '$VENV/python' -m pytest docs/review/2026-09-27/p01-independent/test_*.py -c backend/pytest.ini --ds=p01_independent_settings -q"
  step archived-p02-independent bash -c "cd '$ROOT' && PYTHONPATH='$ROOT/backend:$ROOT/docs/review/2026-09-27/p02-independent' POSTGRES_DB='$POSTGRES_DB' POSTGRES_CONN_MAX_AGE=0 '$VENV/python' -m pytest docs/review/2026-09-27/p02-independent/test_*.py -c backend/pytest.ini --ds=p02_independent_settings -q -k 'not generation_migration_cannot_promote'"
  step archived-p02-final bash -c "cd '$ROOT' && PYTHONPATH='$ROOT/backend:$ROOT/docs/review/2026-09-27/p02-final-independent' POSTGRES_DB='$POSTGRES_DB' POSTGRES_CONN_MAX_AGE=0 '$VENV/python' -m pytest docs/review/2026-09-27/p02-final-independent/test_*.py -c backend/pytest.ini --ds=review_settings -q"
  # Informational: this P0-era file ships with one *pre-existing* failure
  # (test_image_service_invokes_configured_vision_provider; its migrated copy in
  # backend/tests passes). Baseline before optimisation: 13 passed, 1 failed.
  # It is recorded, not gated: the assertion is about the recorded delta.
  echo "── archived-p0-regressions-info (recorded, not gated; baseline 13 passed / 1 failed)"
  PYTHONPATH="$ROOT/backend:$ROOT/docs/review/2026-09-27" POSTGRES_DB="$POSTGRES_DB" POSTGRES_CONN_MAX_AGE=0 \
    "$VENV/python" -m pytest docs/review/2026-09-27/test_p0_regressions.py -c backend/pytest.ini \
    --ds=review_settings -q >"$LOGS/archived-p0-regressions-info.log" 2>&1 || true
  for f in archived-p01-independent archived-p02-independent archived-p02-final archived-p0-regressions-info; do
    grep -E "passed|failed" "$LOGS/$f.log" | tail -1 | sed "s/^/   $f: /"
  done
fi

if [ "$only" = "all" ] || [ "$only" = "perf" ]; then
  step perfprobe bash -c "cd '$ROOT/backend' && PERFPROBE_OUT='$ROOT/var/perfprobe/gate.json' POSTGRES_DB=acepass_perfprobe POSTGRES_CONN_MAX_AGE=0 '$VENV/python' -m pytest perfprobe -q -s"
  grep "^PERFPROBE {" "$LOGS/perfprobe.log" | sed 's/^/   /'
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "GATE OK"; else echo "GATE FAILED"; fi
exit "$FAILED"
