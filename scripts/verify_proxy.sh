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
#
# 隔离约定（C05）——脚本自带，不要求调用者手工设置：
#   * 每次运行生成唯一身份：Compose 项目 `acepass-verify-<run>`、镜像标签、容器/
#     网络名、对外端口、env 文件与证书目录。默认项目 `acepass` 与既有部署不会被
#     触碰；唯一性与端口都由本脚本产生，而不是靠操作者记得导出变量。
#   * **不覆盖** `infra/docker/.env`：所有变量写进临时 env 文件（`--env-file`）
#     并同时导出到进程环境（进程环境优先于项目 `.env`），因此已有配置哨兵保持原样。
#   * **不删除无关卷/配置**：清理只针对本次运行创建的容器、网络、卷与镜像标签；
#     项目名带唯一后缀，`down --volumes` 因此只作用于本次创建的资源。成功与失败
#     路径都执行同样的清理，并保留 `infra/docker/.env`、`infra/docker/certs` 与
#     任何其他项目的卷。
set -euo pipefail

MODE="${1:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

COMPOSE_FILE="infra/docker/docker-compose.yml"

# --------------------------------------------------------------------------
# 唯一身份：本次运行的资源前缀、镜像标签、临时目录与端口
# --------------------------------------------------------------------------
RUN_ID="$(date +%Y%m%d%H%M%S)-$$-${RANDOM}"
PROJECT="acepass-verify-${RUN_ID}"
IMAGE_TAG="acepass-verify-${RUN_ID}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/acepass-proxy-${RUN_ID}.XXXXXX")"
ENV_FILE="${WORK_DIR}/verify.env"
TLS_DIR="${WORK_DIR}/certs"
NETWORK="acepass-proxy-${RUN_ID}"
UPSTREAM="acepass-proxy-${RUN_ID}-upstream"
PROXY="acepass-proxy-${RUN_ID}-web"

# 任何进入删除路径的东西都必须带本次运行的唯一后缀。写成函数而不是注释，是为了
# 让"误删既有资源"变成启动即失败，而不是运行到一半才发现。
guard_identity() {
  case "${PROJECT}" in
    acepass-verify-*) ;;
    *) echo "拒绝运行：Compose 项目名不是本次运行的唯一名（${PROJECT}）" >&2; exit 1 ;;
  esac
  case "${NETWORK}:${UPSTREAM}:${PROXY}" in
    acepass-proxy-*) ;;
    *) echo "拒绝运行：组件资源名不是本次运行的唯一名" >&2; exit 1 ;;
  esac
  [ -n "${WORK_DIR}" ] && [ -d "${WORK_DIR}" ] || {
    echo "拒绝运行：临时目录异常（${WORK_DIR}）" >&2; exit 1; }
}

# 由内核分配一个空闲端口（绑定 0.0.0.0:0），避免与既有服务/既有部署抢端口。
free_port() {
  python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("", 0))
    print(sock.getsockname()[1])
PY
}

usage() {
  echo "用法: bash scripts/verify_proxy.sh component|full-stack" >&2
  exit 2
}

# 证书只生成一次，且只生成到本次运行的临时目录：不读写 infra/docker/certs，
# 也就不可能覆盖既有部署正在使用的证书。
ensure_certs() {
  mkdir -p "${TLS_DIR}"
  bash scripts/gen-dev-certs.sh "${TLS_DIR}" localhost >/dev/null
  test -s "${TLS_DIR}/tls.crt" && test -s "${TLS_DIR}/tls.key" || {
    echo "缺少本次运行生成的 TLS 证书（${TLS_DIR}）" >&2; exit 1; }
}

