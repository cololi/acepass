#!/usr/bin/env bash
# AcePass restore into an EMPTY database and media directory.
#
# Usage: scripts/restore.sh <backup-dir> <target-db> [target-media-dir]
# The target database must not exist yet: a restore is verified by recovering
# into a clean location and then comparing the media manifest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
SRC="${1:?用法: scripts/restore.sh <backup-dir> <target-db> [target-media-dir]}"
TARGET_DB="${2:?目标数据库名必填}"
TARGET_MEDIA="${3:-$ROOT/var/restore-check/media}"

: "${POSTGRES_USER:=acepass}"
: "${POSTGRES_HOST:=127.0.0.1}"
: "${POSTGRES_PORT:=5432}"
export PGPASSWORD="${POSTGRES_PASSWORD:-acepass_dev_pw}"

[ -f "$SRC/database.dump" ] || { echo "找不到 $SRC/database.dump"; exit 1; }

if psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='$TARGET_DB'" | grep -q 1; then
  echo "目标数据库 $TARGET_DB 已存在：恢复必须恢复到空位置，避免覆盖现有数据。"
  exit 1
fi

echo "==> 1/4 create target database ${TARGET_DB}"
psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
  -c "CREATE DATABASE \"$TARGET_DB\" OWNER \"$POSTGRES_USER\" ENCODING 'UTF8';"

echo "==> 2/4 恢复数据库"
pg_restore \
  --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" --username="$POSTGRES_USER" \
  --dbname="$TARGET_DB" --no-owner --no-privileges --single-transaction \
  "$SRC/database.dump"

echo "==> 3/4 restore media into ${TARGET_MEDIA}"
mkdir -p "$TARGET_MEDIA"
tar -xzf "$SRC/media.tar.gz" -C "$TARGET_MEDIA"

echo "==> 4/4 校验文件清单"
if [ -s "$SRC/media-manifest.sha256" ]; then
  (cd "$TARGET_MEDIA" && shasum -a 256 -c "$SRC/media-manifest.sha256" --quiet) \
    && echo "    文件校验通过（内容与备份一致）"
else
  echo "    （备份中没有文件清单）"
fi

echo "==> 恢复完成。用下面命令核对业务事实："
cat <<TIP
  POSTGRES_DB=$TARGET_DB ACEPASS_PRIVATE_MEDIA_ROOT=$TARGET_MEDIA \\
    $BACKEND/.venv/bin/python $BACKEND/manage.py shell -c \\
    "from apps.practice.models import Attempt,GradeEvent;from apps.question_bank.models import QuestionVersion;print('attempts', Attempt.objects.count(), 'grades', GradeEvent.objects.count(), 'versions', QuestionVersion.objects.count())"
TIP
