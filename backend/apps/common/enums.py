"""Shared enums for the AcePass domain.

These string enums are the single source of truth for choices used across
models, services and API schemas. Every enum that a published artefact depends
on is treated as append-only: removing or renaming a member would invalidate
already-recorded grading evidence.
"""

from __future__ import annotations

from django.db import models


class OriginType(models.TextChoices):
    """How a question's content entered the system.

    Only `OFFICIAL_PAST` may back a real paper occurrence; generated or demo
    content never counts towards historical statistics.
    """

    OFFICIAL_PAST = "official_past", "真实考试原题"
    LICENSED_BANK = "licensed_bank", "授权题库"
    USER_AUTHORED = "user_authored", "用户自编"
    AI_GENERATED = "ai_generated", "AI 生成"
    DEMO = "demo", "演示夹具（非真题）"


class AnswerSourceType(models.TextChoices):
    OFFICIAL = "official", "官方答案"
    TEXTBOOK_OR_BANK = "textbook_or_bank", "教材/题库答案"
    USER = "user", "用户提供"
    AI_DERIVED = "ai_derived", "AI 推导（需独立验证）"


class VerificationStatus(models.TextChoices):
    PENDING = "pending", "待核对"
    CHECKED = "checked", "已核对"
    DISPUTED = "disputed", "有争议"


class QuestionVersionStatus(models.TextChoices):
    DRAFT = "draft", "草稿"
    IN_REVIEW = "in_review", "待校对"
    PUBLISHED = "published", "已发布"
    WITHDRAWN = "withdrawn", "已撤回"


class QuestionType(models.TextChoices):
    SINGLE_CHOICE = "single_choice", "单选题"
    MULTIPLE_CHOICE = "multiple_choice", "多选题"
    TRUE_FALSE = "true_false", "判断题"
    FILL_BLANK = "fill_blank", "填空题"
    CONSTRUCTED_RESPONSE = "constructed_response", "大题"
    MATERIAL = "material", "共享材料"


#: Question types that can carry a score and receive an attempt.
SCORABLE_LEAF_TYPES = (
    QuestionType.SINGLE_CHOICE,
    QuestionType.MULTIPLE_CHOICE,
    QuestionType.TRUE_FALSE,
    QuestionType.FILL_BLANK,
    QuestionType.CONSTRUCTED_RESPONSE,
)

OBJECTIVE_TYPES = (
    QuestionType.SINGLE_CHOICE,
    QuestionType.MULTIPLE_CHOICE,
    QuestionType.TRUE_FALSE,
    QuestionType.FILL_BLANK,
)


class SourceKind(models.TextChoices):
    OFFICIAL_PAST = "official_past", "真实考试试卷"
    MOCK = "mock", "模拟卷（非真题）"
    PRACTICE_SET = "practice_set", "练习集"
    DEMO = "demo", "演示夹具"


class PaperRevisionStatus(models.TextChoices):
    DRAFT = "draft", "草稿"
    CONFIRMED = "confirmed", "已确认"
    WITHDRAWN = "withdrawn", "已撤回"


class ImportJobStatus(models.TextChoices):
    QUEUED = "queued", "排队中"
    PROCESSING = "processing", "处理中"
    AWAITING_REVIEW = "awaiting_review", "待校对"
    COMPLETED = "completed", "已完成"
    FAILED = "failed", "失败"
    CANCELLED = "cancelled", "已取消"


class ImportCandidateStatus(models.TextChoices):
    DRAFT = "draft", "待校对"
    READY = "ready", "校对完成待发布"
    PUBLISHED = "published", "已发布"
    IGNORED = "ignored", "已忽略"


class SessionMode(models.TextChoices):
    PRACTICE = "practice", "练习"
    VERIFICATION = "verification", "验证"
    MOCK_EXAM = "mock_exam", "模拟考试"


class SessionStatus(models.TextChoices):
    ACTIVE = "active", "进行中"
    FINISHED = "finished", "已结束"
    ABANDONED = "abandoned", "已放弃"


class ExposureKind(models.TextChoices):
    STEM_DELIVERED = "stem_delivered", "题干下发"
    HINT_DELIVERED = "hint_delivered", "提示下发"
    EXPLANATION_DELIVERED = "explanation_delivered", "讲解下发"
    ANSWER_DELIVERED = "answer_delivered", "答案下发"
    FEEDBACK_DELIVERED = "feedback_delivered", "判分反馈下发"
    EDITORIAL_PREVIEW = "editorial_preview", "编辑/校对预览"
    EXTERNAL_SEEN = "external_seen", "系统外已见（用户声明）"