# --------------------------------------------------------------------------
# component：跳转 / TLS / 真实 SPA 产物 / 上游解析
# --------------------------------------------------------------------------
run_component() {
  echo "== 范围：代理组件（nginx + 真实 frontend/dist + 桩上游）。不证明 AcePass API 登录。=="
  echo "== 本次运行：项目/资源前缀 ${RUN_ID}，临时目录 ${WORK_DIR} =="
  if [ ! -f frontend/dist/index.html ]; then
    echo "缺少 frontend/dist：请先构建前端产物（npm ci && npx vite build）" >&2
    exit 1
  fi
  guard_identity
  ensure_certs

  cleanup() {
    local status=$?
    trap - EXIT
    docker rm -f "${PROXY}" "${UPSTREAM}" >/dev/null 2>&1 || true
    docker network rm "${NETWORK}" >/dev/null 2>&1 || true
    rm -rf "${WORK_DIR}"
    exit "${status}"
  }
  # 只注册退出清理：资源名本来就唯一，不需要（也不允许）先删同名容器。
  trap cleanup EXIT

  local http_port https_port
  http_port="$(free_port)"
  https_port="$(free_port)"

  docker network create "${NETWORK}" >/dev/null
  cat > "${WORK_DIR}/upstream.conf" <<'CONF'
server {
    listen 8000;
    location = /health/ready { return 200 "stub-upstream-ready\n"; }
    location / { return 200 "stub-upstream\n"; }
}
CONF
  docker run -d --name "${UPSTREAM}" --network "${NETWORK}" --network-alias api \
    -v "${WORK_DIR}/upstream.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null
  docker run -d --name "${PROXY}" --network "${NETWORK}" \
    -e ACEPASS_HTTPS_PORT="${https_port}" \
    -v "${REPO_ROOT}/infra/proxy/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro" \
    -v "${TLS_DIR}:/etc/nginx/certs:ro" \
    -v "${REPO_ROOT}/frontend/dist:/usr/share/nginx/html:ro" \
    -p "127.0.0.1:${http_port}:80" -p "127.0.0.1:${https_port}:443" nginx:1.27-alpine >/dev/null

  local ready=""
  for _ in $(seq 1 30); do
    if curl -sk -o /dev/null "https://127.0.0.1:${https_port}/login"; then ready=1; break; fi
    sleep 1
  done
  test -n "${ready}" || { echo "代理容器未在 30 秒内就绪"; docker logs "${PROXY}" || true; exit 1; }

  local location vhost
  location="$(curl -s -o /dev/null -D - "http://127.0.0.1:${http_port}/login" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
  echo "Location: ${location}"
  test "${location}" = "https://127.0.0.1:${https_port}/login" || {
    echo "明文入口跳转目标错误：期望 https://127.0.0.1:${https_port}/login，实际 ${location}"; exit 1; }
  vhost="$(curl -s -o /dev/null -D - -H 'Host: acepass.example.com' "http://127.0.0.1:${http_port}/login" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')"
  echo "Location (no port): ${vhost}"
  test "${vhost}" = "https://acepass.example.com/login" || {
    echo "无端口 Host 跳转目标错误：实际 ${vhost}"; exit 1; }

  # 上游解析：模板里的 `server api:8000` 必须真的解析并转发，否则干净环境里
  # nginx -t 会直接失败，或者运行期 502。
  local health
  health="$(curl -sk "https://127.0.0.1:${https_port}/health/ready")"
  test "${health}" = "stub-upstream-ready" || {
    echo "上游未解析或代理未转发：/health/ready 返回 '${health}'"; exit 1; }
  echo "上游解析与代理转发：ok"

  # 真实产物：/login 由挂载的 frontend/dist/index.html 提供，引用的脚本资源可加载。
  local body asset asset_code asset_type
  body="$(curl -sk "https://127.0.0.1:${https_port}/login")"
  grep -q 'AcePass' <<<"${body}" || { echo "登录页面缺少 AcePass 标题"; exit 1; }
  grep -q 'id="root"' <<<"${body}" || { echo "登录页面缺少 SPA 挂载点"; exit 1; }
  asset="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' <<<"${body}" | head -1)"
  test -n "${asset}" || { echo "登录页面未引用构建产物脚本"; exit 1; }
  asset_code="$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:${https_port}${asset}")"
  asset_type="$(curl -sk -o /dev/null -w '%{content_type}' "https://127.0.0.1:${https_port}${asset}")"
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
  echo "== 本次运行：Compose 项目 ${PROJECT}，镜像 ${IMAGE_TAG}，临时目录 ${WORK_DIR} =="
  guard_identity

  local http_port https_port
  http_port="$(free_port)"
  https_port="$(free_port)"
  local base="https://localhost:${https_port}"
  local email="verify-${RUN_ID}@acepass.test"
  local password="Ci-Login-Password-1"

  # 唯一配置：临时 env 文件 + 进程环境（进程环境优先于项目目录 .env）。
  # 不读取、不写入、不复制 infra/docker/.env —— 那里的既有配置保持原样。
  cat > "${ENV_FILE}" <<ENV
DJANGO_SECRET_KEY=acepass-verify-${RUN_ID}-throwaway-secret-key-value
DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1
DJANGO_CSRF_TRUSTED_ORIGINS=https://localhost:${https_port},https://127.0.0.1:${https_port}
POSTGRES_DB=acepass_verify
POSTGRES_USER=acepass_verify
POSTGRES_PASSWORD=acepass-verify-${RUN_ID}
ACEPASS_HTTP_PORT=${http_port}
ACEPASS_HTTPS_PORT=${https_port}
ACEPASS_TLS_DIR=${TLS_DIR}
ACEPASS_IMAGE_TAG=${IMAGE_TAG}
ACEPASS_AI_PROVIDER=none
ENV
  chmod 600 "${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a

  COMPOSE=(docker compose --project-name "${PROJECT}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

  cleanup() {
    local status=$?
    trap - EXIT
    # Resolve the *api* service image through compose (the compose file names the
    # repository, the tag comes from ACEPASS_IMAGE_TAG), then delete it only when
    # the reference really carries this run's unique tag. `compose config --images`
    # is not usable here: it also lists dependency images in an unstable order, so
    # a naive `head -1` can hand this cleanup a developer's `redis:7-alpine`.
    local image_ref
    image_ref="$("${COMPOSE[@]}" config --format json 2>/dev/null \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("services",{}).get("api",{}).get("image",""))' \
      2>/dev/null || true)"
    # 只作用于本次运行的唯一项目：容器、网络与本次创建的数据卷。
    "${COMPOSE[@]}" down --remove-orphans --volumes >/dev/null 2>&1 || true
    case "${image_ref}" in
      *"${IMAGE_TAG}") docker image rm "${image_ref}" >/dev/null 2>&1 || true ;;
      "") ;;
      *) echo "跳过镜像清理：${image_ref} 不带本次运行的标签 ${IMAGE_TAG}" >&2 ;;
    esac
    rm -rf "${WORK_DIR}"
    exit "${status}"
  }
  trap cleanup EXIT

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
  cookies="$(mktemp "${WORK_DIR}/cookies.XXXXXX")"
  login_body="$(mktemp "${WORK_DIR}/login.XXXXXX")"
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
