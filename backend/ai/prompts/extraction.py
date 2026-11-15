"""Prompts — P0 extraction prompt and payload validation (image → structured candidate)."""

from __future__ import annotations

from typing import Any

from apps.common.enums import QuestionType

EXTRACT_PROMPT_VERSION = "p0-extract-v1"


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


def build_extract_prompt(*, project_name: str, subject_name: str, source_note: str = "") -> str:
    return (
        f"{EXTRACT_SYSTEM}\n\n"
        f"项目：{project_name}\n科目：{subject_name}\n来源说明：{source_note or '（未提供）'}\n"
        "请识别这张图片中的一道题目，输出 JSON。"
    )


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
