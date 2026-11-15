"""Golden vectors for the seven versioned prompt builders.

The oracle is the real `ai.prompts.registry` module: every expected string below is produced by
calling the Python builder itself, never by re-implementing it. The builder/kwargs pairs are also
what `tests/ai_prompts.test.ts` feeds to the Node port, so any byte drift (a space, a fallback
string, a truncation limit) shows up as a diff.

Usage (from dsh-plugin/):
    ../backend/.venv/bin/python scripts/gen_ai_prompts_golden.py > tests/golden/ai_prompts.json
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")
import django  # noqa: E402

django.setup()

from ai.prompts import registry as prompts  # noqa: E402

CJK = "一元二次方程的判别式与根的关系，请保留负号、单位与上下标：x² − 3x + 2 = 0"
EMOJI = "第 2 页 · 含😀与𠀀（超出 BMP 的字）"
LONG = "a" * 400
HUGE = "a" * 4200
ASTRAL = "😀" * 3001


PROMPT_CASES = [
    # ---------------------------------------------------------------- extract
    {
        "name": "extract/normal",
        "builder": "build_extract_prompt",
        "kwargs": {"project_name": "期末复习", "subject_name": "高等数学", "source_note": "2026 年期中卷 第 1 页"},
    },
    {
        "name": "extract/defaults",
        "builder": "build_extract_prompt",
        "kwargs": {"project_name": "错题本", "subject_name": "线性代数"},
    },
    {
        "name": "extract/empty-note",
        "builder": "build_extract_prompt",
        "kwargs": {"project_name": "错题本", "subject_name": "线性代数", "source_note": ""},
    },
    {
        "name": "extract/unicode",
        "builder": "build_extract_prompt",
        "kwargs": {"project_name": EMOJI, "subject_name": "大学物理", "source_note": CJK},
    },
    {
        "name": "extract/long-names",
        "builder": "build_extract_prompt",
        "kwargs": {"project_name": LONG, "subject_name": LONG, "source_note": LONG},
    },
    {
        "name": "extract/null-values",
        "builder": "build_extract_prompt",
        "kwargs": {"project_name": None, "subject_name": None, "source_note": None},
    },
    {
        "name": "extract/whitespace-note",
        "builder": "build_extract_prompt",
        "kwargs": {"project_name": "项目", "subject_name": "科目", "source_note": " \n "},
    },
    # ---------------------------------------------------------------- explain
    {
        "name": "explain/typical",
        "builder": "build_explain_prompt",
        "kwargs": {
            "question_type": "single_choice",
            "stem_text": "已知函数 f(x)=x^2-3x+2，则 f(2) 的值为？",
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "0"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "1"}, {"kind": "math", "latex": "x^2"}]},
                {"id": "opt_c", "label": "C", "blocks": []},
                {"id": "opt_d", "label": "", "blocks": [{"kind": "text", "text": "3"}]},
            ],
            "answer_summary": "答案 B：将 x=2 代入得 0？不对，应为 0。",
            "explanation_blocks": [
                {"kind": "text", "text": "先代入。"},
                {"kind": "math", "latex": "f(2)=4-6+2=0"},
                {"kind": "list", "items": ["检查符号", "检查单位"]},
            ],
            "allowed_citation_ids": ["source:1", "rubric:2", "考点:判别式"],
            "attempt_summary": "我算成了 1，因为把 -3x 写成了 +3x。",
            "user_question": "我哪一步错了？",
            "knowledge_nodes": ["一元二次方程", "函数求值"],
            "rubric_criteria": [
                {"criterion_id": "c1", "max_score": "2.00", "text": "正确代入"},
                {"criterion_id": "c2", "max_score": 2.5, "text": ""},
            ],
            "material_text": "共享材料：某公司利润函数。",
            "blanks": [{"blank_id": "b1", "label": "第 1 空"}, {"blank_id": "b2", "label": ""}],
        },
    },
    {
        "name": "explain/minimal",
        "builder": "build_explain_prompt",
        "kwargs": {
            "question_type": "constructed_response",
            "stem_text": "",
            "options": [],
            "answer_summary": "",
            "explanation_blocks": [],
            "allowed_citation_ids": [],
        },
    },
    {
        "name": "explain/blank-shapes",
        "builder": "build_explain_prompt",
        "kwargs": {
            "question_type": "fill_blank",
            "stem_text": "填空：1+1=____",
            "options": [],
            "answer_summary": "",
            "explanation_blocks": [],
            "allowed_citation_ids": [],
            "knowledge_nodes": [],
            "rubric_criteria": [],
            "material_text": "",
            "blanks": [{"blank_id": "b1"}, {"label": "无 ID"}, {"blank_id": "b2", "label": "第二空"}],
        },
    },
    {
        "name": "explain/option-without-label-or-blocks",
        "builder": "build_explain_prompt",
        "kwargs": {
            "question_type": "multiple_choice",
            "stem_text": "选出全部正确项",
            "options": [{"id": "opt_a"}, {"label": "B", "blocks": [{"kind": "math", "latex": "\\frac{1}{2}"}]}],
            "answer_summary": "答案 A、B",
            "explanation_blocks": [{"kind": "text", "text": None}, {"kind": "image"}],
            "allowed_citation_ids": ["source:1"],
            "knowledge_nodes": ["集合"],
            "material_text": "材料",
            "attempt_summary": "作答",
            "user_question": "问题",
        },
    },
    {
        "name": "explain/long-fields",
        "builder": "build_explain_prompt",
        "kwargs": {
            "question_type": "single_choice",
            "stem_text": HUGE,
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": LONG}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "短"}]},
            ],
            "answer_summary": LONG,
            "explanation_blocks": [{"kind": "text", "text": LONG}, {"kind": "math", "latex": "x" * 5000}],
            "allowed_citation_ids": [f"source:{index}" for index in range(30)],
            "attempt_summary": LONG,
            "user_question": LONG,
            "knowledge_nodes": [f"考点{index}" for index in range(40)],
            "rubric_criteria": [{"criterion_id": f"c{index}", "max_score": index, "text": "评分点"} for index in range(40)],
            "material_text": LONG,
            "blanks": [{"blank_id": f"b{index}", "label": "空"} for index in range(40)],
        },
    },
    {
        "name": "explain/unicode-astral",
        "builder": "build_explain_prompt",
        "kwargs": {
            "question_type": "single_choice",
            "stem_text": EMOJI,
            "options": [{"id": "opt_a", "label": "甲", "blocks": [{"kind": "text", "text": "😀"}, {"kind": "math", "latex": "𠀀"}]}],
            "answer_summary": "答案甲",
            "explanation_blocks": [{"kind": "text", "text": "𠀀😀"}],
            "allowed_citation_ids": ["来源:一"],
            "knowledge_nodes": ["中文考点"],
            "material_text": "材料😀",
            "attempt_summary": "作答𠀀",
            "user_question": "为何？",
            "rubric_criteria": [{"criterion_id": "c1", "max_score": "0.50", "text": "文字"}],
            "blanks": [{"blank_id": "b1", "label": "空😀"}],
        },
    },
    # ---------------------------------------------------------------- tags
    {
        "name": "tags/typical",
        "builder": "build_tag_suggestion_prompt",
        "kwargs": {
            "subject_name": "高等数学",
            "stem_text": "求极限 lim_{x→0} sin x / x",
            "option_texts": ["0", "1", "不存在"],
            "allowed_node_names": ["极限", "导数", "连续性"],
            "material_text": "材料：三角函数基本极限。",
        },
    },
    {
        "name": "tags/no-material-no-options",
        "builder": "build_tag_suggestion_prompt",
        "kwargs": {
            "subject_name": "线性代数",
            "stem_text": "矩阵可逆的条件",
            "option_texts": [],
            "allowed_node_names": [],
        },
    },
    {
        "name": "tags/option-filtering",
        "builder": "build_tag_suggestion_prompt",
        "kwargs": {
            "subject_name": "线性代数",
            "stem_text": "题干",
            "option_texts": ["", "A", None, "0"],
            "allowed_node_names": ["行列式"],
            "material_text": "",
        },
    },
    {
        "name": "tags/truncation",
        "builder": "build_tag_suggestion_prompt",
        "kwargs": {
            "subject_name": "数学",
            "stem_text": HUGE,
            "option_texts": [LONG],
            "allowed_node_names": [f"考点{index}" for index in range(205)],
            "material_text": HUGE,
        },
    },
    {
        "name": "tags/unicode",
        "builder": "build_tag_suggestion_prompt",
        "kwargs": {
            "subject_name": EMOJI,
            "stem_text": EMOJI,
            "option_texts": ["甲𠀀", ""],
            "allowed_node_names": ["中文考点", "另一个考点"],
            "material_text": "材料😀",
        },
    },
    # ---------------------------------------------------------------- transcribe
    {
        "name": "transcribe/typical",
        "builder": "build_transcribe_prompt",
        "kwargs": {"subject_name": "物理", "question_stem": "计算小球落地时间", "note": "字迹较淡"},
    },
    {
        "name": "transcribe/defaults",
        "builder": "build_transcribe_prompt",
        "kwargs": {"subject_name": "物理"},
    },
    {
        "name": "transcribe/long-and-unicode",
        "builder": "build_transcribe_prompt",
        "kwargs": {"subject_name": EMOJI, "question_stem": HUGE, "note": CJK},
    },
    {
        "name": "transcribe/null-note",
        "builder": "build_transcribe_prompt",
        "kwargs": {"subject_name": "化学", "question_stem": "", "note": None},
    },
    # ---------------------------------------------------------------- estimate
    {
        "name": "estimate/typical",
        "builder": "build_estimate_prompt",
        "kwargs": {
            "question_type": "constructed_response",
            "stem_text": "证明根号 2 是无理数。",
            "rubric_criteria": [
                {"criterion_id": "c1", "max_score": "2.00", "description": "假设相反"},
                {"criterion_id": "c2", "max_score": 3, "description": "推出矛盾"},
                {"criterion_id": "c3", "max_score": "5.00"},
            ],
            "learner_answer_text": "假设 √2=p/q ...",
            "transcription_note": "已确认转写",
            "max_total": "10.00",
        },
    },
    {
        "name": "estimate/defaults",
        "builder": "build_estimate_prompt",
        "kwargs": {
            "question_type": "fill_blank",
            "stem_text": "",
            "rubric_criteria": [],
            "learner_answer_text": "",
        },
    },
    {
        "name": "estimate/long-fields",
        "builder": "build_estimate_prompt",
        "kwargs": {
            "question_type": "constructed_response",
            "stem_text": HUGE,
            "rubric_criteria": [
                {"criterion_id": f"c{index}", "max_score": index, "description": HUGE} for index in range(2)
            ],
            "learner_answer_text": HUGE,
            "transcription_note": LONG,
            "max_total": 0,
        },
    },
    {
        "name": "estimate/unicode",
        "builder": "build_estimate_prompt",
        "kwargs": {
            "question_type": "constructed_response",
            "stem_text": EMOJI,
            "rubric_criteria": [{"criterion_id": "c1", "max_score": "1.5", "description": "说明𠀀😀"}],
            "learner_answer_text": "作答𠀀😀",
            "transcription_note": "说明😀",
            "max_total": "1.5",
        },
    },
    # ---------------------------------------------------------------- diagnose
    {
        "name": "diagnose/typical",
        "builder": "build_diagnose_prompt",
        "kwargs": {
            "question_type": "constructed_response",
            "stem_text": "化简 (a+b)^2。",
            "answer_summary": "a^2+2ab+b^2",
            "learner_answer_text": "a^2+b^2",
            "graded_parts": [
                {"criterion_id": "c1", "score": "1.00", "max_score": "2.00"},
                {"blank_id": "b1", "score": 0, "max_score": 2},
                {"part_id": "p1", "score": None, "max_score": None},
                {"score": 1, "max_score": 1},
            ],
            "transcription_note": "手写清晰",
        },
    },
    {
        "name": "diagnose/parts-capped-at-30",
        "builder": "build_diagnose_prompt",
        "kwargs": {
            "question_type": "single_choice",
            "stem_text": "题干",
            "answer_summary": "A",
            "learner_answer_text": "B",
            "graded_parts": [{"criterion_id": f"c{index}", "score": index, "max_score": index} for index in range(35)],
        },
    },
    {
        "name": "diagnose/long-fields",
        "builder": "build_diagnose_prompt",
        "kwargs": {
            "question_type": "constructed_response",
            "stem_text": HUGE,
            "answer_summary": HUGE,
            "learner_answer_text": HUGE,
            "graded_parts": [],
            "transcription_note": LONG,
        },
    },
    {
        "name": "diagnose/defaults-and-unicode",
        "builder": "build_diagnose_prompt",
        "kwargs": {
            "question_type": "single_choice",
            "stem_text": EMOJI,
            "answer_summary": "答案𠀀",
            "learner_answer_text": "作答😀",
            "graded_parts": [],
        },
    },
    # ---------------------------------------------------------------- variant
    {
        "name": "variant/single-choice",
        "builder": "build_variant_prompt",
        "kwargs": {
            "question_type": "single_choice",
            "stem_text": "已知 f(x)=x^2-3x+2，则 f(2)=？",
            "options": [
                {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "0"}]},
                {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "1"}]},
                {"id": "opt_c", "label": "C", "blocks": [{"kind": "math", "latex": "x"}]},
            ],
            "answer_summary": "B",
            "node_name": "函数求值",
            "difficulty_note": "同等难度",
            "avoid_stems": ["已知 f(x)=x^2-3x+2，则 f(2)=？"],
            "rubric_criteria": [],
            "material_text": "",
        },
    },
    {
        "name": "variant/constructed",
        "builder": "build_variant_prompt",
        "kwargs": {
            "question_type": "constructed_response",
            "stem_text": "证明：任意三角形内角和为 180°。",
            "options": [],
            "answer_summary": "作平行线，利用内错角。",
            "node_name": "三角形内角和",
            "difficulty_note": "",
            "avoid_stems": ["", "   ", "另一个必须避免的题干" * 40],
            "rubric_criteria": [
                {"criterion_id": "c1", "max_score": "2.00", "text": "作辅助线"},
                {"criterion_id": "c2", "max_score": "3.00", "text": LONG},
            ],
            "material_text": "共享材料：平行线性质。",
        },
    },
    {
        "name": "variant/fill-blank",
        "builder": "build_variant_prompt",
        "kwargs": {
            "question_type": "fill_blank",
            "stem_text": "1+1=____",
            "options": [],
            "answer_summary": "",
            "node_name": "",
            "difficulty_note": "略简单",
            "avoid_stems": ["1+1=____"],
        },
    },
    {
        "name": "variant/long-fields",
        "builder": "build_variant_prompt",
        "kwargs": {
            "question_type": "single_choice",
            "stem_text": HUGE,
            "options": [{"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": LONG}]}, {"id": "opt_b", "label": "B", "blocks": []}],
            "answer_summary": HUGE,
            "node_name": "考点",
            "difficulty_note": "难度",
            "avoid_stems": [HUGE, "短题干"],
            "rubric_criteria": [{"criterion_id": "c1", "max_score": "1.00", "text": LONG}],
            "material_text": HUGE,
        },
    },
    {
        "name": "variant/unicode",
        "builder": "build_variant_prompt",
        "kwargs": {
            "question_type": "constructed_response",
            "stem_text": EMOJI,
            "options": [{"id": "opt_a", "label": "甲", "blocks": [{"kind": "text", "text": "𠀀😀"}]}],
            "answer_summary": "答案😀",
            "node_name": "中文考点",
            "difficulty_note": "保持",
            "avoid_stems": ["题干😀"],
            "rubric_criteria": [{"criterion_id": "c1", "max_score": "2.00", "text": "说明"}],
            "material_text": "材料𠀀",
        },
    },
    {
        "name": "tags/astral-boundary",
        "builder": "build_tag_suggestion_prompt",
        "kwargs": {
            "subject_name": "数学",
            "stem_text": ASTRAL,
            "option_texts": [ASTRAL],
            "allowed_node_names": ["考点"],
            "material_text": ASTRAL[:1501],
        },
    },
    {
        "name": "transcribe/exact-limit",
        "builder": "build_transcribe_prompt",
        "kwargs": {"subject_name": "物理", "question_stem": "q" * 800, "note": "n" * 800},
    },
    {
        "name": "estimate/exact-limit",
        "builder": "build_estimate_prompt",
        "kwargs": {
            "question_type": "constructed_response",
            "stem_text": "s" * 2000,
            "rubric_criteria": [{"criterion_id": "c1", "max_score": "1.00", "description": "d" * 300}],
            "learner_answer_text": "t" * 4000,
            "transcription_note": "",
            "max_total": "1.00",
        },
    },
    {
        "name": "variant/exact-limit",
        "builder": "build_variant_prompt",
        "kwargs": {
            "question_type": "single_choice",
            "stem_text": "v" * 3000,
            "options": [{"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "o" * 400}]}],
            "answer_summary": "w" * 1000,
            "node_name": "考点",
            "difficulty_note": "难度",
            "avoid_stems": ["x" * 400],
            "rubric_criteria": [{"criterion_id": "c1", "max_score": "1.00", "text": "y" * 200}],
            "material_text": "z" * 1500,
        },
    },
    {
        "name": "variant/null-values",
        "builder": "build_variant_prompt",
        "kwargs": {
            "question_type": "single_choice",
            "stem_text": None,
            "options": [],
            "answer_summary": None,
            "node_name": None,
            "difficulty_note": None,
            "avoid_stems": [],
            "rubric_criteria": None,
            "material_text": None,
        },
    },
]


def build_case(case: dict) -> dict:
    builder = getattr(prompts, case["builder"])
    expected = builder(**case["kwargs"])
    return {
        "name": case["name"],
        "builder": case["builder"],
        "kwargs": case["kwargs"],
        "expected": expected,
    }


SYSTEM_CONSTANTS = {
    "extract": prompts.EXTRACT_SYSTEM,
    "explain": prompts.EXPLAIN_SYSTEM,
    "suggest_tags": prompts.SUGGEST_TAGS_SYSTEM,
    "transcribe": prompts.TRANSCRIBE_SYSTEM,
    "estimate": prompts.ESTIMATE_SYSTEM,
    "diagnose": prompts.DIAGNOSE_SYSTEM,
    "propose_variant": prompts.VARIANT_SYSTEM,
}

payload = {
    "source": {
        "file": "backend/ai/prompts/registry.py",
        "harness": "real builder functions imported with django.setup(); no database, network or clock",
    },
    "versions": {
        "extract_question": prompts.EXTRACT_PROMPT_VERSION,
        "explain": prompts.EXPLAIN_PROMPT_VERSION,
        "suggest_tags": prompts.SUGGEST_TAGS_PROMPT_VERSION,
        "transcribe_handwriting": prompts.TRANSCRIBE_PROMPT_VERSION,
        "estimate_grade": prompts.ESTIMATE_GRADE_PROMPT_VERSION,
        "diagnose": prompts.DIAGNOSE_PROMPT_VERSION,
        "propose_variant": prompts.PROPOSE_VARIANT_PROMPT_VERSION,
    },
    "systems": SYSTEM_CONSTANTS,
    "cases": [build_case(case) for case in PROMPT_CASES],
}

json.dump(payload, sys.stdout, ensure_ascii=False, sort_keys=False, separators=(",", ":"))
sys.stdout.write("\n")
