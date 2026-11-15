"""Golden vectors for the seven AI output validators.

The oracle is the real `ai.prompts.registry` code: every `clean` / `problems` pair below is whatever
`validate_*` returned for the payload. The payload is emitted as *JSON text* so the Node test can
parse it with the number-lexeme-preserving parser (`2` vs `2.0` matter for the stored Decimal
strings), and it is also what a service would parse out of `raw_text`.

Coverage: normal paths, empty/None fields, overlong fields, Unicode/astral text, wrong JSON shapes,
and at least one vector per problem code in the registry. Cases where the Python validator itself
raises (field-level nonsense such as `"doubts": 5`) are deliberately absent: Python answers those
with a 500, the port returns an empty list, and that deviation is listed in the migration report.

Usage (from dsh-plugin/):
    ../backend/.venv/bin/python scripts/gen_ai_validators_golden.py > tests/golden/ai_validators.json
"""
from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")
import django  # noqa: E402

django.setup()

from ai.prompts import registry as prompts  # noqa: E402
from apps.tutoring.services.core import _strip_code_fence  # noqa: E402

CJK = "一元二次方程：x² − 3x + 2 = 0，注意负号与单位"
EMOJI = "第 2 页 · 含😀与𠀀"
LONG = "a" * 4200


def text_block(text: str = "题干") -> dict:
    return {"kind": "text", "text": text}


def options(*ids: str) -> list[dict]:
    return [
        {"id": option_id, "label": option_id[-1].upper(), "blocks": [text_block(f"选项 {option_id}")]}
        for option_id in ids
    ]


def single_choice_payload(**overrides) -> dict:
    payload = {
        "question_type": "single_choice",
        "content": {
            "blocks": [text_block("已知 f(x)=x^2-3x+2，则 f(2)=？")],
            "options": options("opt_a", "opt_b", "opt_c"),
        },
        "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_b"},
        "practice_max_score": "2.00",
        "difficulty_note": "与原题相当",
        "rationale": "换了函数但同一考点",
        "doubts": [],
    }
    payload.update(overrides)
    return payload


def multiple_choice_payload(**overrides) -> dict:
    payload = {
        "question_type": "multiple_choice",
        "content": {
            "blocks": [text_block("下列哪些是质数？")],
            "options": options("opt_a", "opt_b", "opt_c", "opt_d"),
        },
        "answer_payload": {"kind": "multiple_choice", "correct_option_ids": ["opt_a", "opt_b"]},
        "practice_max_score": "2.00",
        "difficulty_note": "",
        "rationale": "",
        "doubts": [],
    }
    payload.update(overrides)
    return payload


def true_false_payload(**overrides) -> dict:
    payload = {
        "question_type": "true_false",
        "content": {"blocks": [text_block("π 是有理数。")]},
        "answer_payload": {"kind": "true_false", "value": False},
        "practice_max_score": "1.00",
        "difficulty_note": "",
        "rationale": "",
        "doubts": [],
    }
    payload.update(overrides)
    return payload


def fill_blank_payload(**overrides) -> dict:
    payload = {
        "question_type": "fill_blank",
        "content": {
            "blocks": [text_block("1+1=____，2+2=____")],
            "blanks": [
                {"blank_id": "b1", "label": "第 1 空"},
                {"blank_id": "b2", "label": "第 2 空"},
            ],
        },
        "answer_payload": {
            "kind": "fill_blank",
            "blanks": {
                "b1": {"accepted_values": ["2", "二"]},
                "b2": {"accepted_values": ["4"]},
            },
        },
        "practice_max_score": "2.00",
        "difficulty_note": "",
        "rationale": "",
        "doubts": [],
    }
    payload.update(overrides)
    return payload


def constructed_payload(**overrides) -> dict:
    payload = {
        "question_type": "constructed_response",
        "content": {"blocks": [text_block("证明根号 2 是无理数。")]},
        "answer_payload": {"kind": "constructed_response", "rubric_required": True},
        "rubric_criteria": [
            {"criterion_id": "c1", "text": "假设相反", "max_score": "2.00", "required": True},
            {"criterion_id": "c2", "text": "推出矛盾", "max_score": "3.00", "required": True},
        ],
        "rubric_total_score": "5.00",
        "practice_max_score": "5.00",
        "difficulty_note": "",
        "rationale": "",
        "doubts": [],
    }
    payload.update(overrides)
    return payload


def mutated(base: dict, **overrides) -> dict:
    payload = copy.deepcopy(base)
    for key, value in overrides.items():
        if key == "__delete__":
            for name in value:
                payload.pop(name, None)
        else:
            payload[key] = value
    return payload


def content_mutated(base: dict, **overrides) -> dict:
    payload = copy.deepcopy(base)
    payload["content"].update(overrides)
    return payload


VALIDATOR_CASES: list[dict] = []


def case(name: str, validator: str, payload, **kwargs) -> None:
    VALIDATOR_CASES.append(
        {
            "name": name,
            "validator": validator,
            "payload": json.dumps(payload, ensure_ascii=False),
            "kwargs": kwargs,
        }
    )


# =========================================================================== extract
EXTRACT = "validate_extract_payload"

