"""Paste-text structure parser.

Two strategies are supported and the result is always a *candidate* that a human
proofreads:

1. an explicit template with labelled sections (recommended, lossless)
2. a light heuristic for numbered question blocks

Neither strategy invents an answer. When a field cannot be determined it is left
empty and reported as an issue, which keeps unverified content out of scoring.
"""

from __future__ import annotations

import re
from typing import Any

from apps.common.enums import QuestionType

SECTION_LABELS = {
    "题干": "stem",
    "题目": "stem",
    "题型": "question_type",
    "选项": "options",
    "答案": "answer",
    "解析": "explanation",
    "评分标准": "rubric",
    "评分点": "rubric",
    "考点": "knowledge",
    "来源": "source",
    "分值": "max_score",
}

TYPE_ALIASES = {
    "单选": QuestionType.SINGLE_CHOICE,
    "单选题": QuestionType.SINGLE_CHOICE,
    "single": QuestionType.SINGLE_CHOICE,
    "多选": QuestionType.MULTIPLE_CHOICE,
    "多选题": QuestionType.MULTIPLE_CHOICE,
    "multiple": QuestionType.MULTIPLE_CHOICE,
    "判断": QuestionType.TRUE_FALSE,
    "判断题": QuestionType.TRUE_FALSE,
    "true_false": QuestionType.TRUE_FALSE,
    "填空": QuestionType.FILL_BLANK,
    "填空题": QuestionType.FILL_BLANK,
    "fill_blank": QuestionType.FILL_BLANK,
    "大题": QuestionType.CONSTRUCTED_RESPONSE,
    "主观题": QuestionType.CONSTRUCTED_RESPONSE,
    "简答": QuestionType.CONSTRUCTED_RESPONSE,
    "constructed_response": QuestionType.CONSTRUCTED_RESPONSE,
    "材料": QuestionType.MATERIAL,
    "材料题": QuestionType.MATERIAL,
    "material": QuestionType.MATERIAL,
}

SECTION_PATTERN = re.compile(r"^\s*[【\[]\s*([^】\]]+?)\s*[】\]]\s*(.*)$")
OPTION_PATTERN = re.compile(r"^\s*([A-Ha-h])\s*[.、)）:：]\s*(.+)$")
NUMBERED_PATTERN = re.compile(r"^\s*(?:第\s*)?(\d{1,3})\s*[题.、)）]\s*(.*)$")
BLANK_MARKER = re.compile(r"_{2,}|（\s*）|\(\s*\)")
ANS_NUMBER_PATTERN = re.compile(r"^\s*(?:第\s*)?(\d{1,3})\s*[题.、)）:：]\s*(.+)$")


def parse_paste(text: str) -> list[dict[str, Any]]:
    """Parse pasted material into candidate payloads."""
    stripped = (text or "").strip()
    if not stripped:
        return []
    labelled = _parse_labelled(stripped)
    if labelled:
        return labelled
    return _parse_numbered(stripped)


def _parse_labelled(text: str) -> list[dict[str, Any]]:
    """Explicit 【题干】/【选项】/【答案】 template.

    A new 【题干】 or 【题型】 label closes the previous question, so several
    questions can be pasted in one go without the parser merging them.
    """
    holder: dict[str, Any] = {"current": None, "pending_section": None}
    blocks: list[dict[str, Any]] = []
    saw_label = False

    def flush() -> None:
        current = holder["current"]
        if current and any(
            current.get(key) for key in ("stem_text", "options_raw", "answer_raw", "type_raw")
        ):
            blocks.append(_to_payload(current))
        holder["current"] = None

    def ensure_current() -> dict[str, Any]:
        if holder["current"] is None:
            holder["current"] = {}
        return holder["current"]

    for raw_line in text.splitlines():
        match = SECTION_PATTERN.match(raw_line)
        if not match:
            if holder["current"] is not None and holder["pending_section"]:
                _append(holder["current"], holder["pending_section"], raw_line)
            elif holder["current"] is None and raw_line.strip():
                holder["current"] = {"stem_text": raw_line}
                holder["pending_section"] = "stem_text"
            continue

        saw_label = True
        label, remainder = match.group(1).strip(), match.group(2)
        section = SECTION_LABELS.get(label)

        if label.isdigit() and section is None:
            # A numbered question inside an otherwise labelled document.
            flush()
            holder["current"] = {"stem_text": remainder, "label": label}
            holder["pending_section"] = "stem_text"
            continue
        if section is None:
            if holder["current"] is not None:
                _append(holder["current"], holder["pending_section"], raw_line)
            continue
        if section in {"stem", "question_type"} and holder["current"] and holder["current"].get("stem_text"):
            flush()
        current = ensure_current()

        if section == "question_type":
            current["type_raw"] = remainder.strip()
            holder["pending_section"] = None
        elif section == "stem":
            current["stem_text"] = remainder
            holder["pending_section"] = "stem_text"
        elif section == "options":
            current["options_raw"] = [remainder] if remainder else []
            holder["pending_section"] = "options_raw"
        elif section == "answer":
            current["answer_raw"] = remainder
            holder["pending_section"] = "answer_raw"
        elif section == "explanation":
            current["explanation_raw"] = remainder
            holder["pending_section"] = "explanation_raw"
        elif section == "rubric":
            current["rubric_raw"] = [remainder] if remainder else []
            holder["pending_section"] = "rubric_raw"
        elif section == "knowledge":
            current["knowledge_raw"] = remainder
            holder["pending_section"] = None
        elif section == "source":
            current["source_raw"] = remainder
            holder["pending_section"] = None
        elif section == "max_score":
            current["max_score_raw"] = remainder.strip()
            holder["pending_section"] = None
    flush()
    if not saw_label:
        return []
    return blocks


