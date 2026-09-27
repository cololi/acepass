"""Paste-text structure parser.

Two strategies are supported and the result is always a *candidate* that a human
proofreads:

1. an explicit template with labelled sections (recommended, lossless)
2. a light heuristic for numbered question blocks

Neither strategy invents an answer. When a field cannot be determined it is left
empty and reported as an issue, which keeps unverified content out of scoring.

P1-01 adds two things the PDF import needs and neither strategy may fake:

* **material groups.** A ``【材料】`` block collects the sub-questions that follow
  it, so the parent/child relation is parsed rather than reconstructed by hand.
  Children carry ``parent_local_id`` and a candidate row is created for each, so
  the published material question can point at real child versions.
* **answer pages.** Answers printed on their own page are parsed into a
  ``{position: raw answer}`` map and *matched* onto the question candidates.
  Matching never publishes an answer key: it fills the candidate and records how
  the match was made so the proofreader confirms it (``答案匹配只产生候选``).
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
    "材料": "material",
    "材料正文": "material",
    "阅读材料": "material",
}

#: Labels that open one sub-question inside a material block.
CHILD_LABELS = {"子题", "小题", "问题", "设问", "小问"}

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
#: ``【子题1】`` / ``【第2题】`` / ``【小题 3】`` inside a material block.
CHILD_SECTION_PATTERN = re.compile(r"^\s*(?:第\s*)?([0-9]{1,2})\s*(?:题|问)?\s*$")
#: Bare headings that introduce an answer section (no 【】 brackets).
ANSWER_HEADINGS = ("参考答案", "答案与解析", "答案及解析", "答案", "答案页", "评分标准")
#: ``1．【题型】…`` — a paper prints the question number before the label.
LEADING_NUMBER_PATTERN = re.compile(r"^\s*(?:第\s*)?(\d{1,3})\s*[.、．)）]\s*(.+)$")
#: ``1. A`` / ``1、A`` / ``第 1 题 A`` / ``（1）A`` on an answer page.
ANSWER_ENTRY_PATTERN = re.compile(
    r"^\s*(?:第\s*)?[(（]?\s*(\d{1,3})\s*[)）]?\s*(?:题)?\s*[.、．)）:：]?\s*(?:【答案】|答案[:：]?)?\s*(.+?)\s*$"
)


def _split_inline_labels(line: str) -> list[tuple[str, str]]:
    """``【子题1】【题型】单选`` on one line yields two labels, not one loss."""
    labels: list[tuple[str, str]] = []
    rest = line
    while True:
        match = SECTION_PATTERN.match(rest)
        if not match:
            break
        label, remainder = match.group(1).strip(), match.group(2)
        if SECTION_PATTERN.match(remainder):
            # The reminder opens another label: keep this one empty so the text
            # lands on the label it really belongs to.
            labels.append((label, ""))
            rest = remainder
            continue
        labels.append((label, remainder))
        rest = ""
        break
    if not labels:
        return [("", line)]
    if rest.strip():  # pragma: no cover - only when the pattern loop broke early
        labels.append(("", rest))
    return labels


def parse_paste(text: str, *, structure_only: bool = False) -> list[dict[str, Any]]:
    """Parse pasted material into candidate payloads.

    A material block keeps its sub-questions: the material payload comes first and
    every child follows with ``parent_local_id`` pointing at it, so the import can
    create linked candidate rows in document order.

    ``structure_only`` drops segments that never received any structure signal (no
    【label】, no question number, no options). A paper PDF starts with page headers
    such as "2024 年真题 卷一 / 一、单项选择题"; those are not questions, and a
    proofreading queue full of header rows would hide the real ones. The paste
    path keeps the permissive behaviour it always had.
    """
    stripped = (text or "").strip()
    if not stripped:
        return []
    labelled = _parse_labelled(stripped)
    if labelled:
        return _with_structure_filter(labelled) if structure_only else labelled
    numbered = _parse_numbered(stripped)
    return _with_structure_filter(numbered) if structure_only else numbered


def _with_structure_filter(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [segment for segment in segments if segment.get("structure_signals")]


def _parse_labelled(text: str) -> list[dict[str, Any]]:
    """Explicit 【题干】/【选项】/【答案】 template.

    A new 【题干】 or 【题型】 label closes the previous question, so several
    questions can be pasted in one go without the parser merging them. A
    【材料】 block opens a parent; the 子题 that follow become its children and the
    block closes at the next 材料 or at the end of the document.
    """
    blocks: list[dict[str, Any]] = []
    counter = {"n": 0}

    def local_id(prefix: str) -> str:
        counter["n"] += 1
        return f"{prefix}{counter['n']}"

    state: dict[str, Any] = {"current": None, "pending": None, "material": None, "children": []}
    saw_label = False

    def material_open() -> bool:
        return state["material"] is not None

    def close_question() -> None:
        current = state["current"]
        if current is not None and any(
            current.get(key) for key in ("stem_text", "options_raw", "answer_raw", "type_raw")
        ):
            if current.get("in_material"):
                state["children"].append(current)
            else:
                blocks.append(_to_payload(current))
        state["current"] = None
        state["pending"] = None

    def close_material() -> None:
        material = state["material"]
        if material is not None:
            parent = _to_payload(
                {"stem_text": material["text"], "label": material["label"], "sections": {"material"}}
            )
            parent["local_id"] = material["local_id"]
            parent["question_type"] = QuestionType.MATERIAL
            parent["display_label"] = material["label"]
            parent["child_local_ids"] = [child["local_id"] for child in state["children"]]
            blocks.append(parent)
            for child in state["children"]:
                payload = _to_payload(child)
                payload["local_id"] = child["local_id"]
                payload["parent_local_id"] = material["local_id"]
                if child.get("label"):
                    payload["display_label"] = child["label"]
                blocks.append(payload)
        state["material"] = None
        state["children"] = []

    def begin(*, label: str = "", stem: str = "", in_material: bool) -> dict[str, Any]:
        close_question()
        if not label and state.get("line_label"):
            # "1．【题型】…": the number belongs to the question this line opens.
            label = state["line_label"]
            state["line_label"] = ""
        current = {
            "stem_text": stem,
            "label": label,
            "local_id": local_id("q"),
            "in_material": in_material,
        }
        state["current"] = current
        state["pending"] = "stem_text" if stem else None
        return current

    def plain(text_line: str) -> None:
        if state["current"] is not None and state["pending"]:
            _append(state["current"], state["pending"], text_line)
            return
        if material_open():
            state["material"]["text"] = f"{state['material']['text']}\n{text_line}"
            return
        if text_line.strip():
            begin(stem=text_line, in_material=False)

    for raw_line in text.splitlines():
        state["line_label"] = ""
        numbered_head = LEADING_NUMBER_PATTERN.match(raw_line)
        if numbered_head is not None and SECTION_PATTERN.match(numbered_head.group(2)):
            state["line_label"] = numbered_head.group(1)
            raw_line = numbered_head.group(2)
        for label, remainder in _split_inline_labels(raw_line):
            if not label:
                plain(remainder)
                continue
            saw_label = True
            section = SECTION_LABELS.get(label)
            child_no = ""
            material_label = ""
            if section is None:
                for prefix in CHILD_LABELS:
                    if label.startswith(prefix):
                        section = "child"
                        child_no = label[len(prefix) :].strip()
                        break
            if section is None and label.startswith("材料"):
                # 【材料1】/【材料二】: keep the label so the paper position is stable.
                section = "material"
                material_label = label[2:].strip()
            if section is None and label.isdigit():
                if material_open():
                    section, child_no = "child", label
                else:
                    close_question()
                    begin(label=label, stem=remainder, in_material=False)
                    continue

            if section == "material":
                close_question()
                close_material()
                state["material"] = {
                    "local_id": local_id("m"),
                    "text": remainder,
                    "label": material_label,
                }
                continue
            if section == "child":
                begin(label=child_no, stem=remainder, in_material=True)
                continue
            if section is None:
                # An unknown label inside a material body belongs to the material.
                if material_open() and state["current"] is None:
                    state["material"]["text"] = f"{state['material']['text']}\n{raw_line}"
                elif state["current"] is not None:
                    _append(state["current"], state["pending"], raw_line)
                continue
            if section in {"stem", "question_type"} and state["current"] and state["current"].get("stem_text"):
                close_question()
            current = state["current"]
            if current is None:
                current = begin(in_material=material_open())
            current.setdefault("sections", set()).add(section)

            if section == "question_type":
                current["type_raw"] = remainder.strip()
                state["pending"] = None
            elif section == "stem":
                current["stem_text"] = remainder
                state["pending"] = "stem_text"
            elif section == "options":
                current["options_raw"] = [remainder] if remainder else []
                state["pending"] = "options_raw"
            elif section == "answer":
                current["answer_raw"] = remainder
                state["pending"] = "answer_raw"
            elif section == "explanation":
                current["explanation_raw"] = remainder
                state["pending"] = "explanation_raw"
            elif section == "rubric":
                current["rubric_raw"] = [remainder] if remainder else []
                state["pending"] = "rubric_raw"
            elif section == "knowledge":
                current["knowledge_raw"] = remainder
                state["pending"] = None
            elif section == "source":
                current["source_raw"] = remainder
                state["pending"] = None
            elif section == "max_score":
                current["max_score_raw"] = remainder.strip()
                state["pending"] = None
    close_question()
    close_material()
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
        # Which explicit labels this segment actually carried. Used to drop page
        # headers from a PDF import without guessing from the wording.
        "structure_signals": sorted(raw.get("sections") or []),
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


# --------------------------------------------------------------------------
# P1-01: answer pages and page provenance
# --------------------------------------------------------------------------
def parse_answer_page(text: str) -> dict[str, Any]:
    """Parse an answer page/section into ``{position: raw answer}`` entries.

    Deliberately conservative: only lines that clearly start with a question
    number become entries, everything else is reported as unparsed so the
    proofreader sees what the parser could not place. Multi-line answers are
    joined until the next numbered entry.
    """
    entries: list[dict[str, Any]] = []
    unparsed: list[str] = []
    current: dict[str, Any] | None = None

    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        header = SECTION_PATTERN.match(line)
        if header is not None and SECTION_LABELS.get(header.group(1).strip()) is None:
            # A heading such as 【参考答案】 introduces the section, not an answer.
            if "答案" in header.group(1) or "解析" in header.group(1):
                continue
        elif header is None and any(line.rstrip("：: ") == marker.rstrip("：: ") for marker in ANSWER_HEADINGS):
            continue
        match = ANSWER_ENTRY_PATTERN.match(line)
        if match and _looks_like_answer_value(match.group(2)):
            current = {"label": match.group(1), "raw": match.group(2).strip()}
            entries.append(current)
            continue
        if current is not None:
            current["raw"] = f"{current['raw']}\n{line}".strip()
            continue
        unparsed.append(line)

    return {
        "entries": entries,
        "unparsed": unparsed[:50],
        "entry_count": len(entries),
    }


def _looks_like_answer_value(value: str) -> bool:
    """Guard against treating an ordinary numbered sentence as an answer."""
    cleaned = value.strip()
    if not cleaned:
        return False
    if len(cleaned) > 200:
        return False
    if re.fullmatch(r"[A-Ha-h][A-Ha-h,，、\s]*", cleaned):  # choice letters
        return True
    if cleaned in {"对", "错", "正确", "错误", "√", "×", "T", "F", "是", "否", "true", "false"}:
        return True
    return not cleaned.endswith(("。", "？", "?")) or len(cleaned) <= 30


def apply_answer_matches(segments: list[dict[str, Any]], entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Match parsed answers onto question segments — as *candidates* only.

    Two matching methods are recorded per segment so the proofreader knows how
    much to trust the pairing:

    * ``label`` — the answer's position number equals the question's label;
    * ``position`` — no label matched, so the answer was paired by order.

    Nothing here writes an answer key. The matched raw answer is offered in the
    candidate and ``answer_status_known`` stays ``False`` until a human confirms
    it, which is what keeps mechanical matching out of scoring.
    """
    by_label: dict[str, dict[str, Any]] = {}
    for entry in entries:
        by_label.setdefault(str(entry.get("label", "")).strip(), entry)

    matched_count = 0
    position_matched = 0
    results: list[dict[str, Any]] = []
    consumed: set[int] = set()
    for segment in segments:
        if segment.get("question_type") == QuestionType.MATERIAL:
            results.append({"matched": False, "reason": "material_parent"})
            continue
        label = str(segment.get("display_label") or "").strip()
        entry = by_label.get(label) if label else None
        method = "label"
        if entry is not None and id(entry) in consumed:
            # The same number cannot answer two questions: a duplicated label
            # (for example a sub-question numbered inside its material) falls back
            # to order instead of silently stealing the other question's answer.
            entry = None
        if entry is None:
            method = "position"
            entry = next((item for item in entries if id(item) not in consumed), None)
        if entry is None:
            results.append({"matched": False, "reason": "no_answer_entry"})
            continue
        consumed.add(id(entry))
        answer_payload, known, issue = _parse_answer(
            entry.get("raw", ""),
            segment.get("question_type"),
            (segment.get("content") or {}).get("options") or [],
            (segment.get("content") or {}).get("blanks") or [],
        )
        if not known:
            results.append({"matched": False, "reason": "answer_value_unusable", "raw": entry.get("raw")})
            continue
        matched_count += 1
        position_matched += 1 if method == "position" else 0
        results.append(
            {
                "matched": True,
                "method": method,
                "label": str(entry.get("label", "")),
                "raw": entry.get("raw", ""),
                "answer_payload": answer_payload,
                "parse_issue": issue,
            }
        )
    return {
        "results": results,
        "matched_count": matched_count,
        "position_matched_count": position_matched,
        "entry_count": len(entries),
        "unmatched_entry_labels": [
            str(entry.get("label"))
            for entry in entries
            if str(entry.get("label")) not in {segment.get("display_label") for segment in segments}
        ][:50],
    }


def attach_source_pages(
    segments: list[dict[str, Any]], text: str, page_map: list[tuple[int, int, int]]
) -> list[dict[str, Any]]:
    """Record which page each segment came from (来源页可追溯).

    The offset is the position of the segment's first line inside the document
    text, so a question that continues across a page break is attributed to the
    page it starts on — the page a proofreader has to open first.
    """
    cursor = 0
    for segment in segments:
        excerpt = segment.get("source_excerpt") or ""
        anchor = excerpt.split("\n", 1)[0].strip()[:40]
        offset = text.find(anchor, cursor) if anchor else -1
        if offset < 0:
            offset = cursor
        cursor = max(cursor, offset)
        segment["source_char_start"] = offset
        segment["source_page_index"] = _page_for_offset(page_map, offset)
    return segments


def _page_for_offset(page_map: list[tuple[int, int, int]], offset: int) -> int:
    for page_index, start, end in page_map:
        if start <= offset <= end:
            return page_index
    return page_map[-1][0] if page_map else 1
