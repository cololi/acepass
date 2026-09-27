# P0.2 独立复验：原反例通过，保留五组补漏

日期：2026-09-27；审查 HEAD：`c168583`，应用修复提交：`bfbbfbd`。

**结论：本轮交付的主要修复和原始反例通过，但不能确认 B01—B07 全部关闭。剩余工作收敛为本文 C01—C05，不重做已通过功能，不扩展 P1。**

## 1. 独立运行结果

| 检查 | 本次结果 |
|---|---|
| 现有后端全套，真实 PostgreSQL | **177 passed，51.17s** |
| 上一轮归档后端反例，原样执行 | **11 passed，5.05s** |
| 新浏览器验收，desktop/mobile | **36 passed，51.1s** |
| 上一轮归档浏览器反例，原样执行 | **2 passed，4.4s** |
| Ruff、迁移一致性、前端构建 | 通过；构建体积提示保留 |
| 本次补充的交叉边界回归 | **10 failed，7.40s**，对应 C01—C04 |
| G07 历史审计正向回归 | **1 passed**：当前行被改写、superseded 行保留、有批次和前后值 |
| 不可连库恢复 dry-run | 非零退出，明确连接失败，已通过 |
| 真实故障脚本 | 清队列/中途 SIGKILL 恢复通过；双 Worker 收尾超时，**最终 ok=false，64/65 processed** |
| Compose 完整启动 / GitHub Actions / 真实 provider / 真实隔天 | 本次未独立验证 |

对照上一轮交接 ZIP，三份后端反例与两份浏览器反例字节一致。本次确认其通过，不将新增交叉场景与原问题混为“原修复无效”。

证据：[p02-independent](review/2026-09-27/p02-independent/README.md)。浏览器使用新建 `acepass_acceptance_p02_independent`、独占 Redis 6394、API 8014、Vite 5184 和临时媒体目录；测试数据库与现有业务库分离。结束后已停止自建服务并删除本次浏览器库。未在业务库执行 migrate、审计改写或清理；未改应用代码、未部署。

## 2. 可以接受的部分与一处评审纠正

- **nextval + 唯一约束的方案可以接受**，不要求改回题目行锁。序列允许回滚间隙，不影响当前代次比较需要。
- 上一轮并发反例把屏障放在创建 run 后、提交前；正确的行锁串行化也可能无法越过该屏障。这是测试同步设计的限制，不能据此推断“稳定行锁天然死锁”。后续应测试业务并发结果，而非要求两个持锁事务同时到达内部屏障。
- 照片草稿、可视填空答案、迟到视觉结果保护、空账户 UI 配置/导入/发布/作答均已补齐对应路径，G05 本次不要求返工。
- G07 当前评分投影审计的批次、前后值与保留 superseded 语义已独立验证。下面 C02 讨论的是另一条 generation 数据迁移，不否定已完成的投影审计。

## 3. 五组剩余问题与有限验收集合

### C01 · P1：内容门禁没有覆盖所有结果交付和幂等重放

已保存普通练习结果，再开启同题 verification，直读 attempt 和 tutor job 已正确拒绝，但其他入口仍交付相同信息。五条独立回归均失败：

| 入口 | 实际结果 | 代码位置 |
|---|---|---|
| GET 旧普通练习会话 | `confirmed_score="2.00"`，items 内含完整 grade | [sessions.py](../backend/apps/practice/services/sessions.py) 405–454 |
| POST submit 使用原幂等键重放 | 200 返回缓存 grade | [practice/api.py](../backend/apps/practice/api.py) 281–283 |
| POST tutor message 使用原幂等键重放 | 201 返回缓存 result_blocks，虽然 GET job 已 403 | [tutoring/api.py](../backend/apps/tutoring/api.py) 129–131 |
| evidence 查询 | 仍返回旧平行练习的 is_correct / score_fraction | [evidence.py](../backend/apps/learning/services/evidence.py) 455–469 |
| grading-queue 查询 | 仍显示同题旧练习的评分点和 rubric | [practice/api.py](../backend/apps/practice/api.py) 513–556 |

这是**一个门禁遗漏组**，不是五项新功能。幂等只保证不重复写入，不应跳过当前交付权限；重放可以返回同一资源回执，但敏感结果需按当前上下文重新序列化。会话汇总、嵌套结果、投影列表和评分队列共用同一内容可见性规则，覆盖后保留无关内容可用。

验收：本文五条回归全部通过；验证结束后恢复正常结果可读；原幂等异载荷 409 与不重复写入仍通过。

### C02 · P1：旧任务拒绝分支和历史迁移仍能影响较新重判

**运行时拒绝分支**：v2 旧任务排队，v3 新任务已确认；将 v2 标争议后执行旧任务，v3 虽未争议也被改为 pending_review。正常评分分支有高水位保护，争议拒绝分支没有同等保护。

位置：[reports.py](../backend/apps/analytics/services/reports.py) 372–407；[attempts.py](../backend/apps/practice/services/attempts.py) 901–951。先判断 stale，再决定是否需要改变该 attempt；旧目标失效不能无差别撤销新有效评分。

**历史代次迁移**：构造旧版可达状态：两个 generation=1，其中旧 v2 尚排队，较新 v3 generation=2 已生效。0004 将重复的旧任务编号改成 3，却不处理已应用高水位 2；恢复消费后旧 v2 覆盖 v3，得分变为 0。

位置：[0004 迁移](../backend/apps/analytics/migrations/0004_p0_2_regrade_generation_sequence.py) 39–54。测试在专用库事务内构造旧状态，然后执行原迁移 SQL 和约束；未动业务库。交付记录称当前业务库无 regrade run，因此没有证据表明现存用户数据已受影响，但迁移对可达旧状态不安全。

