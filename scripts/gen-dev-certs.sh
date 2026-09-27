#!/usr/bin/env bash
# AcePass: 生成本地验证用的自签名 TLS 证书（仅用于本机/测试环境）。
#
# TLS 终止在 nginx 代理（见 infra/proxy/nginx.conf 与 backend/config/settings/prod.py
# 的 Deployment contract），代理容器从挂载目录读取：
#     <dir>/tls.crt  <dir>/tls.key
#
# 用法: scripts/gen-dev-certs.sh [输出目录] [证书 CN]
#   输出目录默认 infra/docker/certs（compose 默认挂载该目录）
#   CN 默认 localhost；SAN 固定包含 localhost / 127.0.0.1 / ::1，另加 CN
#
# 真实环境请使用受信任 CA（例如 Let's Encrypt）签发的证书，把 tls.crt/tls.key
# 放到工作目录或 ACEPASS_TLS_DIR 指向的位置。本脚本生成的证书不被任何浏览器信任。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/infra/docker/certs}"
CN="${2:-localhost}"
DAYS="${ACEPASS_DEV_CERT_DAYS:-365}"

if ! command -v openssl >/dev/null 2>&1; then
  echo "找不到 openssl，无法生成自签名证书。" >&2
  exit 1
fi

mkdir -p "$OUT"

if [ -e "$OUT/tls.crt" ] || [ -e "$OUT/tls.key" ]; then
  echo "已存在证书，拒绝覆盖：$OUT/tls.crt / $OUT/tls.key" >&2
  echo "如需重新生成，请先自行备份并删除这两个文件。" >&2
  exit 1
fi

CONF="$(mktemp "${TMPDIR:-/tmp}/acepass-cert.XXXXXX.cnf")"
trap 'rm -f "$CONF"' EXIT

cat > "$CONF" <<EOF
[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
distinguished_name = dn
x509_extensions    = v3_req

[dn]
CN = ${CN}
O  = AcePass local verification

[v3_req]
basicConstraints = critical, CA:FALSE
keyUsage         = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName   = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = ${CN}
IP.1  = 127.0.0.1
IP.2  = ::1
EOF

umask 077
openssl req -x509 -nodes -newkey rsa:2048 -days "$DAYS" \
  -config "$CONF" -keyout "$OUT/tls.key" -out "$OUT/tls.crt" >/dev/null 2>&1

chmod 600 "$OUT/tls.key"
chmod 644 "$OUT/tls.crt"

echo "==> 已生成自签名证书（本地验证用，浏览器不会信任）"
echo "    cert: $OUT/tls.crt"
echo "    key : $OUT/tls.key"
openssl x509 -in "$OUT/tls.crt" -noout -subject -dates -ext subjectAltName
