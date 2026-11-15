"""Golden vectors for the ingestion text parser (B0).

Driven against the real functions in `backend/apps/ingestion/services/text_parser.py`; nothing here
re-implements the parser, so a vector that disagrees with the TypeScript port is a port defect, not
a stale expectation.

The corpus deliberately includes the shapes the paste/PDF paths have to survive: labelled templates,
materials with children, the numbered fallback, every answer type, answer pages with prose noise,
duplicate labels, astral-plane characters (Python offsets are code points, not UTF-16 units) and the
Unicode whitespace set Python's `re`/`str.strip()` use.
"""
from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
import django  # noqa: E402

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")
django.setup()

from apps.ingestion.services import text_parser  # noqa: E402

TEMPLATE = """【题干】下列哪一项是质数？
【题型】单选
【选项】
A. 4
B. 7
C. 9
【答案】B
【解析】7 只有 1 和 7 两个因数。
【考点】质数
【分值】5
"""

MULTI = """【题干】下列哪些是偶数？
【题型】多选
【选项】
A. 2
B. 3
C. 4
【答案】AC
"""

FILL = """【题型】填空题
【题干】结果保留一位小数，约为 __，另一空为 __。
【答案】10.0; -2
"""

MATERIAL = """【材料】阅读下面的段落，回答问题。
段落第一行。
【子题1】
【题干】第一问？
【答案】A
【子题2】
【题干】第二问？
【答案】B
"""

MATERIAL_LABELS = """【材料一】第一段材料。
【小题 1】【题型】单选
【题干】问题一？
【答案】A
【材料二】第二段材料。
【设问2】
【题干】问题二？
【答案】B
"""

INLINE = "【子题1】【题型】单选\n【题干】内联标签\n【选项】A. 甲\nB. 乙\n【答案】A\n"

LEADING = """1．【题型】单选
【题干】带印题号的一题
【选项】A. 甲
B. 乙
【答案】A
"""

NUMBERED = """一、单项选择题
1. 下列说法正确的是（ ）
A. 甲
B. 乙
C. 丙
2、第二题
D. 丁
E. 戊
"""

JUDGE = """【题型】判断
【题干】地球是圆的。
【答案】对
"""

CONSTRUCTED = """【题型】大题
【题干】请说明推导过程。
【答案】略
【评分标准】列出已知条件 2 分
推导正确 3 分
结论与单位 5 分
"""

BAD_TYPE = """【题型】连线
【题干】把左右两列连起来。
【答案】A
"""

BLANK_MISMATCH = """【题型】填空题
【题干】两个空：__ 和 __。
【答案】只有一空
"""

NO_ANSWER = """【题干】下面哪一项正确？
【选项】
A. 甲
B. 乙
"""

ANSWER_UNMATCHED = """【题型】单选
【题干】下面哪一项正确？
【选项】
A. 甲
B. 乙
【答案】Z
"""

TRUE_FALSE_WRONG = """【题型】判断
【题干】太阳从西边升起。
【答案】错误
"""

TRUE_FALSE_UNPARSEABLE = """【题型】判断
【题干】太阳从东边升起。
【答案】说不清
"""

UNKNOWN_LABEL_IN_MATERIAL = """【材料】材料正文
【提示】这是材料里的说明文字
【子题】问题？
【答案】A
"""

CHILD_WITHOUT_NUMBER = """【材料】材料正文
【子题】
【题干】没有编号的子题
【答案】A
"""

DUPLICATE_LABELS = """【材料】材料正文
【子题1】
【题干】子题一
【答案】A
【子题1】
【题干】子题一重复
【答案】B
"""

LONG_STEM = "【题干】" + "长" * 1100 + "\n"

EMOJI = "【题干】😀🎯" + "题" * 1000 + "\n【答案】A\n"

WEIRD_SPACE = "【\u3000题干\u3000】\u00a0前后有空白\u00a0\n【答案】\u3000A\u3000\n"

SPLITLINES = "【题干】第一行\r\n【选项】\x0bA. 甲\x1cB. 乙\u2028【答案】A\u0085尾行"

RUBRIC_NO_SCORE = """【题型】大题
【题干】说明理由。
【答案】略
【评分标准】论点清晰
（2 分）论据充分（2分）
"""

NUMERIC_CHILD = """【材料】材料
【1】第一小问
【答案】A
【2】第二小问
【答案】B
"""

MIXED = """【题干】题一
【答案】A
【题干】题二
【题型】填空
【题干】题二题干 __
【答案】乙
"""

