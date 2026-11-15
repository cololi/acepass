# AcePass → DSH 代码迁移面清单

> 静态核对日期：2026-11-04；仓库 `/Users/cololi/Documents/AcePass`；基线提交 `7b41d19482e9134a016bc5289826c60893abf75d`。
> 本文只记录本次读取的源码；未运行测试、Django 初始化、数据库迁移、构建或服务器。本任务唯一写入文件为本文。
> DSH 的 CJS lazy client bundle、tsdown、shared module table、Web GUI 挂载和 `dsh-llm` 是本任务给定的目标约束；本文不声称已验证某一 DSH 版本的服务 API 或迁移实现。

## 0. 口径与导航

- 接口：用 Python 3.12 `ast.parse` 扫描 `backend/apps/*/api.py`，并扫描其余 backend Python 源码的 HTTP 装饰器；排除 `.venv`、迁移文件和缓存目录；再核对 `backend/config/api.py`、`backend/config/urls.py`、`backend/apps/accounts/views.py`。未通过执行路由器来生成 OpenAPI。
- 行号指当前文件中的函数/类定义或有关配置；后续修改会使其漂移。路径均相对仓库根。
- 总量：**154 个 Ninja method/path 操作，133 个不同业务路径，11 个有路由的 app，14 个挂载 router**；`common/api.py` 另为共享工具，零端点。
- 模型：**57 个实体模型 + 3 个抽象模型**；不把 Django 内置表、继承自动生成的 M2M 表或 manager/枚举计入 57。
  数据库实际多出 2 张 Django 为 `ImportJob.documents` / `ImportCandidate.source_regions` 自动生成的 through 表，已在 B0 纳入 schema 与归档（共 59 张表），见 [08-ingestion-b0.md](./08-ingestion-b0.md) §8。
- 后文分为 HTTP、模型、异步、AI、可移植领域逻辑、前端、测试和依赖；替代技术及风险等级是迁移建议，不是已完成的兼容性验证。

## 1. HTTP API 表面

### 1.1 挂载、认证与通用契约

- `backend/config/urls.py:41` 将 `api.urls` 挂载在 `/api/v1/`；`backend/config/api.py:41`–54 的 14 个 router 全部以空前缀挂载。`project_scoped_router` 的注释中有静态 `/projects` 前缀的旧说法，实际挂载为空；以下按实际代码拼接。
- 表中 **S** = `LazySessionAuth`（`backend/apps/common/api.py:11`、`:26`），需要已认证的 Django session；**C** = 非安全方法通过该 cookie auth 校验 CSRF；GET 不要求 CSRF token；**I** = handler 直接调用 `idempotency_key(request)`，要求非空 `Idempotency-Key` 且长度≤200（`:43`）。I 标记不代表其他业务唯一约束或服务幂等均不存在。
- 151 个操作显式 `auth=auth`；3 个公开操作为 CSRF cookie、登录、登出。`accounts` router 和 `NinjaAPI` 未设全局 auth；登出也未声明 auth。已读取安装的 Ninja 源码：`backend/.venv/lib/python3.12/site-packages/ninja/main.py:68` 默认 csrf=False、`ninja/operation.py:475` 包装视图 csrf_exempt、`ninja/security/apikey.py:44` 的 cookie auth 默认 csrf=True。因此不能把登录/登出写成“已强制 CSRF”。
- session 存在 Redis cache，cookie HttpOnly、SameSite=Lax，生产模式 Secure；CSRF cookie 可由前端读取（`backend/config/settings/base.py:166`–175）。登录限流键为 email.lower()+REMOTE_ADDR，10 次/300 秒，成功清除（`backend/apps/accounts/api.py:56`、`:83`）。
- 项目访问以 owner 约束，跨项目/跨所有者通常返回 404（`backend/apps/common/scope.py:17`、`:36`）；并非只替换登录即可取消对象级校验。评分确认还区分自己与其他 staff reviewer（`:81`；`backend/apps/practice/services/attempts.py`）。
- 错误包为 `{error:{code,message,details,request_id?}}`，验证错误 400、scope 404、用途 403、版本/幂等冲突 409、结构 422、限流 429、AI 未配置 503（`backend/apps/common/errors.py:22`–112、`:131`）。Ninja cookie CSRF 的 HttpError 403 经通用 handler 变为 `invalid_input`；Django `csrf_failure` 则是 `csrf_failed`（`backend/apps/accounts/views.py:12`），两条路径不可混写。
- RequestIdMiddleware 总是返回 `X-Request-Id` 并记录请求；错误 JSON 的 request_id 还取决于 attach_request_id（`backend/apps/audit/middleware.py:27`；`backend/apps/common/errors.py:115`）。
- 参数列省略 `request` 和 URL 中已有的 path 参数（这些 path 参数均注解为 str）；`payload` 是 JSON body，普通标量为 query，`File`/`Form` 为 multipart。Schema 名称限定在该 app 的 api.py；同名 `DraftIn`/`ReasonIn` 不应合并。
- 109 个操作声明 response，45 个未声明；“未声明”不是无响应或某个猜测的 Out Schema。共 111 个直接继承 Ninja Schema 的类；类字段目录紧跟各 app。未声明 response 的对象键以 handler/serializer 源码为准。

| app | 操作数 |
|---|---:|
| accounts | 6 |
| analytics | 9 |
| exams | 21 |
| ingestion | 20 |
| knowledge | 18 |
| learning | 14 |
| memory | 7 |
| practice | 26 |
| question_bank | 23 |
| search | 2 |
| tutoring | 8 |
| **总计** | **154** |

方法合计：GET 68、POST 77、PATCH 6、DELETE 2、PUT 1；直接要求 Idempotency-Key 的 handler **48** 个。

### 1.2 accounts（6 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| GET | `/api/v1/auth/csrf` | `get_csrf` · `backend/apps/accounts/api.py:100` | 公开/— | `无` | `未声明；JsonResponse {csrf_token}` |
| POST | `/api/v1/auth/login` | `post_login` · `backend/apps/accounts/api.py:110` | 公开/— | `payload:LoginIn` | `未声明（动态 JSON）` |
| POST | `/api/v1/auth/logout` | `post_logout` · `backend/apps/accounts/api.py:121` | 公开/— | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/auth/me` | `get_me` · `backend/apps/accounts/api.py:127` | S/— | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/me/study-settings` | `get_study_settings` · `backend/apps/accounts/api.py:132` | S/— | `无` | `StudySettingsOut` |
| PATCH | `/api/v1/me/study-settings` | `patch_study_settings` · `backend/apps/accounts/api.py:144` | S/C | `payload:StudySettingsPatch` | `StudySettingsOut` |

本 app Schema（`backend/apps/accounts/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `LoginIn` · `backend/apps/accounts/api.py:23` | `email: str; password: str` |
| `UserOut` · `backend/apps/accounts/api.py:28` | `id: str; email: str; display_name: str; is_staff: bool; timezone: str; daily_budget_minutes: int; undiagnosed_time_share_percent: int; needs_project_setup: bool; is_reviewer: bool` |
| `StudySettingsOut` · `backend/apps/accounts/api.py:41` | `timezone: str; daily_budget_minutes: int; project_budget_percent: dict[str, float]; undiagnosed_time_share_percent: int; default_practice_tutoring: str` |
| `StudySettingsPatch` · `backend/apps/accounts/api.py:49` | `timezone: str \| None = None; daily_budget_minutes: int \| None = None; project_budget_percent: dict[str, float] \| None = None; undiagnosed_time_share_percent: int \| None = None` |

### 1.3 analytics（9 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| GET | `/api/v1/projects/{project_id}/reports/practice` | `practice_report` · `backend/apps/analytics/api.py:77` | S/— | `subject_id:str \| None=None; save_snapshot:bool=True` | `ReportOut` |
| GET | `/api/v1/projects/{project_id}/reports/calibration` | `effect_calibration` · `backend/apps/analytics/api.py:87` | S/— | `subject_id:str \| None=None` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/reports/snapshots` | `list_snapshots` · `backend/apps/analytics/api.py:100` | S/— | `limit:int=10` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/papers/cycle-analysis` | `cycle_analysis` · `backend/apps/analytics/api.py:121` | S/— | `subject_id:str; max_cycles:int=5` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/papers/coverage` | `paper_coverage` · `backend/apps/analytics/api.py:135` | S/— | `subject_id:str` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/regrades` | `create_regrade` · `backend/apps/analytics/api.py:154` | S/C；I | `payload:RegradeIn` | `{201: RegradeOut}` |
| GET | `/api/v1/projects/{project_id}/regrades/{regrade_id}` | `get_regrade` · `backend/apps/analytics/api.py:203` | S/— | `无` | `RegradeOut` |
| POST | `/api/v1/projects/{project_id}/regrades/{regrade_id}/run` | `run_regrade_now` · `backend/apps/analytics/api.py:212` | S/C；I | `无` | `RegradeOut` |
| GET | `/api/v1/projects/{project_id}/answer-reviews` | `pending_answer_reviews` · `backend/apps/analytics/api.py:239` | S/— | `无` | `未声明（动态 JSON）` |

本 app Schema（`backend/apps/analytics/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `ReportOut` · `backend/apps/analytics/api.py:23` | `report_kind: str; calculation_version: str; as_of: str; project_id: str; subject_id: str \| None; totals: dict[str, Any]; by_question_type: dict[str, Any]; by_knowledge_node: dict[str, Any]; excluded_evidence: list[dict[str, Any]]; notes: list[str]; hidden_verification_attempts: int = 0; hidden_verification_content_attempts: int = 0; result_status: str = 'final'; incomplete_scope: dict[str, Any] = {}; aggregate: dict[str, Any] = {}; final_result: dict[str, Any] \| None = None` |
| `RegradeIn` · `backend/apps/analytics/api.py:50` | `question_id: str; target_answer_key_version_id: str; target_rubric_version_id: str \| None = None; reason: str; scope: str = 'all_attempts'` |
| `RegradeOut` · `backend/apps/analytics/api.py:58` | `regrade_run_id: str; status: str; question_id: str; target_answer_key_version_id: str; target_rubric_version_id: str \| None; scope: str; reason: str; generation: int = 0; affected_attempts: int; regraded_attempts: int; stale_skipped_attempts: int = 0; invalidated_evidence: int; error_message: str; created_at: str; finished_at: str \| None` |

### 1.4 exams（21 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| GET | `/api/v1/projects` | `list_projects` · `backend/apps/exams/api.py:306` | S/— | `include_archived:bool=False` | `list[ProjectOut]` |
| POST | `/api/v1/projects` | `create_project` · `backend/apps/exams/api.py:314` | S/C；I | `payload:ProjectIn` | `{201: ProjectOut}` |
| GET | `/api/v1/projects/{project_id}` | `get_project` · `backend/apps/exams/api.py:336` | S/— | `无` | `ProjectOut` |
| PATCH | `/api/v1/projects/{project_id}` | `patch_project` · `backend/apps/exams/api.py:341` | S/C | `payload:ProjectPatch` | `ProjectOut` |
| POST | `/api/v1/projects/{project_id}/archive` | `archive_project` · `backend/apps/exams/api.py:348` | S/C；I | `payload:ArchiveIn` | `ProjectOut` |
| POST | `/api/v1/projects/{project_id}/unarchive` | `unarchive_project` · `backend/apps/exams/api.py:364` | S/C；I | `无` | `ProjectOut` |
| GET | `/api/v1/projects/{project_id}/subjects` | `list_subjects` · `backend/apps/exams/api.py:382` | S/— | `无` | `list[SubjectOut]` |
| POST | `/api/v1/projects/{project_id}/subjects` | `create_subject` · `backend/apps/exams/api.py:388` | S/C；I | `payload:SubjectIn` | `{201: SubjectOut}` |
| GET | `/api/v1/projects/{project_id}/exam-spec-versions` | `list_spec_versions` · `backend/apps/exams/api.py:413` | S/— | `subject_id:str \| None=None` | `list[SpecOut]` |
| POST | `/api/v1/projects/{project_id}/exam-spec-versions` | `create_spec_version` · `backend/apps/exams/api.py:423` | S/C；I | `payload:SpecIn` | `{201: SpecOut}` |
| POST | `/api/v1/projects/{project_id}/exam-spec-versions/{spec_id}/publish` | `publish_spec_version` · `backend/apps/exams/api.py:452` | S/C；I | `无` | `SpecOut` |
| GET | `/api/v1/projects/{project_id}/syllabus-versions` | `list_syllabus_versions` · `backend/apps/exams/api.py:471` | S/— | `subject_id:str \| None=None` | `list[SyllabusOut]` |
| POST | `/api/v1/projects/{project_id}/syllabus-versions` | `create_syllabus_version` · `backend/apps/exams/api.py:481` | S/C；I | `payload:SyllabusIn` | `{201: SyllabusOut}` |
| POST | `/api/v1/projects/{project_id}/syllabus-versions/{syllabus_id}/publish` | `publish_syllabus_version` · `backend/apps/exams/api.py:507` | S/C；I | `无` | `SyllabusOut` |
| GET | `/api/v1/projects/{project_id}/papers` | `list_papers` · `backend/apps/exams/api.py:526` | S/— | `subject_id:str \| None=None` | `list[PaperOut]` |
| POST | `/api/v1/projects/{project_id}/papers` | `register_paper` · `backend/apps/exams/api.py:536` | S/C；I | `payload:PaperIn` | `{201: PaperOut, 200: PaperOut}` |
| GET | `/api/v1/projects/{project_id}/papers/{paper_id}` | `get_paper` · `backend/apps/exams/api.py:564` | S/— | `无` | `PaperOut` |
| GET | `/api/v1/projects/{project_id}/paper-revisions/{revision_id}/items` | `list_paper_items` · `backend/apps/exams/api.py:573` | S/— | `无` | `list[PaperItemOut]` |
| POST | `/api/v1/projects/{project_id}/paper-revisions/{revision_id}/coverage` | `confirm_paper_coverage` · `backend/apps/exams/api.py:583` | S/C | `payload:CoverageIn` | `PaperRevisionOut` |
| POST | `/api/v1/projects/{project_id}/paper-revisions/{revision_id}/confirm` | `confirm_paper_revision` · `backend/apps/exams/api.py:618` | S/C | `无` | `PaperRevisionOut` |
| POST | `/api/v1/projects/{project_id}/papers/{paper_id}/effective-revision` | `set_effective_revision` · `backend/apps/exams/api.py:635` | S/C | `revision_id:str` | `PaperOut` |

本 app Schema（`backend/apps/exams/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `ProjectIn` · `backend/apps/exams/api.py:26` | `name: str; description: str = ''; target_date: date \| None = None; target_score: Decimal \| None = None` |
| `ProjectPatch` · `backend/apps/exams/api.py:33` | `name: str \| None = None; description: str \| None = None; target_date: date \| None = None; target_score: Decimal \| None = None; display_order: int \| None = None` |
| `ProjectOut` · `backend/apps/exams/api.py:41` | `id: str; name: str; description: str; target_date: date \| None; target_score: Decimal \| None; is_archived: bool; display_order: int; subject_count: int; question_count: int; created_at: str` |
| `ArchiveIn` · `backend/apps/exams/api.py:54` | `reason: str = ''` |
| `SubjectIn` · `backend/apps/exams/api.py:58` | `name: str; code: str = ''; total_score: Decimal \| None = None; pass_score: Decimal \| None = None` |
| `SubjectOut` · `backend/apps/exams/api.py:65` | `id: str; project_id: str; name: str; code: str; display_order: int; total_score: Decimal \| None; pass_score: Decimal \| None` |
| `SpecIn` · `backend/apps/exams/api.py:75` | `subject_id: str; name: str = ''; total_score: Decimal \| None = None; pass_score: Decimal \| None = None; question_type_rules: dict[str, Any] = {}; time_rules: dict[str, Any] = {}; score_floor_at_zero: bool = False; rule_source_note: str = ''; is_demo: bool = True` |
| `SpecOut` · `backend/apps/exams/api.py:87` | `id: str; subject_id: str; version: int; name: str; total_score: Decimal \| None; pass_score: Decimal \| None; question_type_rules: dict[str, Any]; time_rules: dict[str, Any]; score_floor_at_zero: bool; rule_source_note: str; is_demo: bool; status: str; published_at: str \| None; is_usable: bool` |
| `SyllabusIn` · `backend/apps/exams/api.py:104` | `subject_id: str; name: str; version_label: str = ''; applies_from: date \| None = None; applies_to: date \| None = None; is_user_provisional: bool = True` |
| `SyllabusOut` · `backend/apps/exams/api.py:113` | `id: str; subject_id: str; name: str; version_label: str; applies_from: date \| None; applies_to: date \| None; is_user_provisional: bool; review_status: str; status: str; published_at: str \| None; node_count: int` |
| `PaperIn` · `backend/apps/exams/api.py:127` | `subject_id: str; cycle_key: str; session_key: str = ''; paper_code: str; source_kind: str = 'demo'; title: str = ''` |
| `PaperRevisionOut` · `backend/apps/exams/api.py:136` | `id: str; revision: int; status: str; coverage_status: str; expected_session_count: int \| None; covered_session_count: int \| None; item_count: int; scored_item_count: int; note: str; coverage_confirmed_by: str \| None = None; coverage_confirmed_at: str \| None = None` |
| `PaperOut` · `backend/apps/exams/api.py:150` | `id: str; subject_id: str; cycle_key: str; session_key: str; paper_code: str; source_kind: str; title: str; is_demo: bool; effective_revision_id: str \| None; revisions: list[PaperRevisionOut]; coverage_note: str` |
| `CoverageIn` · `backend/apps/exams/api.py:164` | `expected_session_count: int \| None = None; covered_session_count: int \| None = None; note: str = ''; confirm: bool = False` |
| `PaperItemOut` · `backend/apps/exams/api.py:172` | `id: str; position_key: str; parent_item_id: str \| None; question_id: str; question_version_id: str; answer_key_version_id: str \| None; max_score: Decimal; is_scored: bool` |

### 1.5 ingestion（20 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| POST | `/api/v1/projects/{project_id}/assets` | `upload_asset` · `backend/apps/ingestion/api.py:289` | S/C | `file:File[UploadedFile]; role:str=Form(AssetRole.PAST_PAPER_PAGE)` | `{201: AssetOut}` |
| GET | `/api/v1/projects/{project_id}/assets/{asset_id}` | `download_asset` · `backend/apps/ingestion/api.py:308` | S/— | `purpose:str='practice'; session_item_id:str \| None=None` | `未声明；StreamingHttpResponse（文件）` |
| GET | `/api/v1/projects/{project_id}/source-documents` | `list_source_documents` · `backend/apps/ingestion/api.py:348` | S/— | `subject_id:str \| None=None; limit:int=50` | `list[SourceDocumentOut]` |
| POST | `/api/v1/projects/{project_id}/source-documents/text` | `create_text_source` · `backend/apps/ingestion/api.py:358` | S/C | `payload:TextImportIn` | `{201: SourceDocumentOut}` |
| POST | `/api/v1/projects/{project_id}/source-documents/image` | `create_image_source` · `backend/apps/ingestion/api.py:375` | S/C | `file:File[UploadedFile]; role:str=Form(AssetRole.PAST_PAPER_PAGE); title:str=Form(''); source_note:str=Form(''); usage_scope:str=Form(''); subject_id:str=Form('')` | `{201: SourceDocumentOut}` |
| POST | `/api/v1/projects/{project_id}/imports/parse-text` | `parse_text_preview` · `backend/apps/ingestion/api.py:414` | S/C | `payload:TextParseIn` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/imports` | `create_import` · `backend/apps/ingestion/api.py:422` | S/C；I | `payload:TextImportIn` | `{201: ImportJobOut}` |
| POST | `/api/v1/projects/{project_id}/imports/images` | `create_image_import` · `backend/apps/ingestion/api.py:451` | S/C；I | `files:list[UploadedFile]=File(...); subject_id:str=Form(''); title:str=Form(''); role:str=Form(AssetRole.PAST_PAPER_PAGE)` | `{201: ImportJobOut}` |
| POST | `/api/v1/projects/{project_id}/imports/pdf` | `create_pdf_import` · `backend/apps/ingestion/api.py:527` | S/C；I | `files:list[UploadedFile]=File(...); answer_files:list[UploadedFile]=File(default=[]); subject_id:str=Form(''); title:str=Form(''); source_note:str=Form(''); cycle_key:str=Form(''); session_key:str=Form(''); paper_code:str=Form(''); source_kind:str=Form(SourceKind.OFFICIAL_PAST); expected_session_count:int \| None=Form(None); usage_scope:str=Form('')` | `{201: ImportJobOut}` |
| GET | `/api/v1/projects/{project_id}/imports` | `list_imports` · `backend/apps/ingestion/api.py:615` | S/— | `status:str \| None=None; limit:int=20` | `list[ImportJobOut]` |
| GET | `/api/v1/projects/{project_id}/imports/{job_id}` | `get_import` · `backend/apps/ingestion/api.py:624` | S/— | `无` | `ImportJobOut` |
| POST | `/api/v1/projects/{project_id}/imports/{job_id}/retry` | `retry_import` · `backend/apps/ingestion/api.py:633` | S/C；I | `无` | `ImportJobOut` |
| GET | `/api/v1/projects/{project_id}/import-candidates` | `list_candidates` · `backend/apps/ingestion/api.py:652` | S/— | `job_id:str \| None=None; status:str \| None=None; limit:int=50` | `list[CandidateOut]` |
| GET | `/api/v1/projects/{project_id}/import-candidates/{candidate_id}` | `get_candidate` · `backend/apps/ingestion/api.py:666` | S/— | `无` | `CandidateOut` |
| PATCH | `/api/v1/projects/{project_id}/import-candidates/{candidate_id}` | `patch_candidate` · `backend/apps/ingestion/api.py:703` | S/C | `payload:CandidatePatch` | `CandidateOut` |
| POST | `/api/v1/projects/{project_id}/import-candidates/{candidate_id}/ignore` | `ignore_candidate` · `backend/apps/ingestion/api.py:722` | S/C；I | `reason:str=''` | `CandidateOut` |
| POST | `/api/v1/projects/{project_id}/import-candidates/{candidate_id}/layout-confirm` | `confirm_candidate_layout` · `backend/apps/ingestion/api.py:751` | S/C；I | `payload:CandidateLayoutConfirmIn` | `CandidateOut` |
| POST | `/api/v1/projects/{project_id}/import-candidates/{candidate_id}/publish` | `publish_candidate` · `backend/apps/ingestion/api.py:788` | S/C；I | `payload:CandidatePublishIn` | `CandidateOut` |
| POST | `/api/v1/projects/{project_id}/variants/propose` | `propose_variants` · `backend/apps/ingestion/api.py:868` | S/C；I | `payload:VariantProposeIn` | `{201: VariantProposeOut}` |
| GET | `/api/v1/projects/{project_id}/variants` | `list_variants` · `backend/apps/ingestion/api.py:918` | S/— | `limit:int=20` | `VariantListOut` |

