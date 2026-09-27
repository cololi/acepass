"""Exams services: projects, subjects, versioned specs/syllabus and papers."""

from __future__ import annotations

import hashlib
from datetime import date, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from apps.audit.models import ContentRevision
from apps.audit.services.outbox import enqueue
from apps.common.enums import PaperRevisionStatus, QuestionType, ReviewStatus, SourceKind
from apps.common.errors import InvalidInput, ScopeViolation, VersionConflict
from apps.exams.models import ExamProject, ExamSpecVersion, Paper, PaperItem, PaperRevision, Subject, SyllabusVersion


@transaction.atomic
def create_project(
    user,
    *,
    name: str,
    description: str = "",
    target_date: date | None = None,
    target_score: Decimal | None = None,
) -> ExamProject:
    name = (name or "").strip()
    if not name:
        raise InvalidInput(message="项目名称不能为空")
    if ExamProject.objects.filter(owner=user, name=name).exists():
        raise InvalidInput(message="已存在同名项目", details={"name": name})
    last_order = ExamProject.objects.filter(owner=user).aggregate(value=Max("display_order"))["value"] or 0
    return ExamProject.objects.create(
        owner=user,
        name=name,
        description=description[:500],
        target_date=target_date,
        target_score=target_score,
        display_order=last_order + 1,
    )


@transaction.atomic
def update_project(project: ExamProject, **fields) -> ExamProject:
    if project.is_archived:
        raise InvalidInput(message="已归档项目不能修改；请先恢复或新建项目")
    mutable = {"name", "description", "target_date", "target_score", "display_order"}
    changed = {}
    for key, value in fields.items():
        if key not in mutable or value is None:
            continue
        setattr(project, key, value)
        changed[key] = str(value)
    if "name" in changed:
        if ExamProject.objects.filter(owner=project.owner, name=project.name).exclude(id=project.id).exists():
            raise InvalidInput(message="已存在同名项目", details={"name": project.name})
    project.full_clean(exclude=["owner", "created_at", "updated_at"])
    project.save()
    if changed:
        ContentRevision.objects.create(
            actor=project.owner,
            entity_type="exam_project",
            entity_id=str(project.id),
            action="update",
            project_id=project.id,
            detail=changed,
        )
    return project


@transaction.atomic
def archive_project(project: ExamProject, *, reason: str = "") -> ExamProject:
    """Archive only when nothing is in flight.

    In-progress attempts must be finished (or explicitly abandoned) first:
    history is kept, new tasks stop.
    """
    from apps.practice.models import PracticeSession, SessionStatus

    active_sessions = PracticeSession.objects.filter(project=project, status=SessionStatus.ACTIVE).count()
    if active_sessions:
        raise InvalidInput(
            message="存在进行中的练习会话，请先结束或放弃后再归档",
            details={"active_sessions": active_sessions},
        )
    if project.is_archived:
        return project
    project.is_archived = True
    project.archived_at = timezone.now()
    project.save(update_fields=["is_archived", "archived_at", "updated_at"])
    ContentRevision.objects.create(
        actor=project.owner,
        entity_type="exam_project",
        entity_id=str(project.id),
        action="archive",
        project_id=project.id,
        reason=reason[:500],
    )
    return project


@transaction.atomic
def unarchive_project(project: ExamProject) -> ExamProject:
    if not project.is_archived:
        return project
    project.is_archived = False
    project.archived_at = None
    project.save(update_fields=["is_archived", "archived_at", "updated_at"])
    ContentRevision.objects.create(
        actor=project.owner,
        entity_type="exam_project",
        entity_id=str(project.id),
        action="unarchive",
        project_id=project.id,
    )
    return project


@transaction.atomic
def create_subject(project: ExamProject, *, name: str, code: str = "", **extra) -> Subject:
    name = (name or "").strip()
    if not name:
        raise InvalidInput(message="科目名称不能为空")
    if Subject.objects.filter(project=project, name=name).exists():
        raise InvalidInput(message="该项目下已存在同名科目", details={"name": name})
    last_order = Subject.objects.filter(project=project).aggregate(value=Max("display_order"))["value"] or 0
    return Subject.objects.create(project=project, name=name, code=code[:40], display_order=last_order + 1, **extra)


def next_version_number(queryset, field: str = "version") -> int:
    current = queryset.aggregate(value=Max(field))["value"] or 0
    return current + 1


