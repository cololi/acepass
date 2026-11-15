"""Prompts — P1 AI grade-estimate prompt and validation."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any

ESTIMATE_GRADE_PROMPT_VERSION = "p1-estimate-grade-v1"


ESTIMATE_SYSTEM = """你是考试评分辅助助手。你要按给定的评分点，为一份作答给出**参考估计**。
严格规则：
1. 只输出 JSON，不要输出解释文字或 Markdown 代码块。
2. 只能使用给定的 criterion_id，不得新增、删除或改写评分点。
3. 每个评分点的分数必须在 0 与它的 max_score 之间；不确定就给低分并在 missing_evidence 说明。
4. 这是“参考估计”，不是正式分数：不得声称已确认，不得写“已掌握/通过/及格”。
5. 没有过程证据时不要断言粗心或态度问题。
输出 JSON 结构：
{"criteria": [{"criterion_id": "...", "estimated_score": 0, "rationale": "...", "missing_evidence": ["..."]}],
 "overall_note": "...", "confidence": 0.0}"""


def build_estimate_prompt(
    *,
    question_type: str,
    stem_text: str,
    rubric_criteria: list[dict[str, Any]],
    learner_answer_text: str,
    transcription_note: str = "",
    max_total: str = "",
) -> str:
    criteria_lines = "\n".join(
        f"- criterion_id={criterion.get('criterion_id')} · 满分 {criterion.get('max_score')} · "
        f"{str(criterion.get('description') or '')[:300]}"
        for criterion in rubric_criteria
    )
    return (
        f"{ESTIMATE_SYSTEM}\n\n"
        f"题型：{question_type}\n题干：{stem_text[:2000]}\n"
        f"评分点（只能使用这些 criterion_id）：\n{criteria_lines or '（无评分点）'}\n"
        f"整题满分：{max_total or '（未提供）'}\n"
        f"学习者作答（文字与已确认的转写）：{learner_answer_text[:4000] or '（没有可读文本）'}\n"
        f"转写说明：{transcription_note or '（无）'}\n"
        "请按评分点给出参考估计，输出 JSON。"
    )


def validate_estimate(
    payload: dict[str, Any], *, criteria: list[dict[str, Any]]
) -> tuple[dict[str, Any], list[dict]]:
    """Keep one estimate per real rubric criterion and never exceed its cap."""
    problems: list[dict] = []
    if not isinstance(payload, dict):
        return {"criteria": [], "overall_note": "", "confidence": None}, [
            {"code": "not_object", "message": "模型输出不是对象"}
        ]
    allowed = {str(item["criterion_id"]): item for item in criteria}
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(payload.get("criteria") or []):
        if not isinstance(item, dict):
            problems.append({"code": "criterion_not_object", "message": "评分点必须是对象", "index": index})
            continue
        criterion_id = str(item.get("criterion_id") or "")
        criterion = allowed.get(criterion_id)
        if criterion is None:
            problems.append(
                {"code": "unknown_criterion", "message": f"估计引用了不存在的评分点：{criterion_id}", "index": index}
            )
            continue
        if criterion_id in seen:
            continue
        seen.add(criterion_id)
        try:
            score = Decimal(str(item.get("estimated_score", 0)))
        except (InvalidOperation, TypeError, ValueError):
            problems.append({"code": "bad_score", "message": "估计分数不是数字", "index": index})
            continue
        cap = Decimal(str(criterion.get("max_score", 0)))
        if score < 0:
            problems.append({"code": "negative_score", "message": "估计分数为负", "index": index})
            continue
        if score > cap:
            problems.append(
                {
                    "code": "score_over_cap",
                    "message": f"估计分数超过该评分点满分（{score} > {cap}），已按满分截断",
                    "index": index,
                }
            )
            score = cap
        rows.append(
            {
                "criterion_id": criterion_id,
                "estimated_score": str(score),
                "rationale": str(item.get("rationale") or "")[:500],
                "missing_evidence": [str(value)[:200] for value in (item.get("missing_evidence") or [])][:20],
            }
        )
    if not rows:
        problems.append({"code": "empty_estimate", "message": "模型没有给出任何可用的评分点估计"})
    try:
        confidence = float(payload.get("confidence")) if payload.get("confidence") is not None else None
    except (TypeError, ValueError):
        confidence = None
    if confidence is not None:
        confidence = max(0.0, min(1.0, confidence))
    return {
        "criteria": rows,
        "overall_note": str(payload.get("overall_note") or "")[:1000],
        "confidence": confidence,
    }, problems