本 app Schema（`backend/apps/ingestion/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `AssetOut` · `backend/apps/ingestion/api.py:37` | `id: str; project_id: str; role: str; sensitivity: str; content_type: str; size_bytes: int; width: int \| None; height: int \| None; checksum: str; original_filename: str; download_url: str` |
| `TextImportIn` · `backend/apps/ingestion/api.py:51` | `text: str; subject_id: str \| None = None; title: str = ''; source_note: str = ''; usage_scope: str = ''; parse: bool = True` |
| `ImportJobOut` · `backend/apps/ingestion/api.py:60` | `id: str; project_id: str; subject_id: str \| None; status: str; input_kind: str; progress_percent: int; problems: list[dict[str, Any]]; attempts: int; max_attempts: int; last_error: str; extractor_version: str; duplicate_of_job_id: str \| None; document_ids: list[str]; candidate_count: int; candidate_status_counts: dict[str, int]; page_diagnostics: list[dict[str, Any]] = []; created_at: str` |
| `CandidateRegionOut` · `backend/apps/ingestion/api.py:81` | `id: str; document_id: str; page_index: int; x: float; y: float; width: float; height: float; role: str; text_span: str; crop_asset_id: str \| None; document_asset_id: str \| None = None; document_title: str = ''; document_type: str = ''` |
| `CandidateOut` · `backend/apps/ingestion/api.py:100` | `id: str; job_id: str; subject_id: str \| None; status: str; revision: int; review_issues: list[dict[str, Any]]; is_stub_output: bool; extractor_version: str; draft_payload: dict[str, Any]; machine_payload: dict[str, Any]; source_regions: list[CandidateRegionOut]; publication_question_id: str \| None; publication_version_id: str \| None; publication_paper_item_id: str \| None = None; parent_candidate_id: str \| None = None; child_candidate_ids: list[str] = []; source_position_key: str = ''; paper_revision_id: str \| None = None; answer_match: dict[str, Any] = {}; layout_review_confirmed_at: str \| None = None; layout_review_note: str = ''; updated_at: str` |
| `CandidatePatch` · `backend/apps/ingestion/api.py:130` | `draft_payload: dict[str, Any] \| None = None; subject_id: str \| None = None; expected_revision: int \| None = None; note: str = ''` |
| `CandidateLayoutConfirmIn` · `backend/apps/ingestion/api.py:137` | `note: str = ''` |
| `CandidatePublishIn` · `backend/apps/ingestion/api.py:143` | `exam_spec_version_id: str \| None = None; node_ids: list[str] = []; origin_type: str = 'user_authored'; display_label: str = ''` |
| `SourceDocumentOut` · `backend/apps/ingestion/api.py:150` | `id: str; project_id: str; subject_id: str \| None; title: str; document_type: str; role: str; sensitivity: str; source_type: str; source_note: str; usage_scope: str; checksum: str; asset_id: str \| None; raw_text_preview: str` |
| `TextParseIn` · `backend/apps/ingestion/api.py:166` | `text: str` |
| `VariantProposeIn` · `backend/apps/ingestion/api.py:173` | `source_question_id: str \| None = None; source_version_id: str \| None = None; node_id: str; count: int = 1; difficulty_note: str = ''` |
| `VariantCandidateOut` · `backend/apps/ingestion/api.py:183` | `candidate_id: str; job_id: str; status: str; awaiting_human_review: bool; question_type: str \| None; review_issues: list[dict[str, Any]]; blocking_issues: list[dict[str, Any]]; answer_needs_confirmation: bool; answer_source_type: str; content_digest: str; source_question_id: str; source_version_id: str; node_id: str; llm_run_id: str; is_stub_output: bool; publication_question_id: str \| None; publication_version_id: str \| None; created_at: str` |
| `VariantProposeOut` · `backend/apps/ingestion/api.py:206` | `job_id: str; job_status: str; project_id: str; subject_id: str; source_question_id: str; source_version_id: str; node_id: str; node_name: str; provider: str; model: str; is_stub: bool; prompt_version: str; origin_type: str; requested_count: int; count: int; count_capped: bool; candidates: list[VariantCandidateOut]; validation: dict[str, Any]; nothing_passed: bool; problems: list[dict[str, Any]]; notes: list[str]` |
| `VariantJobOut` · `backend/apps/ingestion/api.py:230` | `job_id: str; project_id: str; subject_id: str \| None; status: str; input_kind: str; extractor_version: str; progress_percent: int; problems: list[dict[str, Any]]; candidate_count: int; candidate_status_counts: dict[str, int]; candidates: list[VariantCandidateOut]; created_at: str` |
| `VariantListOut` · `backend/apps/ingestion/api.py:245` | `count: int; limit: int; jobs: list[VariantJobOut]` |

### 1.6 knowledge（18 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| GET | `/api/v1/projects/{project_id}/knowledge-nodes` | `list_nodes` · `backend/apps/knowledge/api.py:152` | S/— | `syllabus_version_id:str \| None=None; subject_id:str \| None=None` | `list[NodeOut]` |
| POST | `/api/v1/projects/{project_id}/knowledge-nodes` | `create_node` · `backend/apps/knowledge/api.py:166` | S/C；I | `payload:NodeIn` | `{201: NodeOut}` |
| GET | `/api/v1/projects/{project_id}/question-templates` | `list_templates` · `backend/apps/knowledge/api.py:208` | S/— | `subject_id:str \| None=None` | `list[TemplateOut]` |
| POST | `/api/v1/projects/{project_id}/question-templates` | `create_template` · `backend/apps/knowledge/api.py:227` | S/C | `payload:TemplateIn` | `{201: TemplateOut}` |
| GET | `/api/v1/projects/{project_id}/verification-pairings` | `list_pairings` · `backend/apps/knowledge/api.py:243` | S/— | `subject_id:str \| None=None; node_id:str \| None=None` | `list[PairingOut]` |
| POST | `/api/v1/projects/{project_id}/verification-pairings` | `create_pairing` · `backend/apps/knowledge/api.py:255` | S/C；I | `payload:PairingIn` | `{201: PairingOut}` |
| GET | `/api/v1/projects/{project_id}/verification-pairings/{pairing_id}` | `get_pairing_detail` · `backend/apps/knowledge/api.py:305` | S/— | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/knowledge-map` | `knowledge_map` · `backend/apps/knowledge/api.py:330` | S/— | `subject_id:str; syllabus_version_id:str \| None=None` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/syllabus-versions/{syllabus_id}/nodes/import` | `import_syllabus_outline` · `backend/apps/knowledge/api.py:380` | S/C；I | `payload:OutlineIn` | `OutlineOut` |
| PATCH | `/api/v1/projects/{project_id}/knowledge-nodes/{node_id}` | `patch_node` · `backend/apps/knowledge/api.py:409` | S/C | `payload:NodePatch` | `NodeOut` |
| GET | `/api/v1/projects/{project_id}/knowledge-relations` | `list_relations` · `backend/apps/knowledge/api.py:479` | S/— | `syllabus_version_id:str \| None=None; subject_id:str \| None=None` | `GraphOut` |
| POST | `/api/v1/projects/{project_id}/knowledge-relations` | `create_relation` · `backend/apps/knowledge/api.py:502` | S/C；I | `payload:RelationIn` | `{201: RelationOut}` |
| DELETE | `/api/v1/projects/{project_id}/knowledge-relations/{relation_id}` | `deactivate_relation` · `backend/apps/knowledge/api.py:549` | S/C | `reason:str=''` | `RelationOut` |
| GET | `/api/v1/projects/{project_id}/knowledge-nodes/{node_id}/prerequisites` | `node_prerequisites` · `backend/apps/knowledge/api.py:561` | S/— | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/question-versions/{version_id}/tag-suggestions` | `list_tag_suggestions` · `backend/apps/knowledge/api.py:650` | S/— | `无` | `list[TagSuggestionOut]` |
| POST | `/api/v1/projects/{project_id}/question-versions/{version_id}/tag-suggestions` | `create_tag_suggestion` · `backend/apps/knowledge/api.py:662` | S/C；I | `无` | `{201: TagSuggestionOut}` |
| POST | `/api/v1/projects/{project_id}/tag-suggestions/{suggestion_id}/accept` | `accept_tag_suggestion` · `backend/apps/knowledge/api.py:693` | S/C | `payload:SuggestionDecisionIn` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/tag-suggestions/{suggestion_id}/reject` | `reject_tag_suggestion` · `backend/apps/knowledge/api.py:704` | S/C | `payload:SuggestionDecisionIn` | `TagSuggestionOut` |

本 app Schema（`backend/apps/knowledge/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `NodeIn` · `backend/apps/knowledge/api.py:27` | `syllabus_version_id: str; canonical_name: str; kind: str = 'point'; parent_id: str \| None = None; code: str = ''; aliases: list[str] = []; is_unclassified: bool = False; display_order: int = 0` |
| `NodeOut` · `backend/apps/knowledge/api.py:38` | `id: str; syllabus_version_id: str; parent_id: str \| None; kind: str; canonical_name: str; code: str; aliases: list[str]; is_unclassified: bool; display_order: int; question_count: int` |
| `OutlineIn` · `backend/apps/knowledge/api.py:51` | `text: str; kind_by_depth: dict[str, str] = {}` |
| `OutlineOut` · `backend/apps/knowledge/api.py:57` | `created: int; merged: int; aliases_added: list[dict]; skipped: list[dict]; node_count: int` |
| `NodePatch` · `backend/apps/knowledge/api.py:65` | `canonical_name: str \| None = None; aliases: list[str] \| None = None; parent_id: str \| None = None; move: bool = False` |
| `TemplateIn` · `backend/apps/knowledge/api.py:73` | `subject_id: str; name: str; description: str = ''` |
| `TemplateOut` · `backend/apps/knowledge/api.py:79` | `id: str; subject_id: str; name: str; description: str; review_status: str` |
| `PairingIn` · `backend/apps/knowledge/api.py:87` | `subject_id: str; node_id: str; immediate_question_id: str; delayed_question_id: str \| None = None; baseline_question_id: str \| None = None; delay_hours: int = 24; note: str = ''` |
| `PairingOut` · `backend/apps/knowledge/api.py:97` | `id: str; project_id: str; subject_id: str; node_id: str; node_name: str; baseline_question_id: str \| None; immediate_question_id: str; delayed_question_id: str \| None; pairing_version: int; delay_hours: int; is_active: bool; reviewed_at: str \| None; note: str; gap: str` |
| `RelationIn` · `backend/apps/knowledge/api.py:436` | `syllabus_version_id: str; from_node_id: str; to_node_id: str; relation_type: str = 'prerequisite'; note: str = ''` |
| `RelationOut` · `backend/apps/knowledge/api.py:444` | `id: str; syllabus_version_id: str; from_node_id: str; from_node_name: str; to_node_id: str; to_node_name: str; relation_type: str; is_active: bool; note: str` |
| `GraphOut` · `backend/apps/knowledge/api.py:456` | `edges: list[RelationOut]; node_count: int; edge_count: int; generated_at: str; unmet_prerequisites: list[dict] = []` |
| `TagSuggestionOut` · `backend/apps/knowledge/api.py:592` | `id: str; project_id: str; question_version_id: str; question_label: str; status: str; proposals: list[dict]; model_identifier: str; prompt_version: str; is_stub: bool; created_at: str; decided_at: str \| None; accepted_mapping_revision: int \| None; unresolved_names: list[str]; decision_note: str; latest_mappings: list[dict]` |
| `SuggestionDecisionIn` · `backend/apps/knowledge/api.py:610` | `node_names: list[str] \| None = None; note: str = ''` |

### 1.7 learning（14 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| GET | `/api/v1/study-plans/today` | `get_today` · `backend/apps/learning/api.py:72` | S/— | `无` | `TodayPlanOut` |
| POST | `/api/v1/study-plans/today/generate` | `generate_today` · `backend/apps/learning/api.py:78` | S/C；I | `payload:GeneratePlanIn` | `TodayPlanOut` |
| POST | `/api/v1/study-tasks/{task_id}/start` | `start_task` · `backend/apps/learning/api.py:110` | S/C；I | `无` | `未声明（动态 JSON）` |
| POST | `/api/v1/study-tasks/{task_id}/defer` | `defer_task` · `backend/apps/learning/api.py:139` | S/C；I | `payload:ReasonIn` | `未声明（动态 JSON）` |
| POST | `/api/v1/study-tasks/{task_id}/skip` | `skip_task` · `backend/apps/learning/api.py:155` | S/C；I | `payload:ReasonIn` | `未声明（动态 JSON）` |
| POST | `/api/v1/study-tasks/{task_id}/complete` | `complete_task` · `backend/apps/learning/api.py:171` | S/C | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/study-tasks/{task_id}` | `get_task` · `backend/apps/learning/api.py:191` | S/— | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/plans/{plan_id}` | `get_plan` · `backend/apps/learning/api.py:227` | S/— | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/learning-states` | `list_states` · `backend/apps/learning/api.py:246` | S/— | `subject_id:str \| None=None` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/evidence` | `list_evidence` · `backend/apps/learning/api.py:270` | S/— | `node_id:str \| None=None; subject_id:str \| None=None; dimension:str \| None=None; limit:int=100` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/mistakes` | `list_mistakes` · `backend/apps/learning/api.py:298` | S/— | `subject_id:str \| None=None; limit:int=100` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/review-tasks` | `list_review_tasks` · `backend/apps/learning/api.py:315` | S/— | `subject_id:str \| None=None; only_due:bool=False` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/study-tasks/{task_id}/reconcile-delay` | `reconcile_delay` · `backend/apps/learning/api.py:359` | S/C | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/knowledge-states/{node_id}/evidence` | `node_evidence` · `backend/apps/learning/api.py:371` | S/— | `无` | `未声明（动态 JSON）` |

本 app Schema（`backend/apps/learning/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `PlanTaskOut` · `backend/apps/learning/api.py:24` | `task_id: str; task_kind: str; status: str; project_id: str; subject_id: str; question_id: str \| None; question_label: str; knowledge_node_id: str \| None; knowledge_node_name: str; estimated_minutes: int; reason_codes: list[str]; evidence_ids: list[str]; not_before: str \| None; due_at: str \| None; delay_anchor_at: str \| None; delay_hours: int \| None; available_now: bool; deficit_notice: str; pairing_version: int \| None` |
| `TodayPlanOut` · `backend/apps/learning/api.py:46` | `plan: dict[str, Any] \| None; tasks: list[PlanTaskOut]; notes: list[str]; backlog: list[dict[str, Any]] = []; progress_notes: list[str] = []` |
| `GeneratePlanIn` · `backend/apps/learning/api.py:54` | `plan_date: str \| None = None; refresh: bool = False` |
| `ReasonIn` · `backend/apps/learning/api.py:59` | `reason: str = ''` |

### 1.8 memory（7 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| GET | `/api/v1/projects/{project_id}/memory-cards` | `list_memory_cards` · `backend/apps/memory/api.py:143` | S/— | `due_before:str \| None=None; include_suspended:bool=False; limit:int=50` | `list[MemoryCardOut]` |
| POST | `/api/v1/projects/{project_id}/memory-cards` | `create_memory_card` · `backend/apps/memory/api.py:163` | S/C | `payload:MemoryCardCreateIn` | `{200: MemoryCardOut, 201: MemoryCardOut}` |
| POST | `/api/v1/projects/{project_id}/memory-cards/{card_id}/review` | `review_memory_card` · `backend/apps/memory/api.py:174` | S/C；I | `payload:MemoryReviewIn` | `MemoryReviewOut` |
| GET | `/api/v1/projects/{project_id}/memory-cards/{card_id}/logs` | `list_memory_card_logs` · `backend/apps/memory/api.py:188` | S/— | `limit:int=MAX_LOG_LIMIT` | `list[MemoryReviewLogOut]` |
| POST | `/api/v1/projects/{project_id}/memory-cards/{card_id}/rebuild` | `rebuild_memory_card` · `backend/apps/memory/api.py:199` | S/C | `无` | `MemoryRebuildOut` |
| POST | `/api/v1/projects/{project_id}/memory-cards/{card_id}/suspend` | `suspend_memory_card` · `backend/apps/memory/api.py:207` | S/C | `payload:SuspendIn` | `MemoryCardOut` |
| POST | `/api/v1/projects/{project_id}/memory-cards/{card_id}/resume` | `resume_memory_card` · `backend/apps/memory/api.py:216` | S/C | `无` | `MemoryCardOut` |

本 app Schema（`backend/apps/memory/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `MemoryCardOut` · `backend/apps/memory/api.py:35` | `card_id: str; project_id: str; subject_id: str; question_id: str; question_label: str; stem_excerpt: str; knowledge_node_id: str \| None = None; knowledge_node_name: str; phase: str; due_at: str \| None = None; last_reviewed_at: str \| None = None; stability: float; difficulty: float; retrievability: float \| None = None; reps: int; lapses: int; learning_step: int; is_suspended: bool; suspended_reason: str; scheduler_version: str; params_version: str; desired_retention: float` |
| `MemoryCardCreateIn` · `backend/apps/memory/api.py:61` | `question_id: str` |
| `MemoryReviewIn` · `backend/apps/memory/api.py:65` | `rating: str; source_session_item_id: str \| None = None` |
| `MemoryReviewOut` · `backend/apps/memory/api.py:70` | `card_id: str; log_id: str; rating: str; phase: str; phase_before: str; due_at: str \| None = None; reviewed_at: str; interval_days: float; elapsed_days: float; scheduled_days: float; retrievability: float; stability: float; difficulty: float; is_lapse: bool; reps: int; lapses: int; scheduler_version: str; params_version: str` |
| `MemoryReviewLogOut` · `backend/apps/memory/api.py:91` | `log_id: str; card_id: str; rating: str; reviewed_at: str; elapsed_days: float; scheduled_days: float; interval_days: float; retrievability: float; is_lapse: bool; phase_before: str; phase_after: str; stability_before: float; stability_after: float; difficulty_before: float; difficulty_after: float; due_before: str \| None = None; due_after: str \| None = None; scheduler_version: str; params_version: str; source_session_item_id: str \| None = None; note: str` |
| `MemoryRebuildOut` · `backend/apps/memory/api.py:115` | `matches: bool; rebuilt: dict; stored: dict; log_count: int; compared_fields: list[str]; differing_fields: list[str]; unknown_params_versions: list[str]` |
| `SuspendIn` · `backend/apps/memory/api.py:125` | `reason: str = ''` |

