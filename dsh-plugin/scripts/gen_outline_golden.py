"""Golden vectors for the syllabus word-list parser.

`_depth_and_name` + `_split_synonyms` decide how a line of a syllabus becomes a node, and the rule
they implement is a data-integrity one: ``导数（微分）`` and a separate ``微分`` line are the same
knowledge point, so importing both would split one point's score across two rows forever.

Driven against the real functions in `apps/knowledge/services/outline.py`; nothing here re-implements
the regexes.
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

from apps.knowledge.services import outline  # noqa: E402

LINES = [
    "",
    "   ",
    "导数",
    "1 导数",
    "1. 导数",
    "1.1 导数的定义",
    "1.1.1 极限",
    "一、函数",
    "（一）集合",
    "(1) 区间",
    "（1）区间",
    "- 知识点",
    "* 知识点",
    "• 知识点",
    "  1 缩进一级",
    "    1.1 缩进两级",
    "\t1 制表符缩进",
    "导数（微分）",
    "导数(微分)",
    "导数[微分]",
    "导数 别名：微分, 求导",
    "导数 又称：微分、求导",
    "导数（微分，求导）",
    "导数（微分；求导）",
    "导数（微分/求导）",
    "  1.1 积分（不定积分）",
    "1.1.2 导数（微分）",
    "极限的运算法则 别名：四则运算",
    "（一）函数与极限（含连续）",
    "2.3.1",
    "1  （多余空格）导数",
    "第1章 函数",
    "1.2.3.4 四级",
    "  - 1.1 列表中的编号",
    "名称（）",
    "名称（  ）",
    "（函数）",
    "混合 别名：a, b、c；d/e 的测试",
    "1.1 导数 别名：微分",
]

cases = []
for line in LINES:
    parsed = outline._depth_and_name(line)
    if parsed is None:
        cases.append({"line": line, "depth": None, "name": None, "aliases": None})
        continue
    depth, body = parsed
    name, aliases = outline._split_synonyms(body)
    cases.append({"line": line, "depth": depth, "name": name, "aliases": aliases})

json.dump(
    {
        "source": "apps/knowledge/services/outline.py::_depth_and_name + _split_synonyms",
        "kinds": dict(outline.KIND_BY_DEPTH),
        "cases": cases,
    },
    sys.stdout,
    ensure_ascii=False,
    separators=(",", ":"),
)
sys.stdout.write("\n")
