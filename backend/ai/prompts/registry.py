"""Versioned prompts and validation for AI output.

Prompts are data with an explicit version, so an `llm_run` row can always be
traced back to the exact instruction that produced it.
"""

from __future__ import annotations

from typing import Any

from apps.common.enums import QuestionType

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
