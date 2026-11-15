"""Prompts — P2 AI variant proposal prompt, its content contract and validation."""

from __future__ import annotations

import re
from collections.abc import Iterable
from decimal import Decimal, InvalidOperation
from typing import Any

from ai.validators import response_text
from apps.common.enums import SCORABLE_LEAF_TYPES, QuestionType

PROPOSE_VARIANT_PROMPT_VERSION = "p2-propose-variant-v1"


VARIANT_SYSTEM = """你是考试题库的变式题生成助手。你的唯一任务是基于一道已审核的题目，生成一道**新的**同考点变式题候选。
严格规则：
1. 只输出 JSON，不要输出解释文字或 Markdown 代码块。
2. 变式必须是新题：不得照抄原题干，不得只改数字后与原题雷同；题干条件必须完整、自洽。
3. 答案必须能由你自己给出的题干独立推出；不得直接抄写原题答案，也不得把答案写进题干或选项。
4. 单选题只能有一个正确选项；多选题至少两个正确选项，且必须真实存在于选项中。
5. 题型必须与给定题型一致；不得输出 material（共享材料）。
6. 选项 ID 用 opt_a、opt_b…；空位 ID 用 b1、b2…；answer_payload.kind 必须等于题型。
7. 填空题每个空位都必须给出非空的 accepted_values 字符串数组，且空位 ID 与题干一致。
8. 大题必须给出 rubric_criteria（每个评分点有正的 max_score）与 rubric_total_score（等于各评分点之和）。
9. 不得引用图片：content 中不得出现 image 块（你无法知道真实资产 ID）。
10. 你的输出只是候选：不会自动发布，仍需人工逐项核对并确认答案。
输出 JSON 结构：
{
  "question_type": "single_choice|multiple_choice|true_false|fill_blank|constructed_response",
  "content": {"blocks": [{"kind": "text", "text": "..."}], "options": [...], "blanks": [...]},
  "answer_payload": {"kind": "题型", "...": "按题型给出的可判定答案"},
  "rubric_criteria": [{"criterion_id": "c1", "text": "...", "max_score": "2.00", "required": true}],
  "rubric_total_score": "2.00",
  "practice_max_score": "2.00",
  "difficulty_note": "难度说明",
  "rationale": "与原题的差异（一句话，说明为什么是同一考点的陌生变式）",
  "doubts": ["不确定之处"]
}"""


_VARIANT_ANSWER_MARKERS = (
    "正确答案是",
    "正确答案为",
    "正确答案：",
    "答案是",
    "答案为",
    "答案：",
    "故答案为",
    "应选",
    "故选",
    "answer is",
    "correct answer",
)


_VARIANT_OPTION_LEAK_MIN_LENGTH = 8


_VARIANT_FORBIDDEN_BLOCK_KINDS = ("image",)


def _variant_problem(code: str, message: str, path: str = "", severity: str = "blocking") -> dict:
    return {"code": code, "message": message, "path": path, "severity": severity}


def _normalized_for_compare(value: Any) -> str:
    """Whitespace/punctuation-insensitive form used for equality checks."""
    return re.sub(r"[\s\W_]+", "", str(value or "")).lower()


