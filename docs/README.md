# 文档索引

> 本目录记录 AcePass 的规格、架构、各轮评审与交付证据。**文档与实际不一致时，以
> [实现状态](implementation-status.md) 与 [验收结果](acceptance-results.md) 为准。**

## 1. 产品与设计（读代码前先读这五份）

| 文档 | 内容 |
|---|---|
| [00 原始需求](00-original-requirements.md) | 项目起点：以考试得分为目标的个性化刷题与补弱系统 |
| [01 产品规格](01-product-spec.md) | 范围矩阵、页面与交互、题型行为、P0/P1/P2 边界 |
| [02 技术架构](02-architecture.md) | 模块化单体、异步发件箱、私有存储、部署拓扑 |
| [03 领域与 API](03-domain-and-api.md) | 数据契约：项目/科目/题目/答案/证据/暴露的字段与不变量 |
| [04 实施计划](04-implementation-plan.md) · [05 验收规格](05-acceptance.md) | 交付顺序与可判定的验收条件 |

## 2. 状态与交付记录

| 文档 | 内容 |
|---|---|
| [实现状态](implementation-status.md) | **实际执行了什么、没执行什么**（最权威的状态文件） |
| [验收结果](acceptance-results.md) | 测试与门禁的实际输出、数字与命令 |
| [交付日志](CHANGELOG.md) | 历轮交付的逐条摘要（按时间倒序） |
| [17 走向 100% 的计划](17-remaining-plan-to-completion.md) | 剩余批次划分、判据与外部阻塞项 |

## 3. 各轮评审与修复（按时间顺序）

| 轮次 | 文档 |
|---|---|
| P0 独立验收 | [06 独立验收](06-independent-p0-review.md) · [07 修复计划](07-p0-repair-plan.md) |
| P0.1 | [08 修复与重验](08-p0-1-repair-verification.md) · [09 独立复验](09-p0-1-independent-reacceptance.md) |
| P0.2 收尾 | [10 计划](10-p0-2-closeout-plan.md) · [11 验证](11-p0-2-closeout-verification.md) · [12 独立复验](12-p0-2-independent-review.md) |
| P0.2 定向补漏 | [13 补漏](13-p0-2-remaining-repair.md) · [14 复验](14-p0-2-final-independent-review.md) · [15 最后四组遗漏](15-p0-2-final-four-gaps-repair.md) |
| P1 第一批 | [16 交付](16-p1-first-batch-delivery.md) |
| P1 第二批 | [18 交付](18-p1-second-batch-delivery.md) |
| P1 第三批 | [19 交付](19-p1-third-batch-delivery.md) |
| P2 第一批 | [20 交付](20-p2-first-batch-delivery.md) |
| P2 第二批 | [21 交付](21-p2-second-batch-delivery.md) |
| P2 第三批 | [22 交付](22-p2-third-batch-delivery.md) |
| 代码优化轮 | [23 计划](23-code-optimization-plan.md) · [24 交付](24-code-optimization-delivery.md) |
| 结构清理轮 | [25 交付](25-code-structure-cleanup.md) |

## 4. 证据目录

| 目录 | 内容 |
|---|---|
| [review/](review/) | 独立复验的原始日志、浏览器截图与后端反例输出 |
| [handoff/](handoff/) | 早期开发交接笔记（历史存档，结论以状态文件为准） |
| [dsh-migration/](dsh-migration/) | Django 版 → DeepSeek Harness 插件（`dsh-plugin/`）的兼容性审计、迁移方案与逐批判定 |

## 5. 基础设施

- 部署编排、TLS 契约与恢复流程：[infra/docker/README.md](../infra/docker/README.md)
- CI 门禁：[.github/workflows/ci.yml](../.github/workflows/ci.yml)
