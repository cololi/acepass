#!/usr/bin/env bash
# AcePass backup: PostgreSQL dump + private media manifest and archive.
#
# Redis is deliberately NOT part of the backup: it only carries triggers, and
# every business fact lives in PostgreSQL (plus the private media files).
#
# Usage: scripts/backup.sh [output-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
OUT="${1:-$ROOT/var/backups/$(date -u +%Y%m%dT%H%M%SZ)}"
MEDIA="${ACEPASS_PRIVATE_MEDIA_ROOT:-$ROOT/var/private-media}"
KEEP_DAYS="${ACEPASS_BACKUP_KEEP_DAYS:-7}"

: "${POSTGRES_DB:=acepass}"
: "${POSTGRES_USER:=acepass}"
: "${POSTGRES_HOST:=127.0.0.1}"
: "${POSTGRES_PORT:=5432}"
# The password comes from the environment (or the local dev default).
export PGPASSWORD="${POSTGRES_PASSWORD:-acepass_dev_pw}"

mkdir -p "$OUT"
echo "==> 备份目录：$OUT"

echo "==> 1/3 database dump ${POSTGRES_DB} at ${POSTGRES_HOST}:${POSTGRES_PORT}"
pg_dump \
  --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" --username="$POSTGRES_USER" \
  --format=custom --no-owner --no-privileges \
  --file="$OUT/database.dump" "$POSTGRES_DB"

echo "==> 2/3 private media at ${MEDIA}"
if [ -d "$MEDIA" ] && [ -n "$(find "$MEDIA" -type f -print -quit)" ]; then
  # A manifest makes it possible to prove which objects a restore recovered.
  # Format is exactly `shasum -a 256` output with relative `./` paths, so
  # restore.sh can both re-check the hashes and diff the recovered file set.
  (cd "$MEDIA" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256) > "$OUT/media-manifest.sha256"
  echo "    文件数：$(wc -l < "$OUT/media-manifest.sha256" | tr -d " ")"
  tar -czf "$OUT/media.tar.gz" -C "$MEDIA" .
else
  # 目录不存在或为空：写空清单（不要调用 xargs，避免不同平台在空输入上行为不一致）。
  echo "    （媒体目录不存在或为空，记录为空清单）"
  : > "$OUT/media-manifest.sha256"
  tar -czf "$OUT/media.tar.gz" --files-from /dev/null
fi

echo "==> 3/3 版本信息"
{
  echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "database=$POSTGRES_DB"
  echo "media_root=$MEDIA"
  echo "git_revision=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo 'no-git')"
  "$BACKEND/.venv/bin/python" -c "import django;print('django=' + django.get_version())" 2>/dev/null || true
  (cd "$BACKEND" && "$BACKEND/.venv/bin/python" manage.py showmigrations --plan 2>/dev/null | tail -1) || true
} > "$OUT/backup-info.txt"
cat "$OUT/backup-info.txt"

echo "==> 清理超过 ${KEEP_DAYS} 天的旧备份"
find "$ROOT/var/backups" -maxdepth 1 -mindepth 1 -type d -mtime "+${KEEP_DAYS}" -print -exec rm -rf {} + 2>/dev/null || true

echo "==> 完成：$OUT"