验收：旧争议任务不能改新结果；重复历史不能让旧任务获得比新任务更高的有效顺序。可以选择检测歧义后安全中止迁移并输出修复清单，或做保序且可审计的数据映射；不要随意抬高旧 run。安全拒绝方案可以相应调整测试以验证“拒绝且无部分修改”。

### C03 · P1：延迟证据的判断终点由“开始”变成了“提交”

B 完成 23 小时后在普通练习打开 C，25 小时后才提交，当前投影给出 `delayed_verification.qualifies=true`。B 训练锚点改成提交时间是正确的，但 C 的验证间隔应在开始时已满足，不能靠把页面留到阈值之后获得资格。

位置：[evidence.py](../backend/apps/learning/services/evidence.py) 301–318。既有依据：[A30](05-acceptance.md) 明确按 23:59/24:00 **开始**合格验证判断边界；[领域契约](03-domain-and-api.md) 的延迟任务要求开始前复核真实间隔。

本次复现的是普通练习的证据投影错误，不声称已修好的 task 启动门禁再次失效，也不要求将 B 的锚点改回呈现时间。

验收：统一“最近完成的相关训练/教学事件”为锚点，以 C 首次呈现验证是否已经达到间隔；中途辅助仍按现有规则排除。23h 打开/25h 提交不得补获延迟资格，24h 后首次呈现可正常判断。

### C04 · P1：辅导消费者的业务结果不受租约提交保护

真实 task/model 路径的两条确定性回归失败：

1. 保存 job=succeeded 后、TutorTurn/Exposure 前中断，租约到期重投后 outbox=processed，但助手消息与曝光均 **0 条**；可读讲解没有曝光事实。
2. 第一消费者等待模型期间租约过期，第二消费者接管成功；第一消费者随后返回，仍覆盖第二个结果，形成 **2 条消息、2 条曝光**。token 只保护 outbox 确认，没有约束业务写入。

位置：[tutoring/tasks.py](../backend/apps/tutoring/tasks.py) 36–44；[tutoring/core.py](../backend/apps/tutoring/services/core.py) 375–376、451–499。

测试通过模拟 SystemExit 和租约到期固定崩溃/交错位置，不能称为真 SIGKILL。模型用 stub，不涉及真实 provider 质量。

验收：模型调用可以在事务外，最终业务提交需在短事务中重新检查当前 claim/代次；成功结果、消息、曝光与消费完成应作为可恢复的一致提交处理；按 job 唯一约束防重复。已 succeeded 的重投不能在必要事实缺失时直接确认成功。两条反例均通过，同时保留真实 Redis 丢队列和杀进程恢复。

**本次真实演练补充**：Redis 队列 2→0 后补发成功；真 SIGKILL 命中 processing，恢复成功。但双 Worker 阶段，`projection.rebuild_attempt_evidence` 被记录为 `skipped_lease_not_held`，队列已空、event 保持 dispatched；90 秒后脚本报超时，最终 64/65 processed、ok=false。该行属于本次演练的新事件，并非演练前遗留行。

生产扫描器可能后续恢复它，因此这里不声称永久丢消息；但本次脚本没有证明最终收敛。派发过程持行锁与消费者 skip_locked 的竞争需覆盖，演练应启动真实周期扫描或持续执行等价扫描并核对全部新事件。`learning.on_attempt_graded` 也会建出六维证据，因此“已有6条证据”不能替代所有 outbox 已确认。双消费者场景还应主动重复投递同一 event，验证消息/曝光幂等，而非只让两 Worker 分工不同事件。

### C05 · 发布门槛：CI 的 nginx 实测步骤仍不完整

workflow 的 nginx -t 步骤传了 `--add-host api:127.0.0.1`，后续真正启动跳转测试容器却没有该参数，也没有创建 api 容器/网络别名。模板 upstream 仍是 `api:8000`，干净 runner 无法解析它。位置：[ci.yml](../.github/workflows/ci.yml) 113–117；[nginx 模板](../infra/proxy/nginx.conf.template) 18–19。

这是静态配置确认，本次未启动 Docker。另该容器只挂配置和证书，没有挂 AcePass 构建产物；即使修复 DNS，stock nginx 的 `/login` 返回 200 也不能证明 AcePass 登录页可用。

验收：在干净环境执行 workflow 的原命令，确保 upstream 可解析；挂载实际前端产物或使用应用镜像，并断言登录页面内容/脚本资源。跳转/TLS 组件测试可以继续保留，但应准确标识其范围。GitHub Actions 未实际运行时保持未验证状态。

## 4. 下一步与交付边界

修复顺序：C01、C02、C04 可并行；C03 同步更新证据判定；C05 完成真实发布门禁。保留已通过的 177/11/36/2，不新增产品阶段编号，不扩大 P1。

最终验收检查“所有结果交付入口”“新旧代次所有退出分支”“业务提交与曝光一致性”，而非只修改这十条测试命中的单个 if。错误修复需要新增反例，但不要求重做已确认有效的前端路径。

真实模型、真实 24 小时与效果证据继续分开标识。P1 的原生 PDF/历年统计等确定性工作本身不依赖模型 Key；是否进入 P1 取决于上述工程边界是否闭合，而非仅等待凭据。

交接入口：[P0.2 补充修复任务](../DEEPSEEK_P0_2_REMAINING.md)。业务库尚未迁移这一事实保持不变，后续发布先修正迁移并在副本验证。