### 1.9 practice（26 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| POST | `/api/v1/projects/{project_id}/practice-sessions` | `create_session` · `backend/apps/practice/api.py:226` | S/C；I | `payload:SessionCreateIn` | `{201: SessionOut}` |
| GET | `/api/v1/projects/{project_id}/practice-sessions/{session_id}` | `get_session` · `backend/apps/practice/api.py:275` | S/— | `无` | `SessionOut` |
| POST | `/api/v1/projects/{project_id}/practice-sessions/{session_id}/finish` | `finish_session` · `backend/apps/practice/api.py:281` | S/C；I | `无` | `SessionOut` |
| GET | `/api/v1/projects/{project_id}/practice-sessions` | `list_sessions` · `backend/apps/practice/api.py:313` | S/— | `subject_id:str \| None=None; limit:int=20` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/session-items/{item_id}/presentation` | `get_presentation` · `backend/apps/practice/api.py:370` | S/— | `无` | `未声明（动态 JSON）` |
| PUT | `/api/v1/projects/{project_id}/session-items/{item_id}/draft` | `put_draft` · `backend/apps/practice/api.py:377` | S/C | `payload:DraftIn` | `DraftOut` |
| POST | `/api/v1/projects/{project_id}/session-items/{item_id}/submit` | `submit` · `backend/apps/practice/api.py:396` | S/C；I | `payload:SubmitIn` | `{200: SubmitOut}` |
| GET | `/api/v1/projects/{project_id}/attempts/{attempt_id}` | `get_attempt` · `backend/apps/practice/api.py:479` | S/— | `无` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/attempts/{attempt_id}/confirm-grade` | `confirm_grade` · `backend/apps/practice/api.py:513` | S/C；I | `payload:ConfirmGradeIn` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/session-items/{item_id}/reveal` | `reveal_item` · `backend/apps/practice/api.py:578` | S/C | `无` | `RevealOut` |
| POST | `/api/v1/projects/{project_id}/attempts/{attempt_id}/reveal` | `reveal_attempt` · `backend/apps/practice/api.py:608` | S/C | `无` | `RevealOut` |
| GET | `/api/v1/projects/{project_id}/session-items/{item_id}/exposures` | `list_exposures` · `backend/apps/practice/api.py:641` | S/— | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/questions/{question_id}/exposure` | `get_question_exposure` · `backend/apps/practice/api.py:693` | S/— | `无` | `QuestionExposureOut` |
| POST | `/api/v1/projects/{project_id}/questions/{question_id}/external-seen` | `declare_external_seen` · `backend/apps/practice/api.py:711` | S/C；I | `payload:ExternalSeenIn` | `{201: QuestionExposureOut}` |
| POST | `/api/v1/projects/{project_id}/import-candidates/{candidate_id}/editorial-preview` | `record_candidate_editorial_preview` · `backend/apps/practice/api.py:754` | S/C；I | `payload:EditorialPreviewIn` | `{201: QuestionExposureOut}` |
| POST | `/api/v1/projects/{project_id}/attempts/{attempt_id}/diagnosis` | `set_diagnosis` · `backend/apps/practice/api.py:814` | S/C | `payload:DiagnosisIn` | `DiagnosisOut` |
| GET | `/api/v1/projects/{project_id}/grading-queue` | `grading_queue` · `backend/apps/practice/api.py:844` | S/— | `subject_id:str \| None=None; limit:int=30` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/attempts/{attempt_id}/transcriptions` | `list_transcriptions` · `backend/apps/practice/api.py:1039` | S/— | `无` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/attempts/{attempt_id}/transcriptions` | `create_transcription` · `backend/apps/practice/api.py:1058` | S/C；I | `payload:TranscriptionRequestIn` | `{201: TranscriptionOut}` |
| POST | `/api/v1/projects/{project_id}/transcriptions/{transcription_id}/confirm` | `confirm_transcription` · `backend/apps/practice/api.py:1103` | S/C | `payload:TranscriptionConfirmIn` | `TranscriptionOut` |
| POST | `/api/v1/projects/{project_id}/transcriptions/{transcription_id}/reject` | `reject_transcription` · `backend/apps/practice/api.py:1119` | S/C | `payload:TranscriptionRejectIn` | `TranscriptionOut` |
| POST | `/api/v1/projects/{project_id}/attempts/{attempt_id}/ai-estimate` | `create_ai_estimate` · `backend/apps/practice/api.py:1130` | S/C；I | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/attempts/{attempt_id}/ai-estimate` | `get_ai_estimate` · `backend/apps/practice/api.py:1160` | S/— | `无` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/attempts/{attempt_id}/ai-diagnosis` | `create_ai_diagnosis` · `backend/apps/practice/api.py:1169` | S/C；I | `payload:DiagnosisRequestIn` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/diagnosis-follow-ups/{follow_up_id}/answer` | `answer_diagnosis_follow_up` · `backend/apps/practice/api.py:1199` | S/C | `payload:FollowUpAnswerIn` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/diagnosis-follow-ups/{follow_up_id}/skip` | `skip_diagnosis_follow_up` · `backend/apps/practice/api.py:1209` | S/C | `无` | `未声明（动态 JSON）` |

本 app Schema（`backend/apps/practice/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `SessionCreateIn` · `backend/apps/practice/api.py:37` | `mode: str = SessionMode.PRACTICE; subject_id: str; question_ids: list[str] = []; task_id: str \| None = None; exam_spec_version_id: str \| None = None; purpose: str = 'practice'; duration_minutes: int \| None = None` |
| `SessionOut` · `backend/apps/practice/api.py:62` | `session_id: str; project_id: str; subject_id: str; mode: str; status: str; policy_version: str; grading_hidden: bool; revealed_at: str \| None; created_at: str; finished_at: str \| None; items: list[dict[str, Any]]; confirmed_score: str \| None; pending_max_score: str \| None; score_visible: bool; score_hidden_reason: str \| None = None; grading_withheld_session_item_ids: list[str] = []; server_time: str \| None = None; exam_started_at: str \| None = None; exam_deadline: str \| None = None; expired_at: str \| None = None` |
| `DraftIn` · `backend/apps/practice/api.py:91` | `draft: dict[str, Any]; draft_revision: int \| None = None` |
| `DraftOut` · `backend/apps/practice/api.py:96` | `session_item_id: str; draft_revision: int; draft_updated_at: str \| None; saved: bool` |
| `SubmitIn` · `backend/apps/practice/api.py:103` | `answer: dict[str, Any]; steps: list[Any] = []; asset_ids: list[str] = []; confidence: str = ''; client_active_ms: int \| None = None` |
| `SubmitOut` · `backend/apps/practice/api.py:111` | `session_item_id: str; attempt_id: str; grading_revision: int; submitted_at: str; receipt_only: bool; grade: dict[str, Any] \| None` |
| `ConfirmPartIn` · `backend/apps/practice/api.py:120` | `part_id: str; score: str \| None = None; decision: str = 'award'; comment: str = ''` |
| `ConfirmGradeIn` · `backend/apps/practice/api.py:127` | `expected_grading_revision: int; parts: list[ConfirmPartIn]; answer_key_version_id: str \| None = None; rubric_version_id: str \| None = None; comment: str = ''` |
| `RevealOut` · `backend/apps/practice/api.py:135` | `question_version_id: str; answer_key_version_id: str \| None; answer_payload: dict[str, Any]; answer_source_type: str \| None; answer_verification_status: str \| None; check_basis: str; explanation_blocks: list[Any]; rubric: dict[str, Any] \| None; confidence_note: str; exposure_recorded: bool` |
| `DiagnosisIn` · `backend/apps/practice/api.py:148` | `error_type: str; status: str = 'confirmed'; note: str = ''` |
| `DiagnosisOut` · `backend/apps/practice/api.py:154` | `id: str; attempt_id: str; error_type: str; origin: str; status: str; note: str` |
| `ContaminationEvidenceOut` · `backend/apps/practice/api.py:163` | `evidence_id: str; evidence_type: str; exposure_kind: str \| None = None; question_id: str; project_id: str \| None = None; session_item_id: str \| None = None; server_time: str \| None = None` |
| `ExclusionReasonOut` · `backend/apps/practice/api.py:175` | `code: str; message: str; evidence: ContaminationEvidenceOut` |
| `QuestionExposureOut` · `backend/apps/practice/api.py:181` | `question_id: str; seen: bool; reasons: list[str]; first_seen_at: str \| None = None; sources: list[str]; strict_independent_eligible: bool; exclusion_reasons: list[ExclusionReasonOut]` |
| `ExternalSeenIn` · `backend/apps/practice/api.py:193` | `seen: bool = True; note: str = ''` |
| `EditorialPreviewIn` · `backend/apps/practice/api.py:198` | `note: str = ''` |
| `TranscriptionRequestIn` · `backend/apps/practice/api.py:932` | `asset_id: str; text: str \| None = None` |
| `TranscriptionOut` · `backend/apps/practice/api.py:939` | `transcription_id: str; attempt_id: str; asset_id: str; origin: str; status: str; raw_text: str; confirmed_text: str; confidence: float \| None; doubts: list[Any]; is_stub: bool; note: str; is_confirmed: bool; decided_at: str \| None; llm_run_id: str \| None; prompt_version: str` |
| `TranscriptionConfirmIn` · `backend/apps/practice/api.py:957` | `text: str \| None = None; note: str = ''` |
| `TranscriptionRejectIn` · `backend/apps/practice/api.py:963` | `note: str = ''` |
| `DiagnosisRequestIn` · `backend/apps/practice/api.py:967` | `learner_note: str = ''` |
| `FollowUpAnswerIn` · `backend/apps/practice/api.py:971` | `text: str` |

### 1.10 question_bank（23 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| GET | `/api/v1/projects/{project_id}/questions` | `list_questions` · `backend/apps/question_bank/api.py:285` | S/— | `subject_id:str \| None=None; question_type:str \| None=None; status:str \| None=None; origin_type:str \| None=None; search:str \| None=None; limit:int=20; offset:int=0` | `list[QuestionListItem]` |
| GET | `/api/v1/projects/{project_id}/questions/{question_id}` | `get_question` · `backend/apps/question_bank/api.py:374` | S/— | `无` | `QuestionPreviewOut` |
| POST | `/api/v1/projects/{project_id}/questions/{question_id}/revisions` | `create_revision` · `backend/apps/question_bank/api.py:443` | S/C；I | `payload:DraftIn` | `{201: VersionOut}` |
| PATCH | `/api/v1/projects/{project_id}/question-versions/{version_id}` | `patch_version` · `backend/apps/question_bank/api.py:473` | S/C | `payload:DraftIn` | `VersionOut` |
| POST | `/api/v1/projects/{project_id}/question-versions/{version_id}/publish` | `publish_version` · `backend/apps/question_bank/api.py:491` | S/C；I | `无` | `VersionOut` |
| POST | `/api/v1/projects/{project_id}/question-versions/{version_id}/withdraw` | `withdraw_version` · `backend/apps/question_bank/api.py:511` | S/C；I | `reason:str=''` | `VersionOut` |
| GET | `/api/v1/projects/{project_id}/questions/{question_id}/answer-keys` | `list_answer_keys` · `backend/apps/question_bank/api.py:531` | S/— | `无` | `list[AnswerKeyOut]` |
| GET | `/api/v1/projects/{project_id}/questions/{question_id}/source-regions` | `list_source_regions` · `backend/apps/question_bank/api.py:555` | S/— | `无` | `list[SourceRegionOut]` |
| GET | `/api/v1/projects/{project_id}/question-versions/{version_id}/mappings` | `list_mappings` · `backend/apps/question_bank/api.py:581` | S/— | `revision:int \| None=None` | `list[MappingOut]` |
| POST | `/api/v1/projects/{project_id}/question-versions/{version_id}/mappings` | `replace_mappings` · `backend/apps/question_bank/api.py:604` | S/C；I | `payload:list[MappingIn]` | `{201: list[MappingOut]}` |
| GET | `/api/v1/projects/{project_id}/rubric-versions/{rubric_id}` | `get_rubric` · `backend/apps/question_bank/api.py:651` | S/— | `无` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/questions/{question_id}/seal` | `seal_question` · `backend/apps/question_bank/api.py:671` | S/C | `payload:ReasonIn` | `{201: SealOut}` |
| POST | `/api/v1/projects/{project_id}/questions/{question_id}/unseal` | `unseal_question` · `backend/apps/question_bank/api.py:680` | S/C | `payload:ReasonIn` | `{201: SealOut}` |
| POST | `/api/v1/projects/{project_id}/question-families/{family_id}/seal` | `seal_family` · `backend/apps/question_bank/api.py:691` | S/C | `payload:ReasonIn` | `{201: SealOut}` |
| POST | `/api/v1/projects/{project_id}/question-families/{family_id}/unseal` | `unseal_family` · `backend/apps/question_bank/api.py:702` | S/C | `payload:ReasonIn` | `{201: SealOut}` |
| GET | `/api/v1/projects/{project_id}/sealed-content` | `list_sealed_content` · `backend/apps/question_bank/api.py:711` | S/— | `无` | `SealedContentOut` |
| GET | `/api/v1/projects/{project_id}/question-families` | `list_question_families` · `backend/apps/question_bank/api.py:721` | S/— | `subject_id:str \| None=None` | `list[FamilyOut]` |
| POST | `/api/v1/projects/{project_id}/question-families` | `create_question_family` · `backend/apps/question_bank/api.py:734` | S/C；I | `payload:FamilyIn` | `{201: FamilyOut}` |
| PATCH | `/api/v1/projects/{project_id}/question-families/{family_id}` | `patch_question_family` · `backend/apps/question_bank/api.py:757` | S/C | `payload:FamilyPatchIn` | `FamilyOut` |
| POST | `/api/v1/projects/{project_id}/question-families/{family_id}/questions` | `add_question_to_family` · `backend/apps/question_bank/api.py:777` | S/C；I | `payload:FamilyQuestionIn` | `{201: FamilyQuestionOut}` |
| DELETE | `/api/v1/projects/{project_id}/question-families/{family_id}/questions/{question_id}` | `remove_question_from_family` · `backend/apps/question_bank/api.py:803` | S/C | `无` | `FamilyQuestionOut` |
| GET | `/api/v1/projects/{project_id}/question-families/{family_id}/merge-impact` | `question_family_merge_impact` · `backend/apps/question_bank/api.py:831` | S/— | `target_family_id:str` | `MergeImpactOut` |
| POST | `/api/v1/projects/{project_id}/question-families/{family_id}/merge` | `merge_question_family` · `backend/apps/question_bank/api.py:844` | S/C；I | `payload:MergeIn` | `{201: MergeOut}` |

本 app Schema（`backend/apps/question_bank/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `QuestionListItem` · `backend/apps/question_bank/api.py:32` | `id: str; subject_id: str; display_label: str; origin_type: str; is_demo: bool; question_type: str \| None; published_version_id: str \| None; latest_version: int \| None; has_trusted_answer: bool; knowledge_nodes: list[str]` |
| `OptionOut` · `backend/apps/question_bank/api.py:45` | `id: str; label: str` |
| `QuestionPreviewOut` · `backend/apps/question_bank/api.py:50` | `id: str; version_id: str; subject_id: str; question_type: str; display_label: str; content: dict[str, Any]; options: list[OptionOut]; blank_ids: list[str]; material_child_version_ids: list[str]; practice_max_score: Decimal \| None; estimated_seconds: int \| None` |
| `VersionOut` · `backend/apps/question_bank/api.py:64` | `id: str; question_id: str; version: int; question_type: str; status: str; content: dict[str, Any]; practice_max_score: Decimal \| None; estimated_seconds: int \| None; revision_reason: str; published_at: str \| None` |
| `AnswerKeyOut` · `backend/apps/question_bank/api.py:77` | `id: str; version: int; verification_status: str; is_usable: bool; source_type: str; check_basis: str; checked_at: str \| None; is_disputed: bool` |
| `DraftIn` · `backend/apps/question_bank/api.py:94` | `question_type: str; content: dict[str, Any]; practice_max_score: Decimal \| None = None; estimated_seconds: int \| None = None; parent_material_version_id: str \| None = None; revision_reason: str = ''` |
| `MappingIn` · `backend/apps/question_bank/api.py:103` | `node_id: str; is_primary: bool = True; score_weight: Decimal = Decimal('1'); template_id: str \| None = None; note: str = ''` |
| `MappingOut` · `backend/apps/question_bank/api.py:111` | `id: str; mapping_revision: int; node_id: str; node_name: str; is_primary: bool; score_weight: Decimal; template_id: str \| None` |
| `SourceRegionOut` · `backend/apps/question_bank/api.py:121` | `id: str; document_id: str; page_index: int; x: float; y: float; width: float; height: float; role: str; crop_asset_id: str \| None` |
| `ReasonIn` · `backend/apps/question_bank/api.py:133` | `reason: str = ''` |
| `SealOut` · `backend/apps/question_bank/api.py:137` | `policy_id: str; target: str; question_id: str \| None; family_id: str \| None; revision: int; is_holdout: bool; change_reason: str; changed_at: str; sealed: bool; sealed_reason: str; sealed_question_ids: list[str]` |
| `SealedContentOut` · `backend/apps/question_bank/api.py:151` | `project_id: str; questions: list[dict[str, Any]]; families: list[dict[str, Any]]; counts: dict[str, int]; reason_codes: list[str]; generated_at: str` |
| `FamilyOut` · `backend/apps/question_bank/api.py:160` | `id: str; subject_id: str; name: str; revision: int; relation_confirmed: bool; note: str; member_count: int; sealed: bool; sealed_reason: str; sealed_member_count: int; merged_into_id: str \| None; merged_at: str \| None` |
| `FamilyIn` · `backend/apps/question_bank/api.py:175` | `subject_id: str; name: str; note: str = ''` |
| `FamilyPatchIn` · `backend/apps/question_bank/api.py:181` | `name: str \| None = None; relation_confirmed: bool \| None = None; note: str \| None = None` |
| `FamilyQuestionIn` · `backend/apps/question_bank/api.py:187` | `question_id: str` |
| `FamilyQuestionOut` · `backend/apps/question_bank/api.py:191` | `family_id: str; question_id: str; changed: bool; member_count: int; sealed: bool; sealed_reason: str` |
| `MergeImpactOut` · `backend/apps/question_bank/api.py:200` | `project_id: str; source_family_id: str; target_family_id: str; source_family_name: str; target_family_name: str; already_merged: bool; questions_to_move: int; questions_in_target_after: int; evidence_rows_to_invalidate: int; affected_user_ids: list[str]; exposed_before_merge: int; exposed_after_merge: int; exposed_question_ids_before_merge: list[str]` |
| `MergeIn` · `backend/apps/question_bank/api.py:216` | `target_family_id: str; reason: str = ''` |
| `MergeOut` · `backend/apps/question_bank/api.py:221` | `project_id: str; source_family_id: str; target_family_id: str; merge_revision: int; questions_moved: int; questions_in_target_after: int; evidence_invalidated: int; states_recomputed: int; exposed_before_merge: int; exposed_after_merge: int; exposure_changes: list[dict[str, Any]]; affected_user_ids: list[str]; noop: bool; content_revision_id: str \| None` |

### 1.11 search（2 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| GET | `/api/v1/projects/{project_id}/search` | `search` · `backend/apps/search/api.py:59` | S/— | `q:str; subject_id:str \| None=None; limit:int=Query(10, ge=1, le=50); channel:str=SearchChannel.HYBRID.value` | `SearchOut` |
| POST | `/api/v1/projects/{project_id}/search/reindex` | `reindex` · `backend/apps/search/api.py:89` | S/C；I | `payload:ReindexIn \| None=None` | `{200: ReindexOut}` |

本 app Schema（`backend/apps/search/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `SearchOut` · `backend/apps/search/api.py:26` | `project_id: str; subject_id: str \| None; query: str; query_tokens: list[str]; channel: str; limit: int; candidate_documents: int; tokenizer_version: str; fusion: dict[str, Any] \| None; channels: dict[str, Any]; notes: list[str]; results: list[dict[str, Any]]` |
| `ReindexIn` · `backend/apps/search/api.py:41` | `subject_id: str \| None = None` |
| `ReindexOut` · `backend/apps/search/api.py:45` | `project_id: str; subject_id: str \| None; indexed: int; excluded: int; embeddings: int; embedding_unavailable_reason: str \| None; embedding_model: str \| None; documents_total: int; documents_in_index: int; tokenizer_version: str` |

### 1.12 tutoring（8 个操作）

