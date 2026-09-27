"""Answer payload schemas and validation per question type.

The payload shape is the grading contract; it is validated strictly before an
answer can be marked ``checked``. Nothing here awards a score — see
``domain/grading``.

    single_choice        {"kind": "single_choice", "correct_option_id": "opt_a"}
    multiple_choice      {"kind": "multiple_choice",
                          "correct_option_ids": ["opt_a", "opt_c"],
                          "policy": "exact_match" | "partial_credit",
                          "partial_score": "2.00",
                          "wrong_score": "0.00",
                          "blank_score": "0.00"}
    true_false           {"kind": "true_false", "value": true}
    fill_blank           {"kind": "fill_blank",
                          "blanks": {"b1": {"accepted_values": ["-2", "−2"],
                                            "normalization": {"case_insensitive": false,
                                                              "strip_whitespace": true,
                                                              "fullwidth_to_halfwidth": true,
                                                              "collapse_internal_spaces": true},
                                            "max_score": "2.00",
                                            "mismatch_policy": "review",
                                            "unit": {"whitelist": {"m": "1", "cm": "0.01"},
                                                     "expected": "m"}},
                                     "b2": {"numeric": {"value": "10",
                                                        "abs_tol": "0.1",
                                                        "rel_tol": "0",
                                                        "unit_conversions": {"cm": "0.01"}}}},
                          "blank_order_matters": true}
    constructed_response {"kind": "constructed_response", "rubric_required": true}
    material             {}  # a material parent has no answer of its own
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

from apps.common.enums import MismatchPolicy, MultipleChoicePolicy, QuestionType

_OPTION_ID = re.compile(r"^[A-Za-z0-9_\-]{1,40}$")
_BLANK_ID = re.compile(r"^[A-Za-z0-9_\-]{1,40}$")
_SAFE_POLICY_KEYS = {
    "case_insensitive",
    "strip_whitespace",
    "fullwidth_to_halfwidth",
    "collapse_internal_spaces",
    "unicode_nfkc",
}


class AnswerProblem(dict):
    def __init__(self, code: str, message: str, *, path: str = ""):
        super().__init__(code=code, message=message, path=path)


def _problem(code: str, message: str, path: str = "") -> dict:
    return {"code": code, "message": message, "path": path}


def _decimal(value, path: str, problems: list[dict], *, allow_none: bool = False) -> Decimal | None:
    if value in (None, ""):
        if allow_none:
            return None
        problems.append(_problem("score_missing", "缺少分值配置", path))
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        problems.append(_problem("score_invalid", "分值必须是十进制数", path))
        return None
    if parsed < 0:
        problems.append(_problem("score_negative", "分值不能为负", path))
        return None
    return parsed


def validate_answer_payload(payload: Any, question_type: str, content: dict | None = None) -> list[dict]:
    """Return every problem found in an answer payload (empty means valid)."""
    problems: list[dict] = []
    if question_type == QuestionType.MATERIAL:
        if payload not in ({}, None):
            problems.append(_problem("material_has_answer", "共享材料父题不应带答案", "answer_payload"))
        return problems
    if not isinstance(payload, dict):
        return [_problem("answer_not_object", "答案必须是对象", "answer_payload")]

    declared = payload.get("kind")
    if declared != question_type:
        problems.append(
            _problem("answer_kind_mismatch", f"答案类型 {declared!r} 与题型 {question_type!r} 不一致", "answer_payload.kind")
        )
        return problems

    option_ids = set()
    if content:
        option_ids = {
            str(option.get("id"))
            for option in content.get("options") or []
            if isinstance(option, dict) and option.get("id")
        }
    blank_ids = []
    if content:
        blank_ids = [
            str(blank.get("blank_id"))
            for blank in content.get("blanks") or []
            if isinstance(blank, dict) and blank.get("blank_id")
        ]

    if question_type == QuestionType.SINGLE_CHOICE:
        correct = payload.get("correct_option_id")
        if not isinstance(correct, str) or not _OPTION_ID.match(correct):
            problems.append(_problem("correct_option_missing", "单选题必须指定唯一的正确选项 ID", "answer_payload"))
        elif option_ids and correct not in option_ids:
            problems.append(_problem("correct_option_unknown", f"正确选项 {correct} 不在题干选项中", "answer_payload"))

    elif question_type == QuestionType.MULTIPLE_CHOICE:
        correct = payload.get("correct_option_ids")
        if not isinstance(correct, list) or not correct:
            problems.append(_problem("correct_options_missing", "多选题必须给出非空的正确选项集合", "answer_payload"))
        else:
            if len(set(map(str, correct))) != len(correct):
                problems.append(_problem("correct_options_duplicate", "正确选项集合存在重复 ID", "answer_payload"))
            for option_id in correct:
                if not isinstance(option_id, str) or not _OPTION_ID.match(option_id):
                    problems.append(_problem("correct_option_invalid", "选项 ID 无效", "answer_payload"))
                elif option_ids and option_id not in option_ids:
                    problems.append(
                        _problem("correct_option_unknown", f"正确选项 {option_id} 不在题干选项中", "answer_payload")
                    )
        policy = payload.get("policy", MultipleChoicePolicy.EXACT_MATCH)
        if policy not in MultipleChoicePolicy.values:
            problems.append(_problem("mc_policy_invalid", "多选计分策略无效", "answer_payload.policy"))
        if policy == MultipleChoicePolicy.PARTIAL_CREDIT:
            _decimal(payload.get("partial_score"), "answer_payload.partial_score", problems)
        else:
            if payload.get("partial_score") not in (None, "", "0", "0.00"):
                problems.append(
                    _problem(
                        "partial_score_without_policy",
                        "未选择少选部分分策略时不应配置部分分（避免隐式猜测）",
                        "answer_payload.partial_score",
                    )
                )
        _decimal(payload.get("wrong_score", "0"), "answer_payload.wrong_score", problems, allow_none=True)
        _decimal(payload.get("blank_score", "0"), "answer_payload.blank_score", problems, allow_none=True)

    elif question_type == QuestionType.TRUE_FALSE:
        if not isinstance(payload.get("value"), bool):
            problems.append(_problem("tf_value_missing", "判断题必须给出布尔标准答案（false 不等于未答）", "answer_payload"))

    elif question_type == QuestionType.FILL_BLANK:
        blanks = payload.get("blanks")
        if not isinstance(blanks, dict) or not blanks:
            problems.append(_problem("blanks_missing", "填空题必须按空位给出答案", "answer_payload.blanks"))
        else:
            if blank_ids:
                missing = [blank_id for blank_id in blank_ids if blank_id not in blanks]
                unknown = [blank_id for blank_id in blanks if blank_id not in blank_ids]
                if missing:
                    problems.append(_problem("blank_answer_missing", f"缺少空位答案：{', '.join(missing)}", "answer_payload.blanks"))
                if unknown:
                    problems.append(_problem("blank_answer_unknown", f"存在题干未定义的空位：{', '.join(unknown)}", "answer_payload.blanks"))
            for blank_id, spec in blanks.items():
                path = f"answer_payload.blanks.{blank_id}"
                if not _BLANK_ID.match(str(blank_id)):
                    problems.append(_problem("blank_id_invalid", "空位 ID 无效", path))
                    continue
                if not isinstance(spec, dict):
                    problems.append(_problem("blank_spec_invalid", "空位答案必须是对象", path))
                    continue
                accepted = spec.get("accepted_values")
                numeric = spec.get("numeric")
                if not accepted and not numeric:
                    problems.append(
                        _problem("blank_without_rule", "每个空位必须给出可接受答案或数值规则，无法判断时转人工复核", path)
                    )
                if accepted is not None:
                    if not isinstance(accepted, list) or not accepted:
                        problems.append(_problem("accepted_values_invalid", "accepted_values 必须是非空数组", path))
                    elif not all(isinstance(value, str) for value in accepted):
                        problems.append(_problem("accepted_values_invalid", "accepted_values 必须是字符串数组", path))
                normalization = spec.get("normalization")
                if normalization is not None:
                    if not isinstance(normalization, dict):
                        problems.append(_problem("normalization_invalid", "归一化开关必须是对象", path))
                    else:
                        unknown = set(normalization) - _SAFE_POLICY_KEYS
                        if unknown:
                            problems.append(
                                _problem("normalization_unknown", f"不支持的归一化开关：{', '.join(sorted(unknown))}", path)
                            )
                        if normalization.get("delete_symbols"):
                            problems.append(
                                _problem("normalization_unsafe", "禁止全局删除负号/标点等符号", path)
                            )
                if numeric is not None:
                    if not isinstance(numeric, dict):
                        problems.append(_problem("numeric_invalid", "numeric 规则必须是对象", path))
                    else:
                        _decimal(numeric.get("value"), f"{path}.numeric.value", problems)
                        _decimal(numeric.get("abs_tol", "0"), f"{path}.numeric.abs_tol", problems, allow_none=True)
                        _decimal(numeric.get("rel_tol", "0"), f"{path}.numeric.rel_tol", problems, allow_none=True)
                        conversions = numeric.get("unit_conversions")
                        if conversions is not None:
                            if not isinstance(conversions, dict):
                                problems.append(_problem("unit_conversions_invalid", "单位换算表必须是对象", path))
                            else:
                                for unit, factor in conversions.items():
                                    _decimal(factor, f"{path}.numeric.unit_conversions.{unit}", problems)
                policy = spec.get("mismatch_policy", MismatchPolicy.REVIEW)
                if policy not in MismatchPolicy.values:
                    problems.append(_problem("mismatch_policy_invalid", "不匹配处理策略无效", path))
                _decimal(spec.get("max_score", "0"), f"{path}.max_score", problems, allow_none=True)
                unit = spec.get("unit")
                if unit is not None:
                    if not isinstance(unit, dict):
                        problems.append(_problem("unit_invalid", "单位规则必须是对象", path))
                    elif unit.get("whitelist") is not None and not isinstance(unit["whitelist"], dict):
                        problems.append(_problem("unit_whitelist_invalid", "单位白名单必须是对象", path))

    elif question_type == QuestionType.CONSTRUCTED_RESPONSE:
        if payload.get("rubric_required") is not True:
            problems.append(_problem("rubric_required", "大题必须声明需要 rubric 逐评分点确认", "answer_payload"))

    return problems


def blank_specs(payload: dict) -> dict[str, dict]:
    blanks = payload.get("blanks")
    return blanks if isinstance(blanks, dict) else {}


def normalization_flags(spec: dict) -> dict:
    flags = spec.get("normalization") or {}
    if not isinstance(flags, dict):
        return {}
    return {key: bool(value) for key, value in flags.items() if key in _SAFE_POLICY_KEYS}


def blank_max_score(spec: dict, fallback: Decimal) -> Decimal:
    raw = spec.get("max_score")
    if raw in (None, ""):
        return fallback
    try:
        return Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError):
        return fallback


def sum_blank_scores(payload: dict) -> Decimal | None:
    """Total configured blank score, or None when any blank has no score."""
    total = Decimal("0")
    for spec in blank_specs(payload).values():
        raw = spec.get("max_score") if isinstance(spec, dict) else None
        if raw in (None, ""):
            continue
        try:
            total += Decimal(str(raw))
        except (InvalidOperation, TypeError, ValueError):
            return None
    return total
