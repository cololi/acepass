"""Prompts — P1 AI diagnosis prompt and validation."""

from __future__ import annotations

from typing import Any

DIAGNOSE_PROMPT_VERSION = "p1-diagnose-v1"


DIAGNOSIS_ERROR_TYPES = (
    "concept_gap",  # 概念没掌握
    "misread_question",  # 看错题目要求
    "calculation_slip",  # 计算/抄写失误
    "unit_or_sign_error",  # 单位/符号错误
    "incomplete_reasoning",  # 过程不完整
    "method_misapplied",  # 方法用错
    "guessing",  # 猜答案（仅在过程证据支持时）
    "unknown",  # 证据不足
)


DIAGNOSE_SYSTEM = """你是学习诊断助手。你要根据一份作答，提出**可能的**错误原因与需要向学习者追问的问题。
严格规则：
1. 只输出 JSON，不要输出解释文字或 Markdown 代码块。
2. error_type 只能从给定列表中选；证据不足时用 unknown，不要为了凑数而猜。
3. 不得修改分数、不得给出掌握结论、不得声称学习者“粗心”或态度问题。
4. 每个原因必须给出可核对的 evidence（引用作答或题干中的具体内容）。
5. follow_up_questions 是让学习者补充过程证据的问题，必须具体、可回答。
输出 JSON 结构：
{"causes": [{"error_type": "...", "confidence": 0.0, "evidence": ["..."]}],
 "follow_up_questions": [{"question": "...", "why": "...", "evidence_kind": "过程步骤|口算过程|题意理解|单位与符号"}],
 "missing_information": ["..."]}"""


def build_diagnose_prompt(
    *,
    question_type: str,
    stem_text: str,
    answer_summary: str,
    learner_answer_text: str,
    graded_parts: list[dict[str, Any]],
    transcription_note: str = "",
) -> str:
    parts = "\n".join(
        f"- {str(part.get('criterion_id') or part.get('blank_id') or part.get('part_id') or '')}: "
        f"得分 {part.get('score')} / {part.get('max_score')}"
        for part in graded_parts[:30]
    )
    return (
        f"{DIAGNOSE_SYSTEM}\n\n"
        f"题型：{question_type}\n题干：{stem_text[:2000]}\n"
        f"已核对答案（仅供你判断，不要直接抄给学习者）：{answer_summary[:1000]}\n"
        f"学习者作答：{learner_answer_text[:3000] or '（没有可读文本）'}\n"
        f"评分点得分：\n{parts or '（无逐点得分）'}\n"
        f"转写说明：{transcription_note or '（无）'}\n"
        f"允许的 error_type：{', '.join(DIAGNOSIS_ERROR_TYPES)}\n"
        "请给出可能原因与追问问题，输出 JSON。"
    )


def validate_diagnosis(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict]]:
    """Keep only known causes; an unproven cause becomes ``unknown``."""
    problems: list[dict] = []
    if not isinstance(payload, dict):
        return {"causes": [], "follow_up_questions": [], "missing_information": []}, [
            {"code": "not_object", "message": "模型输出不是对象"}
        ]
    causes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(payload.get("causes") or []):
        if not isinstance(item, dict):
            problems.append({"code": "cause_not_object", "message": "原因必须是对象", "index": index})
            continue
        error_type = str(item.get("error_type") or "").strip()
        if error_type not in DIAGNOSIS_ERROR_TYPES:
            problems.append(
                {"code": "unknown_error_type", "message": f"原因类型不在受控词表中：{error_type}", "index": index}
            )
            continue
        evidence = [str(value)[:300] for value in (item.get("evidence") or []) if str(value).strip()][:10]
        if error_type != "unknown" and not evidence:
            problems.append(
                {
                    "code": "cause_without_evidence",
                    "message": f"原因 {error_type} 没有证据，已降级为 unknown",
                    "index": index,
                }
            )
            error_type = "unknown"
        if error_type in seen:
            continue
        seen.add(error_type)
        try:
            confidence = float(item.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        causes.append(
            {
                "error_type": error_type,
                "confidence": max(0.0, min(1.0, confidence)),
                "evidence": evidence,
            }
        )
    questions: list[dict[str, Any]] = []
    for index, item in enumerate(payload.get("follow_up_questions") or []):
        if isinstance(item, dict):
            question = str(item.get("question") or "").strip()
            if not question:
                continue
            questions.append(
                {
                    "question": question[:500],
                    "why": str(item.get("why") or "")[:300],
                    "evidence_kind": str(item.get("evidence_kind") or "")[:60],
                }
            )
        elif str(item).strip():
            questions.append({"question": str(item)[:500], "why": "", "evidence_kind": ""})
        else:
            problems.append({"code": "empty_question", "message": "追问问题为空", "index": index})
    return {
        "causes": causes,
        "follow_up_questions": questions[:10],
        "missing_information": [str(value)[:300] for value in (payload.get("missing_information") or [])][:20],
    }, problems