| 方法 | 完整路径 | handler / 定位 | auth/CSRF/幂等 | 请求 Schema / query / form | response 声明 |
|---|---|---|---|---|---|
| GET | `/api/v1/projects/{project_id}/ai-status` | `get_ai_status` · `backend/apps/tutoring/api.py:80` | S/— | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/ai-runs` | `list_ai_runs` · `backend/apps/tutoring/api.py:87` | S/— | `limit:int=20` | `未声明（动态 JSON）` |
| POST | `/api/v1/projects/{project_id}/tutor-sessions` | `create_tutor_session` · `backend/apps/tutoring/api.py:93` | S/C；I | `payload:TutorSessionIn` | `{201: TutorSessionOut}` |
| POST | `/api/v1/projects/{project_id}/tutor-sessions/{tutor_session_id}/messages` | `post_message` · `backend/apps/tutoring/api.py:126` | S/C；I | `payload:TutorMessageIn` | `{201: TutorJobOut}` |
| GET | `/api/v1/projects/{project_id}/tutor-jobs/{job_id}/stream` | `stream_job` · `backend/apps/tutoring/api.py:214` | S/— | `after:int \| None=None; poll_seconds:float=tutor_streaming.DEFAULT_POLL_SECONDS; max_seconds:float=tutor_streaming.DEFAULT_STREAM_SECONDS` | `未声明；StreamingHttpResponse（SSE）` |
| GET | `/api/v1/projects/{project_id}/tutor-jobs/{job_id}/segments` | `list_job_segments` · `backend/apps/tutoring/api.py:252` | S/— | `无` | `未声明（动态 JSON）` |
| GET | `/api/v1/projects/{project_id}/tutor-jobs/{job_id}` | `get_job` · `backend/apps/tutoring/api.py:265` | S/— | `无` | `TutorJobOut` |
| GET | `/api/v1/projects/{project_id}/tutor-sessions` | `list_tutor_sessions` · `backend/apps/tutoring/api.py:277` | S/— | `session_item_id:str \| None=None; limit:int=20` | `未声明（动态 JSON）` |

本 app Schema（`backend/apps/tutoring/api.py`；字段语法保留 Python 默认值；无默认值表示必填）：

| Schema / 定位 | 字段 |
|---|---|
| `TutorSessionIn` · `backend/apps/tutoring/api.py:22` | `session_item_id: str; purpose: str = 'explanation'` |
| `TutorSessionOut` · `backend/apps/tutoring/api.py:27` | `tutor_session_id: str; session_item_id: str; purpose: str; attempt_id: str \| None; prompt_version: str; question_version_id: str \| None; answer_key_version_id: str \| None; created_at: str` |
| `TutorMessageIn` · `backend/apps/tutoring/api.py:38` | `user_question: str = ''; purpose: str \| None = None` |
| `TutorJobOut` · `backend/apps/tutoring/api.py:43` | `tutor_job_id: str; tutor_session_id: str; session_item_id: str; purpose: str; status: str; reveals_answer: bool; is_stale: bool; is_stub: bool; provider: str; model: str; prompt_version: str; error_code: str; error_message: str; delivered_at: str \| None; segment_count: int; result_blocks: list[Any]; citations: list[str]; missing_information: list[str]; suggested_next: list[str]` |

### 1.13 非业务 Ninja URL、Django 入口及传输细节

| 入口 | handler / 定位 | 方法与 auth/CSRF | 输出/限制 |
|---|---|---|---|
| `/health/live` | `health_live` · `backend/apps/accounts/views.py:29` | 源码未限制方法；公开、csrf_exempt | JSON `{status:"ok",service:"acepass-api"}` |
| `/health/ready` | `health_ready` · `backend/apps/accounts/views.py:34` | 源码未限制方法；公开、csrf_exempt | DB `SELECT 1` 失败为 503；cache 写读失败仅 degraded；暴露 provider 标识 |
| `/admin/` | `admin.site.urls` · `backend/config/urls.py:42` | Django admin 子路由；非 Ninja，内置 staff/session/CSRF | 非本仓库逐条声明的业务 API |
| `/assets/<path:path>` | lambda → Django `static_serve` · `backend/config/urls.py:54` | 仅 FRONTEND_DIST 存在时注册；无应用级 auth | 构建产物 |
| `/<path:path>` | `catch_all` · `backend/config/urls.py:61` → `spa_index:19` | 无应用级 auth；普通 Django middleware | 保留前缀 api/admin/static/health/assets 返回404；其余 SPA shell 或 frontend_not_built 503；没有另写 `path("",spa_index)` |
| `/api/v1/openapi.json`、`/api/v1/docs`、`/api/v1/` | Ninja `openapi_json`、`openapi_view`、`default_home` | 框架自动入口，未配置 docs_decorator；不计154 | 已读 `.venv/.../ninja/openapi/urls.py:14`、`:40` 和 `main.py:62`；root 为框架默认入口而非业务端点 |

- 文件下载：`backend/apps/ingestion/api.py:308` 检查资产所有者/项目/purpose/活动验证 gate，记录 exposure，再流式读取私有存储，`Cache-Control: private, no-store`、nosniff；迁移时不能改为公开静态目录。
- Tutor stream：`backend/apps/tutoring/api.py:214` 是受认证的 GET SSE；after/Last-Event-ID、持久 segment、终止与重连规则见第3、4、6节。
- HTTP GET 不保证无业务写入：如 reports/practice 默认 save_snapshot=True（`backend/apps/analytics/api.py:77`），今天计划/检索等读路径也可触发重算/索引；移植时以服务行为与测试为准。

## 2. 数据模型与持久化边界

统计口径：AST 解析 `backend/apps/*/models.py`，仅统计 Django 模型类，排除 `UserManager` 和 `SearchDocumentKind` 枚举；未连接数据库，以下是源码声明而非线上 schema。
共 **13 个模型文件、57 个实体模型、3 个抽象模型**；实体分布为 accounts 2、analytics 3、audit 5、exams 7、ingestion 6、knowledge 6、learning 4、memory 2、practice 9、question_bank 8、search 1、tutoring 4。
显式字段声明包含 **59 个 JSONField、189 个 ForeignKey、4 个 OneToOneField、2 个 ManyToManyField、16 个 DecimalField**；不重复展开抽象继承字段。
显式约束包含 **31 个 UniqueConstraint（其中 3 个带条件）、6 个 CheckConstraint、32 个 Meta Index、4 个 unique=True 字段、57 个 db_index=True 字段声明**；后者包含抽象类声明，不等于实际数据库索引数。
`User` 继承的 `groups`、`user_permissions` 两个 M2M 已进入 migration，所以“显式 M2M=2”不是完整 schema 的关系总数（`backend/apps/accounts/migrations/0001_initial.py:33`）。
关系记法：`字段→模型` 默认 FK；`1:1`、`M2M` 单独标明。后缀 `?` 表示 on_delete=SET_NULL，`!` 表示 PROTECT，无后缀表示 CASCADE；193 个 FK/O2O 声明中三者分别为 76、23、94。这里的 `?` 不表示所有 nullable 字段，CASCADE/PROTECT 字段也可能 nullable。
约束记法：U=唯一约束或 unique=True；C=显式检查约束；I=Meta 复合索引；i=显式 db_index=True。J 列出模型全部 JSON 字段，— 表示没有。未列 U/C/I/i 表示没有额外显式声明，不包含 PK、FK 默认索引和继承项。

### 2.1 公共基类

- `UUIDPrimaryKeyMixin`（`backend/apps/common/models.py:10`）：抽象；UUID id 主键，default=uuid.uuid4、editable=False；J=—；无独立表。
- `TimeStampedMixin`（`backend/apps/common/models.py:17`）：抽象；created_at=auto_now_add 且 i(created_at)，updated_at=auto_now；J=—；无独立表。
- `BaseModel`（`backend/apps/common/models.py:25`）：抽象；组合 UUID 与时间戳。55 个实体模型继承它；User 单独声明 UUID，UserSettings 使用隐式 BigAutoField（`backend/apps/accounts/migrations/0001_initial.py:48`）。

### 2.2 accounts：身份与学习设置

- `User`（表 `accounts_user`；`backend/apps/accounts/models.py:46`）：身份；关键字段 id/email/display_name/is_active/is_staff/date_joined；J=—。  U(email)；继承认证字段与 M2M groups→auth.Group、user_permissions→auth.Permission（`backend/apps/accounts/migrations/0001_initial.py:24`）。
- `UserSettings`（表 `accounts_user_settings`；`backend/apps/accounts/models.py:74`）：全局学习预算与时区；timezone/daily_budget_minutes/undiagnosed_time_share_percent/default_practice_tutoring；J=project_budget_percent。  1:1 user→User；预算和未诊断份额上限使用字段 validators，不是本文件声明的 CheckConstraint。

### 2.3 exams：项目、规范、大纲与试卷

- `ExamProject`（表 `exams_project`；`backend/apps/exams/models.py:16`）：考试目标与归档；name/target_date/target_score/is_archived/archived_at/display_order；J=—。  owner→User；U(owner,name)；i(is_archived)。
- `Subject`（表 `exams_subject`；`backend/apps/exams/models.py:41`）：项目科目；name/code/display_order/total_score/pass_score；J=—。  project→ExamProject；U(project,name)。
- `ExamSpecVersion`（表 `exams_spec_version`；`backend/apps/exams/models.py:63`）：版本化计分规范；version/status/total_score/pass_score/score_floor_at_zero/is_demo/published_at；J=question_type_rules,time_rules。  subject→Subject, created_by→User?；U(subject,version)；i(status)。
- `SyllabusVersion`（表 `exams_syllabus_version`；`backend/apps/exams/models.py:128`）：大纲与适用时间；name/version_label/applies_from/applies_to/review_status/status/is_user_provisional；J=—。  subject→Subject, source_document→SourceDocument?, created_by→User?；U(subject,name,version_label)；i(status)。
- `Paper`（表 `exams_paper`；`backend/apps/exams/models.py:165`）：稳定的考试发生记录；cycle_key/session_key/paper_code/title/source_kind/is_demo；J=—。  subject→Subject, effective_revision→PaperRevision?；U(subject,cycle_key,session_key,paper_code)。
- `PaperRevision`（表 `exams_paper_revision`；`backend/apps/exams/models.py:206`）：试卷版本与覆盖确认；revision/expected_session_count/covered_session_count/coverage_confirmed_at/status；J=—。  paper→Paper, spec_version→ExamSpecVersion!, coverage_confirmed_by→User?；U(paper,revision)；i(status)。
- `PaperItem`（表 `exams_paper_item`；`backend/apps/exams/models.py:255`）：试卷版本中的计分叶题；position_key/max_score/is_scored/is_demo；J=—。  revision→PaperRevision, parent_item→PaperItem, question_version→QuestionVersion!, answer_key_version→AnswerKeyVersion!；U(revision,position_key)。

### 2.4 ingestion：文件、导入与校对

- `Asset`（表 `ingestion_asset`；`backend/apps/ingestion/models.py:19`）：私有存储对象；role/sensitivity/object_key/content_type/size_bytes/checksum/width/height/is_retained；J=—。  owner→User, project→ExamProject, subject→Subject?, source_document→SourceDocument?, uploaded_by→User?；U(object_key)；I(project,role)；i(project,checksum)。
- `SourceDocument`（表 `ingestion_source_document`；`backend/apps/ingestion/models.py:65`）：原始材料与文本溯源；title/document_type/role/sensitivity/raw_text/checksum/source_type/usage_scope/page_count；J=page_texts。  owner→User, project→ExamProject, subject→Subject?, asset→Asset!；I(project,-created_at)；i(project,checksum)。
- `SourceRegion`（表 `ingestion_source_region`；`backend/apps/ingestion/models.py:109`）：页码与归一化选区；page_index/x/y/width/height/role/text_span/char_start/char_end；J=—。  document→SourceDocument, crop_asset→Asset?；C(x≥0,y≥0,width>0,height>0)、C(x≤1,y≤1)；完整矩形边界另由 clean() 校验。
- `ImportJob`（表 `ingestion_import_job`；`backend/apps/ingestion/models.py:151`）：导入任务与重试；status/input_kind/input_text/extractor_version/progress_percent/attempts/max_attempts/input_fingerprint；J=problems,page_diagnostics。  project→ExamProject, subject→Subject?, created_by→User, duplicate_of→ImportJob?；M2M documents→SourceDocument；I(project,status,-created_at)；i(project,status,input_fingerprint)。
- `ImportCandidate`（表 `ingestion_import_candidate`；`backend/apps/ingestion/models.py:201`）：待校对题目结构；source_position_key/status/revision/extractor_version/is_stub_output/layout_review_confirmed_at/publication_question_id/publication_version_id/publication_paper_item_id；J=answer_match,draft_payload,machine_payload,review_issues。  job→ImportJob, project→ExamProject, subject→Subject?, parent_candidate→ImportCandidate?, paper_revision→PaperRevision?, duplicate_of_candidate→ImportCandidate?, reviewed_by→User?；M2M source_regions→SourceRegion；i(source_position_key,status)。
- `CandidateRevision`（表 `ingestion_candidate_revision`；`backend/apps/ingestion/models.py:269`）：校对快照；revision/note；J=payload,review_issues。  candidate→ImportCandidate, edited_by→User?；U(candidate,revision)。

### 2.5 question_bank：题目身份、版本与封存

- `ContentLineage`（表 `question_bank_content_lineage`；`backend/apps/question_bank/models.py:24`）：同一所有者跨项目内容谱系；basis/is_confirmed/note；J=—。  owner→User；谱系属于用户作用域，并非全局内容 hash。
- `QuestionFamily`（表 `question_bank_family`；`backend/apps/question_bank/models.py:43`）：近重复题族与合并；name/relation_confirmed/revision/merged_at；J=—。  subject→Subject, merged_into→QuestionFamily?；U(subject,name)。
- `Question`（表 `question_bank_question`；`backend/apps/question_bank/models.py:74`）：稳定题目身份；origin_type/is_demo/display_label；J=—。  subject→Subject, current_published_version→QuestionVersion?, family→QuestionFamily?, content_lineage→ContentLineage?, created_by→User?；I(subject,origin_type)。
- `QuestionVersion`（表 `question_bank_question_version`；`backend/apps/question_bank/models.py:109`）：题面修订；version/question_type/practice_max_score/estimated_seconds/status/content_digest/published_at/withdrawn_at；J=content,material_child_version_ids。  question→Question, parent_material_version→QuestionVersion!, created_by→User?；U(question,version)；i(status)。
- `QuestionSourceLink`（表 `question_bank_source_link`；`backend/apps/question_bank/models.py:179`）：题面/答案/材料来源；role/note；J=—。  question_version→QuestionVersion, region→SourceRegion!；U(question_version,region,role)。
- `AnswerKeyVersion`（表 `question_bank_answer_key_version`；`backend/apps/question_bank/models.py:197`）：答案修订与核验；version/source_type/verification_status/checked_at/check_basis/is_disputed；J=answer_payload,explanation_blocks。  question_version→QuestionVersion, checked_by→User?, source_region→SourceRegion?, supersedes→AnswerKeyVersion?, created_by→User?；U(question_version,version)；i(verification_status)。
- `RubricVersion`（表 `question_bank_rubric_version`；`backend/apps/question_bank/models.py:248`）：主观题评分点；version/total_score/usage_note/checked_at/is_disputed；J=criteria。  1:1 answer_key_version→AnswerKeyVersion；FK checked_by→User?；每个答案至多一个 rubric 行，draft 内容可原地更新。
- `QuestionPoolPolicy`（表 `question_bank_pool_policy`；`backend/apps/question_bank/models.py:313`）：题目/题族训练与保留策略修订；revision/is_holdout/change_reason；J=—。  project→ExamProject, family→QuestionFamily, question→Question, changed_by→User?；C(family 非空 OR question 非空)，数据库约束未要求二选一。

### 2.6 knowledge：知识体系、映射与验证配对

- `KnowledgeNode`（表 `knowledge_node`；`backend/apps/knowledge/models.py:14`）：大纲章节/考点；kind/canonical_name/code/is_unclassified/display_order；J=aliases。  syllabus_version→SyllabusVersion, parent→KnowledgeNode；U(syllabus_version,parent,canonical_name)；parent 可空。
- `QuestionTemplate`（表 `knowledge_question_template`；`backend/apps/knowledge/models.py:69`）：人工问法模板；name/description/review_status；J=—。  subject→Subject, confirmed_by→User?；U(subject,name)。
- `QuestionKnowledge`（表 `knowledge_question_mapping`；`backend/apps/knowledge/models.py:93`）：版本化考点映射；mapping_revision/is_primary/score_weight/note；J=—。  question_version→QuestionVersion, node→KnowledgeNode!, template→QuestionTemplate?；U(question_version,mapping_revision,node)；C(0≤score_weight≤1)。
- `VerificationPairing`（表 `knowledge_verification_pairing`；`backend/apps/knowledge/models.py:135`）：人工审核的基准/即时/延迟配对；pairing_version/delay_hours/is_active/reviewed_at；J=—。  project→ExamProject, subject→Subject, node→KnowledgeNode!, baseline_question/immediate_question/delayed_question→Question!, reviewer→User?；U(project,subject,node,pairing_version)；i(is_active)。
- `KnowledgeRelation`（表 `knowledge_relation`；`backend/apps/knowledge/models.py:204`）：知识节点有向关系；relation_type/is_active/note；J=—。  syllabus_version→SyllabusVersion, from_node/to_node→KnowledgeNode, created_by→User?；U(from_node,to_node,relation_type)；C(from_node≠to_node)；I(syllabus_version,relation_type,is_active)；i(is_active)。
- `TagSuggestion`（表 `knowledge_tag_suggestion`；`backend/apps/knowledge/models.py:257`）：机器建议及人工决定；status/model_identifier/prompt_version/is_stub/accepted_mapping_revision/decided_at；J=proposals,unresolved_names。  project→ExamProject, question_version→QuestionVersion, run→LLMRun?, decided_by/created_by→User?；C(status 属于 proposed/accepted/rejected/superseded)；I(project,status,-created_at)；i(status)。

### 2.7 practice：会话、作答、评分与证据

- `PracticeSession`（表 `practice_session`；`backend/apps/practice/models.py:25`）：练习/验证/考试生命周期；mode/status/policy_version/revealed_at/finished_at/exam_started_at/exam_deadline/expired_at；J=—。  user→User, project→ExamProject, subject→Subject, origin_task→StudyTask?；I(user,status,-created_at)；i(mode,status)；有 save() 生命周期检查。
- `SessionItem`（表 `practice_session_item`；`backend/apps/practice/models.py:121`）：固定呈现与评分版本；ordinal/mapping_revision/max_score/purpose/tutoring_allowed/first_delivered_at/draft_revision；J=draft。  session→PracticeSession, question_version→QuestionVersion!, answer_key_version→AnswerKeyVersion!, rubric_version→RubricVersion!, spec_version→ExamSpecVersion!, paper_item→PaperItem?, pairing→VerificationPairing?；U(session,ordinal)。
- `Attempt`（表 `practice_attempt`；`backend/apps/practice/models.py:172`）：原始提交及有效评分指针；confidence/submitted_at/elapsed_ms/client_active_ms/request_digest/idempotency_key/grading_revision/applied_regrade_generation；J=raw_answer,steps,attachments。  1:1 session_item→SessionItem!；FK user→User!, project→ExamProject!, current_grade_event→GradeEvent?；I(user,project,-submitted_at)；i(idempotency_key)，该字段无单独唯一约束。
- `GradeEvent`（表 `practice_grade_event`；`backend/apps/practice/models.py:210`）：评分修订历史；kind/status/method/grading_revision/confirmed_score/max_score/pending_max_score/estimated_score/is_fully_confirmed/is_superseded；J=parts,rule_snapshot。  attempt→Attempt, answer_key_version→AnswerKeyVersion!, rubric_version→RubricVersion!, spec_version→ExamSpecVersion!, grader→User?, supersedes→GradeEvent?, llm_run→LLMRun?；U(attempt,grading_revision)；I(attempt,-grading_revision)；i(is_superseded)。
- `ExposureEvent`（表 `practice_exposure_event`；`backend/apps/practice/models.py:275`）：实际内容交付曝光账本；kind/purpose/source/server_time/reveals_answer；J=detail。  user→User, project→ExamProject, question→Question?, question_version→QuestionVersion?, family→QuestionFamily?, content_lineage→ContentLineage?, session_item→SessionItem?；I(user,question,kind)、I(question_version,kind)；i(kind,server_time,reveals_answer)。
- `ErrorDiagnosis`（表 `practice_error_diagnosis`；`backend/apps/practice/models.py:326`）：候选错误原因，不直接改分；error_type/origin/status/note/decided_at；J=evidence。  attempt→Attempt, llm_run→LLMRun?, decided_by→User?；i(status)。
- `AnswerTranscription`（表 `practice_answer_transcription`；`backend/apps/practice/models.py:355`）：答题照片转写与确认；asset_id/origin/status/raw_text/confirmed_text/confidence/is_stub/decided_at；J=doubts。  attempt→Attempt, run→LLMRun?, decided_by→User?；U(attempt,asset_id)；I(attempt,status)；i(status)；asset_id 是字符串，非 Asset FK。
- `DiagnosisFollowUp`（表 `practice_diagnosis_follow_up`；`backend/apps/practice/models.py:404`）：诊断追问及回答；question/why/evidence_kind/status/answer_text/answered_at；J=—。  attempt→Attempt, run→LLMRun?；I(attempt,status)；i(status)。
- `LearningEvidence`（表 `practice_learning_evidence`；`backend/apps/practice/models.py:436`）：作答证明的学习维度投影；grade_revision/dimension/qualifies/is_correct/score_fraction/rule_version/computed_at/is_active/invalidated_at；J=exclusion_reasons,detail。  attempt→Attempt, session_item→SessionItem, user→User, project→ExamProject, grade_event→GradeEvent?, knowledge_node→KnowledgeNode；U(attempt,dimension,knowledge_node,grade_revision)；I(user,project,dimension,qualifies)；i(dimension,qualifies,is_active)。

### 2.8 learning 与 memory：计划、状态和复习

- `LearnerKnowledgeState`（表 `learning_knowledge_state`；`backend/apps/learning/models.py:15`）：用户/项目/大纲/节点证据投影；summary/best_summary/independent_correct_count/distinct_question_count/distinct_template_count/needs_review/projection_version/rule_version/as_of；J=detail,source_evidence_ids。  user→User, project→ExamProject, syllabus_version→SyllabusVersion, node→KnowledgeNode；U(user,project,syllabus_version,node)；I(user,project,summary)；i(needs_review)。
- `StudyPlan`（表 `learning_study_plan`；`backend/apps/learning/models.py:66`）：每日预算与轮转快照；plan_date/timezone/revision/daily_budget_minutes/allocated_minutes/rotation_offset/rule_version/generated_at；J=allocation,project_order,notes。  user→User；U(user,plan_date,revision)；I(user,plan_date,-revision)；i(plan_date)。
- `StudyTask`（表 `learning_study_task`；`backend/apps/learning/models.py:98`）：计划任务及延迟门槛；task_kind/status/pairing_version/trigger_event/delay_anchor_at/not_before/due_at/estimated_minutes/rule_version；J=reason_codes,evidence_ids。  plan→StudyPlan?, user→User, project→ExamProject, subject→Subject, question→Question?, knowledge_node→KnowledgeNode?, pairing→VerificationPairing?, origin_session_item→SessionItem?, memory_card→MemoryCard?；条件 U(user,pairing,origin_session_item,task_kind)，条件 origin_session_item 非空；I(plan,status)、I(user,project,status)；i(task_kind,status,not_before)。
- `ReviewTask`（表 `learning_review_task`；`backend/apps/learning/models.py:164`）：延迟验证锚点；delay_hours/delay_anchor_at/not_before/anchor_source/was_started/missing_question_reason；J=—。  user→User, project→ExamProject, knowledge_node→KnowledgeNode?；1:1 study_task→StudyTask；i(not_before)。
- `MemoryCard`（表 `memory_card`；`backend/apps/memory/models.py:25`）：用户/题目 FSRS 当前状态；phase/stability/difficulty/due_at/last_reviewed_at/reps/lapses/learning_step/scheduler_version/params_version/desired_retention/is_suspended；J=—。  user→User, project→ExamProject, subject→Subject, question→Question, knowledge_node→KnowledgeNode?；U(user,question)；I(user,project,due_at)、I(user,is_suspended,due_at)；i(phase,due_at)。
- `MemoryReviewLog`（表 `memory_review_log`；`backend/apps/memory/models.py:79`）：复习账本与前后状态；rating/reviewed_at/elapsed_days/scheduled_days/interval_days/retrievability/phase_before/phase_after/stability_before/stability_after/difficulty_before/difficulty_after/due_before/due_after/scheduler_version/params_version/idempotency_key；J=—。  card→MemoryCard, user→User, source_session_item→SessionItem?；U(card,idempotency_key)；I(card,-reviewed_at)、I(user,reviewed_at)；i(reviewed_at)。

### 2.9 tutoring：辅导任务与已验证内容

- `TutorSession`（表 `tutoring_session`；`backend/apps/tutoring/models.py:11`）：练习题项辅导线程；purpose/prompt_version；J=—。  user→User, project→ExamProject, practice_session→PracticeSession, session_item→SessionItem, attempt→Attempt?, question_version→QuestionVersion?, answer_key_version→AnswerKeyVersion?, rubric_version→RubricVersion?；I(user,project,-created_at)。
- `TutorJob`（表 `tutoring_job`；`backend/apps/tutoring/models.py:54`）：模型请求及结果；purpose/status/request_text/error_code/input_fingerprint/is_stale/reveals_answer/delivered_at/finalized_at；J=result_blocks,citations,missing_information,suggested_next。  tutor_session→TutorSession, user→User, project→ExamProject, llm_run→LLMRun?；I(user,status,-created_at)；i(status,input_fingerprint)。
- `TutorSegment`（表 `tutoring_segment`；`backend/apps/tutoring/models.py:98`）：已校验结果的顺序片段；index/kind/text/digest/is_stale/stale_reason；J=items。  job→TutorJob；U(job,index)；i(is_stale)；index 同时作为片段位置和 SSE event id。
- `TutorTurn`（表 `tutoring_turn`；`backend/apps/tutoring/models.py:138`）：对话日志；role/text；J=—。  tutor_session→TutorSession, job→TutorJob?；与已验证任务结果分开存储。

### 2.10 analytics、audit 与 search

- `ReportSnapshot`（表 `analytics_report_snapshot`；`backend/apps/analytics/models.py:15`）：报告快照；report_kind/calculation_version/as_of/status/is_stale；J=input_watermark,filters,payload,notes。  user→User, project→ExamProject, subject→Subject?；I(user,project,report_kind,-as_of)；i(status)。
- `RecomputeRun`（表 `analytics_recompute_run`；`backend/apps/analytics/models.py:46`）：证据/报告重算；reason/status/started_at/finished_at/affected_attempts/affected_evidence/error_message；J=scope,input_watermark。  user→User?, project→ExamProject；i(status)。
- `RegradeRun`（表 `analytics_regrade_run`；`backend/apps/analytics/models.py:72`）：指定答案/rubric 重判；reason/scope/status/generation/affected_attempts/regraded_attempts/stale_skipped_attempts/invalidated_evidence；J=—。  user→User, project→ExamProject, subject→Subject, question→Question, target_answer_key_version→AnswerKeyVersion!, target_rubric_version→RubricVersion!, requested_by→User?；U(question,generation)；i(status,generation)。
- `RequestLog`（表 `audit_request_log`；`backend/apps/audit/models.py:14`）：请求追踪；request_id/method/path/status_code/duration_ms/created_at；J=—。  user→User?；U(request_id)；I(user,-created_at)；i(created_at)。
- `IdempotencyRecord`（表 `audit_idempotency_record`；`backend/apps/audit/models.py:34`）：幂等状态和响应回放；route_scope/idempotency_key/request_fingerprint/status_code/resource_type/resource_id；J=response_body。  user→User；U(user,route_scope,idempotency_key)。
- `OutboxEvent`（表 `audit_outbox_event`；`backend/apps/audit/models.py:59`）：事务出箱与租约；topic/status/attempts/max_attempts/available_at/dispatched_at/claimed_at/claim_token/lease_expires_at/processed_at/dedupe_key；J=payload。  无关系字段；U(dedupe_key，可空)；I(status,available_at)、I(status,lease_expires_at)；i(topic,status,available_at,lease_expires_at)。
- `LLMRun`（表 `audit_llm_run`；`backend/apps/audit/models.py:101`）：模型调用/校验/token/费用审计；provider/model_identifier/capability/prompt_version/status/prompt_tokens/completion_tokens/cost_cents/cost_known/latency_ms/attempts/is_stub；J=request_summary,input_snapshot,retrieval_source_ids,validation_result。  user→User?；I(provider,-created_at)、I(capability,status)；i(project_id)；project_id 是 UUIDField，非项目 FK。
- `ContentRevision`（表 `audit_content_revision`；`backend/apps/audit/models.py:138`）：内容编辑审计；entity_type/entity_id/action/project_id/reason/before_digest/after_digest；J=detail。  actor→User?；I(entity_type,entity_id,-created_at)；i(project_id)；实体与项目标识不是 FK。
- `SearchDocument`（表 `search_document`；`backend/apps/search/models.py:34`）：题目版本/知识节点检索单元；kind/text/doc_length/embedding_model/embedding_dim/source_revision/is_searchable/exclusion_reason；J=tokens,term_frequencies,embedding。  project→ExamProject, subject→Subject, question→Question, question_version→QuestionVersion, knowledge_node→KnowledgeNode；条件 U(question_version,kind) / U(knowledge_node,kind)，分别要求目标非空；I(project,subject,is_searchable)；i(kind,is_searchable)。

### 2.11 不可变规则与校验层级

- 题面编辑先锁行并 assert_draft，已发布内容不能经此入口原地编辑（`backend/apps/question_bank/services/core.py:132`）；QuestionVersion 没有 save() 覆盖或数据库不可变 trigger。
- rubric 更新拒绝“答案可用且题目版本非 draft”；其他路径可修改同一行并递增 version，不能写成所有 rubric 永不可变（`backend/apps/question_bank/services/core.py:471`）。
- 映射建新 revision（`backend/apps/question_bank/services/core.py:500`），校对创建 CandidateRevision（`backend/apps/ingestion/services/core.py:636`），封存追加策略并在服务层要求恰好一个目标（`backend/apps/question_bank/services/sealing.py:270`）。
- Attempt 保留原始提交，但有效评分指针、revision、水位会更新；新 GradeEvent 建立后旧行 is_superseded 也更新（`backend/apps/practice/services/attempts.py:471`、`:764`）。
- PracticeSession.save 拒绝结束状态回 active；deadline 检查仅在新旧值均非空且不同时拒绝，NULL 转换未由此条件阻止，QuerySet.update 可绕过（`backend/apps/practice/models.py:69`）。
- MemoryReviewLog 为只增账本（`backend/apps/memory/services/scheduler.py:452`）；TutorSegment 内容按序新增，但 stale 标记会批量更新（`backend/apps/tutoring/services/streaming.py:142`、`:151`）。
- clean() 不是 DB check：SourceRegion 完整边界、同大纲/科目关系、辅助标签权重必须为0、评分上限、rubric 合计等见 `backend/apps/ingestion/models.py:146`、`backend/apps/knowledge/models.py:45`、`:130`、`:182`、`:245`、`backend/apps/practice/models.py:265`、`backend/apps/question_bank/models.py:274`；迁移时须保留显式调用和事务位置。

### 2.12 PostgreSQL / SQLite / Node 存储差异

- engine 固定 PostgreSQL，test settings 也保留真实 PostgreSQL 约束和事务（`backend/config/settings/base.py:139`、`backend/config/settings/test.py:1`）；Compose 使用 postgres:16-alpine（`infra/docker/docker-compose.yml:50`）。无可直接启用的 SQLite 配置。
- PostgreSQL 后端的 Django JSONField 实际采用 JSONB：59 个字段承载结构化内容、快照、embedding 等；SQLite JSON 文本或普通 Node store 不会自动保留数据库类型、查询与事务语义。类型映射可核对安装源码 `backend/.venv/lib/python3.12/site-packages/django/db/backends/postgresql/base.py:113` 的 data_types。
- analytics 0004 创建 `analytics_regrade_generation_seq`，用 setval/GREATEST 初始化，运行时 nextval 分配（`backend/apps/analytics/migrations/0004_p0_2_regrade_generation_sequence.py:53`、`:79`、`:114`；`backend/apps/analytics/models.py:130`）。迁移函数不按 vendor 跳过；模型中的非 PG fallback 不代表 SQLite 迁移链或并发语义已兼容，空表还没有可锁的最新行。
- 0004 先拒绝重复 (question,generation) 的歧义历史，再建序列/约束，不自动重排旧任务（同迁移文件 `:88`、`:137`）；必须保留“旧任务不能覆盖新评分”的顺序语义。
- 3 个 partial unique 已在 migrations：StudyTask（`backend/apps/learning/migrations/0003_alter_studytask_options_and_more.py:35`）、SearchDocument 两项（`backend/apps/search/migrations/0001_initial.py:49`）。条件唯一并非 PostgreSQL 独有，但 Node schema 重建必须保留 predicate。
- 搜索 backend/apps、backend/config 未发现 advisory lock、GIN/GiST、ExclusionConstraint、tsvector/tsquery 或不可变 trigger；不能据此断言线上没有手工 DB 对象。
- AST 定位 42 个 select_for_update 调用，其中 2 个 skip_locked=True；覆盖导入、发布、评分、转写、考试、记忆、重判、辅导、outbox。跳过锁行见 `backend/apps/audit/services/outbox.py:176`、`:446`；锁卡见 `backend/apps/memory/services/scheduler.py:407`。SQLite/进程队列不能直接照搬行锁/租约竞争语义。
- 服务先锁主行再载入 nullable 关联，以避开 PG 外连接可空侧 FOR UPDATE 限制（`backend/apps/practice/services/attempts.py:130`、`backend/apps/analytics/services/reports.py:762`）；检查、插入、指针更新及出箱写入须作为完整事务移植。
- 幂等插入捕获 IntegrityError 后回读旧记录（`backend/apps/audit/services/idempotency.py:59`）；唯一冲突是业务路径，不能只复制字段声明。
- 当前全文检索实际为 Python 分词/BM25 + JSON embedding cosine + RRF，非 PostgreSQL FTS（`backend/apps/search/services/hybrid.py:69`、`:193`；`backend/apps/search/services/vector.py:84`）。移植要保留先可见性过滤再评分。
- 16 个 DecimalField、UUID、带时区时间、choices/validators/clean/on_delete 必须显式映射；部分 *_id 是 UUIDField/CharField/JSON，并非 FK。KnowledgeNode.parent、LearningEvidence.knowledge_node、StudyTask.pairing 等 nullable 唯一键未设 nulls_distinct=False，不能自行用 sentinel 改变可接受数据集合。

## 3. 异步任务、Outbox、Redis 与幂等

### 3.1 注册任务全表

静态发现 **12 个 Celery 注册任务**：audit/tasks.py 10 个、tutoring/tasks.py 1 个、config/celery.py 1 个；**10 个 topic 有 outbox producer**，另 2 个由 beat 调度。注册模块见 `backend/config/celery.py:26`，producer 集合见 `:71`。下表行号定位装饰器，函数定义紧随下一行。

| Task name | 业务参数；除 scan 外另有可选 outbox_event_id | 消费者入口及作用 | 队列 |
|---|---|---|---|
| projection.rebuild_attempt_evidence | attempt_id | `backend/apps/audit/tasks.py:43` → evidence.rebuild_for_attempt | projection |
| projection.regrade_effects | attempt_id, grade_event_id | `backend/apps/audit/tasks.py:56` → 重建证据、刷新知识状态；grade_event_id 未参与 action | projection |
| projection.run_regrade | regrade_run_id | `backend/apps/audit/tasks.py:72` → regrade.execute_regrade_run | projection |
| projection.rebuild_after_answer_change | answer_key_version_id, affected_attempts=0 | `backend/apps/audit/tasks.py:85` → invalidate_for_answer_version；计数参数未参与 action | projection |
| projection.refresh_paper_stats | paper_id | `backend/apps/audit/tasks.py:100` → reports.mark_project_stale_for_paper | projection |
| learning.on_attempt_graded | attempt_id, grade_event_id | `backend/apps/audit/tasks.py:114` → 证据、知识状态、A/B/C 配对任务；grade_event_id 未参与 action | projection |
| learning.on_session_finished | session_id | `backend/apps/audit/tasks.py:132` → state.refresh_session_states | projection |
| learning.refresh_delayed_tasks | 无业务必填参数 | `backend/apps/audit/tasks.py:146` → pairing.reconcile_delayed_tasks | projection |
| learning.reconcile_plan | plan_id="" | `backend/apps/audit/tasks.py:160` → planner.reconcile_plan | projection |
| ingestion.extract_candidate | import_job_id, document_id, candidate_id | `backend/apps/audit/tasks.py:180` → 图像候选提取 | ingestion |
| tutoring.run_job | tutor_job_id, prompt, citations, purpose | `backend/apps/tutoring/tasks.py:21` → 辅导调用及结果终结 | tutoring |
| audit.scan_outbox | limit=100 | `backend/config/celery.py:29` → outbox.dispatch_pending | ingestion |

全部任务 ignore_result=True；完成事实查 DB，不依赖 Celery result。Beat 每30秒扫 outbox，每300秒刷新延迟任务（`backend/config/celery.py:37`）。队列 routing、ACKS_LATE、REJECT_ON_WORKER_LOST、prefetch=1 见 `backend/config/settings/base.py:211`、`:218`；inline 默认仅 test/demo 开启（`:205`）。`run_leased(None,action)` 直接执行，没有持久租约（`backend/apps/audit/services/outbox.py:255`）。`expire_mock_exams` 是 management command，未注册 Celery（`backend/apps/practice/management/commands/expire_mock_exams.py:1`）。

### 3.2 Producer 与业务去重

| Producer | Topic / payload | dedupe_key |
|---|---|---|
| `backend/apps/practice/services/attempts.py:315` | projection.rebuild_attempt_evidence / attempt_id | evidence:{attempt.id}:{grading_revision}；396/506/782行同模式 |
| `backend/apps/practice/services/attempts.py:320` | learning.on_attempt_graded / attempt_id,grade_event_id | graded:{attempt.id}:{grading_revision}；511行同模式 |
| `backend/apps/practice/services/attempts.py:787` | projection.regrade_effects / attempt_id,grade_event_id | regrade-effects:{attempt.id}:{grading_revision} |
| `backend/apps/practice/services/attempts.py:900` | projection.run_regrade / regrade_run_id | regrade-run:{run.id} |
| `backend/apps/practice/services/sessions.py:277` | learning.on_session_finished / session_id | session-finished:{session.id} |
| `backend/apps/question_bank/services/core.py:463` | projection.rebuild_after_answer_change / answer_key_version_id,affected_attempts | answer-change:{version.id}:{当前时间戳取整} |
| `backend/apps/exams/services/core.py:362` | projection.refresh_paper_stats / paper_id | paper-stats:{paper.id}:{revision.id} |
| `backend/apps/analytics/services/reports.py:902` | projection.refresh_paper_stats / paper_id；源码实际取 run.subject_id | regrade-report-refresh:{run.id} |
| `backend/apps/learning/services/planner.py:578` | learning.reconcile_plan / plan_id | plan:{plan.id} |
| `backend/apps/ingestion/services/imports.py:179` | ingestion.extract_candidate / 三个关联 ID | extract-candidate:{candidate.id} |
| `backend/apps/tutoring/services/core.py:357` | tutoring.run_job / job ID、完整 prompt、citations、purpose | tutor-job:{job.id} |

### 3.3 租约、事务、重投和完成

- Outbox 状态 pending/dispatched/processing/processed/failed（`backend/apps/common/enums.py:223`）；enqueue 在调用方当前事务内插入，failed 且未完成的去重行可被重置再排队（`backend/apps/audit/services/outbox.py:76`）。默认 lease=300秒、max_attempts=8、backoff=30秒且封顶1800秒（`backend/config/settings/base.py:227`；`outbox.py:59`）。
- `claim_event:171` 用 secrets.token_hex(16)、短事务和 select_for_update(skip_locked=True)，拒绝已完成/有效 processing lease；`hold_claim:215` 在业务写事务重锁行并校验 token，不单独按 lease_expires_at 判失权。路径均为 `backend/apps/audit/services/outbox.py`。
- `mark_processed:192` 写 processed_at 并清 lease，传 token 时条件更新；`mark_retryable_failure:120` 不覆盖已完成行，验证 token，尝试耗尽变 failed；`run_leased:242` 的 action 与确认并非统一包在一笔 DB 事务。
- `dispatch_pending:426` 先选批次并记录投递、提交短事务，然后调 broker；`_record_deliveries:364` 在消息出现前写 dispatched_at/attempts/lease，非 inline 用 F(attempts)+1，避免快速消费者撞未提交锁或重复计数。
- `RECOVERABLE_STATUSES:348` / `_recoverable_queryset:357` 实际只扫 pending/dispatched/processing 且 available 到期、lease 为空或过期；failed 不自动重投。`recover_stale:496` 只有 include_failed=True 才重置失败行，默认释放过期 processing 再扫描。
- `after_commit_dispatch:477` 普通路径 transaction.on_commit、inline 立即执行；`dispatch_after_commit:457` inline 可扩展 horizon，消费者仍须重查业务时间。`dispatch_event:274` 达 attempts 上限不交 broker，send_task 成功后不再覆盖 outbox。`unresolved_summary:529` 按 processed_at 未填写聚合。
- Tutor HTTP 同步路径与 worker 领取同一 outbox lease；结果先持久化，短事务再写 segment、assistant turn、ExposureEvent、finalized_at 和 outbox 完成标记。成功但未 finalized 的重投只补终结、不重调模型（`backend/apps/tutoring/tasks.py:57`；`backend/apps/tutoring/services/core.py:475`、`:549`）。
- Node 目标即使采用 DSH jobs/进程队列，也要保存以上持久事实、token fencing、事务边界、补扫和幂等；队列调度替换本身不等于已移植恢复协议。

### 3.4 Redis、会话与 HTTP 幂等

- Redis 承担 Celery broker/result、Django cache 和基础配置中的 cache session。默认 broker/cache /0、result /1；若设置 REDIS_URL，result fallback 也用该值（`backend/config/settings/base.py:166`、`:188`）。Compose 明确 broker /0、result /1、cache /2（`infra/docker/docker-compose.yml:35`）。
- 业务直接 cache 调用集中在登录限流/readiness，无独立 Redis 业务事实仓库；登录计数为 get/set 加一，非原子 INCR（`backend/apps/accounts/api.py:83`；`backend/apps/accounts/views.py:50`）。dev/test locmem 不代表普通 Celery 可省 broker；test 另改 DB session、inline（`backend/config/settings/dev.py:12`；`backend/config/settings/test.py:19`）。
- HTTP 幂等唯一键为 user+route_scope+idempotency_key（`backend/apps/audit/models.py:34`）。`fingerprint:32` 是排序 key、紧凑分隔符、ensure_ascii=False/default=str 的 JSON SHA-256；`claim:45` 同键同 payload 回放已存响应，不同 payload 或未完成 in-flight 冲突。以下函数均在 `backend/apps/audit/services/idempotency.py`。
- 并发插入用独立 savepoint 捕获 unique violation（`:64`）；`release:81` 仅删未完成 claim；`record_result:129` 存 status/body/resource；json_safe 递归把 Decimal/日期/UUID 转字符串。
- RequestIdMiddleware 生成/接受 UUID、回传 X-Request-Id 并记 monotonic 时长；4xx/5xx cleanup 按 user+key+status_code IS NULL 删除，未限定 route_scope（`backend/apps/audit/middleware.py:27`、`:40`）。本节涉及 DB/网络、timezone.now、secrets、UUID4、monotonic，不是纯领域算法。

## 4. AI 能力、Prompt、调用点与降级

### 4.1 backend/ai 全目录与 provider 表面

共 **7 个 Python 文件、3 个非空文件、1805 行**：`backend/ai/providers/base.py` 498行、`backend/ai/providers/embeddings.py` 258行、`backend/ai/prompts/registry.py` 1049行；ai/__init__.py、prompts/__init__.py、providers/__init__.py、validators/__init__.py 均为空。校验器实际在 registry，不在 validators 包。

- base.py 声明8能力 extract_question/transcribe_handwriting/suggest_tags/explain/diagnose/estimate_grade/propose_variant/embed（`:27`）；P0_CAPABILITIES 仅 extract/explain（`:38`），不能当完整能力表。
- `AiRequest:105` 输入 capability/prompt_version/prompt/images[(name,bytes)]/input_context/max_output_tokens=1500；`AiCallResult:88` 输出 payload/raw_text/token/cost/attempts/latency/is_stub/provider/model/prompt_version/validation。公共入口 `call_with_deadline:424`、`set_provider_override:443`、`get_provider:449`、`provider_status:478`。
- `BaseProvider:115` 定义 supports/call，Null/OpenAICompatible/Stub 实现在 base.py:127/141/281。真实 text_model 开启 explain/diagnose/suggest_tags/estimate_grade/propose_variant，vision_model 开启 extract/transcribe（`:164`）。
- 真实调用 POST /chat/completions，单条 user message、temperature=0、max_tokens；没有 tool calling 或 token stream。图片统一 data:image/png;base64，name/input_context 不进请求体（`backend/ai/providers/base.py:191`、`:195`）。
- 408/409/425/429/500/502/503/504 可重试，sleep=min(2**attempt,8)，默认2次重试即最多3次请求（`:245`）。connect_timeout 保存但 urlopen 实际只用 total_timeout（`:161`、`:228`）。
- call_with_deadline 使用 ThreadPoolExecutor 的 with；退出上下文仍可能等待线程，不能把源码注释当硬取消实现（`:424`）。AI_MAX_STRUCTURE_REPAIRS/AI_MAX_COST_CENTS 仅找到配置声明，未找到消费逻辑（`backend/config/settings/base.py:245`）。
- 真实响应只包装 `payload={"text":text},raw_text=text,cost_known=False`（`backend/ai/providers/base.py:233`）；结构化 JSON 解析责任仍在业务层。

### 4.2 全部 Prompt 与验证契约

共 **7 个版本化 prompt、7 个 build、7 个 validate**，均在 `backend/ai/prompts/registry.py`；没有独立 prompt_id 字段，能力名+version 是当前标识。

| 能力 / 版本（版本行） | build 函数 / 输入 | 输出结构 | validator |
|---|---|---|---|
| extract / p0-extract-v1（16） | build_extract_prompt:56；项目/科目/source_note，图片另传 | question_type/display_label/content/answer_payload/answer_status_known/source_hint/doubts | validate_extract_payload:124 |
| explain / p0-explain-v1（17） | build_explain_prompt:64；题型/题干/选项、答案/解析、允许引用、作答/提问、考点/rubric、材料/空位 | key_conditions/stuck_points/explanation_blocks/method_summary/suggested_next/missing_information/citations | validate_explain_payload:159 |
| suggest_tags / p1-suggest-tags-v1（208） | build_tag_suggestion_prompt:220；科目/题干/选项、允许考点名、材料 | tags[{name,confidence,rationale}] | validate_tag_suggestions:240 |
| transcribe / p1-transcribe-v1（287） | build_transcribe_prompt:315；科目/题干上下文/note，手写图另传 | text/confidence/doubts/illegible | validate_transcription:325 |
| estimate_grade / p1-estimate-grade-v1（288） | build_estimate_prompt:361；题型/题干/rubric/作答/转写说明/满分 | criteria[{criterion_id,estimated_score,rationale,missing_evidence}]/overall_note/confidence | validate_estimate:386 |
| diagnose / p1-diagnose-v1（289） | build_diagnose_prompt:466；题型/题干/核对答案/作答/逐点分/转写说明 | causes/follow_up_questions/missing_information | validate_diagnosis:492 |
| propose_variant / p2-propose-variant-v1（565） | build_variant_prompt:631；源题型/题干/选项/答案、考点/难度/avoid_stems/rubric/材料 | question_type/content/answer_payload/rubric_criteria/rubric_total_score/practice_max_score/difficulty_note/rationale/doubts | validate_variant_payload:677 |

- extract 校验题型、共享 content、允许图片资产、有答案声明但空答案；未知题型清为 single_choice 并记录问题（registry.py:124）。explain 仅 text/math/list 块、引用白名单，既无块又无 key_conditions 判空（:159）。
- tags 逐字匹配考点名、去重、confidence 夹到[0,1]，未知名称丢弃并记问题（:240）；transcription 最多8000字/20 doubts，空文标 illegible，不补全（:325）。
- estimate 只接受 rubric 已有 criterion_id、去重、负分丢弃、超 cap 截断并记问题，无有效项报 empty_estimate（:386）。diagnosis 受控原因8项，非 unknown 却无证据降为 unknown，追问最多10项（:293、:492）。
- variant 仅5种计分题型，复用 content validator；检查答案 kind/选项ID/填空覆盖/rubric正分及合计/重复题干/答案泄漏（:677）。多选至少2正确项，填空非空 accepted_values，大题 rubric_required=true（:826、:876、:997）。题干禁 image，正确项文本≥8字才做逐字泄漏扫描（:613、:736、:1040），这不是可解性证明。
- builder/validator 无 DB/网络/时钟/随机依赖；extract/variant 使用 apps.common.content，共用枚举。输入/输出为字符串、dict/list/标量及清洗结果+problems，不是另一个 Pydantic 模型目录。

### 4.3 apps 中全部模型调用点

静态发现 **7 个 call_with_deadline 业务调用点 + 2 个 embed 调用点**。表中的简写 services 路径均补全列出。

| 业务入口 / 调用位置 | 持久化与副作用 | 未配置/失败路径 |
|---|---|---|
| tutoring：`backend/apps/tutoring/api.py:148`；`backend/apps/tutoring/services/core.py:587` | TutorJob/LLMRun/Turn/Segment/Exposure/Outbox；前后短事务 | job unavailable/failed；非法 JSON 或 explain 校验问题拒绝展示 |
| ingestion：`backend/apps/audit/tasks.py:190`；`backend/apps/ingestion/services/extraction.py:161` | 读私图；LLMRun、候选机器/草稿与问题 | 缺图/无 vision/失败/问题保留人工录入 |
| tags：`backend/apps/knowledge/api.py:672`；`backend/apps/knowledge/services/suggestions.py:141` | LLMRun、TagSuggestion；旧 proposed superseded | 不支持能力先记 unavailable 再抛 AiUnavailable |
| transcription：`backend/apps/practice/api.py:1082`；`backend/apps/practice/services/transcription.py:348` | 读私图、LLMRun、proposed AnswerTranscription | 无 vision unavailable；文件失败 dependency unavailable；confirmed 禁重转写 |
| estimation：`backend/apps/practice/api.py:1143`；`backend/apps/practice/services/estimation.py:208` | LLMRun、AI estimate GradeEvent/逐点数据；无证据重建 outbox | 缺能力/rubric/有效评分点拒绝；验证/考试交付 gate |
| diagnosis：`backend/apps/practice/api.py:1181`；`backend/apps/practice/services/diagnosis.py:247` | LLMRun、ErrorDiagnosis 候选、DiagnosisFollowUp | 无能力 unavailable；先要求转写确认及交付 gate |
| variants：`backend/apps/ingestion/api.py:895`；`backend/apps/question_bank/services/variants.py:827` | 每道一个 LLMRun、ImportJob/Candidate，最多3道，不发布 | 无能力记 unavailable；调用失败标 job failed；校验失败仍存阻塞候选 |
| 文档向量：`backend/apps/search/services/index.py:274` | 每批最多32，写 embedding/model/dim/updated_at | 失败停后续批次、返回原因；不填伪向量 |
| 查询向量：`backend/apps/search/services/vector.py:70` | 返回单查询向量，无 LLMRun | hybrid 降关键词；vector-only 空结果+原因 |

- Tutor prompt/input fingerprint 在 `backend/apps/tutoring/services/core.py:285` 冻结，outbox 保存完整 prompt；读取历史结果仍查封存/活跃验证（:372）。API :158 的同步执行与 worker 共用 lease。SSE 轮询已存 segment，Last-Event-ID=index，不调模型、不建审计/outbox（`backend/apps/tutoring/services/streaming.py:331`）；轮询默认0.5秒，连接预算30秒、上限120秒（:49）。
- extraction 调用前记 revision，写入时防迟到结果覆盖人工编辑（`backend/apps/ingestion/services/extraction.py:125`、`:239`）；转写落库再锁行查 confirmed（`backend/apps/practice/services/transcription.py:390`）。
- estimation/diagnosis 先确认附件转写，再构造 learner_answer 与 prompt digest（`backend/apps/practice/services/estimation.py:135`；`backend/apps/practice/services/diagnosis.py:186`）。estimate 有 problems 但仍有有效 criteria 可 succeeded，仍不是 confirmed 分数（estimation.py:234、:354）；转写/诊断也允许清洗结果 succeeded 并保留问题（transcription.py:375；diagnosis.py:273），不能统一成“任何问题均拒绝”。
- 变式独立检查还查 DB 重复、项目/科目/大纲与官方真题规则，发布重查（`backend/apps/question_bank/services/variants.py:397`、`:482`）。
- **已核实的结构适配差异**：tags/variants 直接校验 call.payload，其余5条 chat 调用解析 raw_text JSON；真实 provider 给的是 {text:text}。源码分支因此会让 tags 得到空 proposals 并可 succeeded，而 variants 生成阻塞候选；未做运行验证（`backend/apps/knowledge/services/suggestions.py:164`；`backend/apps/question_bank/services/variants.py:854`；`backend/ai/providers/base.py:234`）。迁移应明确这是保留行为还是另行修复。

### 4.4 Stub、embedding、审计与 dsh-llm 适配

- get_provider 支持 none/stub/openai_compatible，未知值/缺 key或base URL/非 test-demo 的 stub 请求都回 Null（`backend/ai/providers/base.py:449`）；Null 只抛 AiUnavailable(code=ai_not_configured)，不造输出（:127）。AI 请求可503或转任务 unavailable/人工路径，非 AI 主流程仍走各自本地逻辑。
- Stub 声明6能力，不声明 tags/embed；call 虽有 tags 分支但正常 supports gate 不通过（base.py:53、:373）。可模拟 timeout/unavailable/invalid_json/fabricated_reference（:295）；估分空 criteria、诊断 unknown+追问、变式缺答案形成阻塞候选（:349、:375），不能当真实智能效果。
- embedding Base/Null/OpenAICompatible 与 override/get 位于 `backend/ai/providers/embeddings.py:44`、`:81`、`:99`、`:231`、`:237`；仅 openai_compatible 可能可用，stub/none 均 Null。POST /embeddings 的 input 为文本数组、encoding_format=float，默认重试1次（:154）。
- embedding 校验数量、index排序、非空数值数组、配置维数；无配置则记录首个观测维度（:203）。ACEPASS_AI_EMBEDDING_MODEL/DIM/TIMEOUT_SECONDS 经 settings getattr 读取，但 base.py 未把这些 env 映射到 Django setting；只设同名环境变量并不等于已接通（embeddings.py:249；`backend/config/settings/base.py:237`）。
- provider_status 的 embed 来自 chat provider.supports，不代表独立 embedding provider 可用；search 有独立状态（`backend/ai/providers/base.py:478`；`backend/apps/search/services/vector.py:43`）。两条 embed 调用不写 LLMRun，也无 token/cost telemetry（`backend/apps/search/services/index.py:248`；vector.py:64）。

| LLMRun 字段组（`backend/apps/audit/models.py:101`） | 全部字段 |
|---|---|
| 标识与归属 | id/created_at/updated_at（继承）；provider/model_identifier/capability/prompt_version；nullable user FK、nullable project_id UUID |
| 状态 | status=succeeded/failed/rejected/unavailable/timeout；无 queued/running，创建时通常先 failed；枚举 `backend/apps/common/enums.py:252` |
| 输入与引用 | request_summary/input_snapshot/retrieval_source_ids |
| 输出 | validation_result/raw_response_excerpt（业务各自截2000或4000字符） |
| 使用量 | prompt_tokens/completion_tokens/cost_cents Decimal(10,4)/cost_known |
| 执行 | latency_ms/attempts/error_code/error_message/is_stub |

迁到 dsh-llm 的接口边界建议为 AiRequest/AiCallResult 加独立 embed 契约；保留 prompt version、结构校验、业务 gate、人工确认、用量与审计归属。DSH 调用 API、取消、structured output、embedding 支持与计费字段仍需按目标版本验证；本次不把这些能力当已接通。模型调用有网络/时间依赖，审计另有 DB/UUID4/now。

## 5. 领域算法与 Golden Parity

### 5.1 domain 目录与判分

`backend/domain/` 共 **8个.py、3个非空、2303行、23个顶层公共函数**：grading/adapters.py 917行/8函数；grading/expressions.py 938行/5函数；memory/fsrs.py 448行/10函数。domain、grading、memory 的 __init__.py 均空；**evidence/__init__.py 和 planning/__init__.py 也是0字节占位**，实际算法在 apps/learning/services。

| 公共入口（`backend/domain/grading/adapters.py`） | I/O 与确定性 |
|---|---|
| grade_single_choice:212 | raw_answer/answer_payload/rule dict、max_score Decimal → GradeResult；稳定选项ID，无答案 pending |
| grade_multiple_choice:239 | 同上；集合 exact_match/partial_credit，重复ID pending、缺部分分不猜分 |
| grade_true_false:307 | 同上；仅真正 bool，False 与 None 不同 |
| normalize_text:335 | str、flags dict → str；NFKC/全半角/空格/casefold 可选，strip_whitespace 默认真 |
| parse_numeric:364 | str → (Decimal或None,unit str)；接受科学计数法，不执行分数/表达式 |
| grade_fill_blank:382 | 同评分参数 → GradeResult；按 literal/numeric/expression/mismatch_policy 逐空评分 |
| grade_constructed_response:855 | 同评分参数+rubric dict → 逐评分点 pending_review |
| grade:880 | question_type + 评分输入 → 五类适配器结果；不支持题型 pending_review |

上述无 DB/网络/文件/随机，表达式分支间接有时钟预算。GradePart.as_dict:76 将 Decimal 转字符串；GradeResult.is_correct:112 要求全确认且正满分、得分≥满分；as_dict:121 输出 status/method/confirmed_score/max_score/pending_max_score/is_fully_confirmed/is_correct/parts/notes，**不含 rule_snapshot**；confirmed_fraction:135 为4位 Decimal 或 None。_finalize:141 仅未决部分计 pending，错题失分不是未评分。numeric 容差=max(abs_tol,rel_tol*abs(target))且含边界，单位仅显式白名单（:743）。表达式先文字精确匹配，再受限引擎；未知/单位/语法/定义域/超时均 pending，已证不等价只有 mismatch_policy=wrong 才判错（:585、:710）。

### 5.2 受限数学表达式引擎

| 公共入口（`backend/domain/grading/expressions.py`） | I/O / 依赖 |
|---|---|
| evaluate:495 | expr str、variables映射、time_budget → float或类型化异常；perf_counter |
| normalize_expression:716 | str → 白名单折叠/规范化str；纯 |
| free_variables:722 | str → 排序变量tuple；纯 |
| compare_expressions:831 | left/right str、可选samples/tolerance/time_budget → ExpressionVerdict；时钟+固定采样 |
| expressions_equivalent:922 | 同上 → True/False/None；None=unknown，不可判错 |

- ExpressionVerdict:153 输出 outcome/reason/error_type/samples_checked/sample，is_equivalent/as_dict 在:163/:166；自建 tokenizer/parser/evaluator（:195/:242/:405），无 eval/CAS、DB/网络/文件。
- 白名单 sqrt/abs/sin/cos/tan/log/ln/exp，常量 pi/e（:92）；上限200字符、160token、128节点、深度12、4000步、指数绝对值64、结果绝对值1e30（:74）。最多2变量/24样本、默认50ms、预算最大2秒、tolerance=1e-9（:81）。
- 16固定点+seed=20260214自写LCG，无随机熵（:733/:753）；结构规范化只有双方 total 才直接等价，否则全部样本成功且相等才 equivalent，定义域孔洞 unknown（:868）。float容差为 tolerance*max(abs(a),abs(b),1)（:807）。Golden 要固定样本序列，单独控制时钟，不把墙钟波动混入数值 oracle。

### 5.3 FSRS 全部公共函数

| 公共入口（`backend/domain/memory/fsrs.py`） | I/O |
|---|---|
| weights_for:217 | params_version str → 17权重tuple；未知KeyError |
| retrievability:230 | elapsed_days/stability float → [0,1]；stability≤0返1 |
| initial_stability:244；initial_difficulty:250 | rating str、weights tuple → float |
| clamp_difficulty:257 | float → [1,10]float |
| next_interval_days:261 | stability/desired_retention → [1,36500]整天float，floor(x+0.5) |
| recall_stability:274 | stability/difficulty/retrievability/rating/weights → float |
| forget_stability:297 | stability/difficulty/retrievability/weights → float |
| next_difficulty:314 | difficulty/rating/weights → 均值回归后float |
| schedule:333 | CardState、rating、reviewed_at datetime、weights、retention → ScheduleResult |

全部无隐式now/随机/DB/网络/文件。版本 fsrs-4.5-default-v1，仅1组注册参数，retention=.9/decay=-.5/factor=19/81（:54）。CardState:143 含 stability/difficulty/phase/reps/lapses/learning_step/last_reviewed_at/due_at/scheduled_days/elapsed_days；ScheduleResult:166 含 state/retrievability/interval_days/elapsed_days/phase_after/is_lapse/scheduler_version，next_state 是 state 别名。短步1/10分钟、hard5分钟；四rating和四phase（:87）。naive时间按UTC、aware转UTC、elapsed≥0（:199/:357）。Golden 必须同时比较新状态和解释字段。

### 5.4 公共内容/答案结构

两个文件各5个顶层公共函数，无 I/O/DB/时钟/随机。

| 公共函数 / 定位 | I/O |
|---|---|
| `backend/apps/common/content.py:184` validate_content | content Any、question_type str → code/message/path/severity问题list |
| `backend/apps/common/content.py:208` normalize_content | dict → 保留blocks/options/blanks/table_note的浅拷贝dict |
| `backend/apps/common/content.py:224` option_ids；`:228` blank_ids | content dict → 非空ID list，保留顺序 |
| `backend/apps/common/content.py:234` content_digest | 规范化、排序key、紧凑UTF-8 JSON → SHA-256 str |
| `backend/apps/common/answers.py:79` validate_answer_payload | payload Any、题型str、可选content dict → 问题list |
| `backend/apps/common/answers.py:230` blank_specs；`:235` normalization_flags | dict → blanks dict或{}；spec dict → 允许flag/bool映射 |
| `backend/apps/common/answers.py:242` blank_max_score；`:252` sum_blank_scores | spec+fallback Decimal → Decimal；payload → Decimal合计或失败None，缺分项跳过 |

content 允许 text/math/image/table，上限120块/26选项/20空/8000字（content.py:31）；拒HTML/script、要求非空latex和合法UUID图片引用，只校形状不查DB所有者（:55）。None 的 options/blanks 提前返回而[]会报问题，材料父题可无题干（:122/:152/:198）。answer kind/选项ID/bool/多选部分分/填空覆盖、受控normalization/mismatch_policy、numeric/unit、rubric_required均需保留（answers.py:79/:118）；通用_decimal当前拒负值（:62/:202），与文档注释含义不一致时 Golden 以实际分支为准。

### 5.5 PDF、版式与文本解析

| 文件 / 公共入口 | I/O / 确定性 |
|---|---|
| `backend/apps/ingestion/services/pdf_text.py:242` extract_native_text | bytes → PdfExtraction；BytesIO+pypdf，无磁盘/DB/网络/时间/随机 |
| 同文件 :793 bbox_for_text | PdfPage、text str → normalized bbox dict或None；纯，合并fragment、夹[0,1]、最小边长.005 |
| 同文件 :862 looks_like_answer_text | str → bool；纯 |
| `backend/apps/ingestion/services/text_parser.py:116` parse_paste | text str、structure_only bool → list[dict[str,Any]]；显式标签优先，其次题号fallback |
| 同文件 :532 normalise_answer_map；:540 parse_answer_page；:594 apply_answer_matches | 答案value去首尾空白/解析答案页/返回候选与答案匹配结果，精确签名见下方补充 |
| 同文件 :668 attach_source_pages；:750 detect_page_continuations；:782 attach_cross_page_continua | 源页绑定/跨页检测/延续拼接；attach 修改传入segments，不能假定无副作用 |
| `backend/apps/ingestion/services/layout.py:88` issue_for_reason；:93 reasons_needing_review；:102 needs_review；:106 issue_codes_for_reasons；:115 layout_review_issues | 版式reason → code/人工复核判断/候选问题列表；纯，无I/O |

- pdf_text 874行/3公共函数、text_parser 860行/7函数、layout 162行/5函数。PDF限40MiB/200页/200万字符；%PDF-、损坏、空页、加密检查，只试空密码（pdf_text.py:48/:207）。全文无文字层拒绝，不做OCR（:282）。
- 页数据含text/character_count/fragments/columns/table/formula/scanned/reliable/diagnostics（:748）；几何解析依赖pypdf私有_cmap.build_char_map和_page.get_text_operands（:397/:415），迁移pdf库风险高。
- 检测多栏/栏序含混/表格网格/公式/扫描/无几何/截断（:692），仅明确多栏才重排；重建可见字符变少时保留原文并标不可靠（:728）。
- 文本纯函数无时间/随机/DB；structure_only丢无结构信号段、local_id确定递增；答案先label后position，consumed防重复占用（text_parser.py:116/:594）。续页要求前页无句末符、后页似续句；保留起始页与per-page spans（:750）。
- 只对候选触及的可疑页生成blocking；无几何本身不阻塞，扫描/多栏/表格/公式需人工确认（layout.py:62）。外层 `start_pdf_import` 才有上传/storage/DB/now（`backend/apps/ingestion/services/imports.py:377`）。

### 5.6 Hybrid scoring 与知识状态规则

- `backend/apps/search/services/tokenize.py` 的 is_cjk:48（字符→bool）、tokenize:104（str→list[str]）、term_frequencies:123（tokens→dict[str,int]）均纯；版本 zh-char-ngram-v1，NFKC+casefold、CJK单字/相邻双字，保留数字小数点/百分号，顺序固定（:35）。
- `_bm25_scores` 在 `backend/apps/search/services/hybrid.py:69`，输入查询tokens/可见文档、输出ID分数映射；k1=1.2、b=.75（:49）。cosine 在 `backend/apps/search/services/vector.py:22`，两个float序列→float，空/零/异长返0；model/dim匹配才评分且只排名正相似度（:76）。
- RRF两路各加1/(60+rank)，同分按document_id升序；向量先截effective_limit、关键词融合前保留全部命中（hybrid.py:236/:254）。纯评分无时钟/随机；完整 search:174 先owner/project/subject/live relation/发布/撤回/封存过滤，再DB materialize/BM25/可选网络embedding/输出（index.py:192）。
- keyword不请求embedding；hybrid显式回退关键词，vector-only不可用时空结果+原因（hybrid.py:225）。完整search依赖DB/配置/网络，索引写入另有now。
- `backend/apps/learning/services/state.py` rule_version=p0-1；公共 refresh_node_state:58、refresh_states_for_attempt:190、refresh_session_states:218、states_for_project:232、weak_nodes:265 都有ORM，refresh另读now并写投影；纯候选为 `_summary_from_counts:28` 与 `_missing_evidence:177`。
- 摘要优先“需复习且已有独立正确→延迟验证→陌生变式→独立完成→提示完成→补基础→未诊断”；延迟阈值实际 independent_correct≥3/templates≥2/has_delayed_correct，陌生变式≥2/templates≥2（state.py:38）。**distinct_questions虽入参但未用于阈值**（:28/:106/:139）。
- 最近窗口3，至少2记录且失败≥2则needs_review；仅active且grade_revision>0证据；best_summary保留历史最高且不被needs_review降低，保存rule/evidence IDs/阈值/缺项（state.py:63/:98/:122）。
- Golden候选是评分/表达式/FSRS/content/tokenizer的unit向量，PDF/layout/hybrid/state的integration fixture，以及HTTP输出；时间/UUID/Decimal序列化需明确归一化，已发现的行为差异应区分“兼容”与“另行修复”。本次均未运行。

### 5.7 实际 evidence / planning / anchors / pairing 函数

以下路径前缀为 `backend/apps/learning/services/`。4文件共33个顶层公共函数：evidence8、planner20、anchors1、pairing4；DB读包含关联延迟加载，写入另隐含UUID/时间戳，无直接外部网络或随机算法。

| 文件 / 公共函数 | I/O、DB及时间依赖 |
|---|---|
| evidence.py:137 compute_dimensions | Attempt → list[dict]，考点×维度的qualifies/is_correct/fraction/exclusions/detail；DB读映射/证据/污染/锚点和settings，用持久提交/呈现时间，无直接now |
| evidence.py:355 confirmation_ok；:363 is_grade_correct；:511 evidence_digest | item→bool；grade→bool；Attempt→SHA256(id:grading_revision) str；字段预载后可纯算 |
| evidence.py:390 rebuild_for_attempt；:441 rebuild_for_attempts；:448 invalidate_for_answer_version | attempt_id str/list[str]/answer_key_version_id str → int；DB读写+失效/重建now |
| evidence.py:458 evidence_summary_rows | user/project/node?/limit=100/subject?/dimension? → list[dict]；DB读，limit夹1–200，无直接now |
| planner.py:44 active_projects；:48 allocate_budget | user→list[ExamProject]，DB读；user/projects/budget_minutes/on_date → projects/notes/rotation_offset/project_order dict，settings预载后可确定计算 |
| planner.py:148 delayed_task_candidates；:213 memory_review_candidates | user/project/now?/limit=20或10 → list[dict]；DB读，缺now读当前时间 |
| planner.py:256 weakly_known_candidates；:332 undiagnosed_candidates；:380 general_candidates | user/project/limit=20 → list[dict]；DB读题目/状态/映射/封存，无直接now |
| planner.py:416 current_plan；:426 generate_plan | user/on_date?/revision? → StudyPlan或None；user/on_date?/refresh/now? → StudyPlan；前者DB读/可隐式今天，后者事务DB读写/settings/时区/now/outbox |
| planner.py:575 enqueue_plan_event；:582 reconcile_plan | StudyPlan→None；plan_id str→状态str；DB写outbox/重算，间接/直接now |
| planner.py:627 plan_payload；:692 start_task | StudyPlan或None、now?→dict；user/task_id/now?→(StudyTask,dict)；前者DB读，后者DB读写，均可读now |
| planner.py:722 defer_task；:734 skip_task | user/task_id/reason="" → StudyTask；DB读写，updated_at隐式时钟 |
| planner.py:744 backlog_summary；:760 progress_notes | user/now? → list[dict] / list[str]；前者DB+now，后者DB但当前未使用now参数 |
| planner.py:783 unclassified_weight_warning；:798 plan_delta_minutes；:802 next_day | project→list[str]（DB聚合）；StudyPlan→int（预算差）；date→date+1天；后两者可纯算 |
| anchors.py:28 latest_learning_anchor | user/project/node_id/before/exclude_attempt_id? → (datetime或None,来源str)；DB查Attempt/Exposure/Tutor，时间上界显式before |
| pairing.py:112 on_attempt_graded；:199 on_explanation_delivered | attempt_id/item_id str → 新任务数int；DB读写StudyTask/ReviewTask，持久事件时刻+delay配置 |
| pairing.py:271 reconcile_delayed_tasks；:321 delayed_interval_status | 无参→顺延数int；task/now?→required/satisfied/reason/锚点及截止dict；DB读写或关联读、settings+now |

可先提取 evidence._fraction:372、确认/满分/hash、planner._rotation_rank:108/预算分摊/分钟差/次日、pairing.py:347 的“锚点+delay”规则；将ORM/settings/now/事实集合显式传入。compute_dimensions 整体当前不是纯函数。

### 5.8 文本/布局精确签名补充

路径前缀为 `backend/apps/ingestion/services/`；均无DB/网络/系统now/随机。

- `text_parser.py:116` parse_paste(text:str,*,structure_only:bool=False) → list[dict[str,Any]]；`:532` normalise_answer_map(dict[str,str]) → dict[str,str]，仅strip各value；`:540` parse_answer_page(str) → dict，含entries[{label,raw}]/unparsed/entry_count。
- `text_parser.py:594` apply_answer_matches(segments:list[dict],entries:list[dict]) → dict，含逐项匹配、matched_count/position_matched_count/entry_count/unmatched_entry_labels；`:668` attach_source_pages(segments,text,page_map:list[tuple[int,int,int]]) → 同segments，原地补source_page_index/source_char_start。
- `text_parser.py:750` detect_page_continuations(pages:list，元素具有page_index/text) → list[dict]（from_page/to_page/last_line/first_line/reason）；`:782` attach_cross_page_continua(segments,text,page_map,continuations:list[dict]或None=None) → 同segments，原地补source_char_end/source_spans/continues_on_pages。
- `layout.py:88` issue_for_reason(str) → str或None；`:93` reasons_needing_review(Iterable[str]) → list[str]；`:102` needs_review(Iterable[str]) → bool；`:106` issue_codes_for_reasons(Iterable[str]) → list[str]，去重保原序。
- `layout.py:115` layout_review_issues(*,page_diagnostics:Iterable[dict]或None,pages:Iterable[tuple[str或None,int]]) → list[dict]，含code/message/severity/pages/page_indexes/reasons，按固定ISSUE_ORDER；两个参数均keyword-only，page_diagnostics允许None但无默认值。

## 6. 前端页面、请求、状态与构建

静态共 **3个src/app TSX、21个feature TSX、13个页面/13条route**。下表页面路径前缀 `frontend/src/features/`；API均加 `/api/v1`，`P=/projects/{projectId}`；query key 用 `p=projectId,s=subjectId` 表示变量，Q为key、I为失效前缀。
`frontend/src/main.tsx:12` 建QueryClient（retry=false、refetchOnWindowFocus=false、staleTime=5000），`:22` 自行createRoot+StrictMode+QueryClientProvider+BrowserRouter。`frontend/src/app/AppRoot.tsx:62` 登录gate包ScopeProvider/AppShell，无/login route。AuthProvider（`context.tsx:74`）直接GET /auth/me、POST login/logout，启动ensureCsrf；ScopeProvider（`:147`）直接GET projects/subjects，用localStorage的acepass.currentProject/currentSubject，切项目清科目（`:234`），二者不使用react-query。

| route / 页面 | API client 调用 | query key / 更新 |
|---|---|---|
| `/` projects/HomePage.tsx:25 | apiRequest GET /me/study-settings；POST /projects | Q study-settings；创建reload scope+全量I（:28/:48） |
| `/today` today/TodayPage.tsx:25 | GET /study-plans/today；POST /study-plans/today/generate、/study-tasks/{id}/start、…/defer | Q today-plan；生成/顺延I同key；启动把project/subject/task/purpose/q写入practice查询串（:33/:38/:59/:82） |
| `/practice` practice/PracticePage.tsx:185 | GET P/practice-sessions/{id}、P/session-items/{id}/presentation、P/attempts/{id}；fetchPublishedQuestions、fetchSealedContent | Q session(p,id)、published-questions(p,examSubjectId)、sealed-content(p)、presentation(p,itemId)、attempt(p,attemptId)（:185/:249/:258/:301/:309） |
| practice写入（:363） | PUT P/session-items/{id}/draft；POST P/practice-sessions、P/session-items/{id}/submit、P/{attempts或session-items}/{id}/reveal、P/tutor-sessions、…/{id}/messages、P/assets；createMockExamSession/finishPracticeSession | 创建I today-plan；提交I session/presentation；结束I session/today-plan；过期拒绝refetch session（:429/:454/:470/:515/:594） |
| `/questions` questions/QuestionBankPage.tsx:81 | GET P/questions、P/syllabus-versions；fetchSealedContent；POST P/imports/parse-text、P/imports、P/practice-sessions（:87/:112/:118/:127/:152） | Q questions(p,s,typeFilter,search)、sealed-content(p)、syllabus(p,s)；导入I imports(p) |
| `/imports` imports/ImportsPage.tsx:60 | GET P/imports?limit=50、P/import-candidates?job_id；POST P/imports/pdf、…/images、…/{id}/retry、P/import-candidates/{id}/ignore?reason=not_a_question | Q imports(p)、candidates(p,selectedJobId)；上传/重试I imports，忽略I candidates+imports（:93/:114/:127/:143） |
| `/imports/:jobId/candidates/:candidateId` imports/CandidateReviewPage.tsx:158 | GET/PATCH P/import-candidates/{id}；GET P/knowledge-nodes、P/import-candidates?job_id、P/exam-spec-versions；fetchImportJob/confirmCandidateLayout；POST …/{id}/publish | Q candidate(p,id)、importJob(p,jobId)、nodes(p,s)、candidates(p,jobId)、specs(p,s)；保存I candidate，确认setQueryData+I candidate/candidates/imports，发布另I questions（:308/:328/:352） |
| `/knowledge` knowledge/KnowledgePage.tsx:134 | GET P/knowledge-map、knowledge-nodes、learning-states、evidence?node_id、syllabus-versions、verification-pairings、questions?limit=100；关系/前置/标签helpers | Q knowledge-map/nodes/learning-states/syllabus/pairings/questions-for-pairing/knowledge-relations(p,s)、evidence(p,nodeId)、node-prerequisites(p,toNodeId)、tag-suggestions(p,versionId) |
| knowledge写入（:211） | POST P/knowledge-nodes、P/syllabus-versions/{id}/nodes/import、P/verification-pairings；PATCH P/knowledge-nodes/{id}；create/deactivate relation、create/accept/reject suggestion | I knowledge-map/nodes；提纲另I syllabus；配对I pairings；关系I knowledge-relations；标签I tag-suggestions（:220/:238/:263/:286/:302/:318/:333/:357/:372） |
| `/search` search/SearchPage.tsx:77 | fetchSearchResults GET P/search；reindexSearch POST P/search/reindex | Q search(p,s,activeQuery,channel)；重建I search（:98） |
| `/review` review/ReviewPage.tsx:37 | GET P/review-tasks、P/evidence?limit=200、P/mistakes；POST /study-tasks/{id}/start、/study-tasks/{id}/reconcile-delay | Q review-tasks/evidence-mistakes/mistakes(p,s)；核对延迟I review-tasks(p)（:94）；reconcile路径与后端差异见下 |
| `/memory` memory/MemoryPage.tsx:68 | fetchMemoryCards/Logs、create/review/rebuild/suspend/resume helpers；GET P/questions（:81） | Q memory-cards(p,onlyDue,includeSuspended)、questions-for-memory(p,s)、memory-logs(p,logsFor)；创建/暂停/恢复I cards；复习另I logs；rebuild仅展示（:98/:110/:117/:126/:135） |
| `/grading` practice/GradingPage.tsx:122 | GET P/grading-queue；POST P/attempts/{id}/confirm-grade、…/reveal | Q grading-queue(p,s)；确认I grading-queue(p)/evidence/learning-states（:124/:139/:152/:161） |
| `/reports` reports/ReportsPage.tsx:213 | GET P/reports/practice、P/papers/coverage、…/cycle-analysis、P/papers、P/ai-runs?limit=20、P/ai-status、P/answer-reviews；POST P/paper-revisions/{id}/coverage、…/confirm、P/regrades、…/{id}/run | Q report/coverage/cycle-analysis/papers(p,s)、ai-runs/ai-status/answer-reviews(p)；确认I coverage/papers/cycle-analysis；重判I report/answer-reviews（:266/:281/:326） |
| `/settings` settings/SettingsPage.tsx:45 | GET/PATCH /me/study-settings；GET/POST P/exam-spec-versions、P/syllabus-versions；POST …/{id}/publish、P/subjects、P/archive；GET P/ai-status | Q study-settings/specs(p,s)/syllabus(p,s)/ai-status(p)；预算I study-settings/today-plan；科目/归档全量I；大纲I syllabus/knowledge-map；规范I specs（:95/:115/:138/:171/:186） |

Routes在 `frontend/src/app/AppShell.tsx:175`，Home静态引入，另12页用page(()=>import(...))懒载（:22），Suspense与整页reload错误边界在:46/:59。`frontend/src/features/review/ReviewPage.tsx` 的reconcile-delay请求缺projects前缀，后端仅声明项目路径；这是静态契约差异，不能在清单中擅自改成后端路径。

| 其余8个feature组件（前缀同上） | API / state |
|---|---|
| imports/LayoutReview.tsx:24 | 版式展示/问题归类，无请求 |
| imports/VariantsList.tsx:44 | fetchVariantJobs；Q variants(p) |
| knowledge/FamiliesPanel.tsx:113 | Q question-families(p,s)；创建/改名/增删成员/封存/解封/merge-impact/merge；I families，封存/合并另I sealed-content（:126/:221/:252） |
| practice/AiAssistPanels.tsx:119 | Q transcriptions(p,attemptId)、ai-estimate(p,attemptId)；转写请求/人工录入/确认/拒绝后I transcriptions；估分setQueryData；诊断/追问本地state；TutorStreamPanel管SSE（:137/:538/:556/:751/:1031） |
| questions/ExposurePanel.tsx:172 | Q question-exposure(p,questionId)；读exposure、external-seen；setQueryData或I自身，再I evidence-mistakes/evidence |
| questions/SealingControls.tsx:94 | seal/unseal；Q/I sealed-content(p)（:114/:252） |
| questions/VariantProposePanel.tsx:128 | GET nodes；Q nodes(p,question.subject_id)；proposeVariants后I variants(p)（:148/:164） |
| reports/CalibrationPanel.tsx:128 | fetchEffectCalibration GET P/reports/calibration；Q calibration(p,s) |

### 6.1 API transport 与 helper 对照

`frontend/src/api/client.ts:41` 固定BASE=/api/v1；apiRequest:75 默认GET，same-origin cookie、非GET CSRF、可选Idempotency-Key、JSON/FormData、AbortSignal及统一错误；ensureCsrf:50。页面直接apiRequest与helper混用，不能只替换下表。helper位置均在client.ts。

| helper / 行号 | 方法与相对路径 |
|---|---|
| fetchKnowledgeRelations:889 / createKnowledgeRelation:898 / deactivateKnowledgeRelation:915 / fetchNodePrerequisites:925 | GET/POST P/knowledge-relations；DELETE …/{id}；GET P/knowledge-nodes/{id}/prerequisites |
| fetchTagSuggestions:971 / createTagSuggestion:977 / acceptTagSuggestion:984 / rejectTagSuggestion:995 | GET/POST P/question-versions/{id}/tag-suggestions；POST P/tag-suggestions/{id}/{accept,reject} |
| fetchSearchResults:1073 / reindexSearch:1085 | GET P/search；POST P/search/reindex |
| fetchMemoryCards:1177 / createMemoryCard:1188 / reviewMemoryCard:1197 / fetchMemoryCardLogs:1205 / rebuildMemoryCard:1211 / suspendMemoryCard:1218 / resumeMemoryCard:1226 | GET/POST P/memory-cards；GET …/{id}/logs；POST …/{id}/{review,rebuild,suspend,resume} |
| fetchTranscriptions:1339 / requestTranscription:1353 / confirmTranscription:1366 / rejectTranscription:1384 | GET/POST P/attempts/{id}/transcriptions；POST P/transcriptions/{id}/{confirm,reject}；手工转写也用requestTranscription |
| fetchAiEstimate:1497 / requestAiEstimate:1507 / requestAiDiagnosis:1574 / setAttemptDiagnosis:1605 | GET/POST P/attempts/{id}/ai-estimate；POST …/{id}/ai-diagnosis、…/{id}/diagnosis |
| answerDiagnosisFollowUp:1617 / skipDiagnosisFollowUp:1625 | POST P/diagnosis-follow-ups/{id}/{answer,skip} |
| fetchTutorSegments:1684 / tutorStreamUrl:1694 | GET P/tutor-jobs/{id}/segments；生成…/{id}/stream?after={index} |
| fetchImportJob:1808 / confirmCandidateLayout:1819 | GET P/imports/{id}；POST P/import-candidates/{id}/layout-confirm |
| fetchQuestionExposure:1909 / declareQuestionExternalSeen:1922 | GET P/questions/{id}/exposure；POST …/{id}/external-seen |
| sealQuestion:2080 / unsealQuestion:2088 / sealQuestionFamily:2096 / unsealQuestionFamily:2104 / fetchSealedContent:2119 | POST P/questions/{id}/{seal,unseal}、P/question-families/{id}/{seal,unseal}；GET P/sealed-content |
| fetchQuestionFamilies:2199 / createQuestionFamily:2205 / patchQuestionFamily:2216 / addQuestionToFamily:2228 / removeQuestionFromFamily:2240 / fetchFamilyMergeImpact:2248 / mergeQuestionFamily:2254 | GET/POST P/question-families；PATCH …/{id}；POST …/{id}/questions；DELETE …/{id}/questions/{qid}；GET …/{id}/merge-impact；POST …/{id}/merge |
| proposeVariants:2430 / fetchVariantJobs:2465 / fetchPublishedQuestions:2572 | POST P/variants/propose；GET P/variants、P/questions |
| createMockExamSession:2591 / finishPracticeSession:2609 / fetchEffectCalibration:2851 | POST P/practice-sessions、…/{id}/finish；GET P/reports/calibration |

媒体绕过apiRequest：`frontend/src/components/Content.tsx:81` 的img直取P/assets/{assetId}；候选页 `frontend/src/features/imports/CandidateReviewPage.tsx:623`、`:637` 读原页/裁图且purpose=editorial。迁移transport还要覆盖这些URL/cookie/purpose。

### 6.2 SSE、Vite 与 DSH 挂载约束

- `frontend/src/api/tutorStream.ts:29` 手写增量framing，处理CRLF/多行data/注释/残尾；忽略SSE id/retry，恢复用业务segment index。reducer:117处理status/segment/done/error/timeout，按index去重排序、过滤stale、stale_source失效、忽略未知事件。
- `tutorStream.ts:212` fetch+ReadableStream+TextDecoder+AbortController，Accept=text/event-stream、same-origin；最多3次重连，700ms×次数；HTTP<500不重试，异常/5xx重连，耗尽transportFailed（:287）；close只停本地流，resume保留lastIndex，不建新job（:228/:323）。AiAssistPanels.tsx:1052仅transportFailed回退stored segments，:1068合并stale，:1076来源检查前隐藏旧结果。
- `frontend/vite.config.ts:11` manualChunks：React/ReactDOM/scheduler/router→vendor-react，TanStack→vendor-query，KaTeX→vendor-katex；动态页面另拆；:53输出dist且无sourcemap。`frontend/src/components/Content.tsx:13` 首次公式才import KaTeX JS/CSS，失败清缓存并显示原LaTeX，trust=false/throwOnError=false（:40）。
- Vite dev5173，/api和/health代理8000（vite.config.ts:45）；Vitest只收src/**/*.test.{ts,tsx}、node环境（:62）。当前package type=module、HTML入口、自有createRoot，不能直接作为DSH CJS-lazy客户端交付。
- 按用户给定DSH约束：tsdown打CJS lazy bundle、共享module table、挂载宿主GUI。需要组件挂载/卸载适配，BrowserRouter占全局URL、不适合shell；应改宿主导航适配或插件内部路由并保留practice深链参数。
- React/ReactDOM/JSX runtime须遵守共享表，router/query是否共享取决宿主契约；不得假定宿主React19。Vite的动态import/CSS/font定位/manualChunks不能直接复制到tsdown。
- 建议注入API/media base、auth/CSRF/stream transport；query key增加插件namespace并定义账户切换清理。当前study-settings/today-plan无用户参数，logout只清user；持久shell还须卸载SSE/计时器。以上是迁移建议，未验证DSH目标版本API。

