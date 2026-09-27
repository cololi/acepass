#!/usr/bin/env bash
# AcePass 代理发布门槛：两个**分开**的检查，互不冒充。
#
#   component  代理组件检查
#              nginx:1.27-alpine 按生产路径渲染 infra/proxy/nginx.conf.template，
#              挂载**真实** frontend/dist，并接一个占 8000 端口、网络别名为 api 的
#              上游容器 —— 模板里的 `upstream acepass_api { server api:8000; }`
#              因此真的能被解析。检查内容：80→443 的 301 目标（带端口与不带端口）、
#              443 上的 TLS 握手、/login 由真实产物提供且脚本资源可加载、/health/
#              能穿过代理到达上游。
#              **不检查**：AcePass API、数据库、会话与登录是否真的可用。
#
#   full-stack 全栈登录检查
#              用 infra/docker/docker-compose.yml 起真实 postgres/redis/api/web，
#              构建真实应用镜像，执行真实迁移，创建真实账户，然后**经 HTTPS 代理**
#              完成一次带 CSRF 的真实登录并读取会话。
#
# 两者都使用 finally 式清理（trap EXIT），无论成功失败都不留容器/网络/卷。
# GitHub Actions 上的实际执行状态由 CI 记录；脚本自身不声称已经被 CI 跑过。
set -euo pipefail

MODE="${1:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

COMPOSE_FILE="infra/docker/docker-compose.yml"
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

# 证书只生成一次：gen-dev-certs.sh 拒绝覆盖已有文件（退出码 1），CI 里前一步
# 已经生成过，这里必须复用而不是再调一次。
ensure_certs() {
  if [ ! -e infra/docker/certs/tls.crt ] || [ ! -e infra/docker/certs/tls.key ]; then
    bash scripts/gen-dev-certs.sh infra/docker/certs localhost >/dev/null
  fi
  test -s infra/docker/certs/tls.crt && test -s infra/docker/certs/tls.key || {
    echo "缺少 TLS 证书 infra/docker/certs/tls.{crt,key}"; exit 1; }
}

usage() {
  echo "用法: bash scripts/verify_proxy.sh component|full-stack" >&2
  exit 2
}

# --------------------------------------------------------------------------
# component：跳转 / TLS / 真实 SPA 产物 / 上游解析
# --------------------------------------------------------------------------
run_component() {
  echo "== 范围：代理组件（nginx + 真实 frontend/dist + 桩上游）。不证明 AcePass API 登录。=="
  if [ ! -f frontend/dist/index.html ]; then
    echo "缺少 frontend/dist：请先构建前端产物（npm ci && npx vite build）" >&2
    exit 1
  fi
  ensure_certs

  # 名字写成字面量：EXIT trap 在函数返回后执行，local 变量那时已经出栈。
  cleanup() {
    docker rm -f acepass-proxy-web acepass-proxy-upstream >/dev/null 2>&1 || true
    docker network rm acepass-proxy-component >/dev/null 2>&1 || true
  }
  # 先清一次，再注册退出清理：失败路径同样不留残留。
  cleanup
  trap cleanup EXIT

  local network=acepass-proxy-component
  local upstream=acepass-proxy-upstream
  local proxy=acepass-proxy-web

  docker network create "${network}" >/dev/null
  local stub_conf
  stub_conf="$(mktemp)"
  cat > "${stub_conf}" <<'CONF'
server {
    listen 8000;
    location = /health/ready { return 200 "stub-upstream-ready\n"; }
    location / { return 200 "stub-upstream\n"; }
}
CONF
  docker run -d --name "${upstream}" --network "${network}" --network-alias api \
    -v "${stub_conf}:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null
  docker run -d --name "${proxy}" --network "${network}" \
    -e ACEPASS_HTTPS_PORT=18443 \
    -v "${REPO_ROOT}/infra/proxy/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro" \
    -v "${REPO_ROOT}/infra/docker/certs:/etc/nginx/certs:ro" \
    -v "${REPO_ROOT}/frontend/dist:/usr/share/nginx/html:ro" \
    -p 18080:80 -p 18443:443 nginx:1.27-alpine >/dev/null

  local ready=""
  for _ in $(seq 1 30); do
    if curl -sk -o /dev/null "https://127.0.0.1:18443/login"; then ready=1; break; fi
    sleep 1
  done
  test -n "${ready}" || { echo "代理容器未在 30 秒内就绪"; docker logs "${proxy}" || true; exit 1; }

  local location vhost
  location="$(curl -s -o /dev/null -D - http://127.0.0.1:18080/login | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
  echo "Location: ${location}"
  test "${location}" = "https://127.0.0.1:18443/login" || {
    echo "明文入口跳转目标错误：期望 https://127.0.0.1:18443/login，实际 ${location}"; exit 1; }
  vhost="$(curl -s -o /dev/null -D - -H 'Host: acepass.example.com' http://127.0.0.1:18080/login | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
  echo "Location (no port): ${vhost}"
  test "${vhost}" = "https://acepass.example.com/login" || {
    echo "无端口 Host 跳转目标错误：实际 ${vhost}"; exit 1; }

  # 上游解析：模板里的 `server api:8000` 必须真的解析并转发，否则干净环境里
  # nginx -t 会直接失败，或者运行期 502。
  local health
  health="$(curl -sk "https://127.0.0.1:18443/health/ready")"
  test "${health}" = "stub-upstream-ready" || {
    echo "上游未解析或代理未转发：/health/ready 返回 '${health}'"; exit 1; }
  echo "上游解析与代理转发：ok"

  # 真实产物：/login 由挂载的 frontend/dist/index.html 提供，引用的脚本资源可加载。
  local body asset asset_code asset_type
  body="$(curl -sk "https://127.0.0.1:18443/login")"
  grep -q 'AcePass' <<<"${body}" || { echo "登录页面缺少 AcePass 标题"; exit 1; }
  grep -q 'id="root"' <<<"${body}" || { echo "登录页面缺少 SPA 挂载点"; exit 1; }
  asset="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' <<<"${body}" | head -1)"
  test -n "${asset}" || { echo "登录页面未引用构建产物脚本"; exit 1; }
  asset_code="$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:18443${asset}")"
  asset_type="$(curl -sk -o /dev/null -w '%{content_type}' "https://127.0.0.1:18443${asset}")"
  echo "登录页脚本资源 ${asset}: HTTP ${asset_code} (${asset_type})"
  test "${asset_code}" = "200" || { echo "登录页脚本资源不可加载"; exit 1; }
  case "${asset_type}" in
    *javascript*) ;;
    *) echo "登录页脚本资源 Content-Type 异常：${asset_type}"; exit 1 ;;
  esac
  echo "组件检查通过：301 目标、TLS、真实产物与上游解析。"
}

