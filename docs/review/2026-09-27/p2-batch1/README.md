# P2 第一批交付证据（起点 `17f3fd8`）

主报告：[20 P2 第一批交付](../../../20-p2-first-batch-delivery.md)。
本目录只保存本轮实际执行输出；未执行的项不写成通过。环境：macOS 27.0 / Python 3.12.13 /
PostgreSQL 16.15 / Redis 8.10.2（浏览器与演练使用独占库 `acepass_acceptance_p2_batch1` 与独占 Redis 6397）。

## 1. 文件清单

| 文件 | 实际结果 |
|---|---|
| [backend-suite.txt](backend-suite.txt) | 正式后端全套 **366 passed / 144.02s**（起点 340 + 本轮迁入 26：版式导入 16、污染规则 9、校对写入路径 1） |
| [browser-acceptance.txt](browser-acceptance.txt) | 隔离浏览器主套件 **66 passed / 1.4m**（P0 36 + 批次 1 的 12 + 批次 2 的 10 + 批次 3 的 4 + 本批 4） |
| [browser-acceptance-rerun.txt](browser-acceptance-rerun.txt) | 同一命令复跑 **66 passed / 1.4m**（两次一致） |
| [browser-acceptance-stub.txt](browser-acceptance-stub.txt) | 隔离浏览器 stub 专跑（批次 3 的 `@stub` 用例）**6 passed** |
| [reviewer-eleven.txt](reviewer-eleven.txt) | 复验者原始后端反例（`p01-independent`，文件未改）**11 passed** |
| [archived-nine.txt](archived-nine.txt) | 上轮有效后端反例（`p02-independent`，文件未改）**9 passed, 1 deselected** |
| [reviewer-three.txt](reviewer-three.txt) | 复验者三条反例（`p02-final-independent`，文件未改）**3 passed** |
| [archived-browser.txt](archived-browser.txt) | 归档浏览器反例（未改）**2 passed** |
| [worker-drill.txt](worker-drill.txt)、[worker-drill.json](worker-drill.json) | 真故障演练 **ok=true** |
| [clean-export-release-gate.txt](clean-export-release-gate.txt) | 仅提交内容导出的干净副本：代理组件与真实全栈 HTTPS/CSRF 登录两步 exit 0，配置哨兵不变 |

## 2. 复现命令

见主报告 §3 与 `docs/19` §5（批次 4 只换了库名、Redis 端口 6397、API/Vite 端口 8017/5187 与媒体目录）。
浏览器同样需要**两次运行**（主套件 `--grep-invert "@stub"` 与 stub 专跑 `--grep "@stub"`）。

## 3. 未验证项

- 真实试卷 PDF（全部版式证据为自动生成的真实 PDF bytes）、旋转页面、非常规字体编码、Form XObject 嵌套文本。
- 扫描件 OCR：明确不做，也不存在该能力。
- 真实 AI 讲解/图片识别/手写转写/估分/嵌入向量；真实 ≥24 小时学习效果；远程部署与 GitHub Actions 实际执行。
- 家族封存/合并（C03）与生成变式校验（C02）属批次 5，未开始。