case("extract/normal", EXTRACT, {
    "question_type": "single_choice",
    "display_label": "3",
    "content": {"blocks": [text_block(CJK)], "options": options("opt_a", "opt_b")},
    "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_a"},
    "answer_status_known": True,
    "source_hint": {"page_index": 1, "note": "左上"},
    "doubts": ["第 2 行字迹较淡"],
})
case("extract/answer-unknown", EXTRACT, {
    "question_type": "single_choice",
    "content": {"blocks": [text_block("题干")], "options": options("opt_a", "opt_b")},
    "answer_payload": {},
    "answer_status_known": False,
})
case("extract/not-object", EXTRACT, ["not", "an", "object"])
case("extract/unknown-type", EXTRACT, {
    "question_type": "essay",
    "content": {"blocks": [text_block("题干")], "options": options("opt_a")},
    "answer_payload": {},
})
case("extract/unknown-type-null", EXTRACT, {"question_type": None, "content": {}})
case("extract/content-not-object", EXTRACT, {"question_type": "single_choice", "content": "text"})
case("extract/stem-empty", EXTRACT, {"question_type": "single_choice", "content": {}})
case("extract/material-empty-stem", EXTRACT, {"question_type": "material", "content": {}})
case("extract/blocks-not-list", EXTRACT, {"question_type": "single_choice", "content": {"blocks": "abc"}})
case("extract/blocks-empty-string", EXTRACT, {"question_type": "single_choice", "content": {"blocks": ""}})
case("extract/block-not-object", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": ["x", None, 3]}
})
case("extract/unknown-block-kind", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": [{"kind": "video"}, {"kind": None}, {}]}
})
case("extract/text-not-string", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": [{"kind": "text", "text": 5}]}
})
case("extract/text-too-long", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": [text_block("长" * 8001)]}
})
case("extract/text-html-and-script", EXTRACT, {
    "question_type": "single_choice",
    "content": {"blocks": [text_block("<div>x</div>"), text_block("javascript:alert(1)"), text_block("<SCRIPT>")]},
})
case("extract/text-long-script-case", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": [text_block("<ſcript>")]},
})
case("extract/math-empty", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": [{"kind": "math", "latex": "  "}, {"kind": "math"}]}
})
case("extract/math-html", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": [{"kind": "math", "latex": "x<script>"}]}
})
case("extract/image-unresolved", EXTRACT, {
    "question_type": "single_choice",
    "content": {"blocks": [{"kind": "image"}, {"kind": "image", "asset_id": 0}, {"kind": "image", "asset_id": "nope"}]},
})
case("extract/image-allowed", EXTRACT, {
    "question_type": "single_choice",
    "content": {"blocks": [{"kind": "image", "asset_id": "12345678-1234-5678-1234-567812345678"}]},
}, allowed_asset_ids=["12345678-1234-5678-1234-567812345678"])
case("extract/image-unknown-asset", EXTRACT, {
    "question_type": "single_choice",
    "content": {"blocks": [{"kind": "image", "asset_id": "12345678-1234-5678-1234-567812345678"}]},
}, allowed_asset_ids=["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"])
case("extract/image-invalid-uuid", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": [{"kind": "image", "asset_id": "abc"}]}
})
case("extract/table-problems", EXTRACT, {
    "question_type": "single_choice",
    "content": {
        "blocks": [
            {"kind": "table"},
            {"kind": "table", "rows": [[{"text": 1}, "ok", {"no_text": 1}], "row"]},
            {"kind": "table", "rows": []},
        ]
    },
})
case("extract/too-many-blocks", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": [text_block(f"第{i}段") for i in range(121)]}
})
case("extract/options-not-list", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": [text_block()], "options": {"id": "opt_a"}}
})
case("extract/options-empty", EXTRACT, {
    "question_type": "single_choice", "content": {"blocks": [text_block()], "options": []}
})
case("extract/multiple-choice-missing-options", EXTRACT, {
    "question_type": "multiple_choice", "content": {"blocks": [text_block()]}
})
case("extract/option-problems", EXTRACT, {
    "question_type": "single_choice",
    "content": {
        "blocks": [text_block()],
        "options": [
            "not-an-object",
            {"id": "bad id!"},
            {"id": "opt_a"},
            {"id": "opt_a", "blocks": [{"kind": "wat"}], "label": 5},
        ],
    },
})
case("extract/options-too-many", EXTRACT, {
    "question_type": "single_choice",
    "content": {"blocks": [text_block()], "options": [{"id": f"opt_{index}"} for index in range(27)]},
})
case("extract/blanks-empty", EXTRACT, {
    "question_type": "fill_blank", "content": {"blocks": [text_block()], "blanks": []}
})
case("extract/blanks-not-list", EXTRACT, {
    "question_type": "fill_blank", "content": {"blocks": [text_block()], "blanks": "b1"}
})
case("extract/blank-problems", EXTRACT, {
    "question_type": "fill_blank",
    "content": {
        "blocks": [text_block()],
        "blanks": [
            "not-an-object",
            {"blank_id": "bad id"},
            {"blank_id": "b1"},
            {"blank_id": "b1", "max_score": -1},
            {"blank_id": "b2", "max_score": "abc"},
            {"blank_id": "b3", "max_score": "0.00"},
        ],
    },
})
case("extract/blanks-too-many", EXTRACT, {
    "question_type": "fill_blank",
    "content": {"blocks": [text_block()], "blanks": [{"blank_id": f"b{index}"} for index in range(21)]},
})
case("extract/answer-claimed-but-empty", EXTRACT, {
    "question_type": "single_choice",
    "content": {"blocks": [text_block()], "options": options("opt_a")},
    "answer_payload": {},
    "answer_status_known": True,
})
case("extract/answer-truthy-non-object", EXTRACT, {
    "question_type": "single_choice",
    "content": {"blocks": [text_block()], "options": options("opt_a")},
    "answer_payload": "A",
    "answer_status_known": "yes",
})
case("extract/cleanup-truncation", EXTRACT, {
    "question_type": "single_choice",
    "display_label": "标签" * 300,
    "content": {"blocks": [text_block()], "options": options("opt_a")},
    "answer_payload": {"kind": "single_choice", "correct_option_id": "opt_a"},
    "answer_status_known": True,
    "source_hint": "not-a-dict",
    "doubts": ["疑点" * 400, 5, None, {"nested": [1, 2.0, True]}],
})
case("extract/doubts-string", EXTRACT, {
    "question_type": "single_choice",
    "content": {"blocks": [text_block()], "options": options("opt_a")},
    "doubts": "ab",
})
case("extract/unicode", EXTRACT, {
    "question_type": "single_choice",
    "display_label": EMOJI,
    "content": {"blocks": [text_block(EMOJI)], "options": options("opt_a")},
    "answer_payload": {},
    "answer_status_known": False,
    "doubts": ["😀" * 200],
})