def _append(current: dict[str, Any], section: str | None, line: str) -> None:
    if section in ("stem_text",):
        current["stem_text"] = f"{current.get('stem_text', '')}\n{line}"
    elif section == "options_raw":
        current.setdefault("options_raw", []).append(line)
    elif section in ("answer_raw", "explanation_raw"):
        current[section] = f"{current.get(section, '')}\n{line}"
    elif section == "rubric_raw":
        current.setdefault("rubric_raw", []).append(line)


def _parse_numbered(text: str) -> list[dict[str, Any]]:
    """Heuristic fallback: numbered questions with A. B. C. options."""
    blocks: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in text.splitlines():
        numbered = NUMBERED_PATTERN.match(line)
        if numbered and not OPTION_PATTERN.match(line):
            if current:
                blocks.append(_to_payload(current))
            current = {"stem_text": numbered.group(2), "label": numbered.group(1)}
            continue
        if current is None:
            if line.strip():
                current = {"stem_text": line}
            continue
        option = OPTION_PATTERN.match(line)
        if option:
            current.setdefault("options_raw", []).append(line)
        else:
            current["stem_text"] = f"{current.get('stem_text', '')}\n{line}"
    if current:
        blocks.append(_to_payload(current))
    return blocks


def _to_payload(raw: dict[str, Any]) -> dict[str, Any]:
    options_text = "\n".join(raw.get("options_raw") or [])
    stem_text = (raw.get("stem_text") or "").strip()
    if options_text:
        stem_text = stem_text.replace(options_text, "").strip()
    question_type, type_issue = _resolve_type(raw, stem_text, options_text)
    options = _parse_options(raw.get("options_raw") or [])
    blanks = _parse_blanks(stem_text)
    content: dict[str, Any] = {"blocks": [{"kind": "text", "text": stem_text}]}
    if question_type in {QuestionType.SINGLE_CHOICE, QuestionType.MULTIPLE_CHOICE}:
        content["options"] = options
    if question_type == QuestionType.FILL_BLANK:
        content["blanks"] = blanks

    answer_payload, answer_known, answer_issue = _parse_answer(raw.get("answer_raw", ""), question_type, options, blanks)
    payload: dict[str, Any] = {
        "question_type": question_type,
        "display_label": raw.get("label") or "",
        "content": content,
        "answer_payload": answer_payload,
        "answer_status_known": answer_known,
        "explanation_blocks": _text_blocks(raw.get("explanation_raw", "")),
        "source_excerpt": (raw.get("stem_text") or "")[:1000],
        "parse_issues": [issue for issue in (type_issue, answer_issue) if issue],
        "practice_max_score": raw.get("max_score_raw") or None,
    }
    knowledge = (raw.get("knowledge_raw") or "").strip()
    if knowledge:
        payload["knowledge_hint"] = knowledge
    source = (raw.get("source_raw") or "").strip()
    if source:
        payload["source_note"] = source
    rubric_lines = [line for line in (raw.get("rubric_raw") or []) if line.strip()]
    if rubric_lines:
        payload["rubric_criteria"] = _parse_rubric(rubric_lines)
    return payload


def _resolve_type(raw: dict[str, Any], stem: str, options_text: str) -> tuple[str, str | None]:
    declared = (raw.get("type_raw") or "").strip()
    if declared:
        resolved = TYPE_ALIASES.get(declared.replace(" ", ""))
        if resolved:
            return resolved, None
        return QuestionType.SINGLE_CHOICE, f"未识别的题型声明“{declared}”，已暂按单选题处理，请校对。"
    if options_text:
        correct = (raw.get("answer_raw") or "").strip().upper()
        letters = re.findall(r"[A-H]", correct)
        if len(set(letters)) > 1:
            return QuestionType.MULTIPLE_CHOICE, None
        return QuestionType.SINGLE_CHOICE, None
    if re.search(r"正确|错误|对|错|√|×", stem) and len(stem) < 200:
        if re.search(r"(判断|是否正确|说法)", stem):
            return QuestionType.TRUE_FALSE, None
    if BLANK_MARKER.search(stem):
        return QuestionType.FILL_BLANK, None
    if len(stem) > 80:
        return QuestionType.CONSTRUCTED_RESPONSE, "未声明题型且题干较长，已暂按大题处理，请校对。"
    return QuestionType.SINGLE_CHOICE, "未能确定题型，已暂按单选题处理，请校对。"