PARSE_CASES = [
    "",
    "   \n\t\n",
    "一、单项选择题\n二、多项选择题\n",
    TEMPLATE,
    MULTI,
    FILL,
    MATERIAL,
    MATERIAL_LABELS,
    INLINE,
    LEADING,
    NUMBERED,
    JUDGE,
    CONSTRUCTED,
    BAD_TYPE,
    BLANK_MISMATCH,
    NO_ANSWER,
    ANSWER_UNMATCHED,
    TRUE_FALSE_WRONG,
    TRUE_FALSE_UNPARSEABLE,
    UNKNOWN_LABEL_IN_MATERIAL,
    CHILD_WITHOUT_NUMBER,
    DUPLICATE_LABELS,
    LONG_STEM,
    EMOJI,
    WEIRD_SPACE,
    SPLITLINES,
    RUBRIC_NO_SCORE,
    NUMERIC_CHILD,
    MIXED,
    # Several questions pasted together: a second 【题干】 closes the first.
    TEMPLATE + MULTI + FILL,
    # A 【材料】 block closes the previous leaf question.
    TEMPLATE + MATERIAL,
    # No label at all: falls through to the numbered heuristic.
    "第一行没有编号\n第二行\n1. 第一题\nA. 选项\n",
    # A label whose remainder is all whitespace.
    "【题干】   \n【答案】\n",
    # Printed numbering with 第…题 and options written with different separators.
    "第 1 题 下列说法正确的是（ ）\nA) 甲\nB、乙\nC）丙\nD：丁\n【答案】abcd\n",
    # Spaces inside the label and around the values.
    "【 题型 】 单选题 \n【 题干 】 有空格 \n【 选项 】 A . 甲 \n【 答案 】 A \n",
    # An answer that is prose with a lone letter: Python's \b reads it.
    "【题型】单选\n【题干】x\n【选项】A. 甲\nB. 乙\n【答案】答案是 A。\n",
    # CJK run around the letter: Python's \b does not fire.
    "【题型】单选\n【题干】x\n【选项】A. 甲\nB. 乙\n【答案】选A项\n",
    # A child label before any material: the segment is dropped, not guessed into a parent.
    "【子题1】\n【题干】孤儿子题\n【答案】A\n",
    # A material with no children.
    "【材料】只有材料正文。\n",
    # Two materials in a row.
    "【材料一】第一段\n【材料二】第二段\n",
    # Empty stem label followed by plain lines.
    "【题干】\n纯文本行\n",
    # A rubric line that itself carries a label.
    "【评分标准】\n【评分点】步骤分 2 分\n",
    # Lower-case option letters and a multi-letter answer.
    "【题干】x\n【选项】a. 甲\nb. 乙\nc. 丙\n【答案】ac\n",
    # 材料题 declared via the type alias on a normal question.
    "【题型】材料题\n【题干】材料式题干\n【答案】略\n",
    # A question whose stem is only punctuation.
    "【题干】。\n【答案】A\n",
    # Windows line endings and tabs.
    "\t【题干】\t制表符\r\n【答案】\tA\r\n",
    # Mixed labelled and unlabelled lines after a closed question.
    "【题干】第一题\n【答案】A\n没有标签的裸行\n",
    # Labels that collide with JavaScript object-prototype names: Python treats them as unknown.
    "【constructor】x\n【题干】正常\n",
    "【题型】constructor\n【题干】x\n",
    "【toString】材料正文\n【题干】题\n",
    # Declared single choice but the answer parses to more than one option.
    "【题型】单选\n【题干】x\n【选项】A. 甲\nB. 乙\n【答案】AB\n",
    # Negative values and units must survive the fill-blank parse.
    "【题型】填空题\n【题干】速度 __ m/s，温度为 __ ℃。\n【答案】-3.5; -40\n",
]

ANSWER_PAGE_CASES = [
    "参考答案\n1. A\n2. B\n3. C\n",
    "1、A\n2、D\n",
    "第1题 A\n第2题 B\n",
    "（1）A\n（2）B\n",
    "答案\n1. A\n解析：因为……\n2. B\n",
    "【参考答案】\n1. 对\n2. 错\n3. 正确\n",
    "【答案】\n1. A\n",
    "1. " + "长" * 260 + "\n2. B\n",
    "1. 这是一句普通的解释，不是答案。\n2. 好的。\n",
    "没有编号的说明文字\n1. A\n收尾的话\n",
    "1. A\n2. B\n" * 3,
    "1）A\n2）B\n",
    "1: A\n",
    "1. A\n" + "2. B\n" + "3. C\n" + "4. D\n" + "".join(f"{index}. X\n" for index in range(5, 60)),
    "【参考答案】\n第 1 题：A\n第 2 题：B\n",
    "1．A\n2．B\n",
    "答案页\n1. A\n2. B\n",
    "参考答案\n",
    "【解析】\n1. A\n",
]