# =========================================================================== explain
EXPLAIN = "validate_explain_payload"
CITATIONS = ["source:1", "rubric:2"]


def explain_case(name: str, payload, allowed=None) -> None:
    case(name, EXPLAIN, payload, allowed_citation_ids=CITATIONS if allowed is None else allowed)


explain_case("explain/normal", {
    "key_conditions": ["x=2", "先代入"],
    "stuck_points": ["符号"],
    "explanation_blocks": [
        {"kind": "text", "text": "先代入。"},
        {"kind": "math", "latex": "f(2)=0"},
        {"kind": "list", "items": ["检查符号", "", 5, None]},
    ],
    "method_summary": "代入法",
    "suggested_next": ["再做一题"],
    "missing_information": [],
    "citations": ["source:1", "rubric:2"],
})
explain_case("explain/not-object", ["x"])
explain_case("explain/block-not-object", {
    "explanation_blocks": [{"kind": "text", "text": "ok"}, "string", None, 3],
}, allowed=[])
explain_case("explain/unsupported-block", {
    "explanation_blocks": [{"kind": "video", "text": "x"}, {"kind": None}, {"text": "no kind"}],
    "citations": [],
}, allowed=[])
explain_case("explain/empty-block", {
    "explanation_blocks": [{"kind": "text", "text": "   "}, {"kind": "math", "latex": ""}, {"kind": "list", "items": []}],
    "citations": [],
}, allowed=[])
explain_case("explain/text-null-becomes-None", {
    "explanation_blocks": [{"kind": "text", "text": None}, {"kind": "math", "latex": None}],
    "citations": [],
}, allowed=[])
explain_case("explain/no-usable-content", {
    "key_conditions": [],
    "explanation_blocks": [],
    "citations": [],
}, allowed=[])
explain_case("explain/key-conditions-only", {
    "key_conditions": ["条件 1"],
    "explanation_blocks": [],
    "citations": [],
}, allowed=[])
explain_case("explain/citations", {
    "key_conditions": ["条件"],
    "explanation_blocks": [],
    "citations": ["source:1", "source:unknown", 5, "rubric:2"],
}, allowed=["source:1", "rubric:2", "5"])
explain_case("explain/blocks-string", {
    "explanation_blocks": "ab",
    "citations": [],
}, allowed=[])
explain_case("explain/truncation", {
    "key_conditions": ["k" * 400 for _ in range(25)],
    "stuck_points": ["s" * 400] * 21,
    "explanation_blocks": [
        {"kind": "text", "text": "t" * 4001},
        {"kind": "math", "latex": "m" * 4001},
        {"kind": "list", "items": ["i" * 501, ""]},
    ],
    "method_summary": "m" * 2001,
    "suggested_next": ["n" * 400] * 21,
    "missing_information": ["i" * 400] * 21,
    "citations": ["source:1"] * 25,
}, allowed=["source:1"])
explain_case("explain/unicode", {
    "key_conditions": [EMOJI],
    "explanation_blocks": [{"kind": "text", "text": EMOJI}, {"kind": "list", "items": ["😀" * 300]}],
    "citations": ["来源:一"],
}, allowed=["来源:一"])
explain_case("explain/empty-payload", {})

# =========================================================================== tags
TAGS = "validate_tag_suggestions"
ALLOWED_NODES = ["极限", "导数", "连续性", EMOJI]


