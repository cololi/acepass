#!/usr/bin/env bash
# AcePass restore into an EMPTY database and an EMPTY media directory.
#
# 用法:
#   scripts/restore.sh [--dry-run] <backup-dir> <target-db> [target-media-dir]
#
# 恢复前按顺序检查，全部通过后才写入任何东西：
#   1. 备份目录必须同时含 database.dump、media.tar.gz、media-manifest.sha256；
#   2. 目标媒体目录必须不存在或为空 —— 非空就拒绝，绝不覆盖已有文件；
#   3. 目标数据库必须不存在 —— 恢复只恢复到干净位置。
# 恢复后校验 media-manifest.sha256（backup.sh 写入的 `shasum -a 256` 清单，相对路径）：
#   * 逐文件比对 SHA-256；
#   * 报告 missing（清单里有、恢复目录没有）与 extra（恢复目录多出、清单里没有）。
#
# --dry-run: 只做前置检查并打印恢复计划与目标目录/清单差异，不创建数据库、不写文件。
#             退出码与真实恢复的前置判定一致：0 = 可以恢复，1 = 被拒绝。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

SRC="${1:?用法: scripts/restore.sh [--dry-run] <backup-dir> <target-db> [target-media-dir]}"
TARGET_DB="${2:?目标数据库名必填}"
TARGET_MEDIA="${3:-$ROOT/var/restore-check/media}"
MANIFEST="$(cd "$SRC" 2>/dev/null && pwd || echo "$SRC")/media-manifest.sha256"

: "${POSTGRES_USER:=acepass}"
: "${POSTGRES_HOST:=127.0.0.1}"
: "${POSTGRES_PORT:=5432}"
export PGPASSWORD="${POSTGRES_PASSWORD:-acepass_dev_pw}"

# GNU 系统没有 shasum（Perl 脚本）时退回 sha256sum；两者清单格式一致。
if command -v shasum >/dev/null 2>&1; then
  SHA256_CHECK=(shasum -a 256 -c --quiet)
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256_CHECK=(sha256sum -c --quiet)
else
  SHA256_CHECK=()
fi

MISSING=""
EXTRA=""
EXPECTED_COUNT=0
ACTUAL_COUNT=0

fail() {
  echo "错误：$*" >&2
  exit 1
}

# 清单中的相对路径（去掉 `shasum` 输出的 64 位摘要与分隔空白，保留含空格的文件名）。
list_expected() {
  [ -s "$MANIFEST" ] || return 0
  sed -e 's/^[0-9a-fA-F]\{64\}[[:space:]]\{1,\}//' "$MANIFEST" | LC_ALL=C sort
}

# 目标目录里的实际文件（与 backup.sh 的 find 口径一致：相对 `./` 路径）。
list_actual() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  (cd "$dir" && find . -type f -print | LC_ALL=C sort)
}

# 计算 missing/extra/计数，结果写入上面的全局变量。
manifest_diff() {
  local target="$1" tmp_expected tmp_actual
  tmp_expected="$(mktemp "${TMPDIR:-/tmp}/acepass-expected.XXXXXX")"
  tmp_actual="$(mktemp "${TMPDIR:-/tmp}/acepass-actual.XXXXXX")"
  list_expected > "$tmp_expected"
  list_actual "$target" > "$tmp_actual"
  MISSING="$(comm -23 "$tmp_expected" "$tmp_actual" || true)"
  EXTRA="$(comm -13 "$tmp_expected" "$tmp_actual" || true)"
  EXPECTED_COUNT="$(wc -l < "$tmp_expected" | tr -d ' ')"
  ACTUAL_COUNT="$(wc -l < "$tmp_actual" | tr -d ' ')"
  rm -f "$tmp_expected" "$tmp_actual"
}

report_diff() {
  echo "    清单条目：${EXPECTED_COUNT}；目标目录文件：${ACTUAL_COUNT}"
  if [ -n "$MISSING" ]; then
    echo "    missing（清单有、目标目录没有）："
    printf '%s\n' "$MISSING" | sed 's/^/      /'
  fi
  if [ -n "$EXTRA" ]; then
    echo "    extra（目标目录多出、清单没有）："
    printf '%s\n' "$EXTRA" | sed 's/^/      /'
  fi
  if [ -z "$MISSING" ] && [ -z "$EXTRA" ]; then
    echo "    文件集合一致：无 missing、无 extra"
  fi
}

