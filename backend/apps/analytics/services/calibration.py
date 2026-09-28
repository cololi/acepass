"""Effect calibration: comparable groups, honest samples, no causal claim.

docs/05 §3 C08: 学习效果对比按题型、难度、时限、暴露情况说明可比性和样本数；不从单人前后分数推断因果.

The product temptation this module exists to refuse is a single headline number:
"你的得分率提升了 X%". A within-person before/after difference of two *different*
sets of questions, taken under different exposure conditions, with different
time pressure and a handful of attempts each, cannot support that sentence — no
matter how the arithmetic is dressed up. So:

* attempts are grouped by the dimensions that actually make two sets of attempts
  comparable: question type, a declared difficulty proxy, the server-measured
  time condition, and the exposure state (which reuses
  :mod:`apps.learning.services.contamination` instead of re-deriving it);
* a group reports its confirmed-score statistics **only** from confirmed grades,
  and only when it has at least :data:`MIN_GROUP_SAMPLE` of them. Below that the
  group is ``insufficient_sample`` and the numbers are withheld, not shown with a
  warning — a warning next to a number is still the number;
* a difference is emitted only between two groups that hold type, difficulty and
  time condition equal, and it carries its per-group n, its spread and its own
  caveats. Groups that cannot be compared are listed with the reason;
* :func:`assert_no_causal_summary` is called on every payload before it is
  returned. It walks the whole structure and raises if a single causal or
  percentage-style summary key ever appears (``improvement_percent``,
  ``pass_probability``, a bare top-level ``delta``, …), so the "no causal claim"
  rule is enforced by code, not by the docstring you are reading.

The module is deliberately read-only: it computes no projection row, writes no
snapshot and changes no state.
"""

from __future__ import annotations

import re
from decimal import Decimal

from django.utils import timezone

from apps.common.enums import (
    EvidenceDimension,
    GradeEventKind,
    GradeMethod,
    GradeStatus,
    QuestionType,
)
from apps.practice.models import Attempt, LearningEvidence

#: A group needs this many *confirmed* scores before any statistic is shown.
#: Below it the group is reported as ``insufficient_sample`` with no numbers.
MIN_GROUP_SAMPLE = 5

#: The difficulty proxy actually used. It is named in the payload
#: (``difficulty_proxy``) so a reader never has to guess what "difficulty" meant.
DIFFICULTY_PROXY = "max_score_band"

#: Which question type answers which declared time rule. The demo and bootstrap
#: fixtures declare ``choice_seconds`` for all three objective types and a
#: separate rule for fill-in and constructed response, so the fallback reads the
#: declared policy instead of inventing a limit.
TIME_RULE_BY_TYPE: dict[str, str] = {
    QuestionType.SINGLE_CHOICE: "choice_seconds",
    QuestionType.MULTIPLE_CHOICE: "choice_seconds",
    QuestionType.TRUE_FALSE: "choice_seconds",
    QuestionType.FILL_BLANK: "fill_blank_seconds",
    QuestionType.CONSTRUCTED_RESPONSE: "constructed_response_seconds",
}

DIFFICULTY_PROXY_NOTE = (
    "难度代理 = 该题项冻结的满分档（≤2 分 / 2—5 分 / >5 分）。"
    "这是卷面分值权重，不是任何模型推断出的难度；它只能粗略代表题目长度与权重，"
    "不能代表认知难度，也不能保证档内题目真的同质。"
)

TIMING_NOTE = (
    "时限条件 = 服务端记录的 elapsed_ms 是否落在该题声明的时限内"
    "（题项规范 time_rules，缺省回退到发表时的 estimated_seconds）。"
    "elapsed_ms 由服务端在首次下发与提交之间测量，客户端时间不参与。"
)

EXPOSURE_NOTE = (
    "暴露情况来自 apps.learning.services.contamination 的同一套规则"
    "（系统外已见、校对预览、答案/讲解/提示下发、展示未提交、跨项目同源、合并家族），"
    "辅助状态取自证据投影 unassisted_completion 不合格且有用时记录的行；"
    "重复 = 本人在同一项目中已答过同一题。四类互斥，按 辅助 > 重复 > 已见 > 严格独立 归类。"
)

STATUS_OK = "ok"
STATUS_INSUFFICIENT = "insufficient_sample"