def tags_case(name: str, payload, allowed=None) -> None:
    case(name, TAGS, payload, allowed_node_names=ALLOWED_NODES if allowed is None else allowed)


tags_case("tags/normal", {"tags": [
    {"name": "极限", "confidence": 0.9, "rationale": "题干出现 lim"},
    {"name": "导数", "confidence": "0.40", "rationale": ""},
]})
tags_case("tags/not-object", [1, 2])
tags_case("tags/missing", {})
tags_case("tags/tags-string", {"tags": "ab"})
tags_case("tags/item-problems", {"tags": [
    "not-an-object",
    {"name": "  "},
    {"name": "不在大纲"},
    {"name": " 极限 ", "confidence": 2},
    {"name": "导数", "confidence": -3},
    {"name": "连续性", "confidence": "nan"},
    {"name": "极限", "confidence": "inf"},
    {"name": "极限", "confidence": None},
    {"name": "极限", "confidence": "abc"},
    {"name": "极限", "confidence": {}},
]})
tags_case("tags/name-exact-match", {"tags": [
    {"name": "极限 ", "confidence": 0.5},
    {"name": "极 限", "confidence": 0.5},
    {"name": "极限拓展", "confidence": 0.5},
    {"name": "极限（补充）", "confidence": 0.5},
    {"name": EMOJI, "confidence": 0.5},
]})
tags_case("tags/unicode-rationale", {"tags": [
    {"name": EMOJI, "confidence": 0.5, "rationale": "理由😀" * 100},
]})
tags_case("tags/empty-allowed", {"tags": [{"name": "极限"}]}, allowed=[])
tags_case("tags/confidence-forms", {"tags": [
    {"name": "极限", "confidence": True},
    {"name": "导数", "confidence": " 0.5 "},
    {"name": "连续性", "confidence": "1_0"},
]})

# =========================================================================== transcribe
TRANSCRIBE = "validate_transcription"

case("transcribe/normal", TRANSCRIBE, {
    "text": "  x = 2，答：2。 ", "confidence": 0.8, "doubts": ["第二个字不确定"], "illegible": False,
})
case("transcribe/not-object", TRANSCRIBE, "just text")
case("transcribe/empty", TRANSCRIBE, {"text": "   ", "confidence": 0.5})
case("transcribe/missing-text", TRANSCRIBE, {})
case("transcribe/illegible-without-doubts", TRANSCRIBE, {"text": "", "illegible": True})
case("transcribe/illegible-with-doubts", TRANSCRIBE, {"text": "", "illegible": 1, "doubts": ["全糊"]})
case("transcribe/bad-confidence", TRANSCRIBE, {"text": "x", "confidence": "abc"})
case("transcribe/confidence-null", TRANSCRIBE, {"text": "x", "confidence": None})
case("transcribe/confidence-clamp", TRANSCRIBE, {"text": "x", "confidence": 5})
case("transcribe/confidence-negative", TRANSCRIBE, {"text": "x", "confidence": -1})
case("transcribe/confidence-inf", TRANSCRIBE, {"text": "x", "confidence": "inf"})
case("transcribe/confidence-nan", TRANSCRIBE, {"text": "x", "confidence": "nan"})
case("transcribe/confidence-bool", TRANSCRIBE, {"text": "x", "confidence": True})
case("transcribe/confidence-exponent", TRANSCRIBE, {"text": "x", "confidence": 1e400})
case("transcribe/confidence-json-nan", TRANSCRIBE, {"text": "x", "confidence": float("nan")})
case("transcribe/confidence-json-negative-infinity", TRANSCRIBE, {"text": "x", "confidence": float("-inf")})
case("transcribe/long-text", TRANSCRIBE, {"text": "字" * 9000, "confidence": 0.1})
case("transcribe/text-astral", TRANSCRIBE, {"text": "😀" * 9000})
case("transcribe/doubts-filtering", TRANSCRIBE, {
    "text": "x", "doubts": [" ", 5, None, {"a": 1}, "疑点" * 300],
})
case("transcribe/doubts-string", TRANSCRIBE, {"text": "x", "doubts": "ab"})
case("transcribe/unicode", TRANSCRIBE, {"text": "😀推导过程𠀀", "confidence": 0.3, "doubts": ["𠀀"]})

# =========================================================================== estimate
ESTIMATE = "validate_estimate"
CRITERIA = [
    {"criterion_id": "c1", "max_score": "2.00", "description": "第一点"},
    {"criterion_id": "c2", "max_score": "3.5", "description": "第二点"},
    {"criterion_id": "c3", "max_score": 4, "description": None},
    {"criterion_id": "c4", "max_score": "6.00", "description": "第四点"},
]


def estimate_case(name: str, payload, criteria=None) -> None:
    case(name, ESTIMATE, payload, criteria=CRITERIA if criteria is None else criteria)