class ExposurePurpose(models.TextChoices):
    PRACTICE = "practice", "练习"
    VERIFICATION = "verification", "验证"
    EDITORIAL = "editorial", "编辑校对"
    PREVIEW = "preview", "题库预览"
    REPORT = "report", "报告"


class GradeStatus(models.TextChoices):
    CONFIRMED = "confirmed", "已确认"
    PENDING_REVIEW = "pending_review", "待复核"
    ESTIMATED = "estimated", "AI 估计"
    VOID = "void", "无效"


class GradeMethod(models.TextChoices):
    DETERMINISTIC = "deterministic", "确定性判分"
    SELF_CONFIRMED = "self_confirmed", "自评确认"
    REVIEWER_CONFIRMED = "reviewer_confirmed", "复核确认"
    AI_ESTIMATED = "ai_estimated", "AI 估计"
    MIXED = "mixed", "混合"


class GradeEventKind(models.TextChoices):
    INITIAL = "initial", "初次判分"
    MANUAL_CONFIRMATION = "manual_confirmation", "人工确认"
    AI_ESTIMATE = "ai_estimate", "AI 估计"
    REGRADE = "regrade", "重判"
    INVALIDATION = "invalidation", "判分失效"


class MismatchPolicy(models.TextChoices):
    """What happens when a fill-in answer matches no accepted value."""

    REVIEW = "review", "转人工复核（默认）"
    WRONG = "wrong", "判错（仅当考试规则明确）"


class MultipleChoicePolicy(models.TextChoices):
    EXACT_MATCH = "exact_match", "完全匹配"
    PARTIAL_CREDIT = "partial_credit", "少选给部分分"


class PracticeMode(models.TextChoices):
    """How practice/verification sessions admit AI tutoring."""

    ALLOWED = "allowed", "允许"
    DENIED = "denied", "禁止"


class KnowledgeNodeKind(models.TextChoices):
    CHAPTER = "chapter", "章节"
    POINT = "point", "考点"


class ReviewStatus(models.TextChoices):
    DRAFT = "draft", "草稿"
    APPROVED = "approved", "已审核"
    REJECTED = "rejected", "已否决"


class EvidenceDimension(models.TextChoices):
    REPEAT_PRACTICE = "repeat_practice", "重复练习"
    UNASSISTED_COMPLETION = "unassisted_completion", "无辅助完成"
    INDEPENDENT_CORRECT = "independent_correct", "严格独立正确"
    TEMPLATE_VARIANT = "template_variant", "同模板变式"
    UNSEEN_VARIANT = "unseen_variant", "陌生变式"
    DELAYED_VERIFICATION = "delayed_verification", "延迟验证"


class KnowledgeStateSummary(models.TextChoices):
    UNDIAGNOSED = "undiagnosed", "未诊断"
    NEEDS_FOUNDATION = "needs_foundation", "需要补基础"
    COMPLETES_WITH_HINTS = "completes_with_hints", "提示后能完成"
    INDEPENDENT = "independent", "可以独立完成"
    HANDLES_UNSEEN = "handles_unseen", "可以处理陌生变式"
    DELAYED_VERIFIED = "delayed_verified", "经过延迟验证"
    NEEDS_REVIEW = "needs_review", "需要复习"


class TaskKind(models.TextChoices):
    DELAYED_VERIFICATION = "delayed_verification", "延迟验证"
    PAIRED_IMMEDIATE = "paired_immediate", "配对即时验证"
    WEAKNESS_REPAIR = "weakness_repair", "补弱练习"
    UNDIAGNOSED_PROBE = "undiagnosed_probe", "未诊断考点"
    GENERAL_PRACTICE = "general_practice", "一般练习"
    MEMORY_REVIEW = "memory_review", "记忆卡复习"


class TaskStatus(models.TextChoices):
    PENDING = "pending", "待开始"
    IN_PROGRESS = "in_progress", "进行中"
    COMPLETED = "completed", "已完成"
    DEFERRED = "deferred", "已顺延"
    INVALIDATED = "invalidated", "已失效"
    SKIPPED = "skipped", "已跳过"