#: Exact key names (lowercased, non-alphanumeric removed) that must never appear
#: anywhere in a calibration payload: each one is a way of smuggling a causal or
#: probability claim into a within-person observation.
FORBIDDEN_SUMMARY_KEYS: frozenset[str] = frozenset(
    {
        "improvement",
        "improvementrate",
        "improvementscore",
        "scoregain",
        "gain",
        "learninggain",
        "effect",
        "causaleffect",
        "causalestimate",
        "causalinference",
        "passprobability",
        "passrate",
        "passchance",
        "probabilityofpass",
        "overalldelta",
        "totaldelta",
        "beforedafter",
        "beforeafterscore",
        "predictedscore",
        "提升",
        "提升率",
        "通过概率",
        "通过率",
        "因果效应",
    }
)

#: A ``delta`` may only live inside a row that also states its sample size, its
#: spread and its own caveats. These are the keys that row must carry.
DELTA_REQUIRED_COMPANIONS = frozenset({"samplesize", "spread", "caveats"})

_CAUSAL_SUBSTRINGS = ("提升", "因果", "通过率", "通过概率")


def _normalised(key: object) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(key).lower())


def assert_no_causal_summary(value, *, path: str = "$") -> None:
    """Raise ``AssertionError`` if the payload grew a causal/summary field.

    The rule is enforced on the *shape* of every payload this module returns, so
    a later edit that adds ``improvement_percent`` (or a bare top-level ``delta``
    without n/spread/caveats) fails loudly at request time instead of shipping a
    claim the data cannot support.
    """
    if isinstance(value, dict):
        keys = {_normalised(key) for key in value}
        for raw_key in value:
            norm = _normalised(raw_key)
            if norm in FORBIDDEN_SUMMARY_KEYS:
                raise AssertionError(f"{path}: forbidden causal/summary field {raw_key!r}")
            if norm.endswith("percent") or norm.endswith("percentage"):
                raise AssertionError(f"{path}: percentage-style summary field {raw_key!r} is not allowed")
            if any(token in norm for token in _CAUSAL_SUBSTRINGS):
                raise AssertionError(f"{path}: causal-claiming field {raw_key!r} is not allowed")
        if "delta" in keys:
            raw_delta_key = next(raw for raw in value if _normalised(raw) == "delta")
            delta_body = value[raw_delta_key]
            # The companions may sit beside the delta or inside the delta object
            # itself; a bare difference is never allowed through.
            target = delta_body if isinstance(delta_body, dict) else value
            target_keys = {_normalised(key) for key in target}
            if not DELTA_REQUIRED_COMPANIONS <= target_keys:
                raise AssertionError(
                    f"{path}.{raw_delta_key}: a delta must carry its sample size, spread and caveats"
                    f" (missing {sorted(DELTA_REQUIRED_COMPANIONS - target_keys)})"
                )
        for raw_key, child in value.items():
            assert_no_causal_summary(child, path=f"{path}.{raw_key}")
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            assert_no_causal_summary(child, path=f"{path}[{index}]")


def _question_type_label(question_type: str) -> str:
    try:
        return QuestionType(question_type).label
    except ValueError:  # pragma: no cover - new type added without a label
        return question_type


def _difficulty_band(max_score: Decimal) -> str:
    """The declared proxy, in bands. Documented in :data:`DIFFICULTY_PROXY_NOTE`."""
    score = Decimal(max_score)
    if score <= 2:
        return "score_le_2"
    if score <= 5:
        return "score_2_to_5"
    return "score_gt_5"


def configured_limit_seconds(item) -> int | None:
    """The declared per-item time limit, or ``None`` when the spec declares none.

    Read from the frozen ``ExamSpecVersion`` the item was presented under (never
    from the current spec), then from the question version's own
    ``estimated_seconds``, then from the shared ``choice_seconds`` rule for the
    three objective types.
    """
    spec = item.spec_version
    rules = (spec.time_rules or {}) if spec is not None else {}
    question_type = item.question_version.question_type
    exact = rules.get(f"{question_type}_seconds")
    if exact:
        return int(exact)
    estimated = item.question_version.estimated_seconds
    if estimated:
        return int(estimated)
    shared = rules.get(TIME_RULE_BY_TYPE.get(question_type, ""))
    return int(shared) if shared else None


def timing_state(*, attempt) -> str:
    """``within_limit`` / ``over_limit`` / ``no_server_timing`` / ``no_configured_limit``."""
    elapsed_ms = int(attempt.elapsed_ms or 0)
    if elapsed_ms <= 0:
        return "no_server_timing"
    limit = configured_limit_seconds(attempt.session_item)
    if limit is None:
        return "no_configured_limit"
    return "within_limit" if elapsed_ms <= limit * 1000 else "over_limit"


