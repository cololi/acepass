"""Validated question content structures.

One JSON shape is used by import candidates, question versions and the editor
UI, so a proofread draft can be published without a lossy conversion step:

    {
      "blocks": [
        {"kind": "text",  "text": "……"},
        {"kind": "math",  "latex": "x^2"},
        {"kind": "image", "asset_id": "<uuid>", "alt": "题干配图", "region_id": "<uuid>"},
        {"kind": "table", "rows": [[{"text": "..."}]], "caption": ""}
      ],
      "options": [{"id": "opt_a", "blocks": [...], "label": "A"}],   # choice types
      "blanks":  [{"blank_id": "b1", "label": "第1空", "blocks": [...]}]  # fill_blank
    }

Validation is strict and returns every problem at once. Raw HTML is refused
outright: the renderer only accepts these structured kinds and KaTeX is used in
non-trust mode, so a question can never smuggle script or arbitrary links.
"""

from __future__ import annotations

import re
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any

from apps.common.enums import QuestionType

BLOCK_KINDS = {"text", "math", "image", "table"}
MAX_BLOCKS = 120
MAX_OPTIONS = 26
MAX_BLANKS = 20
MAX_TEXT_LENGTH = 8000

_HTML_PATTERN = re.compile(r"<\s*/?\s*[a-zA-Z][^>]*>")
_SCRIPT_PATTERN = re.compile(r"(javascript:|data:text/html|<script)", re.IGNORECASE)

OPTION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_\-]{1,40}$")
BLANK_ID_PATTERN = re.compile(r"^[A-Za-z0-9_\-]{1,40}$")


class ContentProblem(dict):
    """A single blocking/warning issue found in a content structure."""

    def __init__(self, code: str, message: str, *, path: str = "", severity: str = "blocking"):
        super().__init__(code=code, message=message, path=path, severity=severity)


def _problem(code: str, message: str, path: str = "", severity: str = "blocking") -> dict:
    return {"code": code, "message": message, "path": path, "severity": severity}


def _validate_blocks(blocks: Any, path: str, problems: list[dict]) -> None:
    if blocks is None:
        return
    if not isinstance(blocks, list):
        problems.append(_problem("blocks_not_list", "题干块必须是数组", path))
        return
    if len(blocks) > MAX_BLOCKS:
        problems.append(_problem("too_many_blocks", f"题干块数量超过上限 {MAX_BLOCKS}", path))
    for index, block in enumerate(blocks):
        block_path = f"{path}[{index}]"
        if not isinstance(block, dict):
            problems.append(_problem("block_not_object", "题干块必须是对象", block_path))
            continue
        kind = block.get("kind")
        if kind not in BLOCK_KINDS:
            problems.append(_problem("unknown_block_kind", f"不支持的题干块类型：{kind!r}", block_path))
            continue
        if kind == "text":
            text = block.get("text", "")
            if not isinstance(text, str):
                problems.append(_problem("text_not_string", "文本块内容必须是字符串", block_path))
                continue
            if len(text) > MAX_TEXT_LENGTH:
                problems.append(_problem("text_too_long", "文本块过长", block_path))
            if _HTML_PATTERN.search(text) or _SCRIPT_PATTERN.search(text):
                problems.append(_problem("raw_html_rejected", "题干不允许包含 HTML 或脚本", block_path))
        elif kind == "math":
            latex = block.get("latex", "")
            if not isinstance(latex, str) or not latex.strip():
                problems.append(_problem("math_empty", "公式块缺少 latex 内容", block_path))
            elif _SCRIPT_PATTERN.search(latex):
                problems.append(_problem("raw_html_rejected", "公式块包含可疑内容", block_path))
        elif kind == "image":
            asset_id = block.get("asset_id")
            region_id = block.get("region_id")
            if not asset_id and not region_id:
                problems.append(_problem("image_without_source", "图片块必须引用本项目的资产或来源区域", block_path))
            for key, value in (("asset_id", asset_id), ("region_id", region_id)):
                if value in (None, ""):
                    continue
                try:
                    uuid.UUID(str(value))
                except (TypeError, ValueError):
                    problems.append(_problem(f"{key}_invalid", f"{key} 必须是 UUID", block_path))
        elif kind == "table":
            rows = block.get("rows")
            if not isinstance(rows, list) or not rows:
                problems.append(_problem("table_without_rows", "表格块必须包含至少一行", block_path))
                continue
            for row_index, row in enumerate(rows):
                if not isinstance(row, list):
                    problems.append(_problem("table_row_not_list", "表格行必须是数组", f"{block_path}.rows[{row_index}]"))
                    continue
                for cell_index, cell in enumerate(row):
                    if isinstance(cell, str):
                        continue
                    if not isinstance(cell, dict) or not isinstance(cell.get("text", ""), str):
                        problems.append(
                            _problem(
                                "table_cell_invalid",
                                "表格单元格必须是字符串或 {text} 对象",
                                f"{block_path}.rows[{row_index}][{cell_index}]",
                            )
                        )