def _parse_options(lines: list[str]) -> list[dict[str, Any]]:
    options: list[dict[str, Any]] = []
    for line in lines:
        match = OPTION_PATTERN.match(line.strip())
        if not match:
            continue
        letter = match.group(1).upper()
        text = match.group(2).strip()
        options.append(
            {
                "id": f"opt_{letter.lower()}",
                "label": letter,
                "blocks": [{"kind": "text", "text": text}],
            }
        )
    return options


def _parse_blanks(stem: str) -> list[dict[str, Any]]:
    count = len(BLANK_MARKER.findall(stem))
    return [
        {"blank_id": f"b{index + 1}", "label": f"第{index + 1}空"}
        for index in range(max(count, 0))
    ]


def _parse_answer(
    raw_answer: str, question_type: str, options: list[dict[str, Any]], blanks: list[dict[str, Any]]
) -> tuple[dict[str, Any], bool, str | None]:
    text = (raw_answer or "").strip()
    if not text:
        return {}, False, "未提供答案；发布前必须填写并人工核对。"
    if question_type in {QuestionType.SINGLE_CHOICE, QuestionType.MULTIPLE_CHOICE}:
        # Only answer-like letter groups are read, so prose (for example a
        # Chinese explanation containing "A") cannot be mistaken for options.
        letters = [
            letter.upper()
            for group in re.findall(r"\b([A-Ha-h]{1,8})\b", text)
            for letter in group
        ]
        known_ids = {option["id"] for option in options}
        selected = [f"opt_{letter.lower()}" for letter in letters if f"opt_{letter.lower()}" in known_ids]
        if not selected:
            return {}, False, "答案未匹配到任何选项 ID，请手工选择。"
        if question_type == QuestionType.SINGLE_CHOICE:
            if len(selected) > 1:
                # The declared type wins: take the first letter and ask a human
                # to confirm, instead of silently switching the question type.
                return (
                    {"kind": "single_choice", "correct_option_id": selected[0]},
                    True,
                    f"题型标注为单选，但答案解析出多个选项（{', '.join(selected)}），已取第一个，请校对。",
                )
            return {"kind": "single_choice", "correct_option_id": selected[0]}, True, None
        return {"kind": "multiple_choice", "correct_option_ids": selected, "policy": "exact_match"}, True, None
    if question_type == QuestionType.TRUE_FALSE:
        if re.search(r"^(对|正确|是|√|T|true)", text, re.IGNORECASE):
            return {"kind": "true_false", "value": True}, True, None
        if re.search(r"^(错|错误|否|×|F|false)", text, re.IGNORECASE):
            return {"kind": "true_false", "value": False}, True, None
        return {}, False, "判断题答案无法解析为真/假，请手工选择。"
    if question_type == QuestionType.FILL_BLANK:
        parts = [part.strip() for part in re.split(r"[;；,，|]", text) if part.strip()]
        if not blanks:
            return {}, False, "题干中未找到空位标记（__ 或（ ）），请先在题干中标记空位。"
        if len(parts) != len(blanks):
            return {}, False, f"答案数量（{len(parts)}）与空位数（{len(blanks)}）不一致，请核对。"
        return (
            {
                "kind": "fill_blank",
                "blank_order_matters": True,
                "blanks": {
                    blank["blank_id"]: {
                        "accepted_values": [parts[index]],
                        "normalization": {"strip_whitespace": True, "fullwidth_to_halfwidth": True},
                        "max_score": None,
                        "mismatch_policy": "review",
                    }
                    for index, blank in enumerate(blanks)
                },
            },
            True,
            None,
        )
    if question_type == QuestionType.CONSTRUCTED_RESPONSE:
        return {"kind": "constructed_response", "rubric_required": True}, True, None
    return {}, False, "该题型暂不支持从文本解析答案。"


def _parse_rubric(lines: list[str]) -> list[dict[str, Any]]:
    criteria: list[dict[str, Any]] = []
    for index, line in enumerate(lines):
        cleaned = SECTION_PATTERN.sub(lambda m: m.group(2), line).strip()
        if not cleaned:
            continue
        match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*分", cleaned)
        score = match.group(1) if match else "0"
        text = re.sub(r"[（(]?\s*[0-9]+(?:\.[0-9]+)?\s*分\s*[)）]?", "", cleaned).strip()
        criteria.append(
            {
                "criterion_id": f"c{index + 1}",
                "text": text or cleaned,
                "max_score": score,
                "required": True,
            }
        )
    return criteria


def _text_blocks(text: str) -> list[dict[str, Any]]:
    cleaned = (text or "").strip()
    return [{"kind": "text", "text": cleaned}] if cleaned else []


def normalise_answer_map(entries: dict[str, str]) -> dict[str, str]:
    """First normalisation of a bare answer map (used by tests and API clients)."""
    return {key: value.strip() for key, value in entries.items()}