## 7. 测试资产、门禁与可复用 Oracle

四目录共 **38个.py，33个test_*.py，459个test_*函数定义（unit112+integration347）**。9处静态parametrize列表/元组展开推算501 cases（148+353），非pytest收集/运行结果。目录文件数：unit6、integration29、evaluation1、support2。
`backend/tests/conftest.py:6`、`:74`、`:84` 用Django Client/ApiCaller，fixture直接建User/调用demo/读ORM；因此integration不是已能对任意URL运行的黑盒。下表高/中/低指抽取HTTP契约复用价值，非通过率。测试路径前缀为 `backend/tests/`。

| 测试文件 / 首测试行 | 定义数（静态展开） | 保护不变量 / parity用途 |
|---|---:|---|
| unit/test_content_and_parsing.py:37 | 16（19） | 标签/编号不编答案、负号单位、content/answer/空位策略；纯函数golden |
| unit/test_fsrs.py:32 | 19（19） | 公式/权重/确定性/UTC/短步/遗忘/边界；纯函数golden |
| unit/test_grading.py:16 | 23（27） | 五题型/ID/False/Decimal/容差/未知转人工；纯函数golden |
| unit/test_p2_expression_grading.py:73 | 39（68） | 等价/unknown/白名单/预算/无文件网络逃逸/评分结构；数值golden，Python monkeypatch重写 |
| unit/test_search_tokenize.py:13 | 15（15） | CJK单/双字、标点/NFKC/数字/大小写/词频顺序/版本；纯函数golden |
| integration/test_acceptance_ids.py:62 | 1（1） | A01–A42映射，A36明确未运行；低，文档映射非实际通过证明 |
| integration/test_ai_providers.py:35 | 12（14） | none/stub诚实标识、故障/引用/辅导曝光/owner/文件；中 |
| integration/test_api_contract.py:23 | 10（10） | OpenAPI/auth/前缀/路由顺序/404/envelope/request-id/health；HTTP高，resolver内省低 |
| integration/test_isolation_and_idempotency.py:18 | 14（14） | 重放/冲突/遮分/辅助与自评/争议/不可变/导入去重/归档/服务端时间；中 |
| integration/test_learning_loop.py:126 | 18（18） | A→B→C/24h锚点/证据/题族/预算轮换上限/outbox/UTC；中，服务ORM较多 |
| integration/test_memory_cards.py:71 | 15（15） | 幂等/到期/重建/owner/暂停、记忆不写评分证据；中 |
| integration/test_outbox_contract.py:188 | 10（10） | producer全有consumer/名称/beat/租约/重试上限/副作用一次；低，需Node机制对等测试 |
| integration/test_outbox_dispatch_lease.py:101 | 6（6） | delivery先提交、失败计一次、并发claim、过期恢复；低，事务/broker注入 |
| integration/test_p0_2_closeout_gaps.py:108 | 17（17） | gate重查/generation/迁移歧义/延迟资格/tutor租约审计；中偏低 |
| integration/test_p0_2_final_gaps.py:81 | 9（9） | finish replay/version generation/HTTP与worker共lease/发布脚本；中 |
| integration/test_p0_2_regressions.py:70 | 13（13） | 并发重判/争议/报告gate/锚点/过期consumer/人工校对防覆盖；中偏低 |
| integration/test_p0_regressions.py:55 | 32（35） | 判完≠全对/逐项评分/争议重判/全入口gate/学习延迟/图导入/辅导恢复；中 |
| integration/test_p1_api.py:51 | 7（7） | multipart PDF/扫描拒绝/真题身份/coverage/大纲树/隔离；高，先换fixture |
| integration/test_p1_cycle_and_syllabus.py:46 | 7（7） | 提纲同义/树无环/权重和/周期去重/排demo和不完整/未归类分；低，service预期可迁 |
| integration/test_p1_memory_plan.py:42 | 5（5） | 到期卡不重复/无解题证据/撤回不排程/预算；低 |
| integration/test_p1_pdf_import.py:123 | 9（9） | 文字层/扫描拒绝/来源位置/人工确认/五题型材料/重复重试；中偏低 |
| integration/test_p1_prerequisites_and_tags.py:85 | 11（11） | 图无环/幂等隔离/前置优先/无题解释/词表/人工接受修订；中 |
| integration/test_p1_transcription_and_estimation.py:208 | 13（13） | 转写门槛/stub/原记录不覆盖/估分无正式效力/截断/诊断/owner；中 |
| integration/test_p1_tutor_stream.py:133 | 10（11） | 已校验段/恢复不调模型/stale与失败零内容/owner/段幂等/超时；SSE字节契约高、内部机制需改 |
| integration/test_p2_contamination.py:112 | 10（10） | 校对/已见/呈现污染、时序/跨项目谱系/重投重判不洗白/解释；中 |
| integration/test_p2_layout_import.py:171 | 16（16） | 双栏跨页/表格公式/扫描/XY/bbox/截断/确认幂等；中，保留PDF字节fixture |
| integration/test_p2_mock_exam.py:173 | 14（14） | 服务端deadline/时长/读不延时/一次结束/迟交拒绝/全gate/并发；中 |
| integration/test_p2_reports_scope_and_calibration.py:184 | 11（11） | 未评分不出最终分/缺口原因/验证隐藏/覆盖/样本门槛/非因果；报告golden价值高 |
| integration/test_p2_sealing_and_merge.py:241 | 9（9） | 封存所有入口和队列/题族传播/追加修订/污染回算/owner；中 |
| integration/test_p2_variants.py:195 | 21（21） | none/stub不产可用题/独立校验/五题型/重复/人工确认/失败保留/scope；中 |
| integration/test_practice_flow.py:50 | 16（16） | 登录/CSRF/退出/隔离/五题型/材料/可信答案/提交不可改/草稿冲突；中偏高 |
| integration/test_read_path_query_budget.py:394 | 6（6） | query数不随行增长/逐题gate/空页/精确payload；payload高，CaptureQueriesContext重写 |
| integration/test_search_hybrid.py:316 | 25（25） | 排名/降级/封存holdout隔离/不含答案/重建幂等/向量解析/eval；HTTP高、内部注入重写 |