class OutboxStatus(models.TextChoices):
    PENDING = "pending", "待派发"
    DISPATCHED = "dispatched", "已派发（等待消费确认）"
    PROCESSING = "processing", "消费者已领取"
    PROCESSED = "processed", "已处理"
    FAILED = "failed", "派发或消费失败"

    @classmethod
    def unresolved(cls) -> tuple[str, ...]:
        """States that still need work: nothing here has been confirmed done."""
        return (cls.PENDING, cls.DISPATCHED, cls.PROCESSING, cls.FAILED)


class TutorPurpose(models.TextChoices):
    HINT = "hint", "提示"
    EXPLANATION = "explanation", "完整讲解"
    CLARIFY = "clarify", "条件澄清"
    DIAGNOSE = "diagnose", "诊断追问"


class TutorRequestStatus(models.TextChoices):
    QUEUED = "queued", "排队中"
    RUNNING = "running", "生成中"
    SUCCEEDED = "succeeded", "已完成"
    FAILED = "failed", "失败"
    UNAVAILABLE = "unavailable", "AI 未配置"
    STALE = "stale", "已被替代"


class LlmRunStatus(models.TextChoices):
    SUCCEEDED = "succeeded", "成功"
    FAILED = "failed", "失败"
    REJECTED = "rejected", "输出未通过校验"
    UNAVAILABLE = "unavailable", "未配置或不可用"
    TIMEOUT = "timeout", "超时"


class RecomputeStatus(models.TextChoices):
    QUEUED = "queued", "排队中"
    RUNNING = "running", "重算中"
    SUCCEEDED = "succeeded", "已完成"
    FAILED = "failed", "失败"


class RegradeStatus(models.TextChoices):
    QUEUED = "queued", "排队中"
    RUNNING = "running", "重判中"
    SUCCEEDED = "succeeded", "已完成"
    FAILED = "failed", "失败"


class AssetRole(models.TextChoices):
    PAST_PAPER_PAGE = "past_paper_page", "试卷整页"
    ANSWER_PAGE = "answer_page", "答案整页"
    STEM_CROP = "stem_crop", "题干裁图"
    MATERIAL_CROP = "material_crop", "材料裁图"
    ANSWER_CROP = "answer_crop", "答案裁图"
    USER_ATTACHMENT = "user_attachment", "用户作答附件"
    OTHER = "other", "其他"


class AssetSensitivity(models.TextChoices):
    """Gate that decides who may read a stored object, and when."""

    PUBLIC_TO_OWNER = "public_to_owner", "所有者可读（不含答案）"
    CONTAINS_ANSWERS = "contains_answers", "含答案，提交前受限"
    INTERNAL_REVIEW = "internal_review", "仅内部审核"


class ContentLineageBasis(models.TextChoices):
    SAME_SOURCE_FILE = "same_source_file", "同一来源文件"
    EXPLICIT_COPY = "explicit_copy", "明确复制"
    MANUAL_CONFIRMED = "manual_confirmed", "人工确认同题"


class UnitConversionKind(models.TextChoices):
    NONE = "none", "无单位换算"
    WHITELIST = "whitelist", "白名单单位换算"


class KnowledgeRelationType(models.TextChoices):
    """Edges between knowledge points inside one syllabus version."""

    PREREQUISITE = "prerequisite", "前置考点"
    RELATED = "related", "相关考点"


class SuggestionStatus(models.TextChoices):
    """Review state of every machine-proposed editorial change.

    A proposal never mutates controlled vocabulary or scoring facts directly;
    it only becomes effective after a human accepts it.
    """

    PROPOSED = "proposed", "待审核"
    ACCEPTED = "accepted", "已采纳"
    REJECTED = "rejected", "已否决"
    SUPERSEDED = "superseded", "已被替代"


class MemoryRating(models.TextChoices):
    """FSRS review grade chosen by the learner."""

    AGAIN = "again", "忘记"
    HARD = "hard", "困难"
    GOOD = "good", "记得"
    EASY = "easy", "简单"


class MemoryCardPhase(models.TextChoices):
    NEW = "new", "未学"
    LEARNING = "learning", "学习中"
    REVIEW = "review", "复习中"
    RELEARNING = "relearning", "重学中"


class SearchChannel(models.TextChoices):
    KEYWORD = "keyword", "关键词"
    VECTOR = "vector", "向量"
    HYBRID = "hybrid", "混合"