estimate_case("estimate/normal", {
    "criteria": [
        {"criterion_id": "c1", "estimated_score": "1.50", "rationale": "写对了", "missing_evidence": []},
        {"criterion_id": "c2", "estimated_score": 2.5, "rationale": "部分正确", "missing_evidence": ["缺少图"]},
    ],
    "overall_note": "参考估计",
    "confidence": 0.6,
})
estimate_case("estimate/not-object", [1])
estimate_case("estimate/empty", {"criteria": []})
estimate_case("estimate/missing-criteria", {})
estimate_case("estimate/row-problems", {"criteria": [
    "not-an-object",
    {"criterion_id": "nope"},
    {"criterion_id": "c1", "estimated_score": "abc"},
    {"criterion_id": "c2", "estimated_score": -1},
    {"criterion_id": "c3", "estimated_score": True},
    {"criterion_id": "c4", "estimated_score": 1, "missing_evidence": ["e" * 250] * 25, "rationale": "r" * 600},
    {"criterion_id": "c1", "estimated_score": 2},
]})
estimate_case("estimate/over-cap", {"criteria": [
    {"criterion_id": "c1", "estimated_score": "5.00"},
    {"criterion_id": "c2", "estimated_score": "1e3"},
    {"criterion_id": "c3", "estimated_score": 99},
]})
estimate_case("estimate/decimal-formats", {"criteria": [
    {"criterion_id": "c1", "estimated_score": "2.000"},
    {"criterion_id": "c2", "estimated_score": 0.0},
    {"criterion_id": "c3", "estimated_score": "0.00"},
]})
estimate_case("estimate/duplicate-rows", {"criteria": [
    {"criterion_id": "c1", "estimated_score": 1},
    {"criterion_id": "c1", "estimated_score": 2},
]})
estimate_case("estimate/criterion-id-number", {"criteria": [
    {"criterion_id": 1, "estimated_score": 1},
]}, criteria=[{"criterion_id": 1, "max_score": "2.00"}])
estimate_case("estimate/confidence-forms", {"criteria": [{"criterion_id": "c1", "estimated_score": 1}], "confidence": "abc"})
estimate_case("estimate/confidence-inf", {"criteria": [{"criterion_id": "c1", "estimated_score": 1}], "confidence": "inf"})
estimate_case("estimate/overall-note-long", {
    "criteria": [{"criterion_id": "c1", "estimated_score": 1}], "overall_note": "n" * 1200,
})
estimate_case("estimate/unicode", {
    "criteria": [{"criterion_id": "c1", "estimated_score": 1, "rationale": "理由😀", "missing_evidence": ["缺𠀀"]}],
    "overall_note": EMOJI,
})

# =========================================================================== diagnose
DIAGNOSE = "validate_diagnosis"

case("diagnose/normal", DIAGNOSE, {
    "causes": [
        {"error_type": "concept_gap", "confidence": 0.7, "evidence": ["把 -3x 写成 +3x"]},
        {"error_type": "unknown", "confidence": 0.1, "evidence": []},
    ],
    "follow_up_questions": [
        {"question": "你当时是怎么展开的？", "why": "需要过程", "evidence_kind": "过程步骤"},
        "能写一下第二步吗？",
    ],
    "missing_information": ["没有草稿"],
})
case("diagnose/not-object", DIAGNOSE, 5)
case("diagnose/cause-problems", DIAGNOSE, {
    "causes": [
        "not-an-object",
        {"error_type": "made_up"},
        {"error_type": "calculation_slip", "evidence": ["  "]},
        {"error_type": "unit_or_sign_error"},
        {"error_type": "unknown", "confidence": 9, "evidence": ["e"]},
        {"error_type": "unknown", "confidence": "abc", "evidence": ["dup"]},
        {"error_type": " guessing ", "confidence": "0.5", "evidence": ["e" * 400]},
    ],
    "follow_up_questions": [],
})
case("diagnose/question-problems", DIAGNOSE, {
    "causes": [],
    "follow_up_questions": [
        {"question": "   "},
        "   ",
        "",
        {"question": "q" * 600, "why": "w" * 400, "evidence_kind": "k" * 100},
    ] + [{"question": f"q{index}"} for index in range(10)],
    "missing_information": ["m" * 400] * 25,
})
case("diagnose/causes-string", DIAGNOSE, {"causes": "ab"})
case("diagnose/question-number", DIAGNOSE, {"causes": [], "follow_up_questions": [5, True, None]})
case("diagnose/unicode", DIAGNOSE, {
    "causes": [{"error_type": "misread_question", "confidence": 0.4, "evidence": ["看错😀"]}],
    "follow_up_questions": [{"question": "为什么𠀀？", "why": "原因", "evidence_kind": "题意理解"}],
    "missing_information": [EMOJI],
})

# =========================================================================== variant
VARIANT = "validate_variant_payload"
AVOID = ["已知 f(x)=x^2-3x+2，则 f(2)=？"]


def variant_case(name: str, question_type: str, payload, avoid=None) -> None:
    case(name, VARIANT, payload, question_type=question_type, avoid_stems=AVOID if avoid is None else avoid)