def _assisted_attempt_ids(*, user, project) -> set[str]:
    """Attempts the evidence projection marked as not unassisted.

    The projection folds "pre-submit answer-revealing exposure / hint" and
    "no trustworthy timing record" into the same ``qualifies=False`` row. An
    attempt with ``elapsed_ms > 0`` cannot have failed on timing, so restricting
    the set to those attempts keeps this flag about assistance only; attempts
    without a usable timing record are disclosed by ``timing_state`` instead.
    """
    rows = LearningEvidence.objects.filter(
        user=user, project=project, dimension=EvidenceDimension.UNASSISTED_COMPLETION, qualifies=False
    ).values_list("attempt_id", flat=True)
    ids = {str(row) for row in rows}
    if not ids:
        return set()
    return {
        str(attempt_id)
        for attempt_id in Attempt.objects.filter(id__in=ids, elapsed_ms__gt=0).values_list("id", flat=True)
    }


def _exposure_states(*, user, project, attempts: list[Attempt], assisted_ids: set[str]) -> dict[str, dict]:
    """Exposure label per attempt, reusing the contamination evaluation.

    ``contamination.exposure_state`` is called with exactly the window the
    evidence projection uses (as of the item's first presentation, excluding the
    item's own deliveries), so "strictly independent" here means the same thing
    it means everywhere else. Results are cached per (question, item, instant).
    """
    from apps.learning.services import contamination

    ordered = sorted(attempts, key=lambda row: row.submitted_at)
    seen_questions: set[str] = set()
    states: dict[str, dict] = {}
    cache: dict[tuple[str, str, str], dict] = {}
    for attempt in ordered:
        item = attempt.session_item
        question_id = str(item.question_version.question_id)
        reference = contamination.attempt_reference_instant(attempt)
        cache_key = (question_id, str(item.id), reference.isoformat())
        if cache_key not in cache:
            state = contamination.exposure_state(
                user=user,
                question_ids=[question_id],
                project=project,
                before=reference,
                exclude_session_item_ids=[str(item.id)],
            )[question_id]
            cache[cache_key] = state
        state = cache[cache_key]
        repeated = question_id in seen_questions
        seen_questions.add(question_id)
        if str(attempt.id) in assisted_ids:
            label, detail = "assisted", "本次作答在提交前获得过提示/答案暴露，不是无辅助完成"
        elif repeated:
            label, detail = "repeated", "同一题目在本人同一项目中已作答过：本次不是首次接触"
        elif not state["strict_independent_eligible"]:
            label, detail = "seen_elsewhere", "本题此前已暴露（系统外已见/校对/下发过答案或讲解/展示未提交/同源/合并家族）"
        else:
            label, detail = "strictly_independent", "本题在本次呈现前没有被任何入口暴露给本人"
        states[str(attempt.id)] = {
            "exposure_state": label,
            "message": detail,
            "reason_codes": list(state["reasons"]),
            "first_seen_at": state["first_seen_at"],
        }
    return states


#: Exclusion reasons for the confirmed-score statistic, in presentation order.
EXCLUSION_MESSAGES: dict[str, str] = {
    "no_grade": "没有判分记录",
    "pending_review": "判分待人工确认",
    "partially_confirmed": "部分评分点未确认",
    "void_grade": "判分已作废",
    "invalidated_grade": "原判分已失效，等待重评",
    "ai_estimated_only": "仅有 AI 估计分",
    "self_assessed_grade": "自评确认：不作为效果校准的确认分",
    "disputed_content": "答案或评分标准有争议",
    "zero_max_score": "满分不为正，无法计算得分率",
}