四目录的__init__.py均无测试；evaluation仅空__init__.py，无独立评测测试，搜索eval在integration/test_search_hybrid.py:813等。support/pdf_builder.py:50是fixture工具，:227/:275/:298生成文字/版式/扫描PDF，无test函数；应保留字节输入或等价生成器。API-level响应/状态转换是最易跨实现复用的oracle；并发、锁、lease、时间与ORM侧效应必须另外保留机制级验证，不能只做成功响应快照。

### 7.1 前端测试全量

Vitest **1文件/5个it**；Playwright **10spec/51个test声明（acceptance43+e2e8）**，不是执行数。

| 文件 | 数量 | 不变量 |
|---|---:|---|
| `frontend/src/components/Content.test.tsx:17` | 5 | SSR/import不触发KaTeX、块结构、未授权图提示、未知块/空内容 |
| `frontend/tests/e2e/p0-loop.spec.ts:17` | 8 | 隔离、五题型、草稿/人工评分/reveal gate、今日复习报告/考点/AI标识 |
| `frontend/tests/acceptance/p0-2-empty-account.spec.ts:68` | 1 | 空账户UI建项目科目规范/导入发布/首次评分 |
| `frontend/tests/acceptance/p0-2-regressions.spec.ts:57` | 2 | 未交照片刷新恢复、填空编辑权威payload |
| `frontend/tests/acceptance/p0-acceptance.spec.ts:35` | 15 | 作用域/五题型/0分/部分评分/gate/刷新reveal-tutor/附件/复习报告/延迟/错误可见 |
| `frontend/tests/acceptance/p1-import-and-cycles.spec.ts:108` | 6 | PDF来源校对/答案匹配/卷面去重/大纲/5真周期/样本不足 |
| `frontend/tests/acceptance/p1-batch2.spec.ts:23` | 5 | 前置环/标签未配置/检索降级隔离/记忆回放 |
| `frontend/tests/acceptance/p1-batch3.spec.ts:106` | 5 | 照片门槛/真实失败/stub估分诊断转写/SSE恢复 |
| `frontend/tests/acceptance/p2-batch1.spec.ts:112` | 2 | 双栏确认发布gate、外部已见不可再严格独立 |
| `frontend/tests/acceptance/p2-batch2.spec.ts:33` | 4 | 封存/合并影响/none与stub不生成可用变式 |
| `frontend/tests/acceptance/p2-batch3.spec.ts:39` | 3 | 服务端时钟/缺评分范围/校准样本与限制 |

