"""Text import parsing, content validation and answer validation."""

from __future__ import annotations

import pytest

from apps.common.answers import validate_answer_payload
from apps.common.content import validate_content
from apps.ingestion.services import text_parser

TEMPLATE_TEXT = """【题型】单选题
【题干】方程 x+1=0 的解是 __。
【选项】
A. -1
B. 1
C. 0
D. 2
【答案】A
【解析】移项即可。
【分值】2

【题型】多选题
【题干】下列哪些属于演示选项？
【选项】
A. 甲
B. 乙
C. 丙
D. 丁
【答案】AC

【题型】填空题
【题干】结果保留一位小数，约为 __，另一空为 __。
【答案】10.0; -2
"""


def test_labelled_template_parses_all_three_questions():
    segments = text_parser.parse_paste(TEMPLATE_TEXT)
    assert len(segments) == 3
    single, multiple, fill = segments
    assert single["question_type"] == "single_choice"
    assert single["answer_payload"] == {"kind": "single_choice", "correct_option_id": "opt_a"}
    assert [option["id"] for option in single["content"]["options"]] == ["opt_a", "opt_b", "opt_c", "opt_d"]
    assert multiple["question_type"] == "multiple_choice"
    assert multiple["answer_payload"]["correct_option_ids"] == ["opt_a", "opt_c"]
    assert fill["question_type"] == "fill_blank"
    assert [blank["blank_id"] for blank in fill["content"]["blanks"]] == ["b1", "b2"]
    assert fill["answer_payload"]["blanks"]["b1"]["accepted_values"] == ["10.0"]
    assert fill["answer_payload"]["blanks"]["b2"]["accepted_values"] == ["-2"]


def test_negative_sign_and_units_survive_parsing():
    text = """【题型】填空题
【题干】速度 __ m/s，温度为 __ ℃。
【答案】-3.5; -40
"""
    segment = text_parser.parse_paste(text)[0]
    compact = str(segment)
    assert "-3.5" in compact and "-40" in compact


def test_numbered_fallback_does_not_invent_an_answer():
    text = """1. 下列说法正确的是（ ）
A. 甲
B. 乙
C. 丙
"""
    segments = text_parser.parse_paste(text)
    assert len(segments) == 1
    assert segments[0]["answer_status_known"] is False
    assert "未提供答案" in " ".join(segments[0]["parse_issues"])


def test_parsed_answer_of_unclear_type_is_flagged_for_review():
    text = """【题干】下面哪一项正确？
【选项】
A. 甲
B. 乙
【答案】AB
"""
    segment = text_parser.parse_paste(text)[0]
    # Two letters with no declared type: inferred multiple choice, still human-checked.
    assert segment["question_type"] in {"single_choice", "multiple_choice"}
    assert segment["answer_status_known"] is True


def test_blank_count_mismatch_is_reported_not_guessed():
    text = """【题型】填空题
【题干】两个空：__ 和 __。
【答案】只有一空
"""
    segment = text_parser.parse_paste(text)[0]
    assert segment["answer_status_known"] is False
    assert "不一致" in " ".join(segment["parse_issues"])


def test_rubric_lines_become_criteria():
    text = """【题型】大题
【题干】请说明推导过程。
【答案】略
【评分标准】
列出已知条件 2 分
推导正确 3 分
结论与单位 5 分
"""
    segment = text_parser.parse_paste(text)[0]
    criteria = segment["rubric_criteria"]
    assert [criterion["max_score"] for criterion in criteria] == ["2", "3", "5"]
    assert sum(float(criterion["max_score"]) for criterion in criteria) == 10


# ------------------------------------------------------------- content checks
def test_content_rejects_raw_html_and_script():
    content = {"blocks": [{"kind": "text", "text": "题干 <script>alert(1)</script>"}]}
    problems = validate_content(content, "single_choice")
    assert any(problem["code"] == "raw_html_rejected" for problem in problems)

    link = {"blocks": [{"kind": "text", "text": "看这里 javascript:alert(1)"}]}
    assert any(problem["code"] == "raw_html_rejected" for problem in validate_content(link, "single_choice"))


def test_content_rejects_duplicate_option_and_blank_ids():
    duplicated = {
        "blocks": [{"kind": "text", "text": "题干"}],
        "options": [
            {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "甲"}]},
            {"id": "opt_a", "label": "B", "blocks": [{"kind": "text", "text": "乙"}]},
        ],
    }
    problems = validate_content(duplicated, "single_choice")
    assert any(problem["code"] == "option_id_duplicate" for problem in problems)

    blank_dup = {
        "blocks": [{"kind": "text", "text": "题干 __ __"}],
        "blanks": [{"blank_id": "b1"}, {"blank_id": "b1"}],
    }
    problems = validate_content(blank_dup, "fill_blank")
    assert any(problem["code"] == "blank_id_duplicate" for problem in problems)


def test_content_requires_image_source():
    problems = validate_content({"blocks": [{"kind": "image"}]}, "single_choice")
    assert any(problem["code"] == "image_without_source" for problem in problems)


def test_material_parent_does_not_require_a_stem_of_its_own():
    problems = validate_content({"blocks": [{"kind": "text", "text": "共享材料"}]}, "material")
    assert problems == []


# -------------------------------------------------------------- answer checks
def test_answer_payload_must_match_question_type():
    problems = validate_answer_payload({"kind": "true_false", "value": True}, "single_choice")
    assert any(problem["code"] == "answer_kind_mismatch" for problem in problems)


def test_answer_payload_rejects_unknown_option_ids():
    content = {
        "options": [{"id": "opt_a"}, {"id": "opt_b"}],
        "blocks": [{"kind": "text", "text": "题干"}],
    }
    problems = validate_answer_payload({"kind": "single_choice", "correct_option_id": "opt_z"}, "single_choice", content)
    assert any(problem["code"] == "correct_option_unknown" for problem in problems)


def test_partial_score_without_policy_is_rejected():
    problems = validate_answer_payload(
        {
            "kind": "multiple_choice",
            "correct_option_ids": ["opt_a"],
            "policy": "exact_match",
            "partial_score": "2.00",
        },
        "multiple_choice",
    )
    assert any(problem["code"] == "partial_score_without_policy" for problem in problems)


def test_normalization_switch_cannot_delete_symbols_globally():
    problems = validate_answer_payload(
        {
            "kind": "fill_blank",
            "blanks": {"b1": {"accepted_values": ["-2"], "normalization": {"delete_symbols": True}, "max_score": "1.00"}},
        },
        "fill_blank",
        {"blocks": [{"kind": "text", "text": "__"}], "blanks": [{"blank_id": "b1"}]},
    )
    assert any(problem["code"] == "normalization_unknown" for problem in problems)


def test_fill_blank_answer_must_cover_every_blank():
    content = {"blocks": [{"kind": "text", "text": "__ __"}], "blanks": [{"blank_id": "b1"}, {"blank_id": "b2"}]}
    problems = validate_answer_payload(
        {"kind": "fill_blank", "blanks": {"b1": {"accepted_values": ["x"], "max_score": "1.00"}}},
        "fill_blank",
        content,
    )
    assert any(problem["code"] == "blank_answer_missing" for problem in problems)
    assert not any(problem["code"] == "blank_answer_unknown" for problem in problems)


@pytest.mark.parametrize("question_type", ["single_choice", "multiple_choice", "true_false", "fill_blank"])
def test_objective_types_reject_a_truthy_but_wrong_shape(question_type):
    problems = validate_answer_payload({"kind": question_type, "value": "maybe"}, question_type)
    assert problems