def _confirmed_fraction(*, attempt, disputed_answers: set[str], disputed_rubrics: set[str]) -> tuple[Decimal, list[str]]:
    """``(fraction, exclusion_codes)`` — a fraction only from a confirmed grade."""
    grade = attempt.current_grade_event
    item = attempt.session_item
    codes: list[str] = []
    if grade is None:
        return Decimal("0"), ["no_grade"]
    if grade.kind == GradeEventKind.INVALIDATION:
        codes.append("invalidated_grade")
    elif grade.status == GradeStatus.PENDING_REVIEW:
        codes.append("pending_review")
    if grade.status == GradeStatus.VOID:
        codes.append("void_grade")
    if grade.method == GradeMethod.AI_ESTIMATED or grade.status == GradeStatus.ESTIMATED:
        codes.append("ai_estimated_only")
    if grade.status == GradeStatus.CONFIRMED and not grade.is_fully_confirmed:
        codes.append("partially_confirmed")
    elif grade.status == GradeStatus.PENDING_REVIEW and grade.confirmed_score is not None:
        # A half-decided rubric keeps a real confirmed subtotal while the attempt
        # is still pending overall: both facts are named.
        codes.append("partially_confirmed")
    if grade.method == GradeMethod.SELF_CONFIRMED or grade.grader_is_self:
        codes.append("self_assessed_grade")
    answer_ids = {str(item.answer_key_version_id or ""), str(grade.answer_key_version_id or "")}
    rubric_ids = {str(item.rubric_version_id or ""), str(grade.rubric_version_id or "")}
    if (answer_ids & disputed_answers) or (rubric_ids & disputed_rubrics):
        codes.append("disputed_content")
    max_score = Decimal(item.max_score)
    if max_score <= 0:
        codes.append("zero_max_score")
    usable = (
        grade.status == GradeStatus.CONFIRMED
        and grade.confirmed_score is not None
        and grade.is_fully_confirmed
        and max_score > 0
        and "self_assessed_grade" not in codes
        and "disputed_content" not in codes
    )
    if not usable:
        return Decimal("0"), codes
    return (Decimal(grade.confirmed_score) / max_score), codes


def _spread(values: list[Decimal]) -> dict:
    """Population standard deviation and range of a group's confirmed fractions."""
    count = len(values)
    mean = sum(values, Decimal("0")) / count
    variance = sum(((value - mean) ** 2 for value in values), Decimal("0")) / count
    # Decimal has no sqrt; the spread is reported with six places through float,
    # which is more precision than any sample this size can justify.
    stdev = Decimal(str(float(variance) ** 0.5))
    return {
        "mean": str(mean.quantize(Decimal("0.0001"))),
        "stdev": str(stdev.quantize(Decimal("0.0001"))),
        "min": str(min(values).quantize(Decimal("0.0001"))),
        "max": str(max(values).quantize(Decimal("0.0001"))),
    }


def _median(values: list[Decimal]) -> str:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        median = ordered[middle]
    else:
        median = (ordered[middle - 1] + ordered[middle]) / 2
    return str(median.quantize(Decimal("0.0001")))


def _comparability_between(left: dict, right: dict) -> dict:
    """Can these two groups be compared at all, and if not, why not.

    Only the exposure axis may differ: two groups that also differ in question
    type, difficulty band or time condition are not a comparison, they are two
    different measurements.
    """
    left_dims, right_dims = left["dimensions"], right["dimensions"]
    base = {"group_a": left["group_key"], "group_b": right["group_key"]}
    if left["status"] != STATUS_OK or right["status"] != STATUS_OK:
        return {
            **base,
            "comparable": False,
            "code": "insufficient_sample",
            "message": (
                f"样本不足（各组确认样本 {left['confirmed_sample_size']} / "
                f"{right['confirmed_sample_size']}，门槛 {MIN_GROUP_SAMPLE}）：不比较、不展示差值。"
            ),
            "delta": None,
        }
    if left_dims["question_type"] != right_dims["question_type"]:
        reason = ("different_question_type", "题型不同：分值规则与作答方式不同，不能比较")
    elif left_dims["difficulty_band"] != right_dims["difficulty_band"]:
        reason = (
            "different_content_difficulty",
            f"难度档不同（{left_dims['difficulty_band']} vs {right_dims['difficulty_band']}）：题目内容权重不同，"
            "得分率差异不能归因于学习效果",
        )
    elif left_dims["timing_state"] != right_dims["timing_state"]:
        reason = (
            "different_time_condition",
            f"时限条件不同（{left_dims['timing_state']} vs {right_dims['timing_state']}）：限时与不限时的分数不可比",
        )
    elif (
        left_dims["exposure_state"] != right_dims["exposure_state"]
        and "strictly_independent" not in {left_dims["exposure_state"], right_dims["exposure_state"]}
    ):
        reason = (
            "different_exposure_state",
            f"暴露条件不同（{left_dims['exposure_state']} vs {right_dims['exposure_state']}）：两组都已被污染，"
            "无法判断差异来自学习还是来自暴露",
        )
    else:
        return {**base, "comparable": True, "code": "comparable_with_caveats", "message": None, "delta": None}
    code, message = reason
    return {**base, "comparable": False, "code": code, "message": message, "delta": None}


