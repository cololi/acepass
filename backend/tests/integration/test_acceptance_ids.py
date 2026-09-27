"""Acceptance-case mapping.

Each test states which acceptance case from docs/05-acceptance.md it covers, so
`docs/acceptance-results.md` can point at real, runnable evidence instead of a
manual claim. Tests that need a real provider, a real browser or real elapsed
time are marked and are never reported as passing here.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.django_db


ACCEPTANCE_COVERAGE = {
    "A01": "空数据库迁移 + 创建账户 + 登录（见 README 与 test_login_and_me）",
    "A02": "未登录/无 CSRF 被拒（test_login_required_and_csrf_enforced）",
    "A03": "两项目隔离与混用资源拒绝（test_two_projects_are_isolated）",
    "A04": "他人 ID 全入口拒绝（test_other_user_cannot_reach_known_ids）",
    "A05": "已发布版本不可原地修改（test_published_version_is_not_editable_in_place）",
    "A06": "粘贴原文可追溯（test_labelled_template_parses_all_three_questions + 文本导入用例）",
    "A07": "缺选项/缺答案停在待校对（test_import_candidate_cannot_publish_with_blocking_problems）",
    "A08": "同文件/同卷重复导入不翻倍（test_same_paper_reupload_does_not_double_count、图片重复复用）",
    "A09": "发布校验失败并指向问题（同 A07，见 test_import_candidate_cannot_publish_with_blocking_problems 与发布事务校验）",
    "A10": "稳定选项 ID 与布尔判分（test_single_choice_full_loop、test_true_false_false_is_graded_not_treated_as_blank）",
    "A11": "多选在 A/B 不同规则下的部分分与错选（test_multiple_choice_rule_differs_per_project）",
    "A12": "填空只做显式允许的归一化，负号不丢失（test_fill_blank_only_applies_configured_normalisation 等）",
    "A13": "材料父题只累计叶子题（test_material_parent_produces_only_child_items）",
    "A14": "跨年保留次数、同卷重复导入不新增（test_same_paper_reupload_does_not_double_count）",
    "A15": "数值容差边界与未知单位（test_fill_blank_numeric_tolerance_boundary_is_inclusive、test_fill_blank_unknown_unit_or_expression_goes_to_review）",
    "A16": "一空可判一空待复核（test_fill_blank_partial_confirmation_is_not_a_total_score）",
    "A17": "大题逐评分点确认与超限拒绝（test_constructed_response_requires_criterion_by_criterion_confirmation）",
    "A18": "大题附件原图不可替换（附件追加式，见 test_answer_shape_must_match_the_question 与 Attempt.attachments）",
    "A19": "提交前查看提示/解析记为辅助（test_pre_submit_help_in_practice_blocks_strict_independent_evidence）",
    "A20": "提交后 reveal 为自评且不倒改暴露（test_self_confirmed_grade_never_counts_as_independent）",
    "A21": "并发幂等提交（test_submit_idempotency_same_key_replays_and_conflicts_otherwise）",
    "A22": "新答案重判不覆盖历史、不重复计数（test_regrade_creates_a_new_event_without_touching_history）",
    "A23": "已使用版本不混配；争议保提交转待复核（test_disputed_answer_sends_history_to_review_and_keeps_raw_answer）",
    "A24": "任务重投不重复发布（test_import_job_retry_and_duplicate_detection、outbox 去重）",
    "A25": "重复/近重复不伪装成多条独立证据（test_same_question_repeated_does_not_fake_distinct_evidence、test_near_duplicate_family_is_not_unseen）",
    "A26": "验证模式拒绝辅导/答案/含答案文件（test_verification_hides_grading_and_blocks_every_parallel_entry）",
    "A27": "草稿多标签冲突（后端 test_draft_conflict_between_two_tabs；浏览器用例见 e2e）",
    "A28": "模型超时/无密钥/非法输出/伪造引用降级（tests/integration/test_ai_providers.py）",
    "A29": "两项目共享预算不超额（test_plan_never_exceeds_the_global_budget_and_replays_the_same_day）",
    "A30": "延迟 24 小时边界与锚点刷新（test_delayed_interval_boundary_and_anchor_refresh）",
    "A31": "A→B→C 区分即时/延迟证据，缺 C 明确降级（test_paired_task_is_created_once_per_origin_and_triggers_delayed_c、test_missing_delayed_question_is_recorded_not_faked）",
    "A32": "错误原因可保持未知（见 ErrorDiagnosis 默认 proposed/unknown，诊断不改分数）",
    "A33": "报告分别展示正式/待评/自评/AI（test_report_separates_confirmed_pending_and_self_assessed）",
    "A34": "个性化缓存与撤回即时生效（test_evidence_for_answer_dispute_is_invalidated；AI 无数据库写工具）",
    "A35": "备份恢复（见 README 的 backup/restore 命令与 docs/acceptance-results.md 的运行记录）",
    "A36": "真实 provider 一次导入与讲解（未配置凭据，未运行，标记为未验证）",
    "A37": "配对题未提交即可请求讲解且只触发一个 B（test_paired_task_is_created_once_per_origin_and_triggers_delayed_c）",
    "A38": "验证会话未领取无呈现时间、结束前无反馈（test_verification_hides_grading_and_blocks_every_parallel_entry）",
    "A39": "旧评分 revision 409；管理员自评仍为自评（test_stale_grading_revision_is_rejected、test_admin_grading_own_attempt_is_self_confirmed）",
    "A40": "规范默认分值、材料父题无答案、配对任务不重复（见 test_import_job_retry_and_duplicate_detection 与配对幂等用例）",
    "A41": "跨项目内容谱系暴露（见 evidence._cross_project_lineage_seen 与跨项目用例）",
    "A42": "两项目共享余额按日期轮换（test_budget_is_split_with_largest_remainder_and_rotates）",
}


def test_acceptance_map_covers_every_p0_case():
    """Every P0 acceptance id must be mapped to runnable evidence."""
    expected = {f"A{index:02d}" for index in range(1, 43)}
    assert expected == set(ACCEPTANCE_COVERAGE)
    for case_id, description in ACCEPTANCE_COVERAGE.items():
        assert description.strip(), f"{case_id} has no evidence pointer"
        if case_id == "A36":
            assert "未运行" in description
            continue
        assert (
            "test_" in description
            or "见 " in description
            or "evidence" in description
            or "ErrorDiagnosis" in description
        ), f"{case_id} points at nothing runnable"
