"""Deterministic grading.

Every adapter returns the same :class:`GradeResult` shape (docs/03 §4.1). A type
that has no complete rule returns ``pending_review`` for the affected part
instead of a guessed score, and a not-yet-graded part is never treated as 0.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from apps.common.answers import blank_max_score, blank_specs, normalization_flags
from apps.common.enums import GradeMethod, GradeStatus, MismatchPolicy, MultipleChoicePolicy, QuestionType

ZERO = Decimal("0")


@dataclass
class GradePart:
    part_id: str
    status: str
    score: Decimal | None
    max_score: Decimal
    method: str | None
    detail: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "part_id": self.part_id,
            "score": None if self.score is None else str(self.score),
            "max_score": str(self.max_score),
            "status": self.status,
            "method": self.method,
            "detail": self.detail,
        }


@dataclass
class GradeResult:
    status: str
    method: str
    max_score: Decimal
    parts: list[GradePart] = field(default_factory=list)
    confirmed_score: Decimal | None = None
    pending_max_score: Decimal = ZERO
    is_fully_confirmed: bool = False
    rule_snapshot: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "method": self.method,
            "confirmed_score": None if self.confirmed_score is None else str(self.confirmed_score),
            "max_score": str(self.max_score),
            "pending_max_score": str(self.pending_max_score),
            "is_fully_confirmed": self.is_fully_confirmed,
            "parts": [part.as_dict() for part in self.parts],
            "notes": self.notes,
        }

    @property
    def confirmed_fraction(self) -> Decimal | None:
        if self.confirmed_score is None or self.max_score <= 0:
            return None
        return (self.confirmed_score / self.max_score).quantize(Decimal("0.0001"))


def _finalize(parts: list[GradePart], max_score: Decimal, rule_snapshot: dict, notes: list[str]) -> GradeResult:
    confirmed = ZERO
    pending = ZERO
    has_confirmed = False
    has_pending = False
    methods: set[str] = set()
    for part in parts:
        if part.status == GradeStatus.CONFIRMED:
            has_confirmed = True
            confirmed += part.score or ZERO
            if part.method:
                methods.add(part.method)
        elif part.status == GradeStatus.PENDING_REVIEW:
            has_pending = True
            pending += part.max_score
        elif part.status == GradeStatus.VOID:
            has_pending = True
            pending += part.max_score

    if has_pending and has_confirmed:
        status = GradeStatus.PENDING_REVIEW
        method = GradeMethod.MIXED
    elif has_pending:
        status = GradeStatus.PENDING_REVIEW
        method = GradeMethod.MIXED if len(methods) > 1 else (next(iter(methods)) if methods else GradeMethod.DETERMINISTIC)
    elif has_confirmed:
        status = GradeStatus.CONFIRMED
        method = GradeMethod.MIXED if len(methods) > 1 else (next(iter(methods)) if methods else GradeMethod.DETERMINISTIC)
    else:
        status = GradeStatus.VOID
        method = GradeMethod.MIXED

    fully_confirmed = (
        status == GradeStatus.CONFIRMED
        and pending == ZERO
        and confirmed == max_score
        and all(part.status == GradeStatus.CONFIRMED for part in parts)
    )
    return GradeResult(
        status=status,
        method=method,
        max_score=max_score,
        parts=parts,
        confirmed_score=confirmed if has_confirmed else None,
        pending_max_score=pending,
        is_fully_confirmed=fully_confirmed,
        rule_snapshot=rule_snapshot,
        notes=notes,
    )


def _pending_all(part_ids: Iterable[str], max_score: Decimal, reason: str, rule_snapshot: dict) -> GradeResult:
    parts = [
        GradePart(
            part_id=part_id,
            status=GradeStatus.PENDING_REVIEW,
            score=None,
            max_score=max_score,
            method=None,
            detail={"reason": reason},
        )
        for part_id in part_ids
    ]
    return _finalize(parts, max_score, rule_snapshot, [reason])


# --------------------------------------------------------------------------
# Objective adapters
# --------------------------------------------------------------------------
def grade_single_choice(
    *, raw_answer: dict, answer_payload: dict, max_score: Decimal, rule: dict
) -> GradeResult:
    correct = answer_payload.get("correct_option_id")
    if not correct:
        return _pending_all(["choice"], max_score, "标准答案缺失，无法自动判分", {"rule": rule})
    selected = raw_answer.get("selected_option_ids") or raw_answer.get("selected_option_id")
    if isinstance(selected, str):
        selected_list = [selected]
    elif isinstance(selected, list):
        selected_list = [str(value) for value in selected]
    else:
        selected_list = []
    wrong_score = _dec(rule.get("wrong_score"), ZERO)
    blank_score = _dec(rule.get("blank_score"), ZERO)
    if not selected_list:
        score, status, detail = blank_score, GradeStatus.CONFIRMED, {"outcome": "blank"}
    elif len(selected_list) > 1:
        score, status, detail = wrong_score, GradeStatus.CONFIRMED, {"outcome": "invalid_multiple_selection"}
    elif selected_list[0] == correct:
        score, status, detail = max_score, GradeStatus.CONFIRMED, {"outcome": "correct"}
    else:
        score, status, detail = wrong_score, GradeStatus.CONFIRMED, {"outcome": "wrong"}
    part = GradePart("choice", status, score, max_score, GradeMethod.DETERMINISTIC, detail)
    return _finalize([part], max_score, {"correct_option_id": correct, "rule": rule}, [])


def grade_multiple_choice(
    *, raw_answer: dict, answer_payload: dict, max_score: Decimal, rule: dict
) -> GradeResult:
    correct = [str(value) for value in answer_payload.get("correct_option_ids") or []]
    if not correct:
        return _pending_all(["choice"], max_score, "标准答案缺失，无法自动判分", {"rule": rule})
    policy = answer_payload.get("policy") or rule.get("policy") or MultipleChoicePolicy.EXACT_MATCH
    partial = answer_payload.get("partial_score", rule.get("partial_score"))
    wrong_score = _dec(answer_payload.get("wrong_score", rule.get("wrong_score")), ZERO)
    blank_score = _dec(answer_payload.get("blank_score", rule.get("blank_score")), ZERO)

    selected_raw = raw_answer.get("selected_option_ids")
    if selected_raw is None:
        selected_raw = raw_answer.get("selected_option_id")
    if isinstance(selected_raw, str):
        selected = [selected_raw]
    elif isinstance(selected_raw, list):
        selected = [str(value) for value in selected_raw]
    else:
        selected = []
    if len(set(selected)) != len(selected):
        return _pending_all(["choice"], max_score, "提交中存在重复选项 ID，需人工确认", {"rule": rule})

    selected_set = set(selected)
    correct_set = set(correct)
    snapshot = {"correct_option_ids": correct, "policy": policy, "partial_score": str(partial) if partial else None, "rule": rule}

    if not selected_set:
        part = GradePart("choice", GradeStatus.CONFIRMED, blank_score, max_score, GradeMethod.DETERMINISTIC, {"outcome": "blank"})
        return _finalize([part], max_score, snapshot, [])
    if selected_set == correct_set:
        part = GradePart("choice", GradeStatus.CONFIRMED, max_score, max_score, GradeMethod.DETERMINISTIC, {"outcome": "correct"})
        return _finalize([part], max_score, snapshot, [])
    if selected_set & correct_set == selected_set:
        # A strict, non-empty subset of the correct set.
        if policy == MultipleChoicePolicy.PARTIAL_CREDIT:
            if partial in (None, ""):
                return _pending_all(["choice"], max_score, "少选部分分规则未配置，不猜测分数", snapshot)
            score = min(_dec(partial, ZERO), max_score)
            part = GradePart(
                "choice",
                GradeStatus.CONFIRMED,
                score,
                max_score,
                GradeMethod.DETERMINISTIC,
                {"outcome": "partial", "missing": sorted(correct_set - selected_set)},
            )
            return _finalize([part], max_score, snapshot, [])
        part = GradePart(
            "choice",
            GradeStatus.CONFIRMED,
            ZERO,
            max_score,
            GradeMethod.DETERMINISTIC,
            {"outcome": "incomplete_exact_match", "missing": sorted(correct_set - selected_set)},
        )
        return _finalize([part], max_score, snapshot, [])
    part = GradePart(
        "choice",
        GradeStatus.CONFIRMED,
        wrong_score,
        max_score,
        GradeMethod.DETERMINISTIC,
        {"outcome": "wrong", "extra": sorted(selected_set - correct_set)},
    )
    return _finalize([part], max_score, snapshot, [])


def grade_true_false(*, raw_answer: dict, answer_payload: dict, max_score: Decimal, rule: dict) -> GradeResult:
    correct = answer_payload.get("value")
    if not isinstance(correct, bool):
        return _pending_all(["statement"], max_score, "标准答案缺失，无法自动判分", {"rule": rule})
    submitted = raw_answer.get("value", None)
    wrong_score = _dec(rule.get("wrong_score"), ZERO)
    blank_score = _dec(rule.get("blank_score"), ZERO)
    snapshot = {"correct_value": correct, "rule": rule}
    if submitted is None:
        part = GradePart(
            "statement", GradeStatus.CONFIRMED, blank_score, max_score, GradeMethod.DETERMINISTIC, {"outcome": "blank"}
        )
    elif not isinstance(submitted, bool):
        return _pending_all(["statement"], max_score, "提交值不是布尔值，需人工确认", snapshot)
    elif submitted == correct:
        part = GradePart(
            "statement", GradeStatus.CONFIRMED, max_score, max_score, GradeMethod.DETERMINISTIC, {"outcome": "correct"}
        )
    else:
        part = GradePart(
            "statement", GradeStatus.CONFIRMED, wrong_score, max_score, GradeMethod.DETERMINISTIC, {"outcome": "wrong"}
        )
    return _finalize([part], max_score, snapshot, [])


# --------------------------------------------------------------------------
# Fill in the blank
# --------------------------------------------------------------------------
def normalize_text(value: str, flags: dict) -> str:
    """Normalisations that are explicitly opted in per blank.

    Symbols are never deleted globally: a negative sign or a unit can change the
    meaning of an answer.
    """
    import unicodedata

    text = value
    if flags.get("unicode_nfkc"):
        text = unicodedata.normalize("NFKC", text)
    if flags.get("fullwidth_to_halfwidth"):
        text = "".join(
            chr(ord(char) - 0xFEE0) if 0xFF01 <= ord(char) <= 0xFF5E else char for char in text
        )
    if flags.get("strip_whitespace", True):
        text = text.strip()
    if flags.get("collapse_internal_spaces"):
        text = " ".join(text.split())
    if flags.get("case_insensitive"):
        text = text.casefold()
    return text


_UNIT_PATTERN_TEXT = r"[^\s0-9+\-.,]+"
#: Arithmetic or fraction markers: a symbol-equivalence decision is deferred to a human.
_EXPRESSION_PATTERN = __import__("re").compile(r"[*/^()\[\]{}]|(?<![\d.])[+\-](?![\d.])|/")


def parse_numeric(value: str) -> tuple[Decimal | None, str]:
    """Parse a decimal and an optional trailing unit, without evaluating code."""
    import re

    if value is None:
        return None, ""
    text = str(value).strip()
    if not text:
        return None, ""
    match = re.match(rf"^([+-]?[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)\s*({_UNIT_PATTERN_TEXT})?$", text)
    if not match:
        return None, ""
    try:
        return Decimal(match.group(1)), (match.group(2) or "")
    except InvalidOperation:
        return None, ""


def grade_fill_blank(*, raw_answer: dict, answer_payload: dict, max_score: Decimal, rule: dict) -> GradeResult:
    specs = blank_specs(answer_payload)
    submitted = raw_answer.get("blanks")
    if not isinstance(submitted, dict):
        submitted = {}
    if not specs:
        return _pending_all(["blank"], max_score, "缺少按空位的答案规则，无法自动判分", {"rule": rule})

    default_mismatch = rule.get("mismatch_policy", MismatchPolicy.REVIEW)
    per_blank_default = (max_score / len(specs)) if specs else max_score
    parts: list[GradePart] = []
    for blank_id, spec in specs.items():
        blank_max = blank_max_score(spec, per_blank_default)
        part = _grade_one_blank(
            blank_id=blank_id,
            spec=spec,
            submitted=submitted.get(blank_id),
            blank_max=blank_max,
            default_mismatch=default_mismatch,
        )
        parts.append(part)
    snapshot = {
        "blank_ids": list(specs.keys()),
        "default_mismatch_policy": default_mismatch,
        "rule": rule,
    }
    return _finalize(parts, max_score, snapshot, [])


def _grade_one_blank(
    *, blank_id: str, spec: dict, submitted: Any, blank_max: Decimal, default_mismatch: str
) -> GradePart:
    policy = spec.get("mismatch_policy", default_mismatch)
    numeric = spec.get("numeric")
    accepted = spec.get("accepted_values") or []
    flags = normalization_flags(spec)
    unit_rule = spec.get("unit") or {}

    if submitted is None:
        return GradePart(blank_id, GradeStatus.PENDING_REVIEW, None, blank_max, None, {"reason": "未作答"})
    text = submitted if isinstance(submitted, str) else str(submitted)
    if not text.strip():
        return GradePart(blank_id, GradeStatus.PENDING_REVIEW, None, blank_max, None, {"reason": "空作答"})

    if numeric:
        return _grade_numeric_blank(blank_id=blank_id, numeric=numeric, text=text, blank_max=blank_max, policy=policy, unit_rule=unit_rule)

    target = normalize_text(text, flags)
    for candidate in accepted:
        if normalize_text(str(candidate), flags) == target:
            return GradePart(
                blank_id,
                GradeStatus.CONFIRMED,
                blank_max,
                blank_max,
                GradeMethod.DETERMINISTIC,
                {"outcome": "correct", "submitted": text},
            )
    if policy == MismatchPolicy.WRONG:
        return GradePart(
            blank_id,
            GradeStatus.CONFIRMED,
            ZERO,
            blank_max,
            GradeMethod.DETERMINISTIC,
            {"outcome": "wrong", "submitted": text, "policy": "wrong"},
        )
    return GradePart(
        blank_id,
        GradeStatus.PENDING_REVIEW,
        None,
        blank_max,
        None,
        {"reason": "未匹配到已登记的等价答案，等待人工复核", "submitted": text, "policy": policy},
    )


def _grade_numeric_blank(
    *, blank_id: str, numeric: dict, text: str, blank_max: Decimal, policy: str, unit_rule: dict
) -> GradePart:
    try:
        target = Decimal(str(numeric.get("value")))
    except (InvalidOperation, TypeError, ValueError):
        return GradePart(blank_id, GradeStatus.PENDING_REVIEW, None, blank_max, None, {"reason": "数值规则无效"})
    abs_tol = _dec(numeric.get("abs_tol"), ZERO)
    rel_tol = _dec(numeric.get("rel_tol"), ZERO)
    conversions = numeric.get("unit_conversions") or {}
    expected_unit = unit_rule.get("expected") or numeric.get("expected_unit") or ""
    whitelist = unit_rule.get("whitelist") or conversions

    value, unit = parse_numeric(text)
    if value is None:
        # A written expression is never evaluated, and `1/2` is not assumed to
        # equal `0.5`: it goes to human review whatever the mismatch policy says.
        if _EXPRESSION_PATTERN.search(text):
            return GradePart(
                blank_id,
                GradeStatus.PENDING_REVIEW,
                None,
                blank_max,
                None,
                {"reason": "提交内容是表达式，P0 不做符号等价判断，转人工复核", "submitted": text},
            )
        if policy == MismatchPolicy.WRONG:
            return GradePart(
                blank_id, GradeStatus.CONFIRMED, ZERO, blank_max, GradeMethod.DETERMINISTIC, {"outcome": "wrong", "submitted": text}
            )
        return GradePart(
            blank_id,
            GradeStatus.PENDING_REVIEW,
            None,
            blank_max,
            None,
            {"reason": "无法解析为数值（可能含表达式或格式差异）", "submitted": text},
        )
    if unit:
        if expected_unit:
            if unit == expected_unit:
                pass
            elif isinstance(whitelist, dict) and unit in whitelist and expected_unit in whitelist:
                try:
                    factor = Decimal(str(whitelist[unit])) / Decimal(str(whitelist[expected_unit]))
                except (InvalidOperation, ZeroDivisionError, TypeError):
                    return GradePart(
                        blank_id,
                        GradeStatus.PENDING_REVIEW,
                        None,
                        blank_max,
                        None,
                        {"reason": "单位换算表无效", "unit": unit},
                    )
                value = value * factor
            else:
                return GradePart(
                    blank_id,
                    GradeStatus.PENDING_REVIEW,
                    None,
                    blank_max,
                    None,
                    {"reason": "未知或不允许的单位", "unit": unit, "expected_unit": expected_unit},
                )
        elif not (isinstance(whitelist, dict) and unit in whitelist):
            return GradePart(
                blank_id, GradeStatus.PENDING_REVIEW, None, blank_max, None, {"reason": "未配置单位规则", "unit": unit}
            )
    elif expected_unit:
        # A bare number is only acceptable when the rule says the unit is optional.
        if not unit_rule.get("unit_optional", False):
            return GradePart(
                blank_id,
                GradeStatus.PENDING_REVIEW,
                None,
                blank_max,
                None,
                {"reason": "缺少单位", "expected_unit": expected_unit},
            )

    tolerance = max(abs_tol, rel_tol * abs(target))
    if abs(value - target) <= tolerance:
        return GradePart(
            blank_id,
            GradeStatus.CONFIRMED,
            blank_max,
            blank_max,
            GradeMethod.DETERMINISTIC,
            {"outcome": "correct", "submitted": text, "parsed": str(value)},
        )
    if policy == MismatchPolicy.WRONG:
        return GradePart(
            blank_id,
            GradeStatus.CONFIRMED,
            ZERO,
            blank_max,
            GradeMethod.DETERMINISTIC,
            {"outcome": "wrong", "submitted": text, "parsed": str(value), "tolerance": str(tolerance)},
        )
    return GradePart(
        blank_id,
        GradeStatus.PENDING_REVIEW,
        None,
        blank_max,
        None,
        {"reason": "超出数值容差且规则未明确判错", "submitted": text, "parsed": str(value), "tolerance": str(tolerance)},
    )


# --------------------------------------------------------------------------
# Constructed response
# --------------------------------------------------------------------------
def grade_constructed_response(
    *, raw_answer: dict, answer_payload: dict, max_score: Decimal, rule: dict, rubric: dict | None
) -> GradeResult:
    """P0 never auto-scores a constructed response: every criterion is human-confirmed."""
    criteria = (rubric or {}).get("criteria") or []
    if not criteria:
        return _pending_all(["rubric"], max_score, "缺少评分标准，无法评分，保持待评", {"rule": rule})
    parts = [
        GradePart(
            part_id=str(criterion.get("criterion_id")),
            status=GradeStatus.PENDING_REVIEW,
            score=None,
            max_score=_dec(criterion.get("max_score"), ZERO),
            method=None,
            detail={"text": criterion.get("text", ""), "required": bool(criterion.get("required"))},
        )
        for criterion in criteria
        if isinstance(criterion, dict)
    ]
    return _finalize(parts, max_score, {"rule": rule, "rubric_version_required": True}, ["大题需逐评分点人工确认"])


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------
def grade(
    *,
    question_type: str,
    raw_answer: dict,
    answer_payload: dict,
    max_score: Decimal,
    rule: dict,
    rubric: dict | None = None,
) -> GradeResult:
    """Route to the adapter for this question type.

    An unsupported or incomplete rule set returns ``pending_review`` rather than
    a guessed score.
    """
    if not isinstance(raw_answer, dict):
        raw_answer = {}
    if question_type == QuestionType.SINGLE_CHOICE:
        return grade_single_choice(raw_answer=raw_answer, answer_payload=answer_payload, max_score=max_score, rule=rule)
    if question_type == QuestionType.MULTIPLE_CHOICE:
        return grade_multiple_choice(raw_answer=raw_answer, answer_payload=answer_payload, max_score=max_score, rule=rule)
    if question_type == QuestionType.TRUE_FALSE:
        return grade_true_false(raw_answer=raw_answer, answer_payload=answer_payload, max_score=max_score, rule=rule)
    if question_type == QuestionType.FILL_BLANK:
        return grade_fill_blank(raw_answer=raw_answer, answer_payload=answer_payload, max_score=max_score, rule=rule)
    if question_type == QuestionType.CONSTRUCTED_RESPONSE:
        return grade_constructed_response(
            raw_answer=raw_answer, answer_payload=answer_payload, max_score=max_score, rule=rule, rubric=rubric
        )
    return _pending_all(["unknown"], max_score, f"P0 尚不支持自动判分的题型：{question_type}", {"rule": rule})


def _dec(value: Any, default: Decimal) -> Decimal:
    if value in (None, ""):
        return default
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return default