def _delta_row(left: dict, right: dict) -> dict:
    """A per-group delta with its n, its spread and its own caveats."""
    left_stats = left["statistics"]
    right_stats = right["statistics"]
    delta = Decimal(right_stats["mean_confirmed_fraction"]) - Decimal(left_stats["mean_confirmed_fraction"])
    return {
        "metric": "mean_confirmed_fraction",
        "group_a_mean": left_stats["mean_confirmed_fraction"],
        "group_b_mean": right_stats["mean_confirmed_fraction"],
        "delta": str(delta.quantize(Decimal("0.0001"))),
        "sample_size": {"group_a": left["confirmed_sample_size"], "group_b": right["confirmed_sample_size"]},
        "spread": {
            "group_a_stdev": left_stats["spread_stdev"],
            "group_b_stdev": right_stats["spread_stdev"],
        },
        "caveats": [
            "这是同一个人、不同时间、不同题目的两组观察值之差，不是因果效应，也不代表学习提升。",
            "两组题目内容与暴露条件仍可能不同；样本量小，差值不稳定。",
        ],
    }


def _group_key(dimensions: dict) -> str:
    return "|".join(
        (
            dimensions["question_type"],
            dimensions["difficulty_band"],
            dimensions["timing_state"],
            dimensions["exposure_state"],
        )
    )


def _comparability_statement(*, sufficient: bool, confirmed_sample_size: int, dimensions: dict) -> str:
    """What this group's numbers may be used for, stated on the group itself."""
    where = (
        f"题型 {dimensions['question_type_label']}、难度档 {dimensions['difficulty_band']}"
        f"（代理 {dimensions['difficulty_proxy']}）、时限条件 {dimensions['timing_state']}、"
        f"暴露情况 {dimensions['exposure_state']}"
    )
    if not sufficient:
        return (
            f"确认样本 {confirmed_sample_size} < {MIN_GROUP_SAMPLE}：不展示统计量，也不参与任何比较。"
            f"（{where}）"
        )
    return (
        f"确认样本 {confirmed_sample_size}（≥{MIN_GROUP_SAMPLE}）：可给出该组自身的确认分均值/中位数与离散度。"
        f"（{where}）与其他组比较必须同题型、同难度档、同时限条件；即使条件相同，组间差值也只是观察差异，"
        "不代表因果或学习提升。"
    )