variant_case("variant/single-choice-ok", "single_choice", single_choice_payload())
variant_case("variant/multiple-choice-ok", "multiple_choice", multiple_choice_payload())
variant_case("variant/true-false-ok", "true_false", true_false_payload())
variant_case("variant/fill-blank-ok", "fill_blank", fill_blank_payload())
variant_case("variant/constructed-ok", "constructed_response", constructed_payload())
variant_case("variant/type-not-scorable-material", "material", single_choice_payload(question_type="material"))
variant_case("variant/type-not-scorable-unknown", "essay", single_choice_payload(question_type="essay"))
variant_case("variant/not-object", "single_choice", ["x"])
variant_case("variant/type-mismatch", "single_choice", multiple_choice_payload())
variant_case("variant/content-not-object", "single_choice", single_choice_payload(content="text"))
variant_case("variant/content-problems", "single_choice", single_choice_payload(content={
    "blocks": "abc", "options": [{"id": "bad id"}, {"id": "opt_a"}, {"id": "opt_a"}],
}))
variant_case("variant/stem-empty", "single_choice", single_choice_payload(content={"blocks": []}))
variant_case("variant/image-block", "single_choice", single_choice_payload(content={
    "blocks": [text_block("题干"), {"kind": "image", "asset_id": "12345678-1234-5678-1234-567812345678"}],
    "options": options("opt_a", "opt_b"),
}))
variant_case("variant/answer-missing", "single_choice", mutated(single_choice_payload(), __delete__=["answer_payload"]))
variant_case("variant/answer-empty", "single_choice", mutated(single_choice_payload(), answer_payload={}))
variant_case("variant/answer-not-object", "single_choice", mutated(single_choice_payload(), answer_payload="B"))
variant_case("variant/answer-kind-mismatch", "single_choice", mutated(
    single_choice_payload(), answer_payload={"kind": "multiple_choice", "correct_option_id": "opt_b"},
))
variant_case("variant/single-multiple-correct", "single_choice", mutated(
    single_choice_payload(),
    answer_payload={"kind": "single_choice", "correct_option_id": "opt_b", "correct_option_ids": ["opt_a"]},
))
variant_case("variant/single-correct-missing", "single_choice", mutated(
    single_choice_payload(), answer_payload={"kind": "single_choice", "correct_option_id": 5},
))
variant_case("variant/single-correct-blank", "single_choice", mutated(
    single_choice_payload(), answer_payload={"kind": "single_choice", "correct_option_id": "  "},
))
variant_case("variant/single-correct-unknown", "single_choice", mutated(
    single_choice_payload(), answer_payload={"kind": "single_choice", "correct_option_id": "opt_z"},
))
variant_case("variant/single-correct-leak", "single_choice", mutated(
    single_choice_payload(),
    content={
        "blocks": [text_block("题干里直接写着选项 选项 opt_b 的文本")],
        "options": options("opt_a", "opt_b"),
    },
))
variant_case("variant/single-short-option-not-leak", "single_choice", mutated(
    single_choice_payload(),
    content={"blocks": [text_block("0")], "options": [{"id": "opt_a", "blocks": [text_block("0")]}]},
    answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
))
variant_case("variant/multiple-missing", "multiple_choice", mutated(
    multiple_choice_payload(), answer_payload={"kind": "multiple_choice"},
))
variant_case("variant/multiple-duplicate-and-few", "multiple_choice", mutated(
    multiple_choice_payload(), answer_payload={"kind": "multiple_choice", "correct_option_ids": ["opt_a", "opt_a"]},
))
variant_case("variant/multiple-too-few", "multiple_choice", mutated(
    multiple_choice_payload(), answer_payload={"kind": "multiple_choice", "correct_option_ids": ["opt_a"]},
))
variant_case("variant/multiple-unknown", "multiple_choice", mutated(
    multiple_choice_payload(), answer_payload={"kind": "multiple_choice", "correct_option_ids": ["opt_a", "opt_z"]},
))
variant_case("variant/multiple-leak", "multiple_choice", mutated(
    multiple_choice_payload(),
    content={
        "blocks": [text_block("题干包含 选项 opt_a 与 选项 opt_b")],
        "options": options("opt_a", "opt_b"),
    },
))
variant_case("variant/true-false-string", "true_false", mutated(
    true_false_payload(), answer_payload={"kind": "true_false", "value": "true"},
))
variant_case("variant/true-false-number", "true_false", mutated(
    true_false_payload(), answer_payload={"kind": "true_false", "value": 1},
))
variant_case("variant/fill-no-blanks", "fill_blank", mutated(
    fill_blank_payload(), content={"blocks": [text_block("无空位")], "blanks": []},
))
variant_case("variant/fill-answer-missing", "fill_blank", mutated(
    fill_blank_payload(), answer_payload={"kind": "fill_blank"},
))
variant_case("variant/fill-answer-empty", "fill_blank", mutated(
    fill_blank_payload(), answer_payload={"kind": "fill_blank", "blanks": {}},
))
variant_case("variant/fill-missing-and-unknown", "fill_blank", mutated(
    fill_blank_payload(),
    answer_payload={"kind": "fill_blank", "blanks": {"b1": {"accepted_values": ["2"]}, "b9": {"accepted_values": ["4"]}}},
))
variant_case("variant/fill-blank-answer-problems", "fill_blank", mutated(
    fill_blank_payload(),
    answer_payload={
        "kind": "fill_blank",
        "blanks": {
            "b1": "not-object",
            "b2": {"accepted_values": ["", "   "]},
        },
    },
))
variant_case("variant/fill-accepted-string", "fill_blank", mutated(
    fill_blank_payload(),
    answer_payload={"kind": "fill_blank", "blanks": {"b1": {"accepted_values": "24"}, "b2": {"accepted_values": [4]}}},
))
variant_case("variant/rubric-missing", "constructed_response", mutated(
    constructed_payload(), __delete__=["rubric_criteria"],
))
variant_case("variant/rubric-not-list", "constructed_response", mutated(
    constructed_payload(), rubric_criteria="c1",
))
variant_case("variant/rubric-empty", "constructed_response", mutated(
    constructed_payload(), rubric_criteria=[],
))
variant_case("variant/rubric-row-problems", "constructed_response", mutated(
    constructed_payload(),
    rubric_criteria=[
        "not-an-object",
        {"max_score": "1.00"},
        {"criterion_id": " ", "max_score": "1.00"},
        {"criterion_id": "c1", "max_score": "abc"},
        {"criterion_id": "c2", "max_score": "0"},
        {"criterion_id": "c3", "max_score": "-1"},
        {"criterion_id": "c4", "max_score": None},
        {"criterion_id": "c4", "max_score": "1.00"},
    ],
    rubric_total_score="1.00",
))
variant_case("variant/rubric-duplicate", "constructed_response", mutated(
    constructed_payload(),
    rubric_criteria=[
        {"criterion_id": "c1", "max_score": "1.00"},
        {"criterion_id": "c1", "max_score": "2.00"},
    ],
    rubric_total_score="3.00",
))
variant_case("variant/rubric-total-missing", "constructed_response", mutated(
    constructed_payload(), __delete__=["rubric_total_score"],
))
variant_case("variant/rubric-total-invalid", "constructed_response", mutated(
    constructed_payload(), rubric_total_score="abc",
))
variant_case("variant/rubric-total-not-positive", "constructed_response", mutated(
    constructed_payload(), rubric_total_score="0.00",
))
variant_case("variant/rubric-total-mismatch", "constructed_response", mutated(
    constructed_payload(), rubric_total_score="6.00",
))
variant_case("variant/rubric-required-missing", "constructed_response", mutated(
    constructed_payload(), answer_payload={"kind": "constructed_response"},
))
variant_case("variant/rubric-required-number", "constructed_response", mutated(
    constructed_payload(), answer_payload={"kind": "constructed_response", "rubric_required": 1},
))
variant_case("variant/rubric-required-string", "constructed_response", mutated(
    constructed_payload(), answer_payload={"kind": "constructed_response", "rubric_required": "true"},
))
variant_case("variant/rubric-required-false", "constructed_response", mutated(
    constructed_payload(), answer_payload={"kind": "constructed_response", "rubric_required": False},
))
variant_case("variant/score-invalid", "single_choice", mutated(
    single_choice_payload(), practice_max_score="abc",
))
variant_case("variant/score-zero", "single_choice", mutated(
    single_choice_payload(), practice_max_score="0",
))
variant_case("variant/score-negative", "single_choice", mutated(
    single_choice_payload(), practice_max_score=-1,
))
variant_case("variant/score-float-lexeme", "single_choice", mutated(
    single_choice_payload(), practice_max_score=2.0,
))
variant_case("variant/stem-copies-source", "single_choice", mutated(
    single_choice_payload(),
    content={
        "blocks": [text_block("已知 f(x) = x^2 - 3x + 2，则 f(2) = ？")],
        "options": options("opt_a", "opt_b"),
    },
))
variant_case("variant/stem-leaks-chinese-marker", "single_choice", mutated(
    single_choice_payload(),
    content={"blocks": [text_block("故选 B。")], "options": options("opt_a", "opt_b")},
))
variant_case("variant/stem-leaks-english-marker", "single_choice", mutated(
    single_choice_payload(),
    content={"blocks": [text_block("The correct answer is B")], "options": options("opt_a", "opt_b")},
))
variant_case("variant/stem-leaks-case", "single_choice", mutated(
    single_choice_payload(),
    content={"blocks": [text_block("ANSWER IS B")], "options": options("opt_a", "opt_b")},
))
variant_case("variant/avoid-empty", "single_choice", mutated(single_choice_payload()), avoid=[])
variant_case("variant/avoid-string", "single_choice", mutated(single_choice_payload()), avoid="ab")
variant_case("variant/doubts-filtering", "single_choice", mutated(
    single_choice_payload(), doubts=[" ", 5, None, "疑点" * 200, {"a": 1}],
))
variant_case("variant/unicode", "single_choice", mutated(
    single_choice_payload(),
    content={
        "blocks": [text_block("已知函数 😀𠀀，则 f(2)=？")],
        "options": [{"id": "opt_a", "label": "甲", "blocks": [text_block("𠀀")]}, {"id": "opt_b", "label": "乙", "blocks": [text_block("😀")]}],
    },
    answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
    rationale="理由😀",
    difficulty_note="难度𠀀",
))
variant_case("variant/option-leak-7-normalized-chars", "single_choice", mutated(
    single_choice_payload(),
    content={
        "blocks": [text_block("题干包含 abcdefg 但不足八个字符")],
        "options": [{"id": "opt_a", "blocks": [text_block("abcdefg")]}, {"id": "opt_b", "blocks": [text_block("b")]}],
    },
    answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
))
variant_case("variant/option-leak-8-normalized-chars", "single_choice", mutated(
    single_choice_payload(),
    content={
        "blocks": [text_block("题干包含 abcdefgh 八个字符")],
        "options": [{"id": "opt_a", "blocks": [text_block("abcdefgh")]}, {"id": "opt_b", "blocks": [text_block("b")]}],
    },
    answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
))
variant_case("variant/option-leak-astral-length", "single_choice", mutated(
    single_choice_payload(),
    content={
        "blocks": [text_block("😀😀😀😀😀😀😀😀")],
        "options": [{"id": "opt_a", "blocks": [text_block("😀😀😀😀")]}, {"id": "opt_b", "blocks": [text_block("b")]}],
    },
    answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
))
variant_case("variant/avoid-index", "single_choice", mutated(
    single_choice_payload(),
    content={"blocks": [text_block("完全不同的一道题")], "options": options("opt_a", "opt_b")},
))


