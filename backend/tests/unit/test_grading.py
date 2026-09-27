"""Deterministic grading: every documented rule and its refusal cases."""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.common.enums import GradeMethod, GradeStatus, MismatchPolicy, MultipleChoicePolicy
from domain.grading import adapters

D = Decimal


# --------------------------------------------------------------- single choice
def test_single_choice_uses_stable_option_id_not_display_order():
    result = adapters.grade(
        question_type="single_choice",
        raw_answer={"type": "single_choice", "selected_option_ids": ["opt_c"]},
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_c"},
        max_score=D("2.00"),
        rule={},
    )
    assert result.status == GradeStatus.CONFIRMED
    assert result.confirmed_score == D("2.00")
    assert result.is_fully_confirmed is True


def test_single_choice_wrong_and_blank_use_configured_scores():
    wrong = adapters.grade(
        question_type="single_choice",
        raw_answer={"type": "single_choice", "selected_option_ids": ["opt_a"]},
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_b"},
        max_score=D("2.00"),
        rule={"wrong_score": "0.00", "blank_score": "0.00"},
    )
    blank = adapters.grade(
        question_type="single_choice",
        raw_answer={"type": "single_choice", "selected_option_ids": []},
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_b"},
        max_score=D("2.00"),
        rule={"wrong_score": "-0.50", "blank_score": "0.00"},
    )
    assert wrong.confirmed_score == D("0.00")
    assert blank.confirmed_score == D("0.00")
    assert blank.parts[0].detail["outcome"] == "blank"


def test_single_choice_without_trusted_answer_is_pending_not_zero():
    result = adapters.grade(
        question_type="single_choice",
        raw_answer={"type": "single_choice", "selected_option_ids": ["opt_a"]},
        answer_payload={},
        max_score=D("2.00"),
        rule={},
    )
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None
    assert result.pending_max_score == D("2.00")


# ------------------------------------------------------------- multiple choice
def test_multiple_choice_exact_match_rejects_subset():
    result = adapters.grade(
        question_type="multiple_choice",
        raw_answer={"type": "multiple_choice", "selected_option_ids": ["opt_a"]},
        answer_payload={
            "kind": "multiple_choice",
            "correct_option_ids": ["opt_a", "opt_c"],
            "policy": MultipleChoicePolicy.EXACT_MATCH,
        },
        max_score=D("4.00"),
        rule={},
    )
    assert result.confirmed_score == D("0.00")
    assert result.parts[0].detail["outcome"] == "incomplete_exact_match"


def test_multiple_choice_partial_credit_and_ordering_independence():
    payload = {
        "kind": "multiple_choice",
        "correct_option_ids": ["opt_a", "opt_c"],
        "policy": MultipleChoicePolicy.PARTIAL_CREDIT,
        "partial_score": "2.00",
    }
    subset = adapters.grade(
        question_type="multiple_choice",
        raw_answer={"type": "multiple_choice", "selected_option_ids": ["opt_c"]},
        answer_payload=payload,
        max_score=D("4.00"),
        rule={},
    )
    reversed_order = adapters.grade(
        question_type="multiple_choice",
        raw_answer={"type": "multiple_choice", "selected_option_ids": ["opt_c", "opt_a"]},
        answer_payload=payload,
        max_score=D("4.00"),
        rule={},
    )
    assert subset.confirmed_score == D("2.00")
    assert subset.parts[0].detail["outcome"] == "partial"
    assert reversed_order.confirmed_score == D("4.00")


def test_multiple_choice_with_wrong_option_uses_wrong_score():
    result = adapters.grade(
        question_type="multiple_choice",
        raw_answer={"type": "multiple_choice", "selected_option_ids": ["opt_a", "opt_b"]},
        answer_payload={
            "kind": "multiple_choice",
            "correct_option_ids": ["opt_a", "opt_c"],
            "policy": MultipleChoicePolicy.PARTIAL_CREDIT,
            "partial_score": "2.00",
            "wrong_score": "-1.00",
        },
        max_score=D("4.00"),
        rule={},
    )
    assert result.parts[0].detail["outcome"] == "wrong"
    assert result.confirmed_score == D("-1.00")