# --------------------------------------------------------------------------
# full-stack：真实镜像 + 真实数据库 + 经代理的真实登录
# --------------------------------------------------------------------------
run_full_stack() {
  echo "== 范围：全栈（真实 api/postgres/redis/web + 经 HTTPS 代理的真实登录）。=="
  local http_port="${ACEPASS_HTTP_PORT:-8080}"
  local https_port="${ACEPASS_HTTPS_PORT:-8443}"
  local base="https://localhost:${https_port}"
  local email="ci-login@acepass.test"
  local password="Ci-Login-Password-1"

  cleanup() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
  cleanup
  trap cleanup EXIT

  cp infra/docker/.env.example infra/docker/.env
  # 覆盖为「本机/CI 回环 + 实际公开端口」：默认的 acepass.example.com 在这里解析不到，
  # 而 public 方案必须是 https://（prod.py 会拒绝非回环的 http 来源）。
  cat >> infra/docker/.env <<ENV
DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1
DJANGO_CSRF_TRUSTED_ORIGINS=https://localhost:${https_port},https://127.0.0.1:${https_port}
ACEPASS_HTTP_PORT=${http_port}
ACEPASS_HTTPS_PORT=${https_port}
ENV

  ensure_certs
  echo "构建真实应用镜像..."
  "${COMPOSE[@]}" build api
  "${COMPOSE[@]}" up -d postgres redis api web

  local api_id health=""
  api_id="$("${COMPOSE[@]}" ps -q api)"
  for _ in $(seq 1 60); do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${api_id}")"
    if [ "${health}" = "healthy" ]; then break; fi
    sleep 5
  done
  test "${health}" = "healthy" || {
    echo "api 未就绪（health=${health}）"; "${COMPOSE[@]}" logs --tail=80 api || true; exit 1; }

  "${COMPOSE[@]}" exec -T api python manage.py migrate --noinput
  "${COMPOSE[@]}" exec -T api python manage.py create_account "${email}" \
    --password "${password}" --display-name "CI Login"

  local cookies login_body token login_code me
  cookies="$(mktemp)"
  login_body="$(mktemp)"
  # 真实登录：先取 CSRF Cookie/Token，再带 Cookie + X-CSRFToken 经 HTTPS 代理登录。
  token="$(curl -sk -c "${cookies}" "${base}/api/v1/auth/csrf" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf_token"])')"
  test -n "${token}" || { echo "未取到 CSRF token"; exit 1; }
  login_code="$(curl -sk -b "${cookies}" -c "${cookies}" \
    -H 'Content-Type: application/json' -H "X-CSRFToken: ${token}" -H "Referer: ${base}/login" \
    -o "${login_body}" -w '%{http_code}' \
    -d "{\"email\":\"${email}\",\"password\":\"${password}\"}" \
    "${base}/api/v1/auth/login")"
  echo "全栈登录 HTTP ${login_code}"
  test "${login_code}" = "200" || { echo "全栈登录失败"; cat "${login_body}"; exit 1; }
  grep -q "${email}" "${login_body}" || { echo "登录响应缺少账户"; cat "${login_body}"; exit 1; }
  me="$(curl -sk -b "${cookies}" "${base}/api/v1/auth/me")"
  grep -q "${email}" <<<"${me}" || { echo "代理后的会话不可用：${me}"; exit 1; }
  # 登录页面本体同样来自真实产物。
  curl -sk "${base}/login" | grep -q 'id="root"' || { echo "登录页面不是真实 SPA 产物"; exit 1; }
  echo "全栈检查通过：真实镜像、真实迁移、经 TLS 代理的真实登录与会话。"
}

case "${MODE}" in
  component) run_component ;;
  full-stack) run_full_stack ;;
  *) usage ;;
esac
