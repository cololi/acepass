# AcePass 部署编排（未在未知服务器上执行过）

本文件是部署配置的交付物，**尚未在真实目标机器上运行验证**：本机 Docker 守护进程
（OrbStack）未启动，仓库中也没有被授权的部署目标。请先在目标环境验证后再视为可用。

服务划分与架构文档一致：同一后端镜像通过不同启动命令承担 `api`、三个 Worker 与
`scheduler`；PostgreSQL 与 Redis 不暴露公网；媒体目录只挂载给 API 与需要的 Worker。

```bash
cd infra/docker
cp .env.example .env      # 修改密码与密钥；不要提交 .env
# 在仓库根目录构建前端产物（api 镜像会拷贝 frontend/dist）
(cd ../../frontend && npm ci && npm run build)
docker compose build
docker compose up -d
docker compose exec api python manage.py migrate
docker compose exec api python manage.py create_account you@example.com
docker compose ps         # 等待 healthcheck 变为 healthy
```

`docker compose config` 可用于只做语法与变量校验，不需要守护进程。