# The two call sites that validate `call.payload` directly instead of parsing `raw_text`
# (`knowledge.services.suggestions`, `question_bank.services.variants`). With the real HTTP provider
# `payload` is `{"text": text}`, so these vectors pin today's behaviour instead of an idealised one.
case("tags/provider-payload-text-only", TAGS, {"text": "{\"tags\": [{\"name\": \"极限\"}]}"}, allowed_node_names=ALLOWED_NODES)
case("variant/provider-payload-text-only", VARIANT, {"text": "{\"question_type\": \"single_choice\"}"},
     question_type="single_choice", avoid_stems=[])

def run_case(case_entry: dict) -> dict:
    validator = getattr(prompts, case_entry["validator"])
    payload = json.loads(case_entry["payload"])
    kwargs = dict(case_entry["kwargs"])
    if case_entry["validator"] == "validate_extract_payload":
        allowed = kwargs.get("allowed_asset_ids")
        kwargs["allowed_asset_ids"] = set(allowed) if allowed is not None else None
    elif case_entry["validator"] == "validate_explain_payload":
        kwargs["allowed_citation_ids"] = set(kwargs["allowed_citation_ids"])
    elif case_entry["validator"] == "validate_tag_suggestions":
        kwargs["allowed_node_names"] = set(kwargs["allowed_node_names"])
    try:
        clean, problems = validator(payload, **kwargs)
    except Exception as exc:  # noqa: BLE001 - recorded, never hidden
        raise RuntimeError(f"{case_entry['name']} raised {type(exc).__name__}: {exc}") from exc
    return {
        **case_entry,
        "clean": json.loads(json.dumps(clean, ensure_ascii=False)),
        "problems": json.loads(json.dumps(problems, ensure_ascii=False)),
    }


