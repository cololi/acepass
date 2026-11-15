"""Golden vectors for `apps.common.answers.validate_answer_payload`.

The payload shape IS the grading contract: an answer can only be marked `checked` once this
validator returns no problems, so a port that accepts something Python rejects would let an
ungradable answer reach the grader. Every expected list below is produced by the real function.
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
import django  # noqa: E402

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")
django.setup()

from apps.common.answers import validate_answer_payload  # noqa: E402
from apps.common.enums import QuestionType  # noqa: E402

SINGLE = "single_choice"
MULTI = "multiple_choice"
TF = "true_false"
FILL = "fill_blank"
CR = "constructed_response"
MAT = "material"

CONTENT_OPTS = {"options": [{"id": "opt_a", "text": "A"}, {"id": "opt_b", "text": "B"}]}
CONTENT_BLANKS = {"blanks": [{"blank_id": "b1"}, {"blank_id": "b2"}]}
CONTENT_BOTH = {**CONTENT_OPTS, **CONTENT_BLANKS}

CASES = [
    # ---- material
    (MAT, {}, None),
    (MAT, None, None),
    (MAT, {"kind": "material"}, None),
    (MAT, [], None),
    # ---- not an object
    (SINGLE, "nope", None),
    (SINGLE, None, None),
    (SINGLE, [], None),
    (SINGLE, 5, None),
    # ---- kind mismatch
    (SINGLE, {"kind": "multiple_choice", "correct_option_ids": ["opt_a"]}, None),
    (SINGLE, {}, None),
    (SINGLE, {"kind": None}, None),
    # ---- single choice
    (SINGLE, {"kind": SINGLE, "correct_option_id": "opt_a"}, CONTENT_OPTS),
    (SINGLE, {"kind": SINGLE, "correct_option_id": "opt_z"}, CONTENT_OPTS),
    (SINGLE, {"kind": SINGLE, "correct_option_id": "opt_z"}, None),
    (SINGLE, {"kind": SINGLE}, None),
    (SINGLE, {"kind": SINGLE, "correct_option_id": ""}, None),
    (SINGLE, {"kind": SINGLE, "correct_option_id": 5}, None),
    (SINGLE, {"kind": SINGLE, "correct_option_id": "x" * 41}, None),
    (SINGLE, {"kind": SINGLE, "correct_option_id": "有 空格"}, None),
    (SINGLE, {"kind": SINGLE, "correct_option_id": "opt-a_1"}, CONTENT_OPTS),
    # ---- multiple choice
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a", "opt_b"]}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": []}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": "opt_a"}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a", "opt_a"]}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a", "opt_z"]}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a", ""]}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"]}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "policy": "partial_credit", "partial_score": "1.5"}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "policy": "partial_credit"}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "policy": "partial_credit", "partial_score": "-1"}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "policy": "partial_credit", "partial_score": "abc"}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "policy": "bogus"}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "partial_score": "1"}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "partial_score": "0"}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "partial_score": "0.00"}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "partial_score": ""}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "wrong_score": "-1"}, CONTENT_OPTS),
    (MULTI, {"kind": MULTI, "correct_option_ids": ["opt_a"], "blank_score": "x"}, CONTENT_OPTS),
    # ---- true/false
    (TF, {"kind": TF, "value": True}, None),
    (TF, {"kind": TF, "value": False}, None),
    (TF, {"kind": TF, "value": 0}, None),
    (TF, {"kind": TF, "value": "true"}, None),
    (TF, {"kind": TF}, None),
    # ---- fill in the blank
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"]}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": []}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": "x"}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"]}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"]}, "b9": {"accepted_values": ["y"]}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"bad id": {"accepted_values": ["x"]}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": "x"}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": []}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": [1, 2]}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"], "normalization": {"case_insensitive": True, "delete_symbols": True}}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"], "normalization": {"bogus": True}}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"], "normalization": "nope"}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"numeric": {"value": "10", "abs_tol": "0.1"}}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"numeric": {"value": "abc"}}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"numeric": {"value": "10", "abs_tol": "-1"}}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"numeric": "x"}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"numeric": {"value": "10", "unit_conversions": {"cm": "0.01"}}}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"numeric": {"value": "10", "unit_conversions": {"cm": "abc"}}}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"numeric": {"value": "10", "unit_conversions": "x"}}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"], "mismatch_policy": "bogus"}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"], "mismatch_policy": "wrong"}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"], "max_score": "-1"}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"], "unit": {"whitelist": {"m": "1"}}}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"], "unit": {"whitelist": "x"}}}}, CONTENT_BLANKS),
    (FILL, {"kind": FILL, "blanks": {"b1": {"accepted_values": ["x"], "unit": "m"}}}, CONTENT_BLANKS),
    # ---- constructed response
    (CR, {"kind": CR, "rubric_required": True}, None),
    (CR, {"kind": CR, "rubric_required": False}, None),
    (CR, {"kind": CR}, None),
    (CR, {"kind": CR, "rubric_required": "true"}, None),
    # ---- options without ids / blank ids absent from content
    (SINGLE, {"kind": SINGLE, "correct_option_id": "opt_a"}, {"options": [{"text": "A"}]}),
    (FILL, {"kind": FILL, "blanks": {"anything": {"accepted_values": ["x"]}}}, {"blanks": [{"blank_id": ""}]}),
]

cases = []
for question_type, payload, content in CASES:
    problems = validate_answer_payload(payload, question_type, content)
    cases.append(
        {
            "question_type": question_type,
            "payload": payload,
            "content": content,
            "expected": problems,
        }
    )

json.dump(
    {
        "source": "apps/common/answers.py::validate_answer_payload",
        "cases": cases,
    },
    sys.stdout,
    ensure_ascii=False,
    separators=(",", ":"),
)
sys.stdout.write("\n")