def build_variant_prompt(
    *,
    question_type: str,
    stem_text: str,
    options: list[dict[str, Any]],
    answer_summary: str,
    node_name: str,
    difficulty_note: str,
    avoid_stems: Iterable[str] = (),
    rubric_criteria: list[dict[str, Any]] | None = None,
    material_text: str = "",
) -> str:
    """Instruction for one variant proposal.

    ``answer_summary`` and ``rubric_criteria`` are *context*: they tell the model
    which point is being examined, never what to copy. ``avoid_stems`` lists the
    wording the variant must not reproduce (the source stem, plus any wording the
    caller already knows is taken).
    """
    option_lines = "\n".join(
        f"- {option.get('label') or option.get('id')}: {response_text.blocks_to_text(option.get('blocks'))}"
        for option in options
        if isinstance(option, dict)
    )
    rubric_lines = "\n".join(
        f"- {criterion.get('criterion_id')}（满分 {criterion.get('max_score')}）: {str(criterion.get('text') or '')[:200]}"
        for criterion in (rubric_criteria or [])
        if isinstance(criterion, dict)
    )
    avoid_lines = "\n".join(f"- {str(stem)[:400]}" for stem in avoid_stems if str(stem or "").strip())
    return (
        f"{VARIANT_SYSTEM}\n\n"
        f"题型：{question_type}\n"
        f"目标考点：{node_name or '（未指定）'}\n"
        f"原题题干（不得照抄，也不得只改数字后雷同）：{str(stem_text or '')[:3000] or '（未提供）'}\n"
        f"原题选项：\n{option_lines or '（无选项）'}\n"
        f"原题评分标准（仅供理解考查方式，不要照抄评分点文字）：\n{rubric_lines or '（无）'}\n"
        f"共享材料：{str(material_text or '')[:1500] or '（无）'}\n"
        f"原题已核对答案（仅供你理解考点；你的变式必须自己可解，不得直接照抄这个答案）："
        f"{str(answer_summary or '')[:1000] or '（原题答案尚未核对：只能依据题干条件生成）'}\n"
        f"必须避免的题干（不得与以下任一题干相同或仅改数字）：\n{avoid_lines or '（无）'}\n"
        f"难度要求：{difficulty_note or '（未指定：保持与原题相当）'}\n"
        "请输出一道变式题的 JSON。"
    )