RAN_CASES = [run_case(entry) for entry in VALIDATOR_CASES]

COVERAGE = {
    "validators": sorted({entry["validator"] for entry in RAN_CASES}),
    "problem_codes": sorted({problem["code"] for entry in RAN_CASES for problem in entry["problems"]}),
    "cases": len(RAN_CASES),
}

# Raw-text handling: `_strip_code_fence` + `json.loads`, executed for real.
PARSING_INPUTS = [
    '{"a": 1}',
    '  {"a": 1}  \n',
    '```json\n{"a": 1}\n```',
    '```\n{"a": 1}\n```',
    '```json\n{\n  "a": 1,\n  "b": [2, 3]\n}\n```',
    '```json\n{"a": 1}\n```   ',
    '```json\n{"a": 1}\n```',
    '```abc```',
    'here:\n```json\n{"a": 1}\n```',
    '```json\n{"a": 1}\n```tail',
    '',
    '   ',
    '{',
    '[1, 2]',
    '"just a string"',
    '{"text": "中文 😀 𠀀"}',
    '{"score": 2.0, "exp": 1e3, "big": 123456789}',
    '{"nested": {"x": [true, false, null]}}',
    'not json at all',
    '{"a": 1}\n```',
]


def parsing_case(raw: str) -> dict:
    stripped = _strip_code_fence(raw)
    try:
        parsed = json.loads(stripped)
        return {
            "input": raw,
            "stripped": stripped,
            "parsed": json.loads(json.dumps(parsed, ensure_ascii=False)),
            "error": None,
        }
    except json.JSONDecodeError as exc:
        return {"input": raw, "stripped": stripped, "parsed": None, "error": type(exc).__name__}


PARSING_VECTORS = [parsing_case(raw) for raw in PARSING_INPUTS]

payload = {
    "parsing": PARSING_VECTORS,
    "source": {
        "file": "backend/ai/prompts/registry.py",
        "harness": "real validate_* functions imported with django.setup(); payloads are JSON text to preserve numeric lexemes",
    },
    "coverage": COVERAGE,
    "cases": RAN_CASES,
}

json.dump(payload, sys.stdout, ensure_ascii=False, sort_keys=False, separators=(",", ":"))
sys.stdout.write("\n")
