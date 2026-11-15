"""Prompts — P1 outline tag-suggestion prompt and validation."""

from __future__ import annotations

from typing import Any

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