def validate_variant_payload(
    payload: Any,
    *,
    question_type: str,
    avoid_stems: Iterable[str] = (),
) -> tuple[dict[str, Any], list[dict]]:
    """Validate one generated variant; returns ``(clean, problems)``.

    Every rule the product depends on is enforced here, so a model cannot get
    around them by "explaining" its output:

    * only the five scorable types (``material`` is never a variant);
    * the structure satisfies the same content contract the rest of the system
      uses — :func:`apps.common.content.validate_content` is called, never
      re-implemented, and its problems are surfaced verbatim;
    * the answer is decisively checkable per type: single choice exactly one
      existing correct option, multiple choice at least two distinct existing
      ones, true/false a real boolean, fill blank one accepted answer per real
      blank, constructed response a positive rubric that sums to its stated total;
    * the stem is non-empty, is not a copy of a stem in ``avoid_stems``, and does
      not state the answer;
    * a payload that is not a JSON object, or that has no answer at all, is a
      ``problem`` — never a crash and never a silent pass.
    """
    if question_type not in SCORABLE_LEAF_TYPES:
        return {}, [
            _variant_problem(
                "variant_type_not_scorable",
                f"变式只允许五种可计分题型（不含 material），收到：{question_type!r}",
                "question_type",
            )
        ]
    if not isinstance(payload, dict):
        return {}, [_variant_problem("not_object", "模型输出不是对象（只能是 JSON 对象）", "payload")]

    problems: list[dict] = []
    # Imported lazily so this module stays importable while the app registry is
    # still being built, exactly like the extractor validation above.
    from apps.common.content import blank_ids, validate_content

    declared = payload.get("question_type")
    if declared != question_type:
        problems.append(
            _variant_problem(
                "variant_type_mismatch",
                f"模型输出的题型 {declared!r} 与要求的 {question_type!r} 不一致",
                "question_type",
            )
        )

    raw_content = payload.get("content")
    content = raw_content if isinstance(raw_content, dict) else {}
    if not isinstance(raw_content, dict):
        problems.append(_variant_problem("content_not_object", "变式缺少 content 对象", "content"))
    # The shared content contract decides what "structurally publishable" means;
    # its problems are appended untouched so the code/message/path a human sees
    # is exactly the one the publish gate would report.
    for problem in validate_content(content, question_type):
        problems.append(dict(problem))
    for index, block in enumerate(content.get("blocks") or []):
        if isinstance(block, dict) and block.get("kind") in _VARIANT_FORBIDDEN_BLOCK_KINDS:
            problems.append(
                _variant_problem(
                    "variant_assets_not_allowed",
                    f"变式题干不能包含 {block.get('kind')} 块：模型无法知道本项目的真实资产，图片必须由人工在校对时补上",
                    f"blocks[{index}]",
                )
            )

    answer = payload.get("answer_payload")
    if not isinstance(answer, dict) or not answer:
        problems.append(
            _variant_problem(
                "variant_answer_missing",
                "模型没有给出答案：缺少答案的候选不能发布，必须人工补齐并确认",
                "answer_payload",
            )
        )
        answer = answer if isinstance(answer, dict) else {}
    elif answer.get("kind") != question_type:
        problems.append(
            _variant_problem(
                "variant_answer_kind_mismatch",
                f"answer_payload.kind={answer.get('kind')!r} 必须等于题型 {question_type!r}",
                "answer_payload.kind",
            )
        )

    option_map = {
        str(option.get("id")): option
        for option in content.get("options") or []
        if isinstance(option, dict) and option.get("id")
    }
    #: Rubric rows survive only for a constructed response; every other type
    #: leaves them empty (a rubric is never invented on the model's behalf).
    rubric_rows: list[dict[str, Any]] = []
    rubric_total = Decimal("0")
    stated_total: Decimal | None = None
    stem = _normalized_for_compare(response_text.blocks_to_text(content.get("blocks")))
    for avoid in avoid_stems:
        avoid_text = _normalized_for_compare(avoid)
        if stem and avoid_text and stem == avoid_text:
            problems.append(
                _variant_problem(
                    "stem_copies_source",
                    "变式题干与必须避免的题干完全相同：这不是变式，请改写题干",
                    "content.blocks",
                )
            )
            break
    for marker in _VARIANT_ANSWER_MARKERS:
        if _normalized_for_compare(marker) in stem:
            problems.append(
                _variant_problem(
                    "stem_leaks_answer",
                    f"题干疑似直接写出答案（命中“{marker}”）：答案必须能从条件推出，不能写在题干里",
                    "content.blocks",
                )
            )
            break

    if question_type == QuestionType.SINGLE_CHOICE:
        listed = answer.get("correct_option_ids")
        if isinstance(listed, list) and listed:
            problems.append(
                _variant_problem(
                    "single_choice_multiple_correct",
                    f"单选题只能有一个正确选项，模型给出 {len(listed)} 个：{listed}",
                    "answer_payload.correct_option_ids",
                )
            )
        correct = answer.get("correct_option_id")
        if not isinstance(correct, str) or not correct.strip():
            problems.append(
                _variant_problem(
                    "single_choice_correct_missing", "单选题必须给出唯一的正确选项 ID", "answer_payload.correct_option_id"
                )
            )
        elif correct not in option_map:
            problems.append(
                _variant_problem(
                    "single_choice_correct_unknown",
                    f"正确选项 {correct} 不在变式给定的选项中",
                    "answer_payload.correct_option_id",
                )
            )
        else:
            _append_option_leak(correct, option_map[correct], stem, problems)

    elif question_type == QuestionType.MULTIPLE_CHOICE:
        correct = answer.get("correct_option_ids")
        if not isinstance(correct, list) or not correct:
            problems.append(
                _variant_problem(
                    "multiple_choice_correct_missing",
                    "多选题必须给出非空的正确选项集合",
                    "answer_payload.correct_option_ids",
                )
            )
        else:
            option_ids = [str(value) for value in correct]
            if len(set(option_ids)) != len(option_ids):
                problems.append(
                    _variant_problem(
                        "multiple_choice_duplicate_correct",
                        "多选题的正确选项集合存在重复 ID",
                        "answer_payload.correct_option_ids",
                    )
                )
            if len(set(option_ids)) < 2:
                problems.append(
                    _variant_problem(
                        "multiple_choice_too_few_correct",
                        f"多选题至少要有两个正确选项，模型给出 {len(set(option_ids))} 个",
                        "answer_payload.correct_option_ids",
                    )
                )
            for option_id in option_ids:
                if option_id not in option_map:
                    problems.append(
                        _variant_problem(
                            "multiple_choice_unknown_correct",
                            f"正确选项 {option_id} 不在变式给定的选项中",
                            "answer_payload.correct_option_ids",
                        )
                    )
                else:
                    _append_option_leak(option_id, option_map[option_id], stem, problems)

    elif question_type == QuestionType.TRUE_FALSE:
        if not isinstance(answer.get("value"), bool):
            problems.append(
                _variant_problem(
                    "true_false_value_missing",
                    "判断题必须给出真正的布尔值（字符串 \"true\" 不等于布尔 true）",
                    "answer_payload.value",
                )
            )

    elif question_type == QuestionType.FILL_BLANK:
        defined_blanks = blank_ids(content)
        if not defined_blanks:
            problems.append(
                _variant_problem("fill_blank_without_blanks", "填空题的 content 必须定义至少一个空位", "content.blanks")
            )
        answers = answer.get("blanks")
        if not isinstance(answers, dict) or not answers:
            problems.append(
                _variant_problem("fill_blank_answer_missing", "填空题必须按空位给出答案", "answer_payload.blanks")
            )
        else:
            missing = [blank_id for blank_id in defined_blanks if blank_id not in answers]
            unknown = [str(blank_id) for blank_id in answers if str(blank_id) not in defined_blanks]
            if missing:
                problems.append(
                    _variant_problem(
                        "fill_blank_answer_missing_for",
                        f"空位没有答案：{', '.join(missing)}",
                        "answer_payload.blanks",
                    )
                )
            if unknown:
                problems.append(
                    _variant_problem(
                        "fill_blank_answer_unknown_blank",
                        f"答案引用了题干未定义的空位：{', '.join(unknown)}",
                        "answer_payload.blanks",
                    )
                )
            for blank_id, spec in answers.items():
                path = f"answer_payload.blanks.{blank_id}"
                if not isinstance(spec, dict):
                    problems.append(_variant_problem("blank_answer_not_object", "空位答案必须是对象", path))
                    continue
                accepted = spec.get("accepted_values")
                usable = [value for value in accepted or [] if isinstance(value, str) and value.strip()]
                if not usable:
                    problems.append(
                        _variant_problem(
                            "blank_accepted_values_missing",
                            f"空位 {blank_id} 没有可接受答案（accepted_values 必须是非空字符串数组）",
                            path,
                        )
                    )

    elif question_type == QuestionType.CONSTRUCTED_RESPONSE:
        criteria = payload.get("rubric_criteria")
        if not isinstance(criteria, list) or not criteria:
            problems.append(
                _variant_problem(
                    "rubric_criteria_missing", "大题必须给出至少一个评分点（rubric_criteria）", "rubric_criteria"
                )
            )
        else:
            seen: set[str] = set()
            for index, criterion in enumerate(criteria):
                path = f"rubric_criteria[{index}]"
                if not isinstance(criterion, dict):
                    problems.append(_variant_problem("rubric_criterion_not_object", "评分点必须是对象", path))
                    continue
                criterion_id = str(criterion.get("criterion_id") or "").strip()
                if not criterion_id:
                    problems.append(_variant_problem("rubric_criterion_id_missing", "评分点缺少 criterion_id", path))
                    continue
                if criterion_id in seen:
                    problems.append(
                        _variant_problem("rubric_criterion_duplicate", f"评分点 ID 重复：{criterion_id}", path)
                    )
                    continue
                seen.add(criterion_id)
                try:
                    score = Decimal(str(criterion.get("max_score")))
                except (InvalidOperation, TypeError, ValueError):
                    problems.append(
                        _variant_problem("rubric_criterion_score_invalid", "评分点满分必须是十进制数", path)
                    )
                    continue
                if score <= 0:
                    problems.append(
                        _variant_problem(
                            "rubric_criterion_score_not_positive", f"评分点满分必须为正数，收到 {score}", path
                        )
                    )
                    continue
                rubric_total += score
                rubric_rows.append(
                    {
                        "criterion_id": criterion_id,
                        "text": str(criterion.get("text") or "")[:500],
                        "max_score": str(score),
                        "required": bool(criterion.get("required", True)),
                    }
                )
        stated = payload.get("rubric_total_score")
        if stated in (None, ""):
            problems.append(
                _variant_problem("rubric_total_missing", "大题必须给出 rubric_total_score（各评分点之和）", "rubric_total_score")
            )
        else:
            try:
                stated_total = Decimal(str(stated))
            except (InvalidOperation, TypeError, ValueError):
                problems.append(
                    _variant_problem("rubric_total_invalid", "rubric_total_score 必须是十进制数", "rubric_total_score")
                )
            else:
                if stated_total <= 0:
                    problems.append(
                        _variant_problem(
                            "rubric_total_not_positive", f"rubric_total_score 必须为正数，收到 {stated_total}", "rubric_total_score"
                        )
                    )
                elif stated_total != rubric_total:
                    problems.append(
                        _variant_problem(
                            "rubric_total_mismatch",
                            f"评分点合计 {rubric_total} 与 rubric_total_score {stated_total} 不一致",
                            "rubric_total_score",
                        )
                    )
        if answer.get("rubric_required") is not True:
            problems.append(
                _variant_problem(
                    "rubric_required_missing",
                    "大题答案必须声明 rubric_required=true（逐评分点人工确认）",
                    "answer_payload.rubric_required",
                )
            )

    proposed_score: Decimal | None = None
    raw_score = payload.get("practice_max_score")
    if raw_score not in (None, ""):
        try:
            proposed_score = Decimal(str(raw_score))
        except (InvalidOperation, TypeError, ValueError):
            problems.append(
                _variant_problem("variant_score_invalid", "practice_max_score 必须是十进制数", "practice_max_score")
            )
        else:
            if proposed_score <= 0:
                problems.append(
                    _variant_problem(
                        "variant_score_not_positive", f"practice_max_score 必须为正数，收到 {proposed_score}", "practice_max_score"
                    )
                )
                proposed_score = None

    clean: dict[str, Any] = {
        "question_type": question_type,
        "content": content,
        "answer_payload": answer,
        "rubric_criteria": rubric_rows,
        # The stated total is kept exactly as proposed: rewriting it to the
        # computed sum would hide a disagreement a human still has to resolve.
        "rubric_total_score": str(stated_total) if stated_total is not None else None,
        "practice_max_score": str(proposed_score) if proposed_score is not None else None,
        "difficulty_note": str(payload.get("difficulty_note") or "")[:300],
        "rationale": str(payload.get("rationale") or "")[:500],
        "doubts": [str(item)[:300] for item in (payload.get("doubts") or []) if str(item).strip()][:20],
    }
    return clean, problems


def _append_option_leak(option_id: str, option: dict[str, Any], stem: str, problems: list[dict]) -> None:
    text = _normalized_for_compare(response_text.blocks_to_text(option.get("blocks")))
    if len(text) >= _VARIANT_OPTION_LEAK_MIN_LENGTH and text in stem:
        problems.append(
            _variant_problem(
                "stem_leaks_answer",
                f"题干逐字包含正确选项 {option_id} 的文本：答案不能出现在题干里",
                "content.blocks",
            )
        )
