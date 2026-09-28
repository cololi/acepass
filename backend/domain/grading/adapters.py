"""Deterministic grading.

Every adapter returns the same :class:`GradeResult` shape (docs/03 §4.1). A type
that has no complete rule returns ``pending_review`` for the affected part
instead of a guessed score, and a not-yet-graded part is never treated as 0.

Fill-in-the-blank expression mode (docs/05 §3, acceptance C07) is *additive* to
the answer contract and only needs one extra key on a blank spec::

    {"kind": "fill_blank",
     "blanks": {"b1": {"equivalence": "expression",
                       "accepted_values": ["x^2+2x+1", "(x+1)^2"],
                       "mismatch_policy": "wrong",
                       "max_score": "3.00"}}}

``accepted`` may be used as an alias for ``accepted_values``.  With
``equivalence: "expression"`` a submission is evaluated by the restricted engine
in :mod:`domain.grading.expressions`: literal matches win first, then sampled
equivalence.  Anything the engine cannot decide (illegal syntax, unknown symbol
or unit, domain hole, hard limit, wall-clock timeout) goes to ``pending_review``
— never to "wrong" — while a *proven* mismatch follows the blank's
``mismatch_policy`` exactly like the numeric path.  Blanks without the flag keep
the previous text/numeric behaviour unchanged.  A blank that declares both
``equivalence`` and ``numeric``/``unit`` uses expression mode; units are then
reported for review instead of converted.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from apps.common.answers import blank_max_score, blank_specs, normalization_flags
from apps.common.enums import GradeMethod, GradeStatus, MismatchPolicy, MultipleChoicePolicy, QuestionType
from domain.grading import expressions

ZERO = Decimal("0")

#: Blank-spec key that switches one blank to restricted expression equivalence.
EQUIVALENCE_KEY = "equivalence"
#: The only equivalence mode that exists today.
EXPRESSION_MODE = "expression"
#: Optional per-blank overrides of the engine defaults (relative tolerance and a
#: wall-clock budget in milliseconds, capped by the engine's own ceiling).
EXPRESSION_TOLERANCE_KEY = "expression_tolerance"
EXPRESSION_TIME_BUDGET_MS_KEY = "expression_time_budget_ms"
#: A configured tolerance may never be looser than this: 1.0 would accept anything.
MAX_EXPRESSION_TOLERANCE = 1.0

#: Human-facing reasons for every way the restricted engine can refuse a verdict.
_EXPRESSION_REVIEW_REASONS = {
    expressions.ERROR_SYNTAX: "表达式语法非法或含未知函数/符号，转人工复核",
    expressions.ERROR_LIMIT: "表达式超出受限计算上限，转人工复核",
    expressions.ERROR_DOMAIN: "表达式在采样点无定义，无法判定等价，转人工复核",
    expressions.ERROR_TIMEOUT: "表达式判分超时，转人工复核",
}
_EXPRESSION_FALLBACK_REASON = "表达式等价判定未完成，转人工复核"
_EXPRESSION_MISMATCH_REASON = "表达式与已登记答案不等价，且规则未明确判错，转人工复核"
_EXPRESSION_UNKNOWN_SYMBOL_REASON = "提交含未登记符号（可能是未知单位），转人工复核"
_EXPRESSION_NO_ANSWER_REASON = "表达式等价规则缺少已登记的标准答案，转人工复核"
_EXPRESSION_UNKNOWN_MODE_REASON = "未登记的等价判定模式，转人工复核"


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
    """One grading outcome.

    Two different questions must never be conflated (docs/03 §4.1):

    * ``is_fully_confirmed`` — *every* scoring part has been decided. A wrong
      answer is fully confirmed and still scores 0; a partly human-confirmed
      constructed response is not fully confirmed and keeps a real
      ``pending_max_score``.
    * ``is_correct`` — the confirmed score actually reaches this item's maximum,
      which is the only thing that may be read as "completely correct".
    """

    status: str
    method: str
    max_score: Decimal
    parts: list[GradePart] = field(default_factory=list)
    confirmed_score: Decimal | None = None
    pending_max_score: Decimal = ZERO
    is_fully_confirmed: bool = False
    rule_snapshot: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    @property
    def is_correct(self) -> bool:
        """Fully confirmed *and* at full marks: "完全正确" in the contract."""
        return bool(
            self.is_fully_confirmed
            and self.confirmed_score is not None
            and self.max_score > 0
            and self.confirmed_score >= self.max_score
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "method": self.method,
            "confirmed_score": None if self.confirmed_score is None else str(self.confirmed_score),
            "max_score": str(self.max_score),
            "pending_max_score": str(self.pending_max_score),
            "is_fully_confirmed": self.is_fully_confirmed,
            "is_correct": self.is_correct,
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
            # The pending value is the maximum of the parts that are genuinely
            # still undecided. Lost marks on a confirmed part are never turned
            # back into "unscored" work.
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

    # "全部评分完成" is about completeness, not about being right. A zero-score
    # wrong answer is fully graded; a partly confirmed manual rubric is not.
    fully_confirmed = (
        status == GradeStatus.CONFIRMED and pending == ZERO and all(part.status == GradeStatus.CONFIRMED for part in parts)
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
        "expression_blanks": [
            blank_id
            for blank_id, spec in specs.items()
            if isinstance(spec, dict) and spec.get(EQUIVALENCE_KEY) == EXPRESSION_MODE
        ],
        "rule": rule,
    }
    # An expression blank that could not be decided is worth reporting once, so
    # the reviewer queue shows why the item is pending.
    notes: list[str] = []
    for part in parts:
        if part.status == GradeStatus.PENDING_REVIEW and part.detail.get("equivalence") == EXPRESSION_MODE:
            reason = part.detail.get("reason")
            if isinstance(reason, str) and reason and reason not in notes:
                notes.append(reason)
    return _finalize(parts, max_score, snapshot, notes)


def _accepted_values(spec: dict) -> list[str]:
    """Accepted answers of one blank.

    ``accepted_values`` is the documented answer-contract key; ``accepted`` is an
    additive alias (the shape used in the C07 plan) so an expression blank can be
    written either way.
    """
    for key in ("accepted_values", "accepted"):
        raw = spec.get(key)
        if isinstance(raw, list) and raw:
            return [str(value) for value in raw]
    return []


def _grade_one_blank(
    *, blank_id: str, spec: dict, submitted: Any, blank_max: Decimal, default_mismatch: str
) -> GradePart:
    policy = spec.get("mismatch_policy", default_mismatch)
    numeric = spec.get("numeric")
    accepted = _accepted_values(spec)
    flags = normalization_flags(spec)
    unit_rule = spec.get("unit") or {}
    equivalence = spec.get(EQUIVALENCE_KEY)

    if submitted is None:
        return GradePart(blank_id, GradeStatus.PENDING_REVIEW, None, blank_max, None, {"reason": "未作答"})
    text = submitted if isinstance(submitted, str) else str(submitted)
    if not text.strip():
        return GradePart(blank_id, GradeStatus.PENDING_REVIEW, None, blank_max, None, {"reason": "空作答"})

    if equivalence not in (None, "", EXPRESSION_MODE):
        # A mode this build does not know must never be guessed at.
        return GradePart(
            blank_id,
            GradeStatus.PENDING_REVIEW,
            None,
            blank_max,
            None,
            {"reason": _EXPRESSION_UNKNOWN_MODE_REASON, "submitted": text, "equivalence": str(equivalence)},
        )

    if equivalence == EXPRESSION_MODE:
        return _grade_expression_blank(
            blank_id=blank_id,
            spec=spec,
            text=text,
            blank_max=blank_max,
            policy=policy,
            flags=flags,
            accepted=accepted,
        )

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


# --------------------------------------------------------------------------
# Restricted expression blanks (docs/05 §3, C07)
# --------------------------------------------------------------------------
def _expression_tolerance(spec: dict) -> float:
    raw = spec.get(EXPRESSION_TOLERANCE_KEY)
    if raw in (None, ""):
        return expressions.DEFAULT_TOLERANCE
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return expressions.DEFAULT_TOLERANCE
    if not math.isfinite(value) or value <= 0.0:
        return expressions.DEFAULT_TOLERANCE
    return min(value, MAX_EXPRESSION_TOLERANCE)


def _expression_budget(spec: dict) -> float:
    """Wall-clock budget for one full comparison; never above the engine ceiling."""
    raw = spec.get(EXPRESSION_TIME_BUDGET_MS_KEY)
    if raw in (None, ""):
        return expressions.DEFAULT_TIME_BUDGET_SECONDS
    try:
        milliseconds = float(raw)
    except (TypeError, ValueError):
        return expressions.DEFAULT_TIME_BUDGET_SECONDS
    if not math.isfinite(milliseconds) or milliseconds <= 0.0:
        return expressions.DEFAULT_TIME_BUDGET_SECONDS
    return min(milliseconds / 1000.0, expressions.MAX_TIME_BUDGET_SECONDS)


def _expression_reason(verdict: expressions.ExpressionVerdict) -> str:
    return _EXPRESSION_REVIEW_REASONS.get(verdict.error_type or "", _EXPRESSION_FALLBACK_REASON)


def _unregistered_symbols(target: str, candidates: list[str]) -> list[str]:
    """Symbols in the submission that no accepted answer declares.

    An extra symbol is how an unknown or ambiguous unit (``2x^2 m``) shows up in
    expression mode; treating it as a variable would silently change the meaning,
    so it is reported instead of judged.
    """
    try:
        submitted_symbols = expressions.free_variables(target)
    except expressions.ExpressionError:
        return []
    registered: set[str] = set()
    for candidate in candidates:
        try:
            registered.update(expressions.free_variables(candidate))
        except expressions.ExpressionError:
            continue
    return sorted(symbol for symbol in submitted_symbols if symbol not in registered)


def _mentions_more_symbols_than_accepted(target: str, candidates: list[str]) -> bool:
    """True when the submission introduces a symbol no accepted answer mentions.

    Compared by *count*: renaming a symbol (`2t+2` for `2x+2`) is still the same
    function, but ``2x^2+1 m`` mentions one symbol more, and that extra symbol is
    a unit or an unknown variable until a human says otherwise.
    """
    try:
        submitted_count = len(expressions.free_variables(target))
    except expressions.ExpressionError:
        return False
    accepted_counts = []
    for candidate in candidates:
        try:
            accepted_counts.append(len(expressions.free_variables(candidate)))
        except expressions.ExpressionError:
            continue
    if not accepted_counts:
        return False
    return submitted_count > max(accepted_counts)


def _grade_expression_blank(
    *, blank_id: str, spec: dict, text: str, blank_max: Decimal, policy: str, flags: dict, accepted: list[str]
) -> GradePart:
    """Restricted expression equivalence for one blank.

    1. a literally accepted answer wins first (unchanged behaviour);
    2. a submission that mentions a symbol no accepted answer uses (a unit, or an
       unknown variable) is never absorbed as "the same expression": it goes to
       review with the symbol named;
    3. otherwise every accepted expression is compared by the engine: equivalent
       -> correct;
    4. anything undecidable (syntax, unknown symbol/unit, domain hole, limit,
       timeout) -> ``pending_review`` with the engine's specific reason;
    5. a proven mismatch follows ``mismatch_policy``: ``wrong`` only when the rule
       says so, otherwise review — the same rule the numeric path uses.

    A ``numeric``/``unit`` block on the same blank is ignored: expression mode
    never converts units, it reports them (step 2).
    """
    if not accepted:
        return GradePart(
            blank_id,
            GradeStatus.PENDING_REVIEW,
            None,
            blank_max,
            None,
            {"reason": _EXPRESSION_NO_ANSWER_REASON, "submitted": text, "equivalence": EXPRESSION_MODE},
        )
    target = normalize_text(text, flags)
    candidates = [normalize_text(candidate, flags) for candidate in accepted]
    for candidate in candidates:
        if candidate == target:
            return GradePart(
                blank_id,
                GradeStatus.CONFIRMED,
                blank_max,
                blank_max,
                GradeMethod.DETERMINISTIC,
                {
                    "outcome": "correct",
                    "submitted": text,
                    "equivalence": EXPRESSION_MODE,
                    "match": "exact",
                    "accepted": candidate,
                },
            )

    tolerance = _expression_tolerance(spec)
    budget = _expression_budget(spec)
    if _mentions_more_symbols_than_accepted(target, candidates):
        # Never let an extra symbol (a unit, or a variable the answer key does
        # not use) be absorbed as "the same expression".
        return GradePart(
            blank_id,
            GradeStatus.PENDING_REVIEW,
            None,
            blank_max,
            None,
            {
                "reason": _EXPRESSION_UNKNOWN_SYMBOL_REASON,
                "submitted": text,
                "equivalence": EXPRESSION_MODE,
                "unknown_symbols": _unregistered_symbols(target, candidates),
            },
        )
    verdicts: list[tuple[str, expressions.ExpressionVerdict]] = []
    for candidate in candidates:
        verdict = expressions.compare_expressions(target, candidate, tolerance=tolerance, time_budget=budget)
        if verdict.outcome == expressions.OUTCOME_EQUIVALENT:
            return GradePart(
                blank_id,
                GradeStatus.CONFIRMED,
                blank_max,
                blank_max,
                GradeMethod.DETERMINISTIC,
                {
                    "outcome": "correct",
                    "submitted": text,
                    "equivalence": EXPRESSION_MODE,
                    "match": "expression",
                    "accepted": candidate,
                    "samples_checked": verdict.samples_checked,
                    "tolerance": str(tolerance),
                    "reason": verdict.reason,
                },
            )
        verdicts.append((candidate, verdict))

    undecided = next((item for item in verdicts if item[1].outcome == expressions.OUTCOME_UNKNOWN), None)
    if undecided is not None:
        candidate, verdict = undecided
        return GradePart(
            blank_id,
            GradeStatus.PENDING_REVIEW,
            None,
            blank_max,
            None,
            {
                "reason": _expression_reason(verdict),
                "submitted": text,
                "equivalence": EXPRESSION_MODE,
                "accepted": candidate,
                "error": verdict.error_type,
                "message": verdict.reason,
                "samples_checked": verdict.samples_checked,
                "sample": verdict.sample,
            },
        )

    unknown_symbols = _unregistered_symbols(target, [candidate for candidate, _ in verdicts])
    if unknown_symbols:
        return GradePart(
            blank_id,
            GradeStatus.PENDING_REVIEW,
            None,
            blank_max,
            None,
            {
                "reason": _EXPRESSION_UNKNOWN_SYMBOL_REASON,
                "submitted": text,
                "equivalence": EXPRESSION_MODE,
                "unknown_symbols": unknown_symbols,
            },
        )

    samples_checked = min(verdict.samples_checked for _, verdict in verdicts)
    if policy == MismatchPolicy.WRONG:
        return GradePart(
            blank_id,
            GradeStatus.CONFIRMED,
            ZERO,
            blank_max,
            GradeMethod.DETERMINISTIC,
            {
                "outcome": "wrong",
                "submitted": text,
                "equivalence": EXPRESSION_MODE,
                "policy": "wrong",
                "reason": "表达式与已登记答案不等价",
                "samples_checked": samples_checked,
            },
        )
    return GradePart(
        blank_id,
        GradeStatus.PENDING_REVIEW,
        None,
        blank_max,
        None,
        {
            "reason": _EXPRESSION_MISMATCH_REASON,
            "submitted": text,
            "equivalence": EXPRESSION_MODE,
            "policy": policy,
            "samples_checked": samples_checked,
        },
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