def _validate_options(options: Any, problems: list[dict]) -> None:
    if options is None:
        return
    if not isinstance(options, list):
        problems.append(_problem("options_not_list", "选项必须是数组", "options"))
        return
    if not options:
        problems.append(_problem("options_empty", "选择题必须至少有一个选项", "options"))
        return
    if len(options) > MAX_OPTIONS:
        problems.append(_problem("too_many_options", f"选项数量超过上限 {MAX_OPTIONS}", "options"))
    seen: set[str] = set()
    for index, option in enumerate(options):
        path = f"options[{index}]"
        if not isinstance(option, dict):
            problems.append(_problem("option_not_object", "选项必须是对象", path))
            continue
        option_id = option.get("id")
        if not isinstance(option_id, str) or not OPTION_ID_PATTERN.match(option_id):
            problems.append(_problem("option_id_invalid", "选项 ID 必须稳定且仅含字母数字_-", path))
            continue
        if option_id in seen:
            problems.append(_problem("option_id_duplicate", f"选项 ID 重复：{option_id}", path))
        seen.add(option_id)
        _validate_blocks(option.get("blocks"), f"{path}.blocks", problems)
        label = option.get("label", "")
        if label and not isinstance(label, str):
            problems.append(_problem("option_label_invalid", "选项标签必须是字符串", path))


def _validate_blanks(blanks: Any, problems: list[dict]) -> None:
    if blanks is None:
        return
    if not isinstance(blanks, list):
        problems.append(_problem("blanks_not_list", "空位定义必须是数组", "blanks"))
        return
    if not blanks:
        problems.append(_problem("blanks_empty", "填空题必须定义至少一个空位", "blanks"))
        return
    if len(blanks) > MAX_BLANKS:
        problems.append(_problem("too_many_blanks", f"空位数量超过上限 {MAX_BLANKS}", "blanks"))
    seen: set[str] = set()
    for index, blank in enumerate(blanks):
        path = f"blanks[{index}]"
        if not isinstance(blank, dict):
            problems.append(_problem("blank_not_object", "空位必须是对象", path))
            continue
        blank_id = blank.get("blank_id")
        if not isinstance(blank_id, str) or not BLANK_ID_PATTERN.match(blank_id):
            problems.append(_problem("blank_id_invalid", "空位 ID 必须稳定且仅含字母数字_-", path))
            continue
        if blank_id in seen:
            problems.append(_problem("blank_id_duplicate", f"空位 ID 重复：{blank_id}", path))
        seen.add(blank_id)
        _validate_blocks(blank.get("blocks"), f"{path}.blocks", problems)
        if blank.get("max_score") is not None:
            try:
                if Decimal(str(blank["max_score"])) < 0:
                    problems.append(_problem("blank_score_negative", "空位分值不能为负", path))
            except (InvalidOperation, TypeError, ValueError):
                problems.append(_problem("blank_score_invalid", "空位分值必须是十进制数", path))


def validate_content(content: Any, question_type: str) -> list[dict]:
    """Return every structural problem for one content payload.

    An empty list means the payload is structurally publishable *for that type*;
    answer correctness and rubric completeness are checked separately.
    """
    problems: list[dict] = []
    if not isinstance(content, dict):
        return [_problem("content_not_object", "内容必须是对象", "content")]
    if question_type not in QuestionType.values:
        return [_problem("unknown_question_type", f"未知题型：{question_type!r}", "type")]

    blocks = content.get("blocks") or []
    _validate_blocks(blocks, "blocks", problems)
    if question_type != QuestionType.MATERIAL and not blocks:
        problems.append(_problem("stem_empty", "题干不能为空", "blocks"))

    if question_type in {QuestionType.SINGLE_CHOICE, QuestionType.MULTIPLE_CHOICE}:
        _validate_options(content.get("options"), problems)
    elif question_type == QuestionType.FILL_BLANK:
        _validate_blanks(content.get("blanks"), problems)
    return problems


def normalize_content(content: dict) -> dict:
    """Return a canonical copy: stable key order, no unknown top-level noise."""
    if not isinstance(content, dict):
        raise ValueError("content must be an object")
    normalized: dict[str, Any] = {
        "blocks": [dict(block) for block in content.get("blocks") or [] if isinstance(block, dict)],
    }
    if content.get("options"):
        normalized["options"] = [dict(option) for option in content["options"] if isinstance(option, dict)]
    if content.get("blanks"):
        normalized["blanks"] = [dict(blank) for blank in content["blanks"] if isinstance(blank, dict)]
    if content.get("table_note"):
        normalized["table_note"] = content["table_note"]
    return normalized


def option_ids(content: dict) -> list[str]:
    return [option["id"] for option in content.get("options") or [] if isinstance(option, dict) and option.get("id")]


def blank_ids(content: dict) -> list[str]:
    return [
        blank["blank_id"] for blank in content.get("blanks") or [] if isinstance(blank, dict) and blank.get("blank_id")
    ]


def content_digest(content: dict) -> str:
    import hashlib
    import json

    payload = json.dumps(normalize_content(content), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