def build_effect_calibration(*, user, project, subject=None) -> dict:
    """Grouped, sample-sized, deliberately non-causal comparison of practice attempts.

    Read-only: nothing is written and no snapshot is produced. Every payload
    passes through :func:`assert_no_causal_summary` before it is returned.
    """
    from apps.analytics.services import reports as report_service

    attempts, hidden_count, content_hidden_count = report_service.scoped_attempts(
        user=user, project=project, subject=subject
    )
    disputed_answers = report_service.disputed_answer_key_ids(project=project)
    disputed_rubrics = report_service.disputed_rubric_ids(project=project)
    assisted_ids = _assisted_attempt_ids(user=user, project=project)
    exposure = _exposure_states(user=user, project=project, attempts=attempts, assisted_ids=assisted_ids)

    groups: dict[str, dict] = {}
    exclusions_global: dict[str, int] = dict.fromkeys(EXCLUSION_MESSAGES, 0)
    for attempt in attempts:
        item = attempt.session_item
        dimensions = {
            "question_type": item.question_version.question_type,
            "question_type_label": _question_type_label(item.question_version.question_type),
            "difficulty_band": _difficulty_band(Decimal(item.max_score)),
            "difficulty_proxy": DIFFICULTY_PROXY,
            "timing_state": timing_state(attempt=attempt),
            "exposure_state": exposure[str(attempt.id)]["exposure_state"],
        }
        key = _group_key(dimensions)
        group = groups.setdefault(
            key,
            {
                "group_key": key,
                "dimensions": dimensions,
                "sample_size": 0,
                "confirmed_sample_size": 0,
                "fractions": [],
                "exclusion_counts": dict.fromkeys(EXCLUSION_MESSAGES, 0),
            },
        )
        group["sample_size"] += 1
        fraction, codes = _confirmed_fraction(
            attempt=attempt, disputed_answers=disputed_answers, disputed_rubrics=disputed_rubrics
        )
        if codes:
            for code in set(codes):
                group["exclusion_counts"][code] += 1
                exclusions_global[code] += 1
        else:
            group["confirmed_sample_size"] += 1
            group["fractions"].append(fraction)

    rows: list[dict] = []
    for key in sorted(groups):
        group = groups[key]
        fractions: list[Decimal] = group["fractions"]
        sufficient = len(fractions) >= MIN_GROUP_SAMPLE
        statistics = None
        if sufficient:
            spread = _spread(fractions)
            statistics = {
                "mean_confirmed_fraction": spread["mean"],
                "median_confirmed_fraction": _median(fractions),
                "spread_stdev": spread["stdev"],
                "min_confirmed_fraction": spread["min"],
                "max_confirmed_fraction": spread["max"],
                "metric": "confirmed_score / item_max_score",
            }
        reasons = [
            {"code": code, "message": EXCLUSION_MESSAGES[code], "attempt_count": group["exclusion_counts"][code]}
            for code in EXCLUSION_MESSAGES
            if group["exclusion_counts"][code]
        ]
        rows.append(
            {
                "group_key": key,
                "dimensions": group["dimensions"],
                "sample_size": group["sample_size"],
                "confirmed_sample_size": group["confirmed_sample_size"],
                "status": STATUS_OK if sufficient else STATUS_INSUFFICIENT,
                # Withheld, not warned about: a number next to a warning is
                # still read as the number.
                "statistics": statistics,
                "exclusions": {
                    "attempts_without_confirmed_score": group["sample_size"] - group["confirmed_sample_size"],
                    "reasons": reasons,
                },
                "comparability": _comparability_statement(
                    sufficient=sufficient,
                    confirmed_sample_size=len(fractions),
                    dimensions=group["dimensions"],
                ),
            }
        )

    eligible = [row for row in rows if row["status"] == STATUS_OK]
    comparisons: list[dict] = []
    for index, left in enumerate(eligible):
        for right in eligible[index + 1 :]:
            row = _comparability_between(left, right)
            if row["comparable"]:
                row["delta"] = _delta_row(left, right)
            comparisons.append(row)
    comparable_pairs = [row for row in comparisons if row["comparable"]]

    not_comparable: list[dict] = []
    for row in rows:
        if row["status"] != STATUS_OK:
            not_comparable.append(
                {
                    "group_key": row["group_key"],
                    "code": "insufficient_sample",
                    "message": row["comparability"],
                }
            )
    for row in comparisons:
        if not row["comparable"]:
            not_comparable.append(
                {"group_key": f"{row['group_a']} ↔ {row['group_b']}", "code": row["code"], "message": row["message"]}
            )

    payload = {
        "report_kind": "effect_calibration",
        "calculation_version": "p2-c08",
        "as_of": timezone.now().isoformat(),
        "project_id": str(project.id),
        "subject_id": str(subject.id) if subject is not None else None,
        "minimum_group_sample": MIN_GROUP_SAMPLE,
        "grouping": {
            "dimensions": ["question_type", "difficulty_band", "timing_state", "exposure_state"],
            "difficulty_proxy": DIFFICULTY_PROXY,
            "difficulty_proxy_note": DIFFICULTY_PROXY_NOTE,
            "timing_note": TIMING_NOTE,
            "exposure_note": EXPOSURE_NOTE,
            "attempts_in_scope": len(attempts),
            "hidden_verification_attempts": hidden_count,
            "hidden_verification_content_attempts": content_hidden_count,
        },
        "groups": rows,
        "group_count": len(rows),
        "comparable_group_count": len(eligible),
        "comparisons": comparisons,
        "comparable_pair_count": len(comparable_pairs),
        "not_comparable": not_comparable,
        "exclusions": {
            "attempts_in_scope": len(attempts),
            "reasons": [
                {"code": code, "message": EXCLUSION_MESSAGES[code], "attempt_count": count}
                for code, count in exclusions_global.items()
                if count
            ],
        },
        "caveats": {
            "statements": [
                "本报告只统计同一个人的个人作答记录：这是个人观察，不是对照实验，也没有对照组。",
                "不推断因果、不声称学习提升：任何组间差异都可能来自题目内容、时间、状态、运气与暴露条件的共同作用。",
                "各组的样本数、题目内容与暴露条件并不相同；只有同时满足同题型、同难度档、同时限条件的两组才给出组间差值，"
                "且差值仍不代表因果。",
                "自评分、AI 估计分、待评、争议与失效分数一律不进入统计；确认样本少于门槛的组不展示任何统计量。",
                "若需要因果结论，需要预先设计的对照或随机化条件与足够样本，本报告不具备这些条件。",
            ],
            "claims": {"causal_claim": False, "improvement_claim": False},
            "minimum_group_sample": MIN_GROUP_SAMPLE,
        },
    }
    assert_no_causal_summary(payload)
    return payload
