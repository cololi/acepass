"""Download authorisation for private files.

Rules enforced here (docs/02 §4, docs/03 §8, docs/05 §3 C03):

* owner + project + subject are always checked
* a page that contains answers is not reachable before submission, and never
  during an unfinished verification run
* the same restriction applies to cached explanations and to the editorial
  entry points, not just to the tutoring button
* **sealed content is never readable**: the whole original page, an answer page
  or any crop that a sealed question's stem/answer comes from is refused, because
  those bytes *are* the sealed content. The relation is derived from the stored
  links, never guessed:

  - ``SourceRegion.crop_asset`` — a crop belongs to the regions that use it;
  - ``QuestionSourceLink(region=..., question_version=...)`` — which question
    version a region's text/crop came from (roles stem/option/material/answer/
    rubric/explanation);
  - ``AnswerKeyVersion.source_region`` — the region an answer was read from;
  - ``SourceDocument.asset`` — a whole-page scan; its regions carry the links, so
    the page inherits the sealing of every question drawn from it;
  - an ``asset_id`` referenced by an ``image`` block of a sealed question version
    (the stem image itself).

  A case that genuinely has no relation is documented rather than invented: an
  asset with no region, no source link, no answer-key link and no block reference
  (for example a photo the learner attached to their own attempt) is not linked to
  any question, so no sealing decision applies to it — the learner's own uploads
  stay readable by their owner, exactly as before.
"""

from __future__ import annotations

from django.utils import timezone

from apps.common.enums import AssetSensitivity, SessionMode, SessionStatus
from apps.common.errors import PurposeNotAllowed, ScopeViolation
from apps.ingestion.models import Asset, SourceDocument, SourceRegion


def _open_verification_runs(user, project):
    from apps.practice.models import PracticeSession

    return PracticeSession.objects.filter(
        user=user,
        project=project,
        status=SessionStatus.ACTIVE,
        mode__in=[SessionMode.VERIFICATION, SessionMode.MOCK_EXAM],
    )


def asset_scope(user, project, asset_id) -> Asset:
    asset = Asset.objects.filter(id=asset_id, project=project, owner=user).first()
    if asset is None:
        raise ScopeViolation(message="文件不存在或不属于当前项目")
    return asset


def sealed_questions_for_asset(*, project, asset: Asset):
    """Every question this asset's bytes can reveal that the resolver calls sealed.

    Returns a list of ``(Question, reason_code)``. The relation walk is
    deliberately explicit (see the module docstring) and needs no data the
    ingestion pipeline does not already store.
    """
    from django.db.models import Q

    from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion
    from apps.question_bank.services import sealing

    version_ids: set[str] = set()

    # 1. Crops: the regions that use this asset, and the versions linked to them.
    region_filter = Q(crop_asset=asset)
    # 2. Whole-page scans: the document(s) stored from this asset.
    document_ids = list(SourceDocument.objects.filter(asset=asset).values_list("id", flat=True))
    if document_ids:
        region_filter |= Q(document_id__in=document_ids)
    linked_versions = QuestionVersion.objects.filter(
        source_links__region__in=SourceRegion.objects.filter(region_filter)
    ).values_list("id", flat=True)
    version_ids.update(str(value) for value in linked_versions)

    # 3. Answers read from a region whose crop is this asset.
    version_ids.update(
        str(value)
        for value in AnswerKeyVersion.objects.filter(
            source_region__crop_asset=asset, question_version__isnull=False
        ).values_list("question_version_id", flat=True)
    )

    question_ids = {
        str(value)
        for value in QuestionVersion.objects.filter(id__in=sorted(version_ids)).values_list(
            "question_id", flat=True
        )
    }

    # 4. Inline stem/material images: bounded by the sealed set rather than by
    #    walking every version of the project.
    sealed_ids = sealing.sealed_question_ids(project=project)
    if sealed_ids:
        for version in QuestionVersion.objects.filter(question_id__in=sorted(sealed_ids)).only(
            "id", "question_id", "content"
        ):
            if _references_asset(version.content, asset.id):
                question_ids.add(str(version.question_id))

    if not question_ids:
        return []
    sealed_ids = sealing.sealed_question_ids(project=project, question_ids=sorted(question_ids))
    if not sealed_ids:
        return []
    questions = {str(question.id): question for question in Question.objects.filter(id__in=sorted(sealed_ids))}
    return [
        (questions[question_id], sealing.is_sealed(questions[question_id], project=project)[1])
        for question_id in sorted(sealed_ids)
    ]