MATCH_CASES = [
    {
        "name": "labels_match",
        "segments": text_parser.parse_paste(LEADING),
        "entries": text_parser.parse_answer_page("1. A\n2. B\n")["entries"],
    },
    {
        "name": "position_fallback",
        "segments": text_parser.parse_paste(TEMPLATE),
        "entries": text_parser.parse_answer_page("1. B\n")["entries"],
    },
    {
        "name": "material_parent_skipped",
        "segments": text_parser.parse_paste(MATERIAL),
        "entries": text_parser.parse_answer_page("1. A\n2. B\n")["entries"],
    },
    {
        "name": "duplicate_labels_fall_back_to_position",
        "segments": text_parser.parse_paste(DUPLICATE_LABELS),
        "entries": text_parser.parse_answer_page("1. A\n1. B\n")["entries"],
    },
    {
        "name": "unusable_answer_value",
        "segments": text_parser.parse_paste(TEMPLATE),
        "entries": [{"label": "1", "raw": "说不清"}],
    },
    {
        "name": "no_entries",
        "segments": text_parser.parse_paste(TEMPLATE),
        "entries": [],
    },
    {
        "name": "unmatched_labels_and_missing_display_label",
        "segments": [
            {"question_type": "single_choice", "content": {"options": [{"id": "opt_a"}]}},
            {"question_type": "material"},
        ],
        "entries": [{"label": "7", "raw": "A"}, {"label": "9", "raw": "B"}],
    },
    {
        "name": "empty_segment_list",
        "segments": [],
        "entries": text_parser.parse_answer_page("1. A\n")["entries"],
    },
]

SOURCE_PAGE_CASES = [
    {
        "name": "two_pages",
        "text": "第一题题干\n第二题题干\n",
        "page_map": [[1, 0, 6], [2, 6, 13]],
        "segments": [{"source_excerpt": "第一题题干"}, {"source_excerpt": "第二题题干"}],
    },
    {
        "name": "multiline_excerpt_uses_first_line",
        "text": "开头\n第一行题干\n第二行\n结尾\n",
        "page_map": [[1, 0, 7], [2, 7, 14], [3, 14, 17]],
        "segments": [{"source_excerpt": "第一行题干\n第二行"}, {"source_excerpt": "结尾"}],
    },
    {
        "name": "anchor_not_found_falls_back_to_cursor",
        "text": "甲乙丙丁",
        "page_map": [[1, 0, 2], [2, 2, 4]],
        "segments": [{"source_excerpt": "不存在"}, {"source_excerpt": "丁"}],
    },
    {
        "name": "emoji_offsets_are_code_points",
        "text": "😀😀\nQ1\nQ2\n",
        "page_map": [[1, 0, 4], [2, 4, 8]],
        "segments": [{"source_excerpt": "Q1"}, {"source_excerpt": "Q2"}],
    },
    {
        "name": "offset_outside_page_map_is_null",
        "text": "甲乙",
        "page_map": [[1, 0, 0]],
        "segments": [{"source_excerpt": "乙"}],
    },
    {
        "name": "empty_text",
        "text": "",
        "page_map": [[1, 0, 0]],
        "segments": [{"source_excerpt": ""}],
    },
]

PAGES_CONTINUATIONS = [
    {
        "name": "sentence_continues",
        "pages": [
            {"page_index": 1, "text": "第一题的开头没有结束\n"},
            {"page_index": 2, "text": "也没有结束，继续。\n"},
        ],
    },
    {
        "name": "terminal_punctuation_blocks",
        "pages": [
            {"page_index": 1, "text": "第一题结束了。\n"},
            {"page_index": 2, "text": "继续的句子\n"},
        ],
    },
    {
        "name": "next_page_starts_heading",
        "pages": [
            {"page_index": 1, "text": "第一题没有结束\n"},
            {"page_index": 2, "text": "一、单项选择题\n"},
        ],
    },
    {
        "name": "next_page_starts_label",
        "pages": [
            {"page_index": 1, "text": "第一题没有结束\n"},
            {"page_index": 2, "text": "【题干】新题\n"},
        ],
    },
    {
        "name": "next_page_starts_option",
        "pages": [
            {"page_index": 1, "text": "下列说法正确的是（ ）\n"},
            {"page_index": 2, "text": "A. 甲\n"},
        ],
    },
    {
        "name": "closing_quote_then_terminal",
        "pages": [
            {"page_index": 1, "text": "他说：“结束。”）\n"},
            {"page_index": 2, "text": "继续\n"},
        ],
    },
    {
        "name": "empty_page_skipped",
        "pages": [
            {"page_index": 1, "text": "\n"},
            {"page_index": 2, "text": "继续\n"},
        ],
    },
    {
        "name": "single_page",
        "pages": [{"page_index": 1, "text": "只有一页\n"}],
    },
    {
        "name": "three_pages_two_breaks",
        "pages": [
            {"page_index": 1, "text": "第一页没有结束\n"},
            {"page_index": 2, "text": "第二页也没有结束\n"},
            {"page_index": 3, "text": "第三页结束。\n"},
        ],
    },
]