def test_multiple_choice_partial_credit_without_configured_score_goes_to_review():
    result = adapters.grade(
        question_type="multiple_choice",
        raw_answer={"type": "multiple_choice", "selected_option_ids": ["opt_a"]},
        answer_payload={
            "kind": "multiple_choice",
            "correct_option_ids": ["opt_a", "opt_c"],
            "policy": MultipleChoicePolicy.PARTIAL_CREDIT,
        },
        max_score=D("4.00"),
        rule={},
    )
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None


def test_multiple_choice_duplicate_option_ids_go_to_review():
    result = adapters.grade(
        question_type="multiple_choice",
        raw_answer={"type": "multiple_choice", "selected_option_ids": ["opt_a", "opt_a"]},
        answer_payload={"kind": "multiple_choice", "correct_option_ids": ["opt_a", "opt_c"]},
        max_score=D("4.00"),
        rule={},
    )
    assert result.status == GradeStatus.PENDING_REVIEW


# ------------------------------------------------------------------ true/false
def test_true_false_false_is_not_a_blank():
    graded = adapters.grade(
        question_type="true_false",
        raw_answer={"type": "true_false", "value": False},
        answer_payload={"kind": "true_false", "value": False},
        max_score=D("2.00"),
        rule={"blank_score": "0.00"},
    )
    blank = adapters.grade(
        question_type="true_false",
        raw_answer={"type": "true_false", "value": None},
        answer_payload={"kind": "true_false", "value": False},
        max_score=D("2.00"),
        rule={"blank_score": "0.00", "wrong_score": "-1.00"},
    )
    assert graded.parts[0].detail["outcome"] == "correct"
    assert graded.confirmed_score == D("2.00")
    assert blank.parts[0].detail["outcome"] == "blank"
    assert blank.confirmed_score == D("0.00")


# ------------------------------------------------------------------ fill blank
def _fill(blanks: dict, submitted: dict, max_score="3.00") -> adapters.GradeResult:
    return adapters.grade(
        question_type="fill_blank",
        raw_answer={"type": "fill_blank", "blanks": submitted},
        answer_payload={"kind": "fill_blank", "blanks": blanks},
        max_score=D(max_score),
        rule={},
    )


def test_fill_blank_only_applies_configured_normalisation():
    blanks = {
        "b1": {
            "accepted_values": ["ABC"],
            "normalization": {"case_insensitive": True, "strip_whitespace": True},
            "max_score": "1.00",
        }
    }
    ok = _fill(blanks, {"b1": "  abc "}, max_score="1.00")
    assert ok.confirmed_score == D("1.00")

    case_sensitive = {
        "b1": {"accepted_values": ["ABC"], "normalization": {"strip_whitespace": True}, "max_score": "1.00"}
    }
    unmatched = _fill(case_sensitive, {"b1": "abc"}, max_score="1.00")
    assert unmatched.status == GradeStatus.PENDING_REVIEW


def test_fill_blank_negative_sign_is_never_dropped():
    blanks = {
        "b1": {"accepted_values": ["-2"], "normalization": {"strip_whitespace": True}, "max_score": "2.00"}
    }
    positive = _fill(blanks, {"b1": "2"}, max_score="2.00")
    negative = _fill(blanks, {"b1": "-2"}, max_score="2.00")
    assert positive.status == GradeStatus.PENDING_REVIEW  # not silently accepted
    assert negative.confirmed_score == D("2.00")


def test_fill_blank_unmatched_answer_goes_to_review_by_default():
    blanks = {
        "b1": {"accepted_values": ["1/2"], "normalization": {"strip_whitespace": True}, "max_score": "3.00"}
    }
    result = _fill(blanks, {"b1": "0.5"}, max_score="3.00")
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None
    assert result.pending_max_score == D("3.00")


def test_fill_blank_wrong_policy_only_when_rule_says_wrong():
    blanks = {
        "b1": {
            "accepted_values": ["1/2"],
            "normalization": {"strip_whitespace": True},
            "max_score": "3.00",
            "mismatch_policy": MismatchPolicy.WRONG,
        }
    }
    result = _fill(blanks, {"b1": "0.5"}, max_score="3.00")
    assert result.confirmed_score == D("0.00")
    assert result.parts[0].detail["outcome"] == "wrong"