def _references_asset(content, asset_id) -> bool:
    """Does one version's structured content reference this asset in an image block?"""
    if not isinstance(content, dict):
        return False
    needle = str(asset_id)
    blocks = list(content.get("blocks") or [])
    for option in content.get("options") or []:
        if isinstance(option, dict):
            blocks.extend(option.get("blocks") or [])
    for blank in content.get("blanks") or []:
        if isinstance(blank, dict):
            blocks.extend(blank.get("blocks") or [])
    for block in blocks:
        if isinstance(block, dict) and block.get("kind") == "image" and str(block.get("asset_id") or "") == needle:
            return True
    return False


def assert_asset_download_allowed(*, user, project, asset: Asset, purpose: str = "practice", session=None) -> None:
    """Decide whether these bytes may be delivered right now."""
    if asset.sensitivity == AssetSensitivity.INTERNAL_REVIEW and not user.is_staff:
        raise PurposeNotAllowed(message="该文件仅限内部审核使用")

    # C03: sealed content is never readable, whatever the purpose. Checked before
    # the purpose rules so the refusal names the sealing policy, not a mode.
    sealed = sealed_questions_for_asset(project=project, asset=asset)
    if sealed:
        from apps.question_bank.services import sealing

        question, code = sealed[0]
        raise PurposeNotAllowed(
            message=(
                f"该文件包含已封存题目的原始内容（题目 {question.display_label or question.id}）："
                f"{sealing.reason_message(code)}，因此不能读取原页或答案文件。"
            ),
            details={
                "reason": code,
                "question_id": str(question.id),
                "asset_id": str(asset.id),
                "action": "读取原页/答案文件",
            },
        )

    if purpose == "editorial":
        # Editorial preview of answer-bearing material during a live
        # verification run would leak answers, so it is refused too.
        if _open_verification_runs(user, project).exists():
            raise PurposeNotAllowed(
                message="存在未结束的验证/考试会话，暂不能查看可能包含答案的来源文件；请先结束验证"
            )
        return

    if asset.sensitivity == AssetSensitivity.CONTAINS_ANSWERS:
        if session is not None:
            if not session.allows_pre_submit_answers:
                raise PurposeNotAllowed(message="当前会话模式在提交前不允许查看含答案的来源文件")
            if session.status == SessionStatus.ACTIVE and session.mode != SessionMode.PRACTICE:
                raise PurposeNotAllowed(message="验证/考试进行中不允许查看含答案的来源文件")
        elif _open_verification_runs(user, project).exists():
            raise PurposeNotAllowed(message="存在未结束的验证/考试会话，暂不能查看含答案的来源文件")


def record_download_exposure(*, user, project, asset: Asset, purpose: str, session_item=None) -> None:
    """Log that answer-bearing bytes were actually delivered."""
    from apps.practice.services import exposure

    if asset.sensitivity != AssetSensitivity.CONTAINS_ANSWERS:
        return
    question = getattr(session_item, "question_version", None)
    exposure.record(
        user=user,
        project=project,
        kind="answer_delivered",
        purpose=purpose if purpose in {"practice", "verification", "editorial", "preview"} else "practice",
        source="asset_download",
        question=question.question if question is not None else None,
        question_version=question,
        session_item=session_item,
        reveals_answer=True,
        detail={"asset_id": str(asset.id), "role": asset.role, "server_time": timezone.now().isoformat()},
    )


def document_scope(user, project, document_id) -> SourceDocument:
    document = SourceDocument.objects.filter(id=document_id, project=project, owner=user).first()
    if document is None:
        raise ScopeViolation(message="来源文档不存在或不属于当前项目")
    return document


def presentation_asset_ids(question_version) -> set[str]:
    """Assets that are safe to render as part of the stem.

    Only reviewed stem/material crops and images that are referenced by the
    structured blocks qualify; a whole-page scan never does.
    """
    allowed: set[str] = set()
    content = question_version.content or {}
    blocks = list(content.get("blocks") or [])
    for option in content.get("options") or []:
        blocks.extend(option.get("blocks") or [])
    for blank in content.get("blanks") or []:
        blocks.extend(blank.get("blocks") or [])
    for block in blocks:
        if isinstance(block, dict) and block.get("kind") == "image" and block.get("asset_id"):
            allowed.add(str(block["asset_id"]))
    return allowed