两Playwright配置均Desktop Chrome/Pixel7、workers=1/retries=0（`frontend/playwright.config.ts:41`；`frontend/playwright.acceptance.config.ts:53`），51不能简单×2当已跑数，配置webServer会启动Django/Vite。e2e/global-setup.ts:17需专用DB/空媒体，执行migrate/create_account/reset_demo_progress/load_demo_fixture；acceptance/global-setup.ts:54建普通/空账户并bootstrap。DSH迁移须替换setup/登录/路由helpers；acceptance/helpers.ts:25/:43经UI登录记录HTTP错误，spec也直接page.request+cookie/CSRF+/api/v1。没有tutorStream独立Vitest，覆盖来自后端integration和Playwright。

### 7.2 scripts / var 门禁与取证工具

scripts共16文件；排除private-media/备份/恢复媒体后，var有7个Python验证/取证工具。下表仅描述代码，均未运行。

| 文件 | 能力 / 迁移边界 |
|---|---|
| `scripts/backup.sh:27` | PG dump+私媒体归档/manifest，:59清旧备份；目标schema/布局需对齐 |
| `scripts/restore.sh:7` | 新DB/空媒体保护、dry-run/SHA256/missing/extra；:140 pg_restore |
| `scripts/demo_live_flow.py:79` | urllib/cookie真实HTTP五题型/PNG/报告；适合改Node fetch黑盒但依赖demo |
| `scripts/gen-dev-certs.sh:16` | 本地证书生成；DSH托管后按部署边界决定保留 |
| `scripts/verify_proxy.sh:98` | component Nginx/TLS/跳转/dist/health；:183 full-stack Compose/迁移/CSRF；重写宿主启动依赖 |
| `scripts/verify_real_ai.py:67` | 专用DB/真实provider/费用校验与不改分数状态计划；直接Django/service，非通用HTTP |
| `scripts/verify_worker_e2e.py:177` | 专用DB/真实broker/worker、SIGKILL/丢队列/恢复/双consumer；:237 FLUSHALL显式opt-in；Node重写故障注入 |
| `scripts/dev/measure-hot-paths.sh:25` | 专用perfprobe DB+pytest；迁场景、改query capture |
| `scripts/dev/optimization-gate.sh:37` | backend suite/ruff/check/迁移/归档反例/perfprobe→var/gate；不跑browser acceptance |
| `scripts/dev/reset-p02-remaining-browser.sh:14` | 专用DB保护、DROP/recreate/Redis/媒体重置，非测试 |
| `scripts/dev/reset-p1-batch-browser.sh:18` | P1首批环境重置，含DB/媒体删除 |
| `scripts/dev/reset-p1-batch2-browser.sh:20` | 图/检索/记忆批次重置，Redis6395 |
| `scripts/dev/reset-p1-batch3-browser.sh:20` | 转写/估分/诊断/SSE重置，Redis6396 |
| `scripts/dev/reset-p2-batch1-browser.sh:19` | 版式/污染重置，Redis6397 |
| `scripts/dev/reset-p2-batch2-browser.sh:19` | 封存/合并/变式重置，Redis6398 |
| `scripts/dev/reset-p2-batch3-browser.sh:19` | 考试/表达式/报告重置，Redis6399 |
| `var/opt-w1/repro_step2.py:74` | 启真实Celery，追踪reconcile_plan；换Node consumer |
| `var/opt-w2/diff_bodies.py:47` | before/after JSON的UUID/时间归一化及去标识比较；适合响应差分 |
| `var/opt-w2/bench/test_bench_sessions_scale.py:134` | 20k session比较旧/新/correlated query，依赖ORM |
| `var/opt-w2/explain/test_explain_at_scale.py:44` | 大规模EXPLAIN ANALYZE BUFFERS；保PG可复用方法 |
| `var/opt-w2/explain/test_explain_read_paths.py:40` | 两列表小规模EXPLAIN，换SQL捕获 |
| `var/opt-w2/golden/test_dump_golden.py:24` | 打印payload golden；依赖integration fixture，可导出跨实现数据 |
| `var/opt-w2/snapshot/test_read_path_snapshot.py:221` | 10类热读响应/旧新列表/查询数；:3的489-test是历史注释 |