def test_fill_blank_partial_confirmation_is_not_a_total_score():
    blanks = {
        "b1": {"accepted_values": ["-2"], "normalization": {"strip_whitespace": True}, "max_score": "2.00"},
        "b2": {"accepted_values": ["1/2"], "normalization": {"strip_whitespace": True}, "max_score": "1.00"},
    }
    result = _fill(blanks, {"b1": "-2", "b2": "0.5"}, max_score="3.00")
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score == D("2.00")
    assert result.pending_max_score == D("1.00")
    assert result.is_fully_confirmed is False


def test_fill_blank_numeric_tolerance_boundary_is_inclusive():
    blanks = {
        "b1": {
            "numeric": {"value": "10", "abs_tol": "0.1", "rel_tol": "0"},
            "max_score": "3.00",
            "mismatch_policy": MismatchPolicy.WRONG,
        }
    }
    inside = _fill(blanks, {"b1": "10.1"}, max_score="3.00")
    outside = _fill(blanks, {"b1": "10.11"}, max_score="3.00")
    assert inside.confirmed_score == D("3.00")
    assert outside.confirmed_score == D("0.00")


def test_fill_blank_unknown_unit_or_expression_goes_to_review():
    blanks = {
        "b1": {
            "numeric": {"value": "10", "abs_tol": "0.1", "rel_tol": "0"},
            "unit": {"whitelist": {"m": "1", "cm": "0.01"}, "expected": "m"},
            "max_score": "3.00",
            "mismatch_policy": MismatchPolicy.WRONG,
        }
    }
    unknown_unit = _fill(blanks, {"b1": "10 furlong"}, max_score="3.00")
    expression = _fill(blanks, {"b1": "5*2"}, max_score="3.00")
    assert unknown_unit.status == GradeStatus.PENDING_REVIEW
    assert expression.status == GradeStatus.PENDING_REVIEW


def test_fill_blank_unit_conversion_is_explicit():
    blanks = {
        "b1": {
            "numeric": {"value": "1", "abs_tol": "0.001", "rel_tol": "0"},
            "unit": {"whitelist": {"m": "1", "cm": "0.01"}, "expected": "m"},
            "max_score": "3.00",
            "mismatch_policy": MismatchPolicy.WRONG,
        }
    }
    converted = _fill(blanks, {"b1": "100 cm"}, max_score="3.00")
    assert converted.confirmed_score == D("3.00")


def test_fill_blank_blank_answer_is_pending_not_wrong():
    blanks = {"b1": {"accepted_values": ["x"], "max_score": "3.00", "mismatch_policy": MismatchPolicy.WRONG}}
    result = _fill(blanks, {}, max_score="3.00")
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.parts[0].detail["reason"] == "未作答"


# -------------------------------------------------------- constructed response
def test_constructed_response_never_auto_scores():
    result = adapters.grade(
        question_type="constructed_response",
        raw_answer={"type": "constructed_response", "text": "推导……"},
        answer_payload={"kind": "constructed_response", "rubric_required": True},
        max_score=D("10.00"),
        rule={},
        rubric={"criteria": [{"criterion_id": "c1", "max_score": "10.00", "required": True}]},
    )
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None
    assert result.pending_max_score == D("10.00")
    assert result.parts[0].status == GradeStatus.PENDING_REVIEW


def test_constructed_response_without_rubric_stays_pending():
    result = adapters.grade(
        question_type="constructed_response",
        raw_answer={"type": "constructed_response", "text": "……"},
        answer_payload={"kind": "constructed_response", "rubric_required": True},
        max_score=D("10.00"),
        rule={},
        rubric=None,
    )
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None


def test_unknown_question_type_is_pending_not_guessed():
    result = adapters.grade(
        question_type="essay_with_formula",
        raw_answer={"type": "essay_with_formula"},
        answer_payload={},
        max_score=D("5.00"),
        rule={},
    )
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.method == GradeMethod.DETERMINISTIC or result.method == GradeMethod.MIXED


def test_normalize_text_keeps_signs_and_units():
    flags = {"strip_whitespace": True, "fullwidth_to_halfwidth": True}
    assert adapters.normalize_text(" －２ ", flags) == "-2"
    assert adapters.normalize_text("10 m", flags) == "10 m"


@pytest.mark.parametrize(
    "raw,expected",
    [("10", (D("10"), "")), ("10 cm", (D("10"), "cm")), ("-2", (D("-2"), "")), ("1/2", (None, "")), ("", (None, ""))],
)
def test_parse_numeric_does_not_evaluate_expressions(raw, expected):
    assert adapters.parse_numeric(raw) == expected
