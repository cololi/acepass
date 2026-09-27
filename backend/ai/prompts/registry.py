"""Versioned prompts and validation for AI output.

Prompts are data with an explicit version, so an `llm_run` row can always be
traced back to the exact instruction that produced it.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from decimal import Decimal, InvalidOperation
from typing import Any

from apps.common.enums import SCORABLE_LEAF_TYPES, QuestionType

EXTRACT_PROMPT_VERSION = "p0-extract-v1"
EXPLAIN_PROMPT_VERSION = "p0-explain-v1"

EXTRACT_SYSTEM = """你是考试题库录入助手。你的唯一任务是把图片中的题目转换成结构化候选数据。
严格规则：
1. 只输出 JSON，不要输出解释文字或 Markdown 代码块。
2. 不得编造题目中不存在的内容；识别不清的字段留空，并在 doubts 中说明。
3. 不得推断官方答案；如果图片中没有答案，answer_status_known 必须为 false。
4. 选项 ID 使用 opt_a、opt_b…；空位 ID 使用 b1、b2…（按出现顺序）。
5. 保留负号、单位、上下标等符号信息，不要“修正”成看起来更合理的内容。
输出 JSON 结构：
{
  "question_type": "single_choice|multiple_choice|true_false|fill_blank|constructed_response|material",
  "display_label": "题号或标签（可为空字符串）",
  "content": {"blocks": [{"kind": "text", "text": "..."}], "options": [...], "blanks": [...]},
  "answer_payload": {},
  "answer_status_known": false,
  "source_hint": {"page_index": 1, "note": ""},
  "doubts": ["疑点说明"]
}"""

EXPLAIN_SYSTEM = """你是考试学习辅导助手。你面对的是固定版本的题目与已核对答案。
严格规则：
1. 只输出 JSON，不要输出解释文字或 Markdown 代码块。
2. 不得修改、重新判定或猜测正式分数；不得声称学生“已掌握”。
3. 不得引用本次输入之外的材料；citations 只能使用给出的引用 ID。
4. 若输入信息不足，把缺失项写进 missing_information，不要编造。
5. 不给出通过率、提分承诺或排名。
输出 JSON 结构：
{
  "key_conditions": ["关键条件"],
  "stuck_points": ["可能卡点"],
  "explanation_blocks": [{"kind": "text", "text": "讲解"}],
  "method_summary": "方法与适用边界",
  "suggested_next": ["下一步验证动作"],
  "missing_information": ["缺失信息"],
  "citations": ["允许的引用 ID"]
}"""


def build_extract_prompt(*, project_name: str, subject_name: str, source_note: str = "") -> str:
    return (
        f"{EXTRACT_SYSTEM}\n\n"
        f"项目：{project_name}\n科目：{subject_name}\n来源说明：{source_note or '（未提供）'}\n"
        "请识别这张图片中的一道题目，输出 JSON。"
    )


def build_explain_prompt(
    *,
    question_type: str,
    stem_text: str,
    options: list[dict[str, Any]],
    answer_summary: str,
    explanation_blocks: list[dict[str, Any]],
    allowed_citation_ids: list[str],
    attempt_summary: str = "",
    user_question: str = "",
    knowledge_nodes: list[str] | None = None,
    rubric_criteria: list[dict[str, Any]] | None = None,
    material_text: str = "",
    blanks: list[dict[str, Any]] | None = None,
) -> str:
    option_lines = "\n".join(
        f"- {option.get('label') or option.get('id')}: {_blocks_text(option.get('blocks'))}" for option in options
    )
    blank_lines = "\n".join(
        f"- {blank.get('blank_id')}: {blank.get('label') or ''}"
        for blank in (blanks or [])
        if isinstance(blank, dict)
    )
    rubric_lines = "\n".join(
        f"- {criterion.get('criterion_id')}（满分 {criterion.get('max_score')}）: {criterion.get('text', '')}"
        for criterion in (rubric_criteria or [])
        if isinstance(criterion, dict)
    )
    node_line = "、".join(knowledge_nodes or []) or "（未映射考点）"
    return (
        f"{EXPLAIN_SYSTEM}\n\n"
        f"题型：{question_type}\n题干：{stem_text}\n"
        f"选项：\n{option_lines or '（无选项）'}\n"
        f"空位：\n{blank_lines or '（无空位）'}\n"
        f"共享材料：{material_text or '（无共享材料）'}\n"
        f"关联考点：{node_line}\n"
        f"评分标准（人工已审核）：\n{rubric_lines or '（本题无逐点评分标准）'}\n"
        f"已核对答案摘要：{answer_summary or '（本题答案尚未核对，只能做条件澄清，不得给出结论性答案）'}\n"
        f"已审核人工解析：{_blocks_text(explanation_blocks) or '（无）'}\n"
        f"学生本次作答（原文，逐字保留；请针对其中具体内容讲解）：\n{attempt_summary or '（尚未提交作答）'}\n"
        f"学生问题：{user_question or '请针对上面学生自己的作答与步骤，给出关键条件、可能卡点、方法与下一步验证。'}\n"
        f"允许引用的引用 ID（只能使用这些）：{', '.join(allowed_citation_ids) or '（无）'}\n"
        "请输出 JSON。"
    )


def _blocks_text(blocks: Any) -> str:
    if not isinstance(blocks, list):
        return ""
    parts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("kind") == "text":
            parts.append(str(block.get("text", "")))
        elif block.get("kind") == "math":
            parts.append(f"${block.get('latex', '')}$")
    return " ".join(part for part in parts if part)


def validate_extract_payload(payload: dict[str, Any], *, allowed_asset_ids: set[str] | None = None) -> tuple[dict[str, Any], list[dict]]:
    """Validate the extractor output. Never trusts it, never fills in answers."""
    from apps.common.content import validate_content

    problems: list[dict] = []
    if not isinstance(payload, dict):
        return {}, [{"code": "not_object", "message": "模型输出不是对象"}]
    question_type = payload.get("question_type")
    if question_type not in QuestionType.values:
        problems.append({"code": "unknown_type", "message": f"模型给出的题型无效：{question_type!r}"})
        question_type = QuestionType.SINGLE_CHOICE
    content = payload.get("content") if isinstance(payload.get("content"), dict) else {}
    for problem in validate_content(content, question_type):
        problems.append({"code": f"content.{problem['code']}", "message": problem["message"]})
    if allowed_asset_ids is not None:
        for block in content.get("blocks") or []:
            if isinstance(block, dict) and block.get("kind") == "image" and block.get("asset_id"):
                if str(block["asset_id"]) not in allowed_asset_ids:
                    problems.append({"code": "unknown_asset", "message": "输出引用了本次输入之外的图片资产"})
    answer_payload = payload.get("answer_payload") if isinstance(payload.get("answer_payload"), dict) else {}
    answer_known = bool(payload.get("answer_status_known"))
    if answer_known and not answer_payload:
        problems.append({"code": "answer_claimed_but_empty", "message": "声称有答案但未给出答案内容"})
    clean = {
        "question_type": question_type,
        "display_label": str(payload.get("display_label") or "")[:200],
        "content": content,
        "answer_payload": answer_payload,
        "answer_status_known": answer_known,
        "source_hint": payload.get("source_hint") if isinstance(payload.get("source_hint"), dict) else {},
        "doubts": [str(item)[:300] for item in (payload.get("doubts") or [])][:20],
    }
    return clean, problems


def validate_explain_payload(
    payload: dict[str, Any], *, allowed_citation_ids: set[str]
) -> tuple[dict[str, Any], list[dict]]:
    problems: list[dict] = []
    if not isinstance(payload, dict):
        return {}, [{"code": "not_object", "message": "模型输出不是对象"}]
    blocks: list[dict] = []
    for index, block in enumerate(payload.get("explanation_blocks") or []):
        if not isinstance(block, dict):
            problems.append({"code": "block_not_object", "message": "讲解块必须是对象", "index": index})
            continue
        kind = block.get("kind", "text")
        if kind not in {"text", "math", "list"}:
            problems.append({"code": "unsupported_block", "message": f"不支持的讲解块类型：{kind}", "index": index})
            continue
        if kind == "list":
            items = [str(item)[:500] for item in (block.get("items") or []) if str(item).strip()]
            blocks.append({"kind": "list", "items": items})
        else:
            key = "text" if kind == "text" else "latex"
            value = str(block.get(key, ""))
            if not value.strip():
                problems.append({"code": "empty_block", "message": "讲解块内容为空", "index": index})
                continue
            blocks.append({"kind": kind, key: value[:4000]})
    citations: list[str] = []
    for citation in payload.get("citations") or []:
        value = str(citation)
        if value not in allowed_citation_ids:
            problems.append({"code": "unknown_citation", "message": f"引用了本次检索范围外的来源：{value}"})
            continue
        citations.append(value)
    clean = {
        "key_conditions": [str(item)[:300] for item in (payload.get("key_conditions") or [])][:20],
        "stuck_points": [str(item)[:300] for item in (payload.get("stuck_points") or [])][:20],
        "explanation_blocks": blocks,
        "method_summary": str(payload.get("method_summary") or "")[:2000],
        "suggested_next": [str(item)[:300] for item in (payload.get("suggested_next") or [])][:20],
        "missing_information": [str(item)[:300] for item in (payload.get("missing_information") or [])][:20],
        "citations": citations,
    }
    if not blocks and not clean["key_conditions"]:
        problems.append({"code": "empty_explanation", "message": "模型没有给出任何可用讲解内容"})
    return clean, problems


# --------------------------------------------------------------------------
# P1: knowledge-tag suggestions (acceptance B04)
# --------------------------------------------------------------------------
SUGGEST_TAGS_PROMPT_VERSION = "p1-suggest-tags-v1"

SUGGEST_TAGS_SYSTEM = """你是考试题库的标签助手。你的唯一任务是为一道题目从给定大纲中挑选可能相关的考点。
严格规则：
1. 只输出 JSON，不要输出解释文字或 Markdown 代码块。
2. 只能从“允许的考点名称”列表中选择，必须逐字复制名称，不得改写、缩写或创造新名称。
3. 不确定就不要给；宁可少给，也不要为了凑数而猜。
4. 不得输出分数、掌握程度或通过率。
输出 JSON 结构：
{"tags": [{"name": "考点名称（逐字复制）", "confidence": 0.0, "rationale": "为什么相关（不超过 60 字）"}]}"""


def build_tag_suggestion_prompt(
    *,
    subject_name: str,
    stem_text: str,
    option_texts: list[str],
    allowed_node_names: list[str],
    material_text: str = "",
) -> str:
    options = "\n".join(f"- {text}" for text in option_texts if text) or "（无选项）"
    allowed = "\n".join(f"- {name}" for name in allowed_node_names[:200]) or "（大纲为空：必须返回空 tags）"
    material = f"\n共享材料：{material_text[:1500]}" if material_text else ""
    return (
        f"{SUGGEST_TAGS_SYSTEM}\n\n"
        f"科目：{subject_name}\n"
        f"题干：{stem_text[:3000]}\n选项：\n{options}{material}\n\n"
        f"允许的考点名称（只能逐字复制以下名称）：\n{allowed}\n\n"
        "请输出 JSON。"
    )


def validate_tag_suggestions(
    payload: dict[str, Any], *, allowed_node_names: set[str]
) -> tuple[list[dict[str, Any]], list[dict]]:
    """Keep only proposals that copy an allowed node name verbatim.

    A suggestion that invents a name is dropped with an explicit problem, so a
    model can never widen the controlled vocabulary through this path.
    """

    problems: list[dict] = []
    if not isinstance(payload, dict):
        return [], [{"code": "not_object", "message": "模型输出不是对象"}]
    clean: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(payload.get("tags") or []):
        if not isinstance(item, dict):
            problems.append({"code": "tag_not_object", "message": "标签必须是对象", "index": index})
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            problems.append({"code": "empty_tag_name", "message": "标签名称为空", "index": index})
            continue
        if name not in allowed_node_names:
            problems.append(
                {"code": "unknown_tag_name", "message": f"建议的考点不在当前大纲中：{name}", "index": index}
            )
            continue
        if name in seen:
            continue
        seen.add(name)
        try:
            confidence = float(item.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        clean.append(
            {
                "name": name,
                "confidence": max(0.0, min(1.0, confidence)),
                "rationale": str(item.get("rationale") or "")[:200],
            }
        )
    return clean, problems


# --------------------------------------------------------------------------
# P1 batch 3: handwriting transcription, AI rubric estimation, diagnosis
# --------------------------------------------------------------------------
TRANSCRIBE_PROMPT_VERSION = "p1-transcribe-v1"
ESTIMATE_GRADE_PROMPT_VERSION = "p1-estimate-grade-v1"
DIAGNOSE_PROMPT_VERSION = "p1-diagnose-v1"

#: The only error causes a model may propose. Anything else is discarded, and a
#: cause is never promoted to "confirmed" by the model itself.
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

TRANSCRIBE_SYSTEM = """你是手写作答的转写助手。你的唯一任务是把照片中的手写内容转写成文字。
严格规则：
1. 只输出 JSON，不要输出解释文字或 Markdown 代码块。
2. 只转写照片中真实存在的内容；看不清的字用“□”占位，并把位置写进 doubts。
3. 不要纠正、补全或“猜”学习者的推导；不要替他算出答案。
4. 不要判断对错，不要给分数，不要写掌握程度。
5. 如果整张图都看不清，text 返回空字符串并把 illegible 设为 true。
输出 JSON 结构：
{"text": "转写文本", "confidence": 0.0, "doubts": ["不确定之处"], "illegible": false}"""


def build_transcribe_prompt(*, subject_name: str, question_stem: str = "", note: str = "") -> str:
    return (
        f"{TRANSCRIBE_SYSTEM}\n\n"
        f"科目：{subject_name}\n"
        f"题目（仅供理解上下文，不要在转写里复制）：{question_stem[:800] or '（未提供）'}\n"
        f"补充说明：{note or '（无）'}\n"
        "请转写这张照片中的手写作答，输出 JSON。"
    )


def validate_transcription(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict]]:
    """Normalise one transcription proposal; never invent text that was not read."""
    problems: list[dict] = []
    if not isinstance(payload, dict):
        return {"text": "", "confidence": None, "doubts": [], "illegible": True}, [
            {"code": "not_object", "message": "模型输出不是对象"}
        ]
    text = str(payload.get("text") or "").strip()[:8000]
    doubts = [str(item)[:200] for item in (payload.get("doubts") or []) if str(item).strip()][:20]
    try:
        confidence = float(payload.get("confidence")) if payload.get("confidence") is not None else None
    except (TypeError, ValueError):
        confidence = None
        problems.append({"code": "bad_confidence", "message": "confidence 不是数字，已忽略"})
    if confidence is not None:
        confidence = max(0.0, min(1.0, confidence))
    illegible = bool(payload.get("illegible")) or not text
    if illegible and not doubts:
        doubts.append("模型认为照片无法辨认")
    if not text:
        problems.append({"code": "empty_transcription", "message": "模型没有读出任何文字"})
    return {"text": text, "confidence": confidence, "doubts": doubts, "illegible": illegible}, problems


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


# --------------------------------------------------------------------------
# P2 batch 2: AI-generated variants with mandatory independent validation (C02)
# --------------------------------------------------------------------------
#: Version of the *instruction* that produced a variant. It is stored on the
#: ingestion job, on every candidate and on every ``llm_run`` row, so a variant
#: can always be traced back to the exact prompt that generated it.
PROPOSE_VARIANT_PROMPT_VERSION = "p2-propose-variant-v1"

VARIANT_SYSTEM = """你是考试题库的变式题生成助手。你的唯一任务是基于一道已审核的题目，生成一道**新的**同考点变式题候选。
严格规则：
1. 只输出 JSON，不要输出解释文字或 Markdown 代码块。
2. 变式必须是新题：不得照抄原题干，不得只改数字后与原题雷同；题干条件必须完整、自洽。
3. 答案必须能由你自己给出的题干独立推出；不得直接抄写原题答案，也不得把答案写进题干或选项。
4. 单选题只能有一个正确选项；多选题至少两个正确选项，且必须真实存在于选项中。
5. 题型必须与给定题型一致；不得输出 material（共享材料）。
6. 选项 ID 用 opt_a、opt_b…；空位 ID 用 b1、b2…；answer_payload.kind 必须等于题型。
7. 填空题每个空位都必须给出非空的 accepted_values 字符串数组，且空位 ID 与题干一致。
8. 大题必须给出 rubric_criteria（每个评分点有正的 max_score）与 rubric_total_score（等于各评分点之和）。
9. 不得引用图片：content 中不得出现 image 块（你无法知道真实资产 ID）。
10. 你的输出只是候选：不会自动发布，仍需人工逐项核对并确认答案。
输出 JSON 结构：
{
  "question_type": "single_choice|multiple_choice|true_false|fill_blank|constructed_response",
  "content": {"blocks": [{"kind": "text", "text": "..."}], "options": [...], "blanks": [...]},
  "answer_payload": {"kind": "题型", "...": "按题型给出的可判定答案"},
  "rubric_criteria": [{"criterion_id": "c1", "text": "...", "max_score": "2.00", "required": true}],
  "rubric_total_score": "2.00",
  "practice_max_score": "2.00",
  "difficulty_note": "难度说明",
  "rationale": "与原题的差异（一句话，说明为什么是同一考点的陌生变式）",
  "doubts": ["不确定之处"]
}"""

#: Phrases that state the answer outright. This is a *marker scan*, not a proof
#: that no answer is implied: it catches the concrete failure mode that matters
#: ("the model wrote the key into the stem") without pretending to understand
#: the wording. Wording the scanner cannot judge stays a human decision.
_VARIANT_ANSWER_MARKERS = (
    "正确答案是",
    "正确答案为",
    "正确答案：",
    "答案是",
    "答案为",
    "答案：",
    "故答案为",
    "应选",
    "故选",
    "answer is",
    "correct answer",
)

#: The shortest normalized option text that counts as "the stem quotes the
#: correct option verbatim". Below it a match is more likely to be a shared
#: condition than a leaked answer, and a false block would cost a human edit.
_VARIANT_OPTION_LEAK_MIN_LENGTH = 8

#: Block kinds a generated variant may never carry. An ``image`` block must
#: reference a real asset/region of the project, and a model that never saw the
#: project cannot produce one; allowing it would let unverifiable material into
#: a publishable draft.
_VARIANT_FORBIDDEN_BLOCK_KINDS = ("image",)


def _variant_problem(code: str, message: str, path: str = "", severity: str = "blocking") -> dict:
    return {"code": code, "message": message, "path": path, "severity": severity}


def _normalized_for_compare(value: Any) -> str:
    """Whitespace/punctuation-insensitive form used for equality checks."""
    return re.sub(r"[\s\W_]+", "", str(value or "")).lower()


def build_variant_prompt(
    *,
    question_type: str,
    stem_text: str,
    options: list[dict[str, Any]],
    answer_summary: str,
    node_name: str,
    difficulty_note: str,
    avoid_stems: Iterable[str] = (),
    rubric_criteria: list[dict[str, Any]] | None = None,
    material_text: str = "",
) -> str:
    """Instruction for one variant proposal.

    ``answer_summary`` and ``rubric_criteria`` are *context*: they tell the model
    which point is being examined, never what to copy. ``avoid_stems`` lists the
    wording the variant must not reproduce (the source stem, plus any wording the
    caller already knows is taken).
    """
    option_lines = "\n".join(
        f"- {option.get('label') or option.get('id')}: {_blocks_text(option.get('blocks'))}"
        for option in options
        if isinstance(option, dict)
    )
    rubric_lines = "\n".join(
        f"- {criterion.get('criterion_id')}（满分 {criterion.get('max_score')}）: {str(criterion.get('text') or '')[:200]}"
        for criterion in (rubric_criteria or [])
        if isinstance(criterion, dict)
    )
    avoid_lines = "\n".join(f"- {str(stem)[:400]}" for stem in avoid_stems if str(stem or "").strip())
    return (
        f"{VARIANT_SYSTEM}\n\n"
        f"题型：{question_type}\n"
        f"目标考点：{node_name or '（未指定）'}\n"
        f"原题题干（不得照抄，也不得只改数字后雷同）：{str(stem_text or '')[:3000] or '（未提供）'}\n"
        f"原题选项：\n{option_lines or '（无选项）'}\n"
        f"原题评分标准（仅供理解考查方式，不要照抄评分点文字）：\n{rubric_lines or '（无）'}\n"
        f"共享材料：{str(material_text or '')[:1500] or '（无）'}\n"
        f"原题已核对答案（仅供你理解考点；你的变式必须自己可解，不得直接照抄这个答案）："
        f"{str(answer_summary or '')[:1000] or '（原题答案尚未核对：只能依据题干条件生成）'}\n"
        f"必须避免的题干（不得与以下任一题干相同或仅改数字）：\n{avoid_lines or '（无）'}\n"
        f"难度要求：{difficulty_note or '（未指定：保持与原题相当）'}\n"
        "请输出一道变式题的 JSON。"
    )


def validate_variant_payload(
    payload: Any,
    *,
    question_type: str,
    avoid_stems: Iterable[str] = (),
) -> tuple[dict[str, Any], list[dict]]:
    """Validate one generated variant; returns ``(clean, problems)``.

    Every rule the product depends on is enforced here, so a model cannot get
    around them by "explaining" its output:

    * only the five scorable types (``material`` is never a variant);
    * the structure satisfies the same content contract the rest of the system
      uses — :func:`apps.common.content.validate_content` is called, never
      re-implemented, and its problems are surfaced verbatim;
    * the answer is decisively checkable per type: single choice exactly one
      existing correct option, multiple choice at least two distinct existing
      ones, true/false a real boolean, fill blank one accepted answer per real
      blank, constructed response a positive rubric that sums to its stated total;
    * the stem is non-empty, is not a copy of a stem in ``avoid_stems``, and does
      not state the answer;
    * a payload that is not a JSON object, or that has no answer at all, is a
      ``problem`` — never a crash and never a silent pass.
    """
    if question_type not in SCORABLE_LEAF_TYPES:
        return {}, [
            _variant_problem(
                "variant_type_not_scorable",
                f"变式只允许五种可计分题型（不含 material），收到：{question_type!r}",
                "question_type",
            )
        ]
    if not isinstance(payload, dict):
        return {}, [_variant_problem("not_object", "模型输出不是对象（只能是 JSON 对象）", "payload")]

    problems: list[dict] = []
    # Imported lazily so this module stays importable while the app registry is
    # still being built, exactly like the extractor validation above.
    from apps.common.content import blank_ids, validate_content

    declared = payload.get("question_type")
    if declared != question_type:
        problems.append(
            _variant_problem(
                "variant_type_mismatch",
                f"模型输出的题型 {declared!r} 与要求的 {question_type!r} 不一致",
                "question_type",
            )
        )

    raw_content = payload.get("content")
    content = raw_content if isinstance(raw_content, dict) else {}
    if not isinstance(raw_content, dict):
        problems.append(_variant_problem("content_not_object", "变式缺少 content 对象", "content"))
    # The shared content contract decides what "structurally publishable" means;
    # its problems are appended untouched so the code/message/path a human sees
    # is exactly the one the publish gate would report.
    for problem in validate_content(content, question_type):
        problems.append(dict(problem))
    for index, block in enumerate(content.get("blocks") or []):
        if isinstance(block, dict) and block.get("kind") in _VARIANT_FORBIDDEN_BLOCK_KINDS:
            problems.append(
                _variant_problem(
                    "variant_assets_not_allowed",
                    f"变式题干不能包含 {block.get('kind')} 块：模型无法知道本项目的真实资产，图片必须由人工在校对时补上",
                    f"blocks[{index}]",
                )
            )

    answer = payload.get("answer_payload")
    if not isinstance(answer, dict) or not answer:
        problems.append(
            _variant_problem(
                "variant_answer_missing",
                "模型没有给出答案：缺少答案的候选不能发布，必须人工补齐并确认",
                "answer_payload",
            )
        )
        answer = answer if isinstance(answer, dict) else {}
    elif answer.get("kind") != question_type:
        problems.append(
            _variant_problem(
                "variant_answer_kind_mismatch",
                f"answer_payload.kind={answer.get('kind')!r} 必须等于题型 {question_type!r}",
                "answer_payload.kind",
            )
        )

    option_map = {
        str(option.get("id")): option
        for option in content.get("options") or []
        if isinstance(option, dict) and option.get("id")
    }
    #: Rubric rows survive only for a constructed response; every other type
    #: leaves them empty (a rubric is never invented on the model's behalf).
    rubric_rows: list[dict[str, Any]] = []
    rubric_total = Decimal("0")
    stated_total: Decimal | None = None
    stem = _normalized_for_compare(_blocks_text(content.get("blocks")))
    for avoid in avoid_stems:
        avoid_text = _normalized_for_compare(avoid)
        if stem and avoid_text and stem == avoid_text:
            problems.append(
                _variant_problem(
                    "stem_copies_source",
                    "变式题干与必须避免的题干完全相同：这不是变式，请改写题干",
                    "content.blocks",
                )
            )
            break
    for marker in _VARIANT_ANSWER_MARKERS:
        if _normalized_for_compare(marker) in stem:
            problems.append(
                _variant_problem(
                    "stem_leaks_answer",
                    f"题干疑似直接写出答案（命中“{marker}”）：答案必须能从条件推出，不能写在题干里",
                    "content.blocks",
                )
            )
            break

    if question_type == QuestionType.SINGLE_CHOICE:
        listed = answer.get("correct_option_ids")
        if isinstance(listed, list) and listed:
            problems.append(
                _variant_problem(
                    "single_choice_multiple_correct",
                    f"单选题只能有一个正确选项，模型给出 {len(listed)} 个：{listed}",
                    "answer_payload.correct_option_ids",
                )
            )
        correct = answer.get("correct_option_id")
        if not isinstance(correct, str) or not correct.strip():
            problems.append(
                _variant_problem(
                    "single_choice_correct_missing", "单选题必须给出唯一的正确选项 ID", "answer_payload.correct_option_id"
                )
            )
        elif correct not in option_map:
            problems.append(
                _variant_problem(
                    "single_choice_correct_unknown",
                    f"正确选项 {correct} 不在变式给定的选项中",
                    "answer_payload.correct_option_id",
                )
            )
        else:
            _append_option_leak(correct, option_map[correct], stem, problems)

    elif question_type == QuestionType.MULTIPLE_CHOICE:
        correct = answer.get("correct_option_ids")
        if not isinstance(correct, list) or not correct:
            problems.append(
                _variant_problem(
                    "multiple_choice_correct_missing",
                    "多选题必须给出非空的正确选项集合",
                    "answer_payload.correct_option_ids",
                )
            )
        else:
            option_ids = [str(value) for value in correct]
            if len(set(option_ids)) != len(option_ids):
                problems.append(
                    _variant_problem(
                        "multiple_choice_duplicate_correct",
                        "多选题的正确选项集合存在重复 ID",
                        "answer_payload.correct_option_ids",
                    )
                )
            if len(set(option_ids)) < 2:
                problems.append(
                    _variant_problem(
                        "multiple_choice_too_few_correct",
                        f"多选题至少要有两个正确选项，模型给出 {len(set(option_ids))} 个",
                        "answer_payload.correct_option_ids",
                    )
                )
            for option_id in option_ids:
                if option_id not in option_map:
                    problems.append(
                        _variant_problem(
                            "multiple_choice_unknown_correct",
                            f"正确选项 {option_id} 不在变式给定的选项中",
                            "answer_payload.correct_option_ids",
                        )
                    )
                else:
                    _append_option_leak(option_id, option_map[option_id], stem, problems)

    elif question_type == QuestionType.TRUE_FALSE:
        if not isinstance(answer.get("value"), bool):
            problems.append(
                _variant_problem(
                    "true_false_value_missing",
                    "判断题必须给出真正的布尔值（字符串 \"true\" 不等于布尔 true）",
                    "answer_payload.value",
                )
            )

    elif question_type == QuestionType.FILL_BLANK:
        defined_blanks = blank_ids(content)
        if not defined_blanks:
            problems.append(
                _variant_problem("fill_blank_without_blanks", "填空题的 content 必须定义至少一个空位", "content.blanks")
            )
        answers = answer.get("blanks")
        if not isinstance(answers, dict) or not answers:
            problems.append(
                _variant_problem("fill_blank_answer_missing", "填空题必须按空位给出答案", "answer_payload.blanks")
            )
        else:
            missing = [blank_id for blank_id in defined_blanks if blank_id not in answers]
            unknown = [str(blank_id) for blank_id in answers if str(blank_id) not in defined_blanks]
            if missing:
                problems.append(
                    _variant_problem(
                        "fill_blank_answer_missing_for",
                        f"空位没有答案：{', '.join(missing)}",
                        "answer_payload.blanks",
                    )
                )
            if unknown:
                problems.append(
                    _variant_problem(
                        "fill_blank_answer_unknown_blank",
                        f"答案引用了题干未定义的空位：{', '.join(unknown)}",
                        "answer_payload.blanks",
                    )
                )
            for blank_id, spec in answers.items():
                path = f"answer_payload.blanks.{blank_id}"
                if not isinstance(spec, dict):
                    problems.append(_variant_problem("blank_answer_not_object", "空位答案必须是对象", path))
                    continue
                accepted = spec.get("accepted_values")
                usable = [value for value in accepted or [] if isinstance(value, str) and value.strip()]
                if not usable:
                    problems.append(
                        _variant_problem(
                            "blank_accepted_values_missing",
                            f"空位 {blank_id} 没有可接受答案（accepted_values 必须是非空字符串数组）",
                            path,
                        )
                    )

    elif question_type == QuestionType.CONSTRUCTED_RESPONSE:
        criteria = payload.get("rubric_criteria")
        if not isinstance(criteria, list) or not criteria:
            problems.append(
                _variant_problem(
                    "rubric_criteria_missing", "大题必须给出至少一个评分点（rubric_criteria）", "rubric_criteria"
                )
            )
        else:
            seen: set[str] = set()
            for index, criterion in enumerate(criteria):
                path = f"rubric_criteria[{index}]"
                if not isinstance(criterion, dict):
                    problems.append(_variant_problem("rubric_criterion_not_object", "评分点必须是对象", path))
                    continue
                criterion_id = str(criterion.get("criterion_id") or "").strip()
                if not criterion_id:
                    problems.append(_variant_problem("rubric_criterion_id_missing", "评分点缺少 criterion_id", path))
                    continue
                if criterion_id in seen:
                    problems.append(
                        _variant_problem("rubric_criterion_duplicate", f"评分点 ID 重复：{criterion_id}", path)
                    )
                    continue
                seen.add(criterion_id)
                try:
                    score = Decimal(str(criterion.get("max_score")))
                except (InvalidOperation, TypeError, ValueError):
                    problems.append(
                        _variant_problem("rubric_criterion_score_invalid", "评分点满分必须是十进制数", path)
                    )
                    continue
                if score <= 0:
                    problems.append(
                        _variant_problem(
                            "rubric_criterion_score_not_positive", f"评分点满分必须为正数，收到 {score}", path
                        )
                    )
                    continue
                rubric_total += score
                rubric_rows.append(
                    {
                        "criterion_id": criterion_id,
                        "text": str(criterion.get("text") or "")[:500],
                        "max_score": str(score),
                        "required": bool(criterion.get("required", True)),
                    }
                )
        stated = payload.get("rubric_total_score")
        if stated in (None, ""):
            problems.append(
                _variant_problem("rubric_total_missing", "大题必须给出 rubric_total_score（各评分点之和）", "rubric_total_score")
            )
        else:
            try:
                stated_total = Decimal(str(stated))
            except (InvalidOperation, TypeError, ValueError):
                problems.append(
                    _variant_problem("rubric_total_invalid", "rubric_total_score 必须是十进制数", "rubric_total_score")
                )
            else:
                if stated_total <= 0:
                    problems.append(
                        _variant_problem(
                            "rubric_total_not_positive", f"rubric_total_score 必须为正数，收到 {stated_total}", "rubric_total_score"
                        )
                    )
                elif stated_total != rubric_total:
                    problems.append(
                        _variant_problem(
                            "rubric_total_mismatch",
                            f"评分点合计 {rubric_total} 与 rubric_total_score {stated_total} 不一致",
                            "rubric_total_score",
                        )
                    )
        if answer.get("rubric_required") is not True:
            problems.append(
                _variant_problem(
                    "rubric_required_missing",
                    "大题答案必须声明 rubric_required=true（逐评分点人工确认）",
                    "answer_payload.rubric_required",
                )
            )

    proposed_score: Decimal | None = None
    raw_score = payload.get("practice_max_score")
    if raw_score not in (None, ""):
        try:
            proposed_score = Decimal(str(raw_score))
        except (InvalidOperation, TypeError, ValueError):
            problems.append(
                _variant_problem("variant_score_invalid", "practice_max_score 必须是十进制数", "practice_max_score")
            )
        else:
            if proposed_score <= 0:
                problems.append(
                    _variant_problem(
                        "variant_score_not_positive", f"practice_max_score 必须为正数，收到 {proposed_score}", "practice_max_score"
                    )
                )
                proposed_score = None

    clean: dict[str, Any] = {
        "question_type": question_type,
        "content": content,
        "answer_payload": answer,
        "rubric_criteria": rubric_rows,
        # The stated total is kept exactly as proposed: rewriting it to the
        # computed sum would hide a disagreement a human still has to resolve.
        "rubric_total_score": str(stated_total) if stated_total is not None else None,
        "practice_max_score": str(proposed_score) if proposed_score is not None else None,
        "difficulty_note": str(payload.get("difficulty_note") or "")[:300],
        "rationale": str(payload.get("rationale") or "")[:500],
        "doubts": [str(item)[:300] for item in (payload.get("doubts") or []) if str(item).strip()][:20],
    }
    return clean, problems


def _append_option_leak(option_id: str, option: dict[str, Any], stem: str, problems: list[dict]) -> None:
    text = _normalized_for_compare(_blocks_text(option.get("blocks")))
    if len(text) >= _VARIANT_OPTION_LEAK_MIN_LENGTH and text in stem:
        problems.append(
            _variant_problem(
                "stem_leaks_answer",
                f"题干逐字包含正确选项 {option_id} 的文本：答案不能出现在题干里",
                "content.blocks",
            )
        )