CROSS_PAGE_CASES = [
    {
        "name": "segment_spans_two_pages_confirmed",
        "text": "第一页末尾\n第二页开头继续\n第二题\n",
        "page_map": [[1, 0, 6], [2, 6, 15], [3, 15, 19]],
        "segments": [
            {"source_char_start": 0, "source_excerpt": "第一页末尾\n第二页开头继续", "source_page_index": 1},
            {"source_char_start": 15, "source_excerpt": "第二题", "source_page_index": 3},
        ],
        "pages": [
            {"page_index": 1, "text": "第一页末尾\n"},
            {"page_index": 2, "text": "第二页开头继续\n"},
            {"page_index": 3, "text": "第二题\n"},
        ],
    },
    {
        "name": "segment_spans_two_pages_not_confirmed",
        "text": "第一页末尾\n第二页开头继续\n",
        "page_map": [[1, 0, 6], [2, 6, 15]],
        "segments": [{"source_char_start": 0, "source_excerpt": "第一页末尾\n第二页开头继续", "source_page_index": 1}],
        "pages": [
            {"page_index": 1, "text": "第一页末尾\n"},
            {"page_index": 2, "text": "第二页开头继续\n"},
        ],
    },
    {
        "name": "single_page_segment",
        "text": "只有一页\n",
        "page_map": [[1, 0, 4]],
        "segments": [{"source_char_start": 0, "source_excerpt": "只有一页"}],
        "pages": [{"page_index": 1, "text": "只有一页\n"}],
    },
    {
        "name": "blank_span_skipped_and_fallback",
        "text": "甲\n乙\n",
        "page_map": [[1, 0, 1], [2, 1, 3], [3, 3, 4]],
        "segments": [{"source_char_start": 0, "source_excerpt": "甲"}, {"source_char_start": 2, "source_excerpt": "乙"}],
        "pages": [{"page_index": 1, "text": "甲\n"}, {"page_index": 2, "text": "乙\n"}],
    },
    {
        "name": "emoji_span_slices_code_points",
        "text": "😀甲\n乙😀\n",
        "page_map": [[1, 0, 3], [2, 3, 6]],
        "segments": [{"source_char_start": 0, "source_excerpt": "😀甲\n乙😀", "source_page_index": 1}],
        "pages": [{"page_index": 1, "text": "😀甲\n"}, {"page_index": 2, "text": "乙😀\n"}],
    },
]


def main() -> None:
    payload = {
        "parse": [
            {
                "text": text,
                "structure_only": structure_only,
                "segments": text_parser.parse_paste(text, structure_only=structure_only),
            }
            for text in PARSE_CASES
            for structure_only in (False, True)
        ],
        "answer_page": [
            {"text": text, "result": text_parser.parse_answer_page(text)} for text in ANSWER_PAGE_CASES
        ],
        "match": [
            {
                "name": case["name"],
                "segments": copy.deepcopy(case["segments"]),
                "entries": copy.deepcopy(case["entries"]),
                "result": text_parser.apply_answer_matches(
                    copy.deepcopy(case["segments"]), copy.deepcopy(case["entries"])
                ),
            }
            for case in MATCH_CASES
        ],
        "source_pages": [
            {
                "name": case["name"],
                "text": case["text"],
                "page_map": case["page_map"],
                "segments": case["segments"],
                "result": text_parser.attach_source_pages(
                    copy.deepcopy(case["segments"]), case["text"], [tuple(row) for row in case["page_map"]]
                ),
            }
            for case in SOURCE_PAGE_CASES
        ],
        "continuations": [
            {
                "name": case["name"],
                "pages": case["pages"],
                "result": text_parser.detect_page_continuations(
                    [SimpleNamespace(**page) for page in case["pages"]]
                ),
            }
            for case in PAGES_CONTINUATIONS
        ],
        "cross_page": [
            {
                "name": case["name"],
                "text": case["text"],
                "page_map": case["page_map"],
                "segments": case["segments"],
                "pages": case["pages"],
                "result": text_parser.attach_cross_page_continua(
                    copy.deepcopy(case["segments"]),
                    case["text"],
                    [tuple(row) for row in case["page_map"]],
                    text_parser.detect_page_continuations(
                        [SimpleNamespace(**page) for page in case["pages"]]
                    ),
                ),
            }
            for case in CROSS_PAGE_CASES
        ],
    }
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