@transaction.atomic
def create_exam_spec_version(subject: Subject, *, created_by, **fields) -> ExamSpecVersion:
    rule_payload = fields.get("question_type_rules") or {}
    _validate_type_rules(rule_payload)
    return ExamSpecVersion.objects.create(
        subject=subject,
        version=next_version_number(ExamSpecVersion.objects.filter(subject=subject)),
        created_by=created_by,
        **fields,
    )


def _validate_type_rules(rules: dict) -> None:
    if not isinstance(rules, dict):
        raise InvalidInput(message="question_type_rules 必须是对象")
    for question_type, rule in rules.items():
        if question_type not in QuestionType.values:
            raise InvalidInput(message=f"未知题型：{question_type}", details={"type": question_type})
        if rule is None:
            continue
        if not isinstance(rule, dict):
            raise InvalidInput(message=f"{question_type} 的规则必须是对象")
        for key in ("default_max_score", "wrong_score", "blank_score", "partial_score"):
            if rule.get(key) in (None, ""):
                continue
            try:
                value = Decimal(str(rule[key]))
            except Exception as exc:
                raise InvalidInput(message=f"{question_type}.{key} 必须是十进制数") from exc
            if value < 0:
                raise InvalidInput(message=f"{question_type}.{key} 不能为负")
        if rule.get("default_max_score") in (None, ""):
            continue
        max_score = Decimal(str(rule["default_max_score"]))
        for key in ("wrong_score", "blank_score", "partial_score"):
            if rule.get(key) in (None, ""):
                continue
            if Decimal(str(rule[key])) > max_score:
                raise InvalidInput(message=f"{question_type}.{key} 不能超过该题型满分")


