"""Exams API: projects, subjects, versioned exam specs, syllabus and papers."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from ninja import Router, Schema

from apps.audit.services import idempotency
from apps.common.api import auth, idempotency_key, project_scoped_router
from apps.common.enums import PaperRevisionStatus
from apps.common.errors import InvalidInput, ScopeViolation
from apps.common.scope import require_project, require_subject
from apps.exams import services
from apps.exams.models import ExamProject, ExamSpecVersion, Paper, PaperRevision, Subject, SyllabusVersion

projects_router = Router(tags=["projects"])
project_router = project_scoped_router(tags=["exams"])


# --------------------------------------------------------------------------
# Schemas
# --------------------------------------------------------------------------
class ProjectIn(Schema):
    name: str
    description: str = ""
    target_date: date | None = None
    target_score: Decimal | None = None


class ProjectPatch(Schema):
    name: str | None = None
    description: str | None = None
    target_date: date | None = None
    target_score: Decimal | None = None
    display_order: int | None = None


class ProjectOut(Schema):
    id: str
    name: str
    description: str
    target_date: date | None
    target_score: Decimal | None
    is_archived: bool
    display_order: int
    subject_count: int
    question_count: int
    created_at: str


class ArchiveIn(Schema):
    reason: str = ""


class SubjectIn(Schema):
    name: str
    code: str = ""
    total_score: Decimal | None = None
    pass_score: Decimal | None = None


class SubjectOut(Schema):
    id: str
    project_id: str
    name: str
    code: str
    display_order: int
    total_score: Decimal | None
    pass_score: Decimal | None


class SpecIn(Schema):
    subject_id: str
    name: str = ""
    total_score: Decimal | None = None
    pass_score: Decimal | None = None
    question_type_rules: dict[str, Any] = {}
    time_rules: dict[str, Any] = {}
    score_floor_at_zero: bool = False
    rule_source_note: str = ""
    is_demo: bool = True


class SpecOut(Schema):
    id: str
    subject_id: str
    version: int
    name: str
    total_score: Decimal | None
    pass_score: Decimal | None
    question_type_rules: dict[str, Any]
    time_rules: dict[str, Any]
    score_floor_at_zero: bool
    rule_source_note: str
    is_demo: bool
    status: str
    published_at: str | None
    is_usable: bool


class SyllabusIn(Schema):
    subject_id: str
    name: str
    version_label: str = ""
    applies_from: date | None = None
    applies_to: date | None = None
    is_user_provisional: bool = True


class SyllabusOut(Schema):
    id: str
    subject_id: str
    name: str
    version_label: str
    applies_from: date | None
    applies_to: date | None
    is_user_provisional: bool
    review_status: str
    status: str
    published_at: str | None
    node_count: int


class PaperIn(Schema):
    subject_id: str
    cycle_key: str
    session_key: str = ""
    paper_code: str
    source_kind: str = "demo"
    title: str = ""


class PaperRevisionOut(Schema):
    id: str
    revision: int
    status: str
    coverage_status: str
    expected_session_count: int | None
    covered_session_count: int | None
    item_count: int
    scored_item_count: int
    note: str
    coverage_confirmed_by: str | None = None
    coverage_confirmed_at: str | None = None


class PaperOut(Schema):
    id: str
    subject_id: str
    cycle_key: str
    session_key: str
    paper_code: str
    source_kind: str
    title: str
    is_demo: bool
    effective_revision_id: str | None
    revisions: list[PaperRevisionOut]
    coverage_note: str


class CoverageIn(Schema):
    expected_session_count: int | None = None
    covered_session_count: int | None = None
    note: str = ""
    #: Explicit confirmation that this revision covers the whole cycle.
    confirm: bool = False


class PaperItemOut(Schema):
    id: str
    position_key: str
    parent_item_id: str | None
    question_id: str
    question_version_id: str
    answer_key_version_id: str | None
    max_score: Decimal
    is_scored: bool


# --------------------------------------------------------------------------
# Serializers
# --------------------------------------------------------------------------
def _project_out(project: ExamProject) -> dict:
    return {
        "id": str(project.id),
        "name": project.name,
        "description": project.description,
        "target_date": project.target_date,
        "target_score": project.target_score,
        "is_archived": project.is_archived,
        "display_order": project.display_order,
        "subject_count": project.subjects.count(),
        "question_count": sum(subject.questions.count() for subject in project.subjects.all()),
        "created_at": project.created_at.isoformat(),
    }


def _subject_out(subject: Subject) -> dict:
    return {
        "id": str(subject.id),
        "project_id": str(subject.project_id),
        "name": subject.name,
        "code": subject.code,
        "display_order": subject.display_order,
        "total_score": subject.total_score,
        "pass_score": subject.pass_score,
    }


def _spec_out(spec: ExamSpecVersion) -> dict:
    from apps.exams.services.core import type_rule_summary

    return {
        "id": str(spec.id),
        "subject_id": str(spec.subject_id),
        "version": spec.version,
        "name": spec.name,
        "total_score": spec.total_score,
        "pass_score": spec.pass_score,
        "question_type_rules": spec.question_type_rules,
        "time_rules": spec.time_rules,
        "score_floor_at_zero": spec.score_floor_at_zero,
        "rule_source_note": spec.rule_source_note,
        "is_demo": spec.is_demo,
        "status": spec.status,
        "published_at": spec.published_at.isoformat() if spec.published_at else None,
        "is_usable": spec.status == "published",
        "rule_summary": type_rule_summary(spec),
    }


def _syllabus_out(syllabus: SyllabusVersion) -> dict:
    return {
        "id": str(syllabus.id),
        "subject_id": str(syllabus.subject_id),
        "name": syllabus.name,
        "version_label": syllabus.version_label,
        "applies_from": syllabus.applies_from,
        "applies_to": syllabus.applies_to,
        "is_user_provisional": syllabus.is_user_provisional,
        "review_status": syllabus.review_status,
        "status": syllabus.status,
        "published_at": syllabus.published_at.isoformat() if syllabus.published_at else None,
        "node_count": syllabus.knowledge_nodes.count(),
    }


def _revision_out(revision: PaperRevision) -> dict:
    items = list(revision.items.all())
    return {
        "id": str(revision.id),
        "revision": revision.revision,
        "status": revision.status,
        "coverage_status": revision.coverage_status,
        "expected_session_count": revision.expected_session_count,
        "covered_session_count": revision.covered_session_count,
        "item_count": len(items),
        "scored_item_count": sum(1 for item in items if item.is_scored),
        "note": revision.note,
        "coverage_confirmed_by": (
            str(revision.coverage_confirmed_by_id) if revision.coverage_confirmed_by_id else None
        ),
        "coverage_confirmed_at": (
            revision.coverage_confirmed_at.isoformat() if revision.coverage_confirmed_at else None
        ),
    }


def _paper_out(paper: Paper) -> dict:
    revisions = [_revision_out(revision) for revision in paper.revisions.all().order_by("-revision")]
    return {
        "id": str(paper.id),
        "subject_id": str(paper.subject_id),
        "cycle_key": paper.cycle_key,
        "session_key": paper.session_key,
        "paper_code": paper.paper_code,
        "source_kind": paper.source_kind,
        "title": paper.title,
        "is_demo": paper.is_demo,
        "effective_revision_id": str(paper.effective_revision_id) if paper.effective_revision_id else None,
        "revisions": revisions,
        "coverage_note": services.coverage_note(paper.revisions.first()) if paper.revisions.exists() else "尚无版本",
    }


def _paper_item_out(item) -> dict:
    return {
        "id": str(item.id),
        "position_key": item.position_key,
        "parent_item_id": str(item.parent_item_id) if item.parent_item_id else None,
        "question_id": str(item.question_version.question_id),
        "question_version_id": str(item.question_version_id),
        "answer_key_version_id": str(item.answer_key_version_id) if item.answer_key_version_id else None,
        "max_score": item.max_score,
        "is_scored": item.is_scored,
    }


# --------------------------------------------------------------------------
# Routes: /projects
# --------------------------------------------------------------------------
@projects_router.get("/projects", auth=auth, response=list[ProjectOut])
def list_projects(request, include_archived: bool = False):
    queryset = ExamProject.objects.filter(owner=request.user)
    if not include_archived:
        queryset = queryset.filter(is_archived=False)
    return [_project_out(project) for project in queryset.prefetch_related("subjects")]


@projects_router.post("/projects", auth=auth, response={201: ProjectOut})
def create_project(request, payload: ProjectIn):
    key = idempotency_key(request)
    scope = "projects.create"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    project = services.create_project(
        request.user,
        name=payload.name,
        description=payload.description,
        target_date=payload.target_date,
        target_score=payload.target_score,
    )
    result = _project_out(project)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="project", resource_id=project.id
    )
    return 201, result


@projects_router.get("/projects/{project_id}", auth=auth, response=ProjectOut)
def get_project(request, project_id: str):
    return _project_out(require_project(request.user, project_id))


@projects_router.patch("/projects/{project_id}", auth=auth, response=ProjectOut)
def patch_project(request, project_id: str, payload: ProjectPatch):
    project = require_project(request.user, project_id)
    project = services.update_project(project, **payload.model_dump(exclude_unset=True))
    return _project_out(project)


@projects_router.post("/projects/{project_id}/archive", auth=auth, response=ProjectOut)
def archive_project(request, project_id: str, payload: ArchiveIn):
    key = idempotency_key(request)
    scope = f"projects.archive:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    project = services.archive_project(require_project(request.user, project_id), reason=payload.reason)
    result = _project_out(project)
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="project", resource_id=project.id
    )
    return result


@projects_router.post("/projects/{project_id}/unarchive", auth=auth, response=ProjectOut)
def unarchive_project(request, project_id: str):
    key = idempotency_key(request)
    scope = f"projects.unarchive:{project_id}"
    replay = idempotency.claim(request.user, scope, key, {})
    if replay is not None:
        return replay.status_code, replay.body
    project = services.unarchive_project(require_project(request.user, project_id))
    result = _project_out(project)
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="project", resource_id=project.id
    )
    return result


# --------------------------------------------------------------------------
# Routes: /projects/{project_id}/...
# --------------------------------------------------------------------------
@project_router.get("/projects/{project_id}/subjects", auth=auth, response=list[SubjectOut])
def list_subjects(request, project_id: str):
    project = require_project(request.user, project_id)
    return [_subject_out(subject) for subject in project.subjects.all()]


@project_router.post("/projects/{project_id}/subjects", auth=auth, response={201: SubjectOut})
def create_subject(request, project_id: str, payload: SubjectIn):
    project = require_project(request.user, project_id)
    if project.is_archived:
        raise InvalidInput(message="已归档项目不能新增科目")
    key = idempotency_key(request)
    scope = f"subjects.create:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    subject = services.create_subject(
        project,
        name=payload.name,
        code=payload.code,
        total_score=payload.total_score,
        pass_score=payload.pass_score,
    )
    result = _subject_out(subject)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="subject", resource_id=subject.id
    )
    return 201, result


@project_router.get("/projects/{project_id}/exam-spec-versions", auth=auth, response=list[SpecOut])
def list_spec_versions(request, project_id: str, subject_id: str | None = None):
    project = require_project(request.user, project_id)
    queryset = ExamSpecVersion.objects.filter(subject__project=project)
    if subject_id:
        require_subject(request.user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    return [_spec_out(spec) for spec in queryset.select_related("subject")]


@project_router.post("/projects/{project_id}/exam-spec-versions", auth=auth, response={201: SpecOut})
def create_spec_version(request, project_id: str, payload: SpecIn):
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, payload.subject_id)
    key = idempotency_key(request)
    scope = f"specs.create:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    spec = services.create_exam_spec_version(
        subject,
        created_by=request.user,
        name=payload.name,
        total_score=payload.total_score,
        pass_score=payload.pass_score,
        question_type_rules=payload.question_type_rules,
        time_rules=payload.time_rules,
        score_floor_at_zero=payload.score_floor_at_zero,
        rule_source_note=payload.rule_source_note,
        is_demo=payload.is_demo,
    )
    result = _spec_out(spec)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="exam_spec", resource_id=spec.id
    )
    return 201, result


@project_router.post("/projects/{project_id}/exam-spec-versions/{spec_id}/publish", auth=auth, response=SpecOut)
def publish_spec_version(request, project_id: str, spec_id: str):
    project = require_project(request.user, project_id)
    spec = ExamSpecVersion.objects.filter(id=spec_id, subject__project=project).first()
    if spec is None:
        raise ScopeViolation(message="规范版本不存在或不属于该项目")
    key = idempotency_key(request)
    scope = f"specs.publish:{spec_id}"
    replay = idempotency.claim(request.user, scope, key, {})
    if replay is not None:
        return replay.status_code, replay.body
    spec = services.publish_exam_spec_version(spec, actor=request.user)
    result = _spec_out(spec)
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="exam_spec", resource_id=spec.id
    )
    return result


@project_router.get("/projects/{project_id}/syllabus-versions", auth=auth, response=list[SyllabusOut])
def list_syllabus_versions(request, project_id: str, subject_id: str | None = None):
    project = require_project(request.user, project_id)
    queryset = SyllabusVersion.objects.filter(subject__project=project)
    if subject_id:
        require_subject(request.user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    return [_syllabus_out(syllabus) for syllabus in queryset.select_related("subject")]


@project_router.post("/projects/{project_id}/syllabus-versions", auth=auth, response={201: SyllabusOut})
def create_syllabus_version(request, project_id: str, payload: SyllabusIn):
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, payload.subject_id)
    key = idempotency_key(request)
    scope = f"syllabus.create:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    syllabus = services.create_syllabus_version(
        subject,
        created_by=request.user,
        name=payload.name,
        version_label=payload.version_label,
        applies_from=payload.applies_from,
        applies_to=payload.applies_to,
        is_user_provisional=payload.is_user_provisional,
    )
    result = _syllabus_out(syllabus)
    idempotency.record_result(
        request.user, scope, key, status_code=201, response_body=result, resource_type="syllabus", resource_id=syllabus.id
    )
    return 201, result


@project_router.post("/projects/{project_id}/syllabus-versions/{syllabus_id}/publish", auth=auth, response=SyllabusOut)
def publish_syllabus_version(request, project_id: str, syllabus_id: str):
    project = require_project(request.user, project_id)
    syllabus = SyllabusVersion.objects.filter(id=syllabus_id, subject__project=project).first()
    if syllabus is None:
        raise ScopeViolation(message="大纲版本不存在或不属于该项目")
    key = idempotency_key(request)
    scope = f"syllabus.publish:{syllabus_id}"
    replay = idempotency.claim(request.user, scope, key, {})
    if replay is not None:
        return replay.status_code, replay.body
    syllabus = services.publish_syllabus_version(syllabus, actor=request.user)
    result = _syllabus_out(syllabus)
    idempotency.record_result(
        request.user, scope, key, status_code=200, response_body=result, resource_type="syllabus", resource_id=syllabus.id
    )
    return result


@project_router.get("/projects/{project_id}/papers", auth=auth, response=list[PaperOut])
def list_papers(request, project_id: str, subject_id: str | None = None):
    project = require_project(request.user, project_id)
    queryset = Paper.objects.filter(subject__project=project).select_related("subject").prefetch_related("revisions")
    if subject_id:
        require_subject(request.user, project, subject_id)
        queryset = queryset.filter(subject_id=subject_id)
    return [_paper_out(paper) for paper in queryset]


@project_router.post("/projects/{project_id}/papers", auth=auth, response={201: PaperOut, 200: PaperOut})
def register_paper(request, project_id: str, payload: PaperIn):
    """Register a real paper occurrence; a repeated upload reuses the record."""
    project = require_project(request.user, project_id)
    subject = require_subject(request.user, project, payload.subject_id)
    key = idempotency_key(request)
    scope = f"papers.register:{project_id}"
    body = payload.model_dump(mode="json")
    replay = idempotency.claim(request.user, scope, key, body)
    if replay is not None:
        return replay.status_code, replay.body
    paper, created = services.get_or_create_paper(
        subject=subject,
        cycle_key=payload.cycle_key,
        session_key=payload.session_key,
        paper_code=payload.paper_code,
        source_kind=payload.source_kind,
        title=payload.title,
        actor=request.user,
    )
    result = _paper_out(paper)
    status_code = 201 if created else 200
    idempotency.record_result(
        request.user, scope, key, status_code=status_code, response_body=result, resource_type="paper", resource_id=paper.id
    )
    return status_code, result


@project_router.get("/projects/{project_id}/papers/{paper_id}", auth=auth, response=PaperOut)
def get_paper(request, project_id: str, paper_id: str):
    project = require_project(request.user, project_id)
    paper = Paper.objects.filter(id=paper_id, subject__project=project).select_related("subject").first()
    if paper is None:
        raise ScopeViolation(message="试卷不存在或不属于该项目")
    return _paper_out(paper)


@project_router.get("/projects/{project_id}/paper-revisions/{revision_id}/items", auth=auth, response=list[PaperItemOut])
def list_paper_items(request, project_id: str, revision_id: str):
    project = require_project(request.user, project_id)
    revision = PaperRevision.objects.filter(id=revision_id, paper__subject__project=project).first()
    if revision is None:
        raise ScopeViolation(message="试卷版本不存在或不属于该项目")
    return [_paper_item_out(item) for item in revision.items.select_related("question_version")]


@project_router.post("/projects/{project_id}/paper-revisions/{revision_id}/coverage", auth=auth,
                     response=PaperRevisionOut)
def confirm_paper_coverage(request, project_id: str, revision_id: str, payload: CoverageIn):
    """Record (or explicitly confirm) how much of one cycle a revision covers.

    A single uploaded paper never proves a full cycle, so completeness is a
    separate, human statement: the expected and covered session counts are
    recorded here, and ``confirm`` is what marks the revision complete. The
    cycle analysis refuses to count anything else.
    """
    project = require_project(request.user, project_id)
    revision = (
        PaperRevision.objects.filter(id=revision_id, paper__subject__project=project)
        .select_related("paper")
        .first()
    )
    if revision is None:
        raise ScopeViolation(message="试卷版本不存在或不属于该项目")
    if revision.status == PaperRevisionStatus.WITHDRAWN:
        raise InvalidInput(message="已撤回的试卷版本不能登记覆盖情况")
    if payload.expected_session_count is not None and payload.expected_session_count < 1:
        raise InvalidInput(message="预期场次必须是正整数")
    if payload.covered_session_count is not None and payload.covered_session_count < 0:
        raise InvalidInput(message="已覆盖场次不能为负")
    updated = services.record_paper_coverage(
        revision,
        actor=request.user,
        expected_session_count=payload.expected_session_count,
        covered_session_count=payload.covered_session_count,
        confirm=payload.confirm,
        note=payload.note,
    )
    return _revision_out(updated)


@project_router.post("/projects/{project_id}/paper-revisions/{revision_id}/confirm", auth=auth,
                     response=PaperRevisionOut)
def confirm_paper_revision(request, project_id: str, revision_id: str):
    """Mark a revision as human-confirmed (and therefore usable by statistics)."""
    project = require_project(request.user, project_id)
    revision = (
        PaperRevision.objects.filter(id=revision_id, paper__subject__project=project)
        .select_related("paper")
        .first()
    )
    if revision is None:
        raise ScopeViolation(message="试卷版本不存在或不属于该项目")
    if not revision.items.filter(is_scored=True).exists():
        raise InvalidInput(message="该版本还没有任何计分题项，确认前请先完成导入与校对")
    updated = services.confirm_paper_revision(revision, actor=request.user)
    return _revision_out(updated)


@project_router.post("/projects/{project_id}/papers/{paper_id}/effective-revision", auth=auth, response=PaperOut)
def set_effective_revision(request, project_id: str, paper_id: str, revision_id: str):
    """Choose the one revision that counts statistically for this paper."""
    project = require_project(request.user, project_id)
    paper = Paper.objects.filter(id=paper_id, subject__project=project).select_related("subject").first()
    if paper is None:
        raise ScopeViolation(message="试卷不存在或不属于该项目")
    revision = PaperRevision.objects.filter(id=revision_id, paper=paper).first()
    if revision is None:
        raise ScopeViolation(message="试卷版本不存在或不属于该试卷")
    services.set_effective_revision(paper, revision, actor=request.user)
    paper.refresh_from_db()
    return _paper_out(paper)