optimization-gate.sh:48归档检查有明确deselect，:54旧P0仅日志不gate。var/perfprobe、var/gate、var/lead-verify已有输出仅是历史文件，本次不据此报告当前通过。

## 8. 全部第三方依赖与 Node 替代建议

后端锁38项；前端5 runtime+8 dev。版本按声明记录，前端范围不是安装解析版本。替代物为离线候选，未安装/验证目标兼容性/核对最新版。风险“高”指业务/数据/并发或宿主整合语义，“中”指需要适配与golden，“低”指主要工具链可移除。

| lock.txt行 | 当前包及版本 | Node责任替代候选 | 风险 |
|---|---|---|---|
| 1 | amqp==5.4.0 | 保留AMQP才评估amqplib；当前Redis路径无需逐包移植 | 中 |
| 2 | annotated-types==0.8.0 | Zod/JSON Schema；边界/错误路径对齐 | 中 |
| 3 | asgiref==3.12.1 | Node HTTP/Web Streams/AsyncLocalStorage；重写同步异步桥 | 中 |
| 4 | billiard==4.3.0 | child_process/worker_threads或独立worker；终止/恢复语义 | 高 |
| 5 | celery==5.5.3 | DSH jobs（待验宿主契约）或Node worker/队列+持久outbox；可评估BullMQ，保留租约/补扫 | 高 |
| 6 | click==8.5.0 | Commander/util.parseArgs；CLI退出码/参数 | 低 |
| 7 | click-didyoumean==0.3.1 | CLI建议按需重写 | 低 |
| 8 | click-plugins==1.1.1.2 | 显式命令注册；不假设DSH发现接口 | 低 |
| 9 | click-repl==0.4.0 | readline，或随Celery CLI删除 | 低 |
| 10 | coverage==7.16.1 | Vitest coverage/V8；覆盖率口径不同 | 低 |
| 11 | Django==5.2.17 | 宿主路由/服务、pg/ORM；拆auth/事务/迁移/admin/命令 | 高 |
| 12 | django-ninja==1.4.5 | 宿主路由或Hono/Fastify+schema/OpenAPI；匹配路径/状态/envelope | 高 |
| 13 | gunicorn==26.2.0 | DSH/Node进程宿主，不直接复制独立Web进程架构 | 中 |
| 14 | iniconfig==2.3.0 | 目标测试配置，随pytest移除 | 低 |
| 15 | kombu==5.5.4 | Redis/AMQP客户端+调度适配；确认/重投/序列化 | 高 |
| 16 | packaging==26.3 | npm semver仅替代npm版本职责，不等价PEP440 | 低 |
| 17 | pillow==11.3.0 | sharp候选；原生分发、尺寸/编码/安全校验 | 高 |
| 18 | pluggy==1.6.0 | 显式接口/注册表；测试间接依赖 | 低 |
| 19 | prompt_toolkit==3.0.53 | readline/Inquirer或宿主交互 | 低 |
| 20 | psycopg==3.2.13 | pg+SQL/Kysely/Drizzle；事务/锁/Decimal/JSON/UTC/错误映射 | 高 |
| 21 | psycopg-binary==3.2.13 | 同上；删除Python驱动二进制 | 高 |
| 22 | pypdf==5.1.0 | pdfjs-dist提取/几何，pdf-lib可评估生成fixture；不视为等价parser | 高 |
| 23 | pydantic==2.13.5 | Zod/JSON Schema；coercion/extra/null/默认值/Decimal字符串 | 高 |
| 24 | pydantic_core==2.46.5 | 随runtime schema替换，无独立同名替身 | 中 |
| 25 | Pygments==2.21.0 | 宿主高亮或移除 | 低 |
| 26 | pytest==8.4.2 | Vitest/node:test；fixtures/marks/monkeypatch重写 | 中 |
| 27 | pytest-cov==6.3.0 | Vitest coverage；不能直比跨语言百分比 | 低 |
| 28 | pytest-django==4.14.0 | Node专用测试DB/事务fixture，保持隔离回滚连接清理 | 高 |
| 29 | python-dateutil==2.9.0.post0 | Temporal类实现/date-fns/Luxon候选；解析/DST/时区锚点 | 高 |
| 30 | redis==6.4.0 | redis/ioredis，或宿主队列+插件会话cache；prefix/重连/序列化 | 高 |
| 31 | ruff==0.16.9 | ESLint/Biome+tsc；规则非逐条等价 | 低 |
| 32 | six==1.17.0 | Python兼容层，无需Node替身 | 低 |
| 33 | sqlparse==0.6.0 | 随Django移除；真需SQL解析再独立选型 | 低 |
| 34 | typing-inspection==0.4.4 | TS类型+runtime schema；不能只靠静态类型 | 中 |
| 35 | typing_extensions==4.16.0 | TS类型，无独立运行时替身 | 低 |
| 36 | tzdata==2026.4 | Node ICU/IANA；记录目标实际时区数据版本 | 中 |
| 37 | vine==5.1.0 | Promise/异步状态机，随Celery体系移除 | 低 |
| 38 | wcwidth==0.9.1 | string-width或宿主终端布局；Unicode宽度差异 | 低 |

上表来源逐行为 `backend/requirements/lock.txt:1`–38；不仅列顶层需求，也保留全部锁定的间接/开发依赖。

| package.json行 | 当前声明 | DSH迁移建议 | 风险 |
|---|---|---|---|
| 15 | @tanstack/react-query ^5.62.7 | 可复用，定义共享实例/模块表/namespace/退出清理 | 中 |
| 16 | katex ^0.16.11 | 可复用，处理CJS-lazy与CSS/字体，保持trust=false | 中 |
| 17 | react ^19.0.0 | 用宿主shared module table，避免重复hook/context身份 | 高 |
| 18 | react-dom ^19.0.0 | 对齐宿主React，改自有createRoot入口 | 高 |
| 19 | react-router-dom ^7.1.1 | BrowserRouter不能直接嵌shell；宿主导航/内部路由适配 | 高 |
| 22 | @playwright/test ^1.49.1 | 保留行为验收，替换setup/宿主挂载/登录导航 | 中 |
| 23 | @types/node ^26.6.3 | 匹配宿主Node实际能力，编译通过不是API存在证明 | 中 |
| 24 | @types/react ^19.0.2 | 对齐宿主版本和导出类型 | 中 |
| 25 | @types/react-dom ^19.0.2 | 对齐宿主挂载接口 | 中 |
| 26 | @vitejs/plugin-react ^4.3.4 | 目标tsdown需处理JSX，dev HMR另定 | 中 |
| 27 | typescript ^5.7.2 | 可保留，遵守宿主target/moduleResolution/tsconfig | 中 |
| 28 | vite ^6.0.5 | 可留独立开发验证，目标产物按tsdown契约重建 | 高 |
| 29 | vitest ^2.1.8 | 可保留/对齐宿主；vite.config.ts:28已有嵌套Vite类型问题说明 | 中 |

来源 `frontend/package.json:14`、`:21`；:5为type=module，:6 scripts是vite、tsc -b && vite build、preview、tsc、vitest、playwright，尚无tsdown脚本。

| 非锁文件运行时责任 / 来源 | Node/DSH候选与必须保留的语义 | 风险 |
|---|---|---|
| PostgreSQL16（`infra/docker/docker-compose.yml:50`） | 可先保PG+pg；改better-sqlite3/node:sqlite前须设计sequence/JSON/Decimal/partial unique/锁/多consumer事务替代；Node store也需持久约束 | 高 |
| Redis7（同文件:68）+Celery队列 | DSH jobs或in-process queue仅替代调度；持久outbox/租约/补扫仍须独立实现，纯内存队列会丢恢复能力 | 高 |
| Django auth/session/CSRF（`backend/config/settings/base.py:155`、`:166`） | DSH remote-access身份或插件session候选；仍要映射owner/project/reviewer和cookie-CSRF边界，不能仅移除登录页 | 高 |
| 私有媒体（`backend/apps/ingestion/storage.py`；settings/base.py:253） | Node fs/宿主存储适配+受权下载handler，保留ID/校验和/purpose/曝光记录 | 高 |
| AI urllib/provider（`backend/ai/providers/base.py:191`） | dsh-llm适配，保留结构validator/audit/stub/降级；embedding单独确认 | 高 |
| Python Decimal/hash/datetime（grading、idempotency、memory） | decimal.js或明确十进制定点、node:crypto、显式UTC/时区；确认舍入/JSON/hash和时间向量 | 高 |

## 9. 本次核对范围

文档自检已逐条对照154条route与handler、111个Schema、57个模型表名及59个JSON字段，核对38+13项依赖全部出现，并检查完整路径引用存在及行号范围；这些是文档静态检查。本文依据源码/AST与已安装Ninja/Django相关实现核对；未访问数据库、外部AI、DSH服务或任何运行中应用，未执行测试/构建/门禁。历史日志不作为本次通过证据。建议迁移先保留HTTP响应/状态转换、纯函数向量、PDF字节fixture和崩溃重投不变量，再分别替换宿主transport、LLM适配和存储。
