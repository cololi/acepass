"""Download authorisation for private files.

Rules enforced here (docs/02 §4, docs/03 §8):

* owner + project + subject are always checked
* a page that contains answers is not reachable before submission, and never
  during an unfinished verification run
* the same restriction applies to cached explanations and to the editorial
  entry points, not just to the tutoring button
"""

from __future__ import annotations

from django.utils import timezone

from apps.common.enums import AssetSensitivity, SessionMode, SessionStatus
from apps.common.errors import PurposeNotAllowed, ScopeViolation
from apps.ingestion.models import Asset, SourceDocument


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


def assert_asset_download_allowed(*, user, project, asset: Asset, purpose: str = "practice", session=None) -> None:
    """Decide whether these bytes may be delivered right now."""
    if asset.sensitivity == AssetSensitivity.INTERNAL_REVIEW and not user.is_staff:
        raise PurposeNotAllowed(message="该文件仅限内部审核使用")

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