@transaction.atomic
def publish_exam_spec_version(spec: ExamSpecVersion, *, actor) -> ExamSpecVersion:
    """Versioned publish. A published spec is never edited in place."""
    if spec.status == "published":
        return spec
    if not spec.question_type_rules:
        raise InvalidInput(message="发布规范前必须配置至少一种题型的计分规则")
    _validate_type_rules(spec.question_type_rules)
    spec.status = "published"
    spec.published_at = timezone.now()
    spec.full_clean(exclude=["question_type_rules"])
    spec.save(update_fields=["status", "published_at", "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="exam_spec_version",
        entity_id=str(spec.id),
        action="publish",
        project_id=spec.subject.project_id,
        detail={"version": spec.version},
    )
    return spec


@transaction.atomic
def create_syllabus_version(subject: Subject, *, created_by, **fields) -> SyllabusVersion:
    name = (fields.get("name") or "").strip()
    if not name:
        raise InvalidInput(message="大纲名称不能为空")
    fields["name"] = name
    return SyllabusVersion.objects.create(subject=subject, created_by=created_by, **fields)


@transaction.atomic
def publish_syllabus_version(syllabus: SyllabusVersion, *, actor) -> SyllabusVersion:
    """Treats a user-authored outline honestly: it is never relabelled official."""
    if syllabus.status == "published":
        return syllabus
    if syllabus.review_status != ReviewStatus.APPROVED:
        syllabus.review_status = ReviewStatus.APPROVED
    syllabus.status = "published"
    syllabus.published_at = timezone.now()
    syllabus.save(update_fields=["status", "published_at", "review_status", "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="syllabus_version",
        entity_id=str(syllabus.id),
        action="publish",
        project_id=syllabus.subject.project_id,
        detail={"is_user_provisional": syllabus.is_user_provisional},
    )
    return syllabus


# --------------------------------------------------------------------------
# Papers (real exam occurrence records)
# --------------------------------------------------------------------------
def paper_identity_fingerprint(*, subject: Subject, cycle_key: str, session_key: str, paper_code: str) -> str:
    raw = "|".join([str(subject.id), cycle_key.strip(), session_key.strip(), paper_code.strip()])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@transaction.atomic
def get_or_create_paper(
    *,
    subject: Subject,
    cycle_key: str,
    session_key: str = "",
    paper_code: str,
    source_kind: str = SourceKind.DEMO,
    title: str = "",
    actor=None,
) -> tuple[Paper, bool]:
    """Register a paper occurrence by its stable natural key.

    Uploading the same paper again must reuse the occurrence instead of
    inventing a second one, so the same file re-imported cannot double count.
    """
    if not cycle_key.strip() or not paper_code.strip():
        raise InvalidInput(message="年份/周期与卷别代码不能为空")
    if source_kind not in SourceKind.values:
        raise InvalidInput(message="试卷来源类型无效", details={"source_kind": source_kind})
    paper, created = Paper.objects.get_or_create(
        subject=subject,
        cycle_key=cycle_key.strip(),
        session_key=session_key.strip(),
        paper_code=paper_code.strip(),
        defaults={
            "source_kind": source_kind,
            "title": title[:300],
            "is_demo": source_kind in {SourceKind.DEMO, SourceKind.MOCK},
        },
    )
    if created and actor is not None:
        ContentRevision.objects.create(
            actor=actor,
            entity_type="paper",
            entity_id=str(paper.id),
            action="create",
            project_id=subject.project_id,
            detail={"cycle_key": paper.cycle_key, "paper_code": paper.paper_code, "source_kind": paper.source_kind},
        )
    return paper, created


@transaction.atomic
def create_paper_revision(paper: Paper, *, actor, **fields) -> PaperRevision:
    revision = next_version_number(PaperRevision.objects.filter(paper=paper), field="revision")
    revision_row = PaperRevision.objects.create(paper=paper, revision=revision, **fields)
    ContentRevision.objects.create(
        actor=actor,
        entity_type="paper_revision",
        entity_id=str(revision_row.id),
        action="create",
        project_id=paper.subject.project_id,
        detail={"revision": revision},
    )
    return revision_row


@transaction.atomic
def set_effective_revision(paper: Paper, revision: PaperRevision, *, actor) -> Paper:
    """One paper has exactly one statistically effective revision."""
    if revision.paper_id != paper.id:
        raise ScopeViolation(message="版本不属于该试卷")
    if revision.status == PaperRevisionStatus.WITHDRAWN:
        raise InvalidInput(message="已撤回版本不能设为有效版本")
    locked = Paper.objects.select_for_update().get(id=paper.id)
    previous = locked.effective_revision_id
    locked.effective_revision = revision
    locked.full_clean(exclude=["subject", "notes"])
    locked.save(update_fields=["effective_revision", "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="paper",
        entity_id=str(locked.id),
        action="set_effective_revision",
        project_id=paper.subject.project_id,
        detail={"from": str(previous) if previous else None, "to": str(revision.id)},
    )
    return locked


@transaction.atomic
def add_paper_item(
    revision: PaperRevision,
    *,
    actor,
    position_key: str,
    question_version,
    answer_key_version=None,
    max_score: Decimal,
    is_scored: bool = True,
    parent_item: PaperItem | None = None,
) -> PaperItem:
    """Add one scored leaf occurrence; duplicates in one revision are refused."""
    if revision.status == PaperRevisionStatus.WITHDRAWN:
        raise InvalidInput(message="已撤回试卷版本不能新增题项")
    if PaperItem.objects.filter(revision=revision, position_key=position_key).exists():
        raise InvalidInput(
            message="该试卷版本已存在相同题号，请确认是修订还是不同卷",
            details={"position_key": position_key},
        )
    if question_version.question.subject_id != revision.paper.subject_id:
        raise ScopeViolation(message="题目科目与试卷科目不一致")
    item = PaperItem(
        revision=revision,
        position_key=position_key.strip(),
        parent_item=parent_item,
        question_version=question_version,
        answer_key_version=answer_key_version,
        max_score=max_score,
        is_scored=is_scored,
        is_demo=revision.paper.is_demo,
    )
    item.full_clean()
    item.save()
    ContentRevision.objects.create(
        actor=actor,
        entity_type="paper_item",
        entity_id=str(item.id),
        action="create",
        project_id=revision.paper.subject.project_id,
        detail={"position_key": item.position_key, "max_score": str(max_score), "is_scored": is_scored},
    )
    enqueue(
        "projection.refresh_paper_stats",
        {"paper_id": str(revision.paper_id)},
        dedupe_key=f"paper-stats:{revision.paper_id}:{revision.id}",
    )
    return item


def coverage_note(revision: PaperRevision) -> str:
    status = revision.coverage_status
    if status == "coverage_unknown":
        return "coverage_unknown：未登记该周期预期场次/卷别，不能据单份试卷判断全年完整。"
    if status == "coverage_incomplete":
        if revision.coverage_confirmed_at is None:
            return "coverage_incomplete：场次已登记但尚未人工确认为完整周期，不能作为完整周期统计。"
        return "coverage_incomplete：已登记场次少于预期，不能作为完整周期统计。"
    return "coverage_complete：人工确认覆盖该周期全部已登记场次。"


def suggest_cycle_keys(today: date | None = None) -> list[str]:
    """Recent cycle labels for the manual registration form (no inference)."""
    anchor = today or timezone.now().date()
    return [str(anchor.year - offset) for offset in range(0, 5)] + [f"{anchor.year}春", f"{anchor.year}秋"]


def default_retention_window() -> timedelta:
    """Backup retention default (7 days) used by the ops commands."""
    return timedelta(days=7)


def type_rule_summary(spec: ExamSpecVersion) -> dict:
    """Human-readable summary of a spec's rules, for confirm-before-use UI."""
    summary = {}
    for question_type, rule in (spec.question_type_rules or {}).items():
        summary[question_type] = {
            "default_max_score": rule.get("default_max_score"),
            "wrong_score": rule.get("wrong_score", "0.00"),
            "blank_score": rule.get("blank_score", "0.00"),
            "policy": rule.get("policy", "exact_match"),
            "partial_score": rule.get("partial_score"),
            "mismatch_policy": rule.get("mismatch_policy", "review"),
        }
    return summary


def assert_version_current(instance, expected: int, field: str = "revision") -> None:
    """Optimistic locking helper; stale editors get 409 instead of overwriting."""
    actual = getattr(instance, field, None)
    if expected is None:
        raise VersionConflict(message="缺少版本号，请重新加载后再提交")
    if int(expected) != int(actual):
        raise VersionConflict(details={"expected": expected, "actual": actual})


@transaction.atomic
def record_paper_coverage(
    revision: PaperRevision,
    *,
    actor,
    expected_session_count: int | None = None,
    covered_session_count: int | None = None,
    confirm: bool = False,
    note: str = "",
) -> PaperRevision:
    """Record how much of one cycle a paper revision covers.

    Completeness is a human statement, never inferred from "a file was
    uploaded". ``confirm`` is what marks the coverage decision as made; the
    cycle analysis counts nothing else.
    """
    locked = PaperRevision.objects.select_for_update().select_related("paper").get(id=revision.id)
    if locked.status == PaperRevisionStatus.WITHDRAWN:
        raise InvalidInput(message="已撤回的试卷版本不能登记覆盖情况")
    if expected_session_count is not None:
        locked.expected_session_count = int(expected_session_count)
    if covered_session_count is not None:
        locked.covered_session_count = int(covered_session_count)
    if confirm:
        if locked.expected_session_count is None or locked.covered_session_count is None:
            raise InvalidInput(message="确认覆盖前必须填写“预期场次”和“已覆盖场次”")
        if locked.covered_session_count < locked.expected_session_count:
            raise InvalidInput(
                message="已覆盖场次少于预期场次，不能标记为完整周期",
                details={
                    "expected": locked.expected_session_count,
                    "covered": locked.covered_session_count,
                },
            )
        locked.coverage_confirmed_by = actor
        locked.coverage_confirmed_at = timezone.now()
    if note:
        locked.note = note[:500]
    locked.full_clean(exclude=["paper"])
    locked.save()
    ContentRevision.objects.create(
        actor=actor,
        entity_type="paper_revision",
        entity_id=str(locked.id),
        action="record_coverage",
        project_id=locked.paper.subject.project_id,
        detail={
            "expected_session_count": locked.expected_session_count,
            "covered_session_count": locked.covered_session_count,
            "coverage_status": locked.coverage_status,
            "confirmed": bool(locked.coverage_confirmed_at),
        },
    )
    return locked


@transaction.atomic
def confirm_paper_revision(revision: PaperRevision, *, actor) -> PaperRevision:
    """Human confirmation that this revision's items are proofread and usable."""
    locked = PaperRevision.objects.select_for_update().select_related("paper").get(id=revision.id)
    if locked.status == PaperRevisionStatus.WITHDRAWN:
        raise InvalidInput(message="已撤回的试卷版本不能确认")
    locked.status = PaperRevisionStatus.CONFIRMED
    locked.save(update_fields=["status", "updated_at"])
    ContentRevision.objects.create(
        actor=actor,
        entity_type="paper_revision",
        entity_id=str(locked.id),
        action="confirm",
        project_id=locked.paper.subject.project_id,
        detail={"revision": locked.revision},
    )
    if locked.paper.effective_revision_id is None:
        set_effective_revision(locked.paper, locked, actor=actor)
    return locked