# --------------------------------------------------------------------------
# 前置检查（任何写入之前）
# --------------------------------------------------------------------------
[ -f "$SRC/database.dump" ] || fail "找不到 $SRC/database.dump"
[ -f "$SRC/media.tar.gz" ] || fail "找不到 $SRC/media.tar.gz"
[ -f "$MANIFEST" ] || fail "找不到媒体清单 ${MANIFEST}（备份不完整，恢复无法校验）"

if [ -d "$TARGET_MEDIA" ] && [ -n "$(find "$TARGET_MEDIA" -mindepth 1 -print -quit)" ]; then
  fail "目标媒体目录非空：${TARGET_MEDIA}。恢复只写入空目录，避免覆盖已有文件；请先自行备份并清空该目录。"
fi

# 目标数据库必须不存在 —— 恢复只恢复到干净位置。
#
# 连接失败与"数据库不存在"必须区分开：以前这条 `psql | grep -q 1` 在数据库端口
# 不可连时同样返回非零，脚本于是认定"目标库不存在"，dry-run 还会 exit 0 声称
# 前置检查全部通过。现在先确认查询本身成功，再判断存在性。
if ! DB_EXISTS="$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='$TARGET_DB'")"; then
  fail "无法连接数据库 ${POSTGRES_USER}@${POSTGRES_HOST}:${POSTGRES_PORT}：恢复前置检查无法完成，已拒绝（不是「目标库不存在」）。"
fi
if [ "$DB_EXISTS" = "1" ]; then
  fail "目标数据库 $TARGET_DB 已存在：恢复必须恢复到空位置，避免覆盖现有数据。"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> dry-run：只做前置检查，不写数据库、不写文件"
  echo "    备份目录：$(cd "$SRC" && pwd)"
  echo "    目标数据库：${TARGET_DB}（不存在，可恢复）"
  echo "    目标媒体目录：${TARGET_MEDIA}（不存在或为空，可恢复）"
  manifest_diff "$TARGET_MEDIA"
  report_diff
  echo "==> dry-run 通过：前置检查全部满足，可以执行真实恢复（去掉 --dry-run）。"
  echo "    注意：dry-run 不解压、不校验备份包内字节与清单是否一致，真实恢复会做完整校验。"
  exit 0
fi

echo "==> 1/5 create target database ${TARGET_DB}"
psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres \
  -c "CREATE DATABASE \"$TARGET_DB\" OWNER \"$POSTGRES_USER\" ENCODING 'UTF8';"

echo "==> 2/5 恢复数据库"
pg_restore \
  --host="$POSTGRES_HOST" --port="$POSTGRES_PORT" --username="$POSTGRES_USER" \
  --dbname="$TARGET_DB" --no-owner --no-privileges --single-transaction \
  "$SRC/database.dump"

echo "==> 3/5 restore media into ${TARGET_MEDIA}"
mkdir -p "$TARGET_MEDIA"
tar -xzf "$SRC/media.tar.gz" -C "$TARGET_MEDIA"

echo "==> 4/5 校验文件清单"
manifest_diff "$TARGET_MEDIA"
report_diff

if [ -n "$MISSING" ] || [ -n "$EXTRA" ]; then
  fail "媒体清单校验失败：missing 或 extra 非空，恢复结果与备份不一致。"
fi

if [ "${#SHA256_CHECK[@]}" -gt 0 ] && [ -s "$MANIFEST" ]; then
  # Verify inside the restored media root; the manifest holds relative paths.
  (cd "$TARGET_MEDIA" && "${SHA256_CHECK[@]}" "$MANIFEST") \
    || fail "媒体内容校验失败：恢复出的文件字节与备份清单不一致。"
  echo "    media manifest verified: restored bytes match the backup"
elif [ ! -s "$MANIFEST" ]; then
  echo "    (backup has no media manifest entries; target media must be empty — checked above)"
else
  echo "    警告：找不到 shasum/sha256sum，跳过字节校验（文件集合已比对）。" >&2
fi

echo "==> 5/5 恢复完成。用下面命令核对业务事实："
cat <<TIP
  POSTGRES_DB=$TARGET_DB ACEPASS_PRIVATE_MEDIA_ROOT=$TARGET_MEDIA \\
    $BACKEND/.venv/bin/python $BACKEND/manage.py shell -c \\
    "from apps.practice.models import Attempt,GradeEvent;from apps.question_bank.models import QuestionVersion;print('attempts', Attempt.objects.count(), 'grades', GradeEvent.objects.count(), 'versions', QuestionVersion.objects.count())"
TIP
