"""AI-generated variants that only a validated pipeline plus a human can publish (C02).

Acceptance rule (docs/05 §3, C02): *生成题条件完整、答案可验证，单选唯一；失败留候选；
不进入 official_past 统计*. The product rules behind it are implemented here, in
one place, so no caller can shortcut them:

* **a model never publishes content.** :func:`propose_variants` only ever writes
  an :class:`~apps.ingestion.models.ImportJob` plus one
  :class:`~apps.ingestion.models.ImportCandidate` per proposal. Publication stays
  the ordinary human gate (``…/import-candidates/{id}/publish``); this module
  deliberately contains no publish path.
* **deterministic validation before a variant can be used.** Every payload goes
  through :func:`ai.prompts.registry.validate_variant_payload` (structure + answer
  contract, never re-implemented) *and* through :func:`independent_checks`
  (answer self-consistency, duplicate identity, syllabus ownership, and an
  explicit probe of the "AI content never joins a real paper" rule).
* **失败留候选.** A proposal that fails any check is still stored, with every
  problem attached, as a candidate in ``draft``/``ready`` (i.e. awaiting human
  review) — never dropped and never auto-published. The same problems are
  recomputed inside the single publish gate, so editing an unrelated field cannot
  clear them (see :func:`variant_review_issues`).
* **不进 official_past 统计.** The proposal always carries
  ``origin_type=ai_generated`` (published versions become ``is_demo=True``, which
  the cycle analysis excludes), it is never linked to a paper revision, and the
  existing ``PaperItem`` rule ("AI 生成题不得挂到真实考试发生记录") is asserted
  rather than assumed.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from ai.prompts import registry as prompts
from ai.providers import base as providers
from apps.audit.models import LLMRun
from apps.common.answers import sum_blank_scores, validate_answer_payload
from apps.common.content import blank_ids, content_digest, option_ids
from apps.common.enums import (
    SCORABLE_LEAF_TYPES,
    AnswerSourceType,
    ImportCandidateStatus,
    ImportJobStatus,
    LlmRunStatus,
    OriginType,
    QuestionType,
    QuestionVersionStatus,
    SourceKind,
    VerificationStatus,
)
from apps.common.errors import InvalidInput, ScopeViolation
from apps.exams.models import Paper, PaperItem, PaperRevision
from apps.ingestion.models import ImportCandidate, ImportJob
from apps.ingestion.services import core as ingestion_services
from apps.knowledge.models import KnowledgeNode
from apps.question_bank.models import Question, QuestionVersion

#: ``ImportJob.input_kind`` of a variant proposal batch. It is the marker the
#: publish gate uses to decide that the variant contract has to be re-checked.
AI_VARIANT_INPUT_KIND = "ai_variant"
#: Hard cap on one request. A batch bigger than this is not a reviewable unit.
MAX_VARIANTS_PER_REQUEST = 3
BLOCKING = "blocking"
WARNING = "warning"


def _problem(code: str, message: str, path: str = "", severity: str = BLOCKING, **extra: Any) -> dict:
    return {"code": code, "message": message, "path": path, "severity": severity, **extra}


def _blocks_text(blocks: Any) -> str:
    """Plain text of a block list (text and math only). Never touches answers."""
    parts: list[str] = []
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        if block.get("kind") == "text":
            parts.append(str(block.get("text", "")))
        elif block.get("kind") == "math":
            parts.append(f"${block.get('latex', '')}$")
    return " ".join(part for part in parts if part)


def _normalized_text(value: Any) -> str:
    import re

    return re.sub(r"[\s\W_]+", "", str(value or "")).lower()


def version_texts(version: QuestionVersion) -> tuple[str, list[str], str]:
    """Stem, option texts and material text of a source version — never answers."""
    content = version.content or {}
    stem = _blocks_text(content.get("blocks"))
    options = [_blocks_text(option.get("blocks")) for option in (content.get("options") or []) if isinstance(option, dict)]
    material = ""
    if version.parent_material_version_id:
        parent = QuestionVersion.objects.filter(id=version.parent_material_version_id).first()
        if parent is not None:
            material = _blocks_text((parent.content or {}).get("blocks"))
    elif version.question_type == QuestionType.MATERIAL:
        material = stem
    return stem, [text for text in options if text], material


def checked_answer(version: QuestionVersion):
    """The answer used as *context* for the model, preferring a checked one."""
    answers = list(version.answer_keys.filter(is_disputed=False).order_by("-version"))
    for answer in answers:
        if answer.is_usable:
            return answer
    return answers[0] if answers else None


def answer_context(version: QuestionVersion) -> tuple[str, list[dict]]:
    """``(answer_summary, rubric_criteria)`` for the prompt.

    The summary is context only: it tells the model which point is being examined
    and is never copied into the variant by the pipeline. An unchecked answer is
    labelled as such instead of being presented as a standard answer.
    """
    answer = checked_answer(version)
    if answer is None:
        return "（原题没有答案版本：只能依据题干条件生成）", []
    payload = answer.answer_payload or {}
    question_type = version.question_type
    if question_type == QuestionType.SINGLE_CHOICE:
        summary = f"正确选项 ID：{payload.get('correct_option_id')}"
    elif question_type == QuestionType.MULTIPLE_CHOICE:
        summary = f"正确选项 ID：{', '.join(str(value) for value in payload.get('correct_option_ids') or [])}"
    elif question_type == QuestionType.TRUE_FALSE:
        summary = f"正确值：{payload.get('value')}"
    elif question_type == QuestionType.FILL_BLANK:
        rows = []
        for blank_id, spec in (payload.get("blanks") or {}).items():
            if not isinstance(spec, dict):
                continue
            accepted = [str(value) for value in (spec.get("accepted_values") or [])]
            rows.append(f"{blank_id}={accepted or spec.get('numeric')}")
        summary = "各空答案：" + "；".join(rows)
    elif question_type == QuestionType.CONSTRUCTED_RESPONSE:
        summary = "按评分点给分（见下方评分标准），不提供可直接抄写的答案"
    else:  # pragma: no cover - materials are refused before this point
        summary = ""
    if not answer.is_usable:
        summary += "（该答案尚未人工核对：仅供参考，不得当作标准答案）"
    rubric = [
        {
            "criterion_id": str(criterion.get("criterion_id")),
            "text": str(criterion.get("text") or ""),
            "max_score": str(criterion.get("max_score")),
        }
        for criterion in (getattr(answer, "rubric", None).criteria if getattr(answer, "rubric", None) else []) or []
        if isinstance(criterion, dict)
    ]
    return summary, rubric


# --------------------------------------------------------------------------
# Independent checks
# --------------------------------------------------------------------------
def _answer_consistency_problems(
    *,
    content: dict,
    answer_payload: dict,
    question_type: str,
    rubric_criteria: Any,
    stated_rubric_total: Any,
) -> list[dict]:
    """The answer must be checkable against the variant's own content.

    The shared answer contract (``apps.common.answers``) is reused — it is the
    same validator the publish gate runs — and the two facts it cannot know are
    added: every fill-blank answer needs a real accepted value, and a constructed
    response's rubric must sum to the total the proposal states.
    """
    problems: list[dict] = []
    if question_type == QuestionType.MATERIAL:
        return [_problem("variant_type_not_scorable", "共享材料不能作为变式（material 不产生可判定答案）", "type")]
    for problem in validate_answer_payload(answer_payload, question_type, content):
        problems.append(
            {
                **problem,
                "code": f"answer.{problem.get('code', 'invalid')}",
                "severity": BLOCKING,
            }
        )
    if question_type in {QuestionType.SINGLE_CHOICE, QuestionType.MULTIPLE_CHOICE}:
        existing = set(option_ids(content))
        if question_type == QuestionType.SINGLE_CHOICE:
            correct = answer_payload.get("correct_option_id")
            if isinstance(correct, str) and correct and existing and correct not in existing:
                problems.append(
                    _problem(
                        "answer.correct_option_not_in_options",
                        f"正确选项 {correct} 不在变式选项中",
                        "answer_payload.correct_option_id",
                    )
                )
        else:
            for option_id in answer_payload.get("correct_option_ids") or []:
                if existing and str(option_id) not in existing:
                    problems.append(
                        _problem(
                            "answer.correct_option_not_in_options",
                            f"正确选项 {option_id} 不在变式选项中",
                            "answer_payload.correct_option_ids",
                        )
                    )
    if question_type == QuestionType.FILL_BLANK:
        defined = set(blank_ids(content))
        answers = answer_payload.get("blanks") if isinstance(answer_payload.get("blanks"), dict) else {}
        for blank_id, spec in answers.items():
            if not isinstance(spec, dict):
                continue
            accepted = [value for value in (spec.get("accepted_values") or []) if isinstance(value, str) and value.strip()]
            if not accepted:
                problems.append(
                    _problem(
                        "answer.blank_accepted_values_missing",
                        f"空位 {blank_id} 没有可接受答案，无法判定对错",
                        f"answer_payload.blanks.{blank_id}",
                    )
                )
        for blank_id in defined - {str(key) for key in answers}:
            problems.append(
                _problem("answer.blank_answer_missing", f"空位 {blank_id} 没有答案", "answer_payload.blanks")
            )
    if question_type == QuestionType.CONSTRUCTED_RESPONSE:
        criteria = rubric_criteria if isinstance(rubric_criteria, list) else []
        total = Decimal("0")
        computed = True
        for criterion in criteria:
            if not isinstance(criterion, dict):
                computed = False
                continue
            try:
                total += Decimal(str(criterion.get("max_score")))
            except (InvalidOperation, TypeError, ValueError):
                computed = False
        if stated_rubric_total in (None, ""):
            problems.append(
                _problem("answer.rubric_total_missing", "大题没有给出 rubric 总分，无法核对", "rubric_total_score")
            )
        elif computed:
            try:
                stated = Decimal(str(stated_rubric_total))
            except (InvalidOperation, TypeError, ValueError):
                stated = None
            if stated is None:
                problems.append(
                    _problem("answer.rubric_total_invalid", "rubric 总分不是十进制数", "rubric_total_score")
                )
            elif stated != total:
                problems.append(
                    _problem(
                        "answer.rubric_total_mismatch",
                        f"评分点合计 {total} 与声明的总分 {stated} 不一致：无法按点判分",
                        "rubric_total_score",
                    )
                )
    return problems


def _duplicate_problems(
    *,
    project,
    subject,
    source_question: Question,
    digest: str,
    content: dict,
    exclude_candidate_id: str | None,
) -> list[dict]:
    """A variant must not repeat published content or another pending proposal."""
    problems: list[dict] = []
    published = (
        QuestionVersion.objects.filter(
            question__subject=subject,
            status=QuestionVersionStatus.PUBLISHED,
            content_digest=digest,
        )
        .select_related("question")
        .order_by("created_at")
        .first()
    )
    if published is not None:
        problems.append(
            _problem(
                "duplicate_published_question",
                "变式内容与已发布题目版本完全相同：不能再次作为新变式发布",
                "content",
                question_id=str(published.question_id),
                question_version_id=str(published.id),
                display_label=published.question.display_label,
            )
        )
    if source_question.family_id:
        family_hit = (
            QuestionVersion.objects.filter(
                question__family_id=source_question.family_id,
                question__subject=subject,
                status=QuestionVersionStatus.PUBLISHED,
                content_digest=digest,
            )
            .exclude(question_id=source_question.id)
            .select_related("question")
            .first()
        )
        if family_hit is not None:
            problems.append(
                _problem(
                    "duplicate_family_question",
                    "同一题目家族中已存在完全相同内容的已发布题目，不能重复生成",
                    "content",
                    question_id=str(family_hit.question_id),
                    family_id=str(source_question.family_id),
                )
            )
    # Other pending proposals: a batch (or a human) must not create the same
    # variant twice. The scan is bounded because proposals are reviewed in small
    # batches; anything older has already been decided by a human.
    queryset = (
        ImportCandidate.objects.filter(project=project, subject=subject)
        .exclude(status=ImportCandidateStatus.IGNORED)
        .order_by("-created_at")
    )
    if exclude_candidate_id:
        queryset = queryset.exclude(id=exclude_candidate_id)
    for candidate in queryset[:200]:
        other = (candidate.draft_payload or {}).get("content")
        if not isinstance(other, dict):
            continue
        try:
            other_digest = content_digest(other)
        except (TypeError, ValueError):  # pragma: no cover - defensive
            continue
        if other_digest == digest and _normalized_text(_blocks_text(other.get("blocks"))) == _normalized_text(
            _blocks_text(content.get("blocks"))
        ):
            problems.append(
                _problem(
                    "duplicate_pending_proposal",
                    "同一批候选中已存在完全相同的变式：重复提案不会产生第二道题",
                    "content",
                    candidate_id=str(candidate.id),
                )
            )
            break
    return problems


def official_past_rule_problems(*, subject) -> list[dict]:
    """Assert the existing rule instead of relying on it silently.

    ``PaperItem.clean()`` is the single place that refuses an ``ai_generated``
    question on an ``official_past`` paper, and ``add_paper_item`` is the only
    writer. The probe below runs that very rule against an in-memory pair, so if
    the rule were ever removed the variant pipeline would fail loudly instead of
    quietly producing content that could be counted as a real past occurrence.
    """
    probe_item = PaperItem(
        revision=PaperRevision(
            paper=Paper(
                subject=subject,
                cycle_key="__variant_origin_probe__",
                session_key="__variant_origin_probe__",
                paper_code="__variant_origin_probe__",
                source_kind=SourceKind.OFFICIAL_PAST,
                title="",
            ),
            revision=1,
        ),
        position_key="__variant_origin_probe__",
        question_version=QuestionVersion(
            question=Question(subject=subject, origin_type=OriginType.AI_GENERATED),
            question_type=QuestionType.SINGLE_CHOICE,
            content={"blocks": []},
        ),
        max_score=Decimal("0"),
    )
    try:
        probe_item.clean()
    except ValidationError:
        return []
    return [
        _problem(
            "official_past_rule_missing",
            "服务端未拒绝“AI 生成题挂到真实考试发生记录”：在规则恢复前不生成变式，避免生成内容进入真题统计",
            "origin_type",
        )
    ]


def independent_checks(
    *,
    payload: dict,
    source_version: QuestionVersion,
    node: KnowledgeNode | None,
    project=None,
    exclude_candidate_id: str | None = None,
) -> dict:
    """Deterministic checks that do not trust the prompt or the model.

    Returns ``{"problems": [...], "content_digest": str, "origin_type": str}``.
    The digest is computed from the normalized content, so it is the same value a
    later duplicate check (or a published ``QuestionVersion.content_digest``)
    would produce.
    """
    subject = source_version.question.subject
    question_type = source_version.question_type
    content = payload.get("content") if isinstance(payload.get("content"), dict) else {}
    answer_payload = payload.get("answer_payload") if isinstance(payload.get("answer_payload"), dict) else {}
    digest = content_digest(content)
    problems: list[dict] = []

    problems.extend(
        _answer_consistency_problems(
            content=content,
            answer_payload=answer_payload,
            question_type=question_type,
            rubric_criteria=payload.get("rubric_criteria"),
            stated_rubric_total=payload.get("rubric_total_score"),
        )
    )
    problems.extend(
        _duplicate_problems(
            project=project or subject.project,
            subject=subject,
            source_question=source_version.question,
            digest=digest,
            content=content,
            exclude_candidate_id=exclude_candidate_id,
        )
    )
    if node is not None:
        node_subject_id = getattr(getattr(node, "syllabus_version", None), "subject_id", None)
        if str(node_subject_id) != str(subject.id):
            problems.append(
                _problem(
                    "node_subject_mismatch",
                    "目标考点不属于该题目的科目大纲：变式不能挂到别的科目的考点上",
                    "node_id",
                    node_id=str(node.id),
                )
            )
        elif getattr(node.syllabus_version, "status", "") != QuestionVersionStatus.PUBLISHED:
            problems.append(
                _problem(
                    "node_syllabus_not_published",
                    "目标考点所在大纲尚未发布：发布变式前需要先发布大纲",
                    "node_id",
                    severity=WARNING,
                    node_id=str(node.id),
                )
            )
    problems.extend(official_past_rule_problems(subject=subject))
    stem, _options, _material = version_texts(source_version)
    variant_stem = _normalized_text(_blocks_text(content.get("blocks")))
    if stem and variant_stem and _normalized_text(stem) == variant_stem:
        problems.append(
            _problem(
                "variant_duplicates_source",
                "变式题干与源题题干完全相同：它不是有效变式",
                "content.blocks",
                source_version_id=str(source_version.id),
            )
        )
    return {
        "problems": problems,
        "content_digest": digest,
        "origin_type": OriginType.AI_GENERATED,
        "source_version_id": str(source_version.id),
    }


# --------------------------------------------------------------------------
# Review issues recomputed inside the publish gate
# --------------------------------------------------------------------------
def variant_review_issues(candidate: ImportCandidate) -> list[dict]:
    """Every deterministic problem of one stored variant candidate.

    ``apps.ingestion.services.core.refresh_candidate_issues`` calls this, so the
    problems are recomputed from the *stored* payload each time proofreading or
    publication is attempted. That is what makes a rejection durable: a human can
    fix the draft (the problems then disappear because the payload really is
    valid now), but no unrelated edit can make a duplicate or answerless variant
    publishable.
    """
    if candidate.job.input_kind != AI_VARIANT_INPUT_KIND:
        return []
    if candidate.status in {ImportCandidateStatus.PUBLISHED, ImportCandidateStatus.IGNORED}:
        return []
    payload = candidate.draft_payload or {}
    stored = candidate.machine_payload or {}
    source_version_id = stored.get("variant_of_version_id") or payload.get("variant_of_version_id")
    source_version = (
        QuestionVersion.objects.filter(id=source_version_id).select_related("question__subject").first()
        if source_version_id
        else None
    )
    if source_version is None:
        return [
            _problem(
                "variant_source_missing",
                "找不到变式的源题版本：无法验证它是否构成有效变式",
                "variant_of_version_id",
            )
        ]
    node_id = stored.get("variant_node_id") or payload.get("variant_node_id")
    node = KnowledgeNode.objects.filter(id=node_id).select_related("syllabus_version").first() if node_id else None
    problems: list[dict] = []
    if node is None:
        problems.append(
            _problem("variant_node_missing", "变式没有可核对的考点：无法验证它属于该科目大纲", "variant_node_id")
        )
    stem, _options, _material = version_texts(source_version)
    _clean, validation_problems = prompts.validate_variant_payload(
        payload, question_type=source_version.question_type, avoid_stems=[stem]
    )
    problems.extend(validation_problems)
    problems.extend(
        independent_checks(
            payload=payload,
            source_version=source_version,
            node=node,
            project=candidate.project,
            exclude_candidate_id=str(candidate.id),
        )["problems"]
    )
    return problems


# --------------------------------------------------------------------------
# Proposal
# --------------------------------------------------------------------------
def _proposed_score(*, clean: dict, question_type: str, content: dict, answer_payload: dict) -> str | None:
    """The score the candidate proposes, so publishing does not guess one.

    A constructed response is worth the sum of its (validated) rubric criteria —
    which is also what the publish gate compares the rubric against — and a
    fill-blank is worth the sum of its blank scores when the model declared them.
    """
    if question_type == QuestionType.CONSTRUCTED_RESPONSE:
        rows = clean.get("rubric_criteria") if isinstance(clean.get("rubric_criteria"), list) else []
        total = Decimal("0")
        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                total += Decimal(str(row.get("max_score")))
            except (InvalidOperation, TypeError, ValueError):
                continue
        if total > 0:
            return str(total)
        stated = clean.get("rubric_total_score")
        return str(stated) if stated not in (None, "") else None
    if clean.get("practice_max_score") not in (None, ""):
        return str(clean["practice_max_score"])
    if question_type == QuestionType.FILL_BLANK:
        blank_total = sum_blank_scores(answer_payload)
        if blank_total:
            return str(blank_total)
        declared = [
            blank.get("max_score")
            for blank in (content.get("blanks") or [])
            if isinstance(blank, dict) and blank.get("max_score") not in (None, "")
        ]
        if declared and len(declared) == len(content.get("blanks") or []):
            try:
                total = sum((Decimal(str(value)) for value in declared), Decimal("0"))
            except (InvalidOperation, TypeError, ValueError):
                return None
            return str(total) if total > 0 else None
    return None


def _draft_payload(
    *,
    clean: dict,
    source_version: QuestionVersion,
    node: KnowledgeNode | None,
    digest: str,
    run_id,
) -> dict:
    question_type = clean.get("question_type") or source_version.question_type
    content = clean.get("content") if isinstance(clean.get("content"), dict) else {}
    answer_payload = clean.get("answer_payload") if isinstance(clean.get("answer_payload"), dict) else {}
    label = source_version.question.display_label or str(source_version.question_id)[:8]
    return {
        "question_type": question_type,
        "content": content,
        "answer_payload": answer_payload,
        "rubric_criteria": clean.get("rubric_criteria") or [],
        "rubric_total_score": clean.get("rubric_total_score"),
        "practice_max_score": _proposed_score(
            clean=clean, question_type=question_type, content=content, answer_payload=answer_payload
        ),
        # The model's answer is a proposal, never a key: the ordinary human
        # confirmation (answer_status_known=true, then publish) is still required.
        "answer_status_known": False,
        "answer_source_type": AnswerSourceType.AI_DERIVED,
        "answer_verification": {
            "source_type": AnswerSourceType.AI_DERIVED,
            "verification_status": VerificationStatus.PENDING,
            "requires_human_confirmation": True,
            "note": "AI 推导答案：发布前必须由人工核对并确认（answer_status_known=true）",
        },
        "display_label": f"AI变式·{label}"[:200],
        "variant_of_question_id": str(source_version.question_id),
        "variant_of_version_id": str(source_version.id),
        "variant_node_id": str(node.id) if node is not None else "",
        "variant_content_digest": digest,
        "variant_prompt_version": prompts.PROPOSE_VARIANT_PROMPT_VERSION,
        "variant_llm_run_id": str(run_id),
        "difficulty_note": clean.get("difficulty_note") or "",
        "rationale": clean.get("rationale") or "",
        "doubts": clean.get("doubts") or [],
    }


def _machine_payload(*, call, clean: dict, source_version: QuestionVersion, node, digest: str, run_id) -> dict:
    return {
        "producer": "ai_variant",
        "provider": call.provider,
        "model": call.model,
        "prompt_version": prompts.PROPOSE_VARIANT_PROMPT_VERSION,
        "llm_run_id": str(run_id),
        "is_stub": bool(call.is_stub),
        "variant_of_version_id": str(source_version.id),
        "variant_node_id": str(node.id) if node is not None else "",
        "content_digest": digest,
        "raw_response_excerpt": (call.raw_text or "")[:2000],
        "model_output": {
            "question_type": clean.get("question_type"),
            "difficulty_note": clean.get("difficulty_note") or "",
            "rationale": clean.get("rationale") or "",
            "doubts": clean.get("doubts") or [],
        },
    }


def variant_candidate_summary(candidate: ImportCandidate) -> dict:
    payload = candidate.draft_payload or {}
    machine = candidate.machine_payload or {}
    issues = list(candidate.review_issues or [])
    blocking = [issue for issue in issues if issue.get("severity") == BLOCKING]
    return {
        "candidate_id": str(candidate.id),
        "job_id": str(candidate.job_id),
        "status": candidate.status,
        "awaiting_human_review": candidate.status
        not in {ImportCandidateStatus.PUBLISHED, ImportCandidateStatus.IGNORED},
        "question_type": payload.get("question_type"),
        "review_issues": issues,
        "blocking_issues": blocking,
        "answer_needs_confirmation": not bool(payload.get("answer_status_known")),
        "answer_source_type": payload.get("answer_source_type") or AnswerSourceType.AI_DERIVED,
        "content_digest": payload.get("variant_content_digest") or machine.get("content_digest") or "",
        "source_question_id": payload.get("variant_of_question_id") or "",
        "source_version_id": payload.get("variant_of_version_id") or machine.get("variant_of_version_id") or "",
        "node_id": payload.get("variant_node_id") or machine.get("variant_node_id") or "",
        "llm_run_id": payload.get("variant_llm_run_id") or machine.get("llm_run_id") or "",
        "is_stub_output": candidate.is_stub_output,
        "publication_question_id": str(candidate.publication_question_id) if candidate.publication_question_id else None,
        "publication_version_id": str(candidate.publication_version_id) if candidate.publication_version_id else None,
        "created_at": candidate.created_at.isoformat(),
    }


def variant_job_summary(job: ImportJob) -> dict:
    candidates = list(job.candidates.order_by("created_at"))
    return {
        "job_id": str(job.id),
        "project_id": str(job.project_id),
        "subject_id": str(job.subject_id) if job.subject_id else None,
        "status": job.status,
        "input_kind": job.input_kind,
        "extractor_version": job.extractor_version,
        "progress_percent": job.progress_percent,
        "problems": job.problems or [],
        "candidate_count": len(candidates),
        "candidate_status_counts": {
            status: sum(1 for candidate in candidates if candidate.status == status)
            for status in {candidate.status for candidate in candidates}
        },
        "candidates": [variant_candidate_summary(candidate) for candidate in candidates],
        "created_at": job.created_at.isoformat(),
    }


def variant_jobs(*, project, user=None, limit: int = 20) -> list[dict]:
    """Variant batches of one project, newest first, capped."""
    queryset = ImportJob.objects.filter(project=project, input_kind=AI_VARIANT_INPUT_KIND)
    if user is not None:
        queryset = queryset.filter(created_by=user)
    bounded = max(1, min(int(limit), 50))
    return [variant_job_summary(job) for job in queryset.order_by("-created_at")[:bounded]]


def propose_variants(
    *,
    project,
    source_version: QuestionVersion,
    node: KnowledgeNode | None,
    actor,
    count: int = 1,
    difficulty_note: str = "",
) -> dict:
    """Ask the configured provider for variant candidates; never publish one.

    Every model call is recorded on an ``llm_run`` row (provider, model, prompt
    version, tokens, cost, latency, attempts, ``is_stub`` and the validation
    result). Without a provider that declares ``propose_variant`` the call fails
    with ``AiUnavailable`` after recording an ``unavailable`` run — nothing is
    fabricated and no job or candidate is created.
    """
    question = source_version.question
    subject = question.subject
    if str(subject.project_id) != str(project.id):
        raise ScopeViolation(message="源题目不属于该项目")
    if source_version.question_type not in SCORABLE_LEAF_TYPES:
        raise InvalidInput(message="共享材料题不能生成变式；请选择它的子题作为源题")
    if source_version.status != QuestionVersionStatus.PUBLISHED:
        raise InvalidInput(message="只能从已发布的题目版本生成变式：草稿内容还没有经过人工发布")
    # C03: sealed content must never enter a generation prompt. The check lives
    # here (not at the API layer) so no caller can bypass it, and it runs before
    # any provider call or audit row for the model.
    from apps.question_bank.services import sealing

    sealing.assert_not_sealed(question=question, project=project, action="用于生成变式")
    requested = max(1, int(count or 1))
    effective = min(requested, MAX_VARIANTS_PER_REQUEST)
    provider = providers.get_provider()

    def _start_run() -> LLMRun:
        return LLMRun.objects.create(
            provider=provider.name,
            model_identifier="",
            capability="propose_variant",
            prompt_version=prompts.PROPOSE_VARIANT_PROMPT_VERSION,
            status=LlmRunStatus.FAILED,
            request_summary={
                "source_question_version_id": str(source_version.id),
                "question_type": source_version.question_type,
                "subject_id": str(subject.id),
                "node_id": str(node.id) if node is not None else "",
                "requested_count": requested,
                "difficulty_note": difficulty_note[:200],
            },
            input_snapshot={
                "content_digest": source_version.content_digest,
                "avoid_stem_count": 1,
                "engine": prompts.PROPOSE_VARIANT_PROMPT_VERSION,
            },
            is_stub=getattr(provider, "is_stub", False),
            user=actor,
            project_id=project.id,
        )

    if not provider.supports("propose_variant"):
        run = _start_run()
        run.status = LlmRunStatus.UNAVAILABLE
        run.error_code = providers.AiUnavailable.code
        run.error_message = "当前 provider 不声明 propose_variant 能力（未配置文本模型）"
        run.save(update_fields=["status", "error_code", "error_message", "updated_at"])
        raise providers.AiUnavailable("未配置可生成变式的文本模型；请配置 provider 或人工录入变式")

    stem, _option_texts, material_text = version_texts(source_version)
    answer_summary, rubric_criteria = answer_context(source_version)
    option_rows = [
        option for option in (source_version.content or {}).get("options") or [] if isinstance(option, dict)
    ]
    job = ingestion_services.create_import_job(
        owner=actor or project.owner,
        project=project,
        input_kind=AI_VARIANT_INPUT_KIND,
        subject=subject,
        input_text=(
            f"ai-variant:{source_version.id}:{node.id if node is not None else 'no-node'}:"
            f"{difficulty_note.strip()}:{effective}"
        ),
        extractor_version=prompts.PROPOSE_VARIANT_PROMPT_VERSION,
    )
    job.status = ImportJobStatus.PROCESSING
    job.started_at = timezone.now()
    job.save(update_fields=["status", "started_at", "updated_at"])
    ingestion_services.add_job_problem(
        job,
        "ai_variant_not_published",
        "变式由模型生成，只会成为待校对候选：必须通过确定性校验并由人工核对答案后，才能走原有发布流程。",
        severity="info",
        source_version_id=str(source_version.id),
        prompt_version=prompts.PROPOSE_VARIANT_PROMPT_VERSION,
    )

    notes: list[str] = []
    if effective < requested:
        note = (
            f"单次最多生成 {MAX_VARIANTS_PER_REQUEST} 道变式：请求 {requested} 道，"
            f"已按上限执行 {effective} 道（如需更多请分批提出）。"
        )
        notes.append(note)
        ingestion_services.add_job_problem(job, "variant_count_capped", note, severity="warning")

    candidates: list[dict] = []
    accepted = 0
    blocking_total = 0
    model_identifier = ""
    last_call_is_stub = bool(getattr(provider, "is_stub", False))
    for index in range(effective):
        run = _start_run()
        prompt = prompts.build_variant_prompt(
            question_type=source_version.question_type,
            stem_text=stem,
            options=option_rows,
            answer_summary=answer_summary,
            node_name=node.canonical_name if node is not None else "",
            difficulty_note=difficulty_note,
            avoid_stems=[stem],
            rubric_criteria=rubric_criteria,
            material_text=material_text,
        )
        try:
            call = providers.call_with_deadline(
                provider,
                providers.AiRequest(
                    capability="propose_variant",
                    prompt_version=prompts.PROPOSE_VARIANT_PROMPT_VERSION,
                    prompt=prompt,
                    input_context={
                        "question_type": source_version.question_type,
                        "node_id": str(node.id) if node is not None else "",
                        "index": index,
                    },
                    max_output_tokens=2000,
                ),
            )
        except providers.AiError as exc:
            run.status = (
                LlmRunStatus.TIMEOUT
                if isinstance(exc, providers.AiTimeout)
                else LlmRunStatus.UNAVAILABLE
                if isinstance(exc, providers.AiUnavailable)
                else LlmRunStatus.FAILED
            )
            run.error_code = exc.code
            run.error_message = str(exc)[:500]
            run.save(update_fields=["status", "error_code", "error_message", "updated_at"])
            ingestion_services.mark_job_failed(job, error=f"变式生成失败：{exc}")
            raise
        clean, validation_problems = prompts.validate_variant_payload(
            call.payload, question_type=source_version.question_type, avoid_stems=[stem]
        )
        model_identifier = call.model
        last_call_is_stub = bool(call.is_stub)
        digest = content_digest(clean.get("content") if isinstance(clean.get("content"), dict) else {})
        draft_payload = _draft_payload(
            clean=clean, source_version=source_version, node=node, digest=digest, run_id=run.id
        )
        checks = independent_checks(payload=draft_payload, source_version=source_version, node=node, project=project)
        problems = [*validation_problems, *checks["problems"]]
        blocking = [problem for problem in problems if problem.get("severity", BLOCKING) == BLOCKING]
        blocking_total += len(blocking)
        if not blocking:
            accepted += 1
        run.model_identifier = call.model
        run.raw_response_excerpt = (call.raw_text or "")[:2000]
        run.prompt_tokens = call.prompt_tokens
        run.completion_tokens = call.completion_tokens
        run.cost_cents = call.cost_cents
        run.cost_known = call.cost_known
        run.latency_ms = call.latency_ms
        run.attempts = call.attempts
        run.validation_result = {
            "accepted": not blocking,
            "problems": problems,
            "validation_problems": validation_problems,
            "independent_problems": checks["problems"],
            "content_digest": checks["content_digest"],
            "index": index,
        }
        run.status = LlmRunStatus.REJECTED if blocking else LlmRunStatus.SUCCEEDED
        run.save(
            update_fields=[
                "model_identifier",
                "raw_response_excerpt",
                "prompt_tokens",
                "completion_tokens",
                "cost_cents",
                "cost_known",
                "latency_ms",
                "attempts",
                "validation_result",
                "status",
                "updated_at",
            ]
        )
        machine_payload = _machine_payload(
            call=call, clean=clean, source_version=source_version, node=node, digest=digest, run_id=run.id
        )
        with transaction.atomic():
            candidate = ingestion_services.create_candidate(
                job=job,
                payload=draft_payload,
                subject=subject,
                machine_payload=machine_payload,
                is_stub_output=call.is_stub,
                extractor_version=prompts.PROPOSE_VARIANT_PROMPT_VERSION,
            )
        summary = variant_candidate_summary(candidate)
        candidates.append(summary)
        if blocking:
            ingestion_services.add_job_problem(
                job,
                "variant_rejected",
                f"第 {index + 1} 个候选未通过独立校验，已保留为待校对候选："
                + "；".join(str(problem.get("message")) for problem in blocking[:5]),
                severity="warning",
                candidate_id=str(candidate.id),
                codes=[problem.get("code") for problem in problems],
            )

    if accepted == 0:
        message = (
            f"{effective} 个候选全部未通过校验，已全部保留在候选中等待人工处理："
            "没有任何内容通过校验，因此本次不会发布任何变式。"
        )
        notes.append(message)
        ingestion_services.add_job_problem(job, "no_variant_usable", message, severity="warning")
    ingestion_services.maybe_complete_job(job)
    job.refresh_from_db()
    return {
        "job_id": str(job.id),
        "job_status": job.status,
        "project_id": str(project.id),
        "subject_id": str(subject.id),
        "source_question_id": str(question.id),
        "source_version_id": str(source_version.id),
        "node_id": str(node.id) if node is not None else "",
        "node_name": node.canonical_name if node is not None else "",
        "provider": provider.name,
        "model": model_identifier,
        "is_stub": last_call_is_stub,
        "prompt_version": prompts.PROPOSE_VARIANT_PROMPT_VERSION,
        "origin_type": OriginType.AI_GENERATED,
        "requested_count": requested,
        "count": effective,
        "count_capped": effective < requested,
        "candidates": candidates,
        "validation": {
            "requested_count": requested,
            "count": effective,
            "accepted": accepted,
            "rejected": effective - accepted,
            "blocking_problem_count": blocking_total,
            "nothing_passed": accepted == 0,
        },
        "nothing_passed": accepted == 0,
        "problems": [problem for candidate_row in candidates for problem in candidate_row["review_issues"]],
        "notes": notes,
    }
