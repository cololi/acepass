# AcePass 部署编排

状态：**本机（OrbStack + Docker）已实际构建并启动验证**（见文末「实测记录」）；尚未在真实目标
服务器上运行验证，也没有被授权的部署目标。请先在目标环境按本文逐条验证后再视为可用。

## 1. 服务划分

同一后端镜像以不同启动命令承担不同角色，业务端口只在内网：

| 服务 | 说明 | 端口 |
|---|---|---|
| `postgres` | PostgreSQL 16，数据卷 `postgres-data` | 仅内网 5432 |
| `redis` | Celery broker / 缓存，**开启 AOF+RDB 持久化**，卷 `redis-data` | 仅内网 6379 |
| `api` | Gunicorn（3 worker，120s 超时） | 仅内网 8000 |
| `worker-ingestion` / `worker-tutoring` / `worker-projection` | Celery worker（按队列） | 无 |
| `scheduler` | Celery beat | 无 |
| `web` | nginx：唯一对外入口，同源提供 SPA 与 `/api` | `${ACEPASS_HTTP_PORT:-8080}`→80、`${ACEPASS_HTTPS_PORT:-8443}`→443 |

## 2. TLS 终止方案（唯一终止点 = web/nginx）

- **80 只做 301 跳转**，443 终止 TLS；证书从 `ACEPASS_TLS_DIR`（默认 `./certs`）挂载到
  `/etc/nginx/certs`，文件名固定为 `tls.crt` / `tls.key`。
- **代理到 api 的一段是私网明文 HTTP**，nginx 显式发送 `X-Forwarded-Proto: https`。
- nginx 原样转发原始 `Host`，因此 Django 的 `ALLOWED_HOSTS` 必须包含公共域名。
- 公共方案始终是 HTTPS，**不通过关闭 HTTPS 来迁就内部探针**。

Django 侧使用同一份契约（`backend/config/settings/prod.py` 的 Deployment contract）：

| 设置 | 值 | 原因 |
|---|---|---|
| `SECURE_PROXY_SSL_HEADER` | `("HTTP_X_FORWARDED_PROTO", "https")` | 信任上面那一个代理头，代理请求不会被二次跳转 |
| `SECURE_SSL_REDIRECT` | 默认 `true`（`DJANGO_SECURE_SSL_REDIRECT`） | 未经代理、没有该头的请求仍被强制到 HTTPS |
| `SECURE_REDIRECT_EXEMPT` | 追加 `^health/live$`、`^health/ready$` | 容器内明文探针可用；豁免仅限这两个路径 |
| `USE_X_FORWARDED_HOST` | 默认 `false`（`DJANGO_USE_X_FORWARDED_HOST`） | 代理不改写 Host；再前置一层改写 Host 的代理时才置 true |
| `SESSION_COOKIE_SECURE` / `CSRF_COOKIE_SECURE` | `true` | 浏览器只经 HTTPS 访问 |
| `CSRF_TRUSTED_ORIGINS` | 必须 `https://…`（回环 `http://` 仅本机验证） | 与公共方案一致；出现 `http://` 公共来源时设置直接报错 |
| `ALLOWED_HOSTS` | 环境变量 + 回环名（`127.0.0.1`/`localhost`/`[::1]`） | 容器内探针与宿主机验证使用回环 Host |

证书来源：

- 真实环境：受信任 CA（如 Let's Encrypt）签发的证书，放到 `ACEPASS_TLS_DIR` 或默认 `./certs`；
  证书目录已加入 `.gitignore` / `.dockerignore`，**不要提交私钥**。
- 本机验证：`scripts/gen-dev-certs.sh ./certs`（自签名，浏览器不信任；已存在证书时拒绝覆盖）。
- 80 端口保留了 `/.well-known/acme-challenge/`（`certbot-webroot` 卷），便于 HTTP-01 轮换。

## 3. 健康检查与启动顺序

| 服务 | 探针 | 依赖条件 |
|---|---|---|
| `postgres` | `pg_isready -U $POSTGRES_USER -d $POSTGRES_DB` | — |
| `redis` | `redis-cli ping` | — |
| `api` | 容器内明文 HTTP `http://127.0.0.1:8000/health/ready`（对 HTTPS 跳转豁免，回环 Host 在 `ALLOWED_HOSTS` 内） | `postgres`、`redis` healthy |
| `web` | `nc -z 127.0.0.1 443 && nc -z 127.0.0.1 80`（nginx 镜像无 curl，busybox wget 会拒绝自签名证书） | `api` healthy |

`web` 依赖 `api` healthy，因此不会在 API 未就绪时对外提供服务；API 探针失败也不会被
`depends_on` 掩盖成「启动成功」。

## 4. 数据持久化与恢复

- 卷：`postgres-data`、`private-media`、`redis-data`、`certbot-webroot`。
- **Redis 必须持久化**：`--appendonly yes --appendfsync everysec --save 60 1000`，队列与缓存
  在重启/重建容器后可恢复；不要再用 `--save ''`/`--appendonly no` 关闭持久化。
- `scripts/backup.sh` 仍只备份 PostgreSQL + 私有媒体（业务事实所在），Redis 的持久化是
  「重启不丢队列」的保障，两者不互相替代：

  ```bash
  ./scripts/backup.sh var/backups/<UTC 时间戳>
  ./scripts/restore.sh --dry-run var/backups/<时间戳> acepass_restore_check   # 只做前置检查与清单差异
  ./scripts/restore.sh var/backups/<时间戳> acepass_restore_check             # 目标库/目录必须为空
  ```

  恢复会拒绝非空目标媒体目录与已存在的目标数据库（都在写入任何东西之前），并在恢复后
  报告清单的 missing/extra 并逐个校验 SHA-256。

## 5. 从零启动

```bash
cd infra/docker
cp .env.example .env                      # 修改密码、密钥与域名；不要提交 .env
# 前端产物（api 镜像会拷贝 frontend/dist，web 服务只读挂载它）
(cd ../../frontend && npm ci && npm run build)
# 本机验证用自签名证书；真实环境替换为受信任证书
../../scripts/gen-dev-certs.sh ./certs
docker compose build
docker compose up -d
docker compose exec api python manage.py migrate
docker compose exec api python manage.py create_account you@example.com
docker compose ps                         # 等待 healthcheck 变为 healthy
```

`docker compose config` 可用于只做语法与变量校验，不需要守护进程（但要先有 `.env`，
否则 `${DJANGO_SECRET_KEY:?…}` 之类的必填变量会直接报错）。

## 6. 实测记录（2026-09-27，本机 OrbStack）

- `docker compose -f infra/docker/docker-compose.yml config` 通过（变量/合并/YAML 校验）。
- `docker compose up -d` 本地实际启动：api、web 进入 healthy，postgres/redis healthy，
  三个 worker 与 scheduler 运行中；`curl -k https://127.0.0.1:8443/health/ready` 返回 200。
- 80 端口返回 301 到 https；容器内明文探针 `http://127.0.0.1:8000/health/ready` 返回 200。
- 未在真实目标服务器、真实域名与受信任证书上验证。
