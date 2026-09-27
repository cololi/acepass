"""Scope and permission helpers.

Every query, file, task and cache lookup is bound to ``owner_id + project_id``.
Objects outside the requested scope raise :class:`ScopeViolation`, which the
error envelope maps to 404 so an outsider cannot probe for existence.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from django.db.models import Model, QuerySet

from apps.common.errors import PurposeNotAllowed, ScopeViolation


def require_project(user, project_id) -> object:
    """Fetch a project owned by ``user`` or raise a scope violation."""
    from apps.exams.models import ExamProject

    project = ExamProject.objects.filter(id=project_id, owner=user).first()
    if project is None:
        raise ScopeViolation(message="项目不存在或无权访问")
    return project


def require_subject(user, project, subject_id) -> object:
    from apps.exams.models import Subject

    subject = Subject.objects.filter(id=subject_id, project=project).first()
    if subject is None:
        raise ScopeViolation(message="科目不存在或不属于该项目")
    return subject


def scoped_queryset[M: Model](user, model: type[M], *, project=None, **filters) -> QuerySet[M]:
    """Base queryset for owner-scoped models.

    ``owner_field`` is ``owner`` for projects/assets, ``user`` for learning
    rows; both are supported so callers cannot forget the owner filter.
    """
    queryset = model.objects.all()
    owner_field = None
    for candidate in ("owner", "user"):
        if any(field.name == candidate for field in model._meta.get_fields()):
            owner_field = candidate
            break
    if owner_field is None:
        raise ScopeViolation(message="对象类型不支持按所有者过滤")
    queryset = queryset.filter(**{owner_field: user})
    if project is not None:
        queryset = queryset.filter(project=project)
    if filters:
        queryset = queryset.filter(**filters)
    return queryset


def assert_same_project(project, *objects) -> None:
    """Every related object must belong to ``project`` (or be None)."""
    for obj in objects:
        if obj is None:
            continue
        obj_project_id = getattr(obj, "project_id", None)
        if obj_project_id is None:
            continue
        if str(obj_project_id) != str(project.id):
            raise ScopeViolation(message="对象不属于当前项目")


def assert_subject_in_project(project, *objects) -> None:
    for obj in objects:
        if obj is None:
            continue
        subject = getattr(obj, "subject", None)
        if subject is None:
            continue
        if str(subject.project_id) != str(project.id):
            raise ScopeViolation(message="科目不属于当前项目")


def is_reviewer_of(user, attempt) -> bool:
    """A different, authorised internal reviewer — never the answerer.

    Being staff is not enough, and scoring your own attempt is always
    self-confirmation (docs/03 §4.3).
    """
    return bool(user.is_staff) and str(attempt.user_id) != str(user.id)


def require_practice_reveal(session) -> None:
    """Pre-submit answer access is practice-only."""
    if not session.allows_pre_submit_answers:
        raise PurposeNotAllowed(message="当前会话模式在提交前不返回答案或评分信息")


def require_reveal_after_finish(session) -> None:
    if session.hides_grading:
        raise PurposeNotAllowed(message="验证/考试尚未结束，不能返回答案或评分信息")


def ensure_unique(ids: Sequence[str] | Iterable[str], message: str) -> None:
    values = [str(value) for value in ids]
    if len(values) != len(set(values)):
        raise ScopeViolation(message=message)
