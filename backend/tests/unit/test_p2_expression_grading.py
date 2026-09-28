"""C07: restricted math-expression grading (docs/05 §3).

The acceptance rule is: an unknown unit, illegal syntax, a formula timeout, an
unknown symbol or any hard limit must go to human review; and a restricted
expression can never execute input code, read a file or open a network
connection.  These tests are pure logic (no database).
"""

from __future__ import annotations

import ast
import builtins
import socket
import time
from decimal import Decimal
from pathlib import Path

import pytest

from apps.common.answers import validate_answer_payload
from apps.common.enums import GradeMethod, GradeStatus, MismatchPolicy
from domain.grading import adapters, expressions

D = Decimal

# ---------------------------------------------------------------------------
# Inputs that must never become code, whatever else happens
# ---------------------------------------------------------------------------
HOSTILE_INPUTS = (
    '__import__("os").system("touch /tmp/pwned")',
    'open("/etc/passwd").read()',
    "(1).__class__.__bases__",
    '"a"*10',
    "lambda: 1",
    "[x for x in ()]",
    "x.__dict__",
    # Shapes without a quote or a dot: a name followed by "(" is a *function*
    # call, and only the whitelist may be called.
    "eval(x)",
    "exec(x)",
    "globals()",
    "__import__(x)",
    "os.system(x)",
    "1;2",
    "x if x else 1",
)

#: Blank ids used below are part of the answer contract, not free-form text.
EXPRESSION_BLANK = {
    "b1": {
        "equivalence": "expression",
        "accepted_values": ["x^2+2x+1"],
        "max_score": "3.00",
        "normalization": {"strip_whitespace": True},
        "mismatch_policy": MismatchPolicy.WRONG,
    }
}


def _fill(blanks: dict, submitted: dict, *, max_score: str = "3.00", rule: dict | None = None) -> adapters.GradeResult:
    return adapters.grade(
        question_type="fill_blank",
        raw_answer={"type": "fill_blank", "blanks": submitted},
        answer_payload={"kind": "fill_blank", "blanks": blanks},
        max_score=D(max_score),
        rule=rule or {},
    )


# ===========================================================================
# 1. Equivalence
# ===========================================================================
def test_expanding_a_square_is_equivalent():
    assert expressions.expressions_equivalent("x^2+2x+1", "(x+1)^2") is True
    verdict = expressions.compare_expressions("x^2+2x+1", "(x+1)^2")
    assert verdict.outcome == expressions.OUTCOME_EQUIVALENT
    assert verdict.samples_checked == expressions.MAX_SAMPLES


def test_pythagorean_identity_is_equivalent_to_one():
    assert expressions.expressions_equivalent("sin(x)^2+cos(x)^2", "1") is True
    # The letter does not matter either: only the function shape does.
    assert expressions.expressions_equivalent("sin(t)^2+cos(t)^2", "1") is True


def test_implicit_multiplication_is_supported_and_documented():
    # Documented in domain/grading/expressions.py: 2x, 2(x+1), 2sin(x), x y.
    assert expressions.evaluate("2x", {"x": 3}) == 6.0
    assert expressions.evaluate("2(x+1)", {"x": 1}) == 4.0
    assert expressions.evaluate("2sin(pi/2)", {}) == 2.0
    assert expressions.evaluate("(x+1)(x-1)", {"x": 3}) == 8.0
    assert expressions.expressions_equivalent("2(x+1)", "2x+2") is True
    # A name directly followed by "(" is a call, not implicit multiplication.
    with pytest.raises(expressions.ExpressionSyntaxError):
        expressions.evaluate("x(x+1)", {"x": 1})


def test_non_equivalent_pair_is_not_equal():
    verdict = expressions.compare_expressions("x+1", "x+2")
    assert verdict.outcome == expressions.OUTCOME_NOT_EQUIVALENT
    assert expressions.expressions_equivalent("x+1", "x+2") is False
    assert expressions.expressions_equivalent("x^2+2x+1", "(x+2)^2") is False
    # A single accepted answer that is not the same function is not equivalent.
    assert expressions.expressions_equivalent("sin(x)", "cos(x)") is False


def test_tolerance_absorbs_float_noise_but_not_a_real_difference():
    assert expressions.expressions_equivalent("0.1+0.2", "0.3") is True
    assert expressions.expressions_equivalent("sin(x)^2+cos(x)^2", "1.000001") is False


def test_structural_normalisation_is_a_whitelist_not_a_cas():
    normal = expressions.normalize_expression
    assert normal("x + 0") == normal("x")
    assert normal("x + 2") == normal("2 + x")
    assert normal("1/x") == normal("x^-1")
    assert normal("x*0") == normal("0")
    assert normal("x+1") == normal("y+1")  # symbol renaming only
    # No distribution: expanding `2(x+1)` is decided by sampling, not by the
    # canonical form (documented as "not a CAS").
    assert normal("2(x+1)") != normal("2x+2")
    assert expressions.expressions_equivalent("2(x+1)", "2x+2") is True


def test_a_difference_at_a_single_sample_point_is_enough_to_reject():
    samples = [1.0, 2.0, 3.0, 4.0, -1.0]
    left, right = "sqrt(x^2)", "x"
    agreeing = [
        point
        for point in samples
        if expressions.evaluate(left, {"x": point}) == expressions.evaluate(right, {"x": point})
    ]
    assert len(agreeing) == 4  # only the negative point differs
    verdict = expressions.compare_expressions(left, right, samples=samples)
    assert verdict.outcome == expressions.OUTCOME_NOT_EQUIVALENT
    assert verdict.sample == {"v0": -1.0}
    assert expressions.expressions_equivalent(left, right, samples=samples) is False


# ===========================================================================
# 2. Domain holes
# ===========================================================================
def test_a_zero_sample_point_makes_the_reciprocal_comparison_unknown():
    assert expressions.evaluate("1/x", {"x": 2}) == 0.5
    with pytest.raises(expressions.ExpressionDomainError):
        expressions.evaluate("1/x", {"x": 0})
    verdict = expressions.compare_expressions("1/x", "1/x")
    assert verdict.outcome == expressions.OUTCOME_UNKNOWN
    assert verdict.error_type == expressions.ERROR_DOMAIN
    assert verdict.sample == {"v0": 0.0}  # 0 is part of the fixed sample set
    assert expressions.expressions_equivalent("1/x", "1/x") is None


def test_every_sample_point_must_evaluate_for_a_root():
    with pytest.raises(expressions.ExpressionDomainError):
        expressions.evaluate("sqrt(x-5)", {"x": -7})
    # Default samples include negative values -> the comparison is unknown, and
    # "unknown" is not "wrong": the caller must send it to review.
    assert expressions.expressions_equivalent("sqrt(x-5)", "sqrt(x-5)") is None
    # Restricted to points where both sides exist, the same comparison decides.
    assert expressions.expressions_equivalent("sqrt(x-5)", "sqrt(x-5)", samples=[5.0, 6.0, 7.0]) is True


def test_unknown_symbol_is_a_syntax_error_not_a_value():
    with pytest.raises(expressions.ExpressionSyntaxError):
        expressions.evaluate("x+1", {})
    with pytest.raises(expressions.ExpressionSyntaxError):
        expressions.evaluate("lg(x)", {"x": 1})


# ===========================================================================
# 3. Hard limits and the wall clock
# ===========================================================================
OVER_LONG_INPUT = "1" * (expressions.MAX_INPUT_LENGTH + 1)
TOO_MANY_TOKENS = "1" + "+1" * 99  # 199 characters, 199 tokens, under the length cap
TOO_MANY_NODES = "+".join(["1"] * 70)  # 139 tokens <= MAX_TOKENS, 139 nodes > MAX_AST_NODES
DEEP_NESTING = "(" * (expressions.MAX_DEPTH + 1) + "x" + ")" * (expressions.MAX_DEPTH + 1)
DEEP_UNARY = "-" * (expressions.MAX_DEPTH + 1) + "x"
ABSURD_POWER = "9^9^9"
# 60 summed symbols -> 119 nodes per side, 238 evaluation steps per sample point.
BIG_SUM = "+".join(["x"] * 60)
BIG_PRODUCT = "+".join(["2*x"] * 30)


@pytest.mark.parametrize(
    "expression,limit_constant",
    [
        (OVER_LONG_INPUT, "MAX_INPUT_LENGTH"),
        (TOO_MANY_TOKENS, "MAX_TOKENS"),
        (TOO_MANY_NODES, "MAX_AST_NODES"),
        (DEEP_NESTING, "MAX_DEPTH"),
        (DEEP_UNARY, "MAX_DEPTH"),
        (ABSURD_POWER, "MAX_EXPONENT_MAGNITUDE"),
        (f"2^{expressions.MAX_EXPONENT_MAGNITUDE + 1}", "MAX_EXPONENT_MAGNITUDE"),
        (f"2^{expressions.MAX_EXPONENT_MAGNITUDE}", None),  # boundary: allowed
    ],
)
def test_limits_are_named_and_enforced(expression, limit_constant):
    if limit_constant is None:
        assert expressions.evaluate(expression, {}) == 2.0**expressions.MAX_EXPONENT_MAGNITUDE
        return
    with pytest.raises(expressions.ExpressionLimitError) as failure:
        expressions.evaluate(expression, {"x": 1.0})
    assert limit_constant in str(failure.value)


def test_length_limit_is_checked_before_tokenising():
    # Both limits apply; the cheap length check must win so a huge input is
    # rejected without being scanned.
    huge = "1+" * 5000
    assert len(huge) > expressions.MAX_INPUT_LENGTH
    with pytest.raises(expressions.ExpressionLimitError) as failure:
        expressions.evaluate(huge, {})
    assert "MAX_INPUT_LENGTH" in str(failure.value)


def test_evaluation_step_budget_bounds_a_whole_comparison():
    # Both sides are legal and numerically identical, but deciding it needs more
    # node visits than MAX_EVAL_STEPS -> unknown, never a guessed "equivalent".
    verdict = expressions.compare_expressions(BIG_SUM, BIG_PRODUCT)
    assert verdict.outcome == expressions.OUTCOME_UNKNOWN
    assert verdict.error_type == expressions.ERROR_LIMIT
    assert "MAX_EVAL_STEPS" in verdict.reason
    assert expressions.expressions_equivalent(BIG_SUM, BIG_PRODUCT) is None


def test_wall_clock_budget_turns_everything_into_unknown():
    # A zero budget is expired before the first check, so even a trivially true
    # comparison may not answer "correct".
    assert expressions.expressions_equivalent("1+1", "2") is True
    verdict = expressions.compare_expressions("1+1", "2", time_budget=0.0)
    assert verdict.outcome == expressions.OUTCOME_UNKNOWN
    assert verdict.error_type == expressions.ERROR_TIMEOUT
    assert "MAX_TIME_BUDGET_SECONDS" in verdict.reason
    assert expressions.expressions_equivalent("1+1", "2", time_budget=0.0) is None
    with pytest.raises(expressions.ExpressionTimeout):
        expressions.evaluate("1+1", {}, time_budget=0.0)
    # A budget above the ceiling is clamped, never honoured.
    assert expressions._budget(60.0) == expressions.MAX_TIME_BUDGET_SECONDS


def test_limits_and_timeouts_stay_fast_in_wall_clock_terms():
    started = time.perf_counter()
    for expression in (OVER_LONG_INPUT, TOO_MANY_TOKENS, TOO_MANY_NODES, DEEP_NESTING, ABSURD_POWER, BIG_SUM):
        try:
            expressions.evaluate(expression, {"x": 1.0})
        except expressions.ExpressionError:
            pass
    for _ in range(20):
        expressions.compare_expressions(BIG_SUM, BIG_PRODUCT)
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, f"hostile/limited inputs took {elapsed:.3f}s"


def test_default_budget_comparison_is_fast():
    started = time.perf_counter()
    for _ in range(50):
        assert expressions.expressions_equivalent("x^2+2x+1", "(x+1)^2") is True
    elapsed = time.perf_counter() - started
    assert elapsed < expressions.MAX_TIME_BUDGET_SECONDS * 50
    # One comparison is far inside the 50 ms budget the acceptance rule names.
    assert expressions.DEFAULT_TIME_BUDGET_SECONDS == 0.05


@pytest.mark.parametrize(
    "samples",
    [
        ["not-a-number"],
        [[]],
        [],
        [1.0] * (expressions.MAX_SAMPLES + 1),
    ],
)
def test_an_unusable_sample_set_is_unknown_not_a_crash(samples):
    verdict = expressions.compare_expressions("x+1", "x+2", samples=samples)
    assert verdict.outcome == expressions.OUTCOME_UNKNOWN
    assert verdict.error_type == expressions.ERROR_LIMIT
    assert expressions.expressions_equivalent("x+1", "x+2", samples=samples) is None


def test_more_than_two_symbols_is_unknown_rather_than_a_guess():
    # The two sides are not the same shape, so sampling is required, and four
    # free symbols are more than the engine is allowed to sample.
    verdict = expressions.compare_expressions("a*b*c", "a*b+d")
    assert verdict.outcome == expressions.OUTCOME_UNKNOWN
    assert verdict.error_type == expressions.ERROR_LIMIT
    assert f"MAX_VARIABLES={expressions.MAX_VARIABLES}" in verdict.reason
    # Renaming a symbol is *not* a new symbol: same shape, same count.
    assert expressions.expressions_equivalent("a*b*c", "p*q*r") is True


def test_variable_values_must_be_finite_real_numbers():
    with pytest.raises(expressions.ExpressionDomainError):
        expressions.evaluate("x+1", {"x": "abc"})
    with pytest.raises(expressions.ExpressionDomainError):
        expressions.evaluate("x+1", {"x": float("inf")})


# ===========================================================================
# 4. No code execution, no file, no network
# ===========================================================================
@pytest.mark.parametrize("hostile", HOSTILE_INPUTS)
def test_hostile_inputs_are_syntax_errors(hostile):
    with pytest.raises(expressions.ExpressionSyntaxError):
        expressions.evaluate(hostile, {"x": 1.0})
    verdict = expressions.compare_expressions(hostile, "x")
    assert verdict.outcome == expressions.OUTCOME_UNKNOWN
    assert verdict.error_type == expressions.ERROR_SYNTAX
    assert expressions.expressions_equivalent(hostile, "x") is None
    # And through the grader: review, never "wrong".
    result = _fill(EXPRESSION_BLANK, {"b1": hostile})
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None


def test_hostile_inputs_cannot_read_or_create_files(tmp_path, monkeypatch):
    sandbox = tmp_path / "canary-dir"
    sandbox.mkdir()
    canary = sandbox / "canary.txt"
    canary.write_text("DO-NOT-READ", encoding="utf-8")
    before = canary.stat()
    opened: list[str] = []
    real_open = builtins.open

    def tripwire(file, *args, **kwargs):
        opened.append(str(file))
        raise AssertionError(f"expression engine tried to open {file!r}")

    monkeypatch.setattr(builtins, "open", tripwire)
    escape_attempts = (
        HOSTILE_INPUTS
        + (
            f'open("{canary}").read()',
            f'__import__("os").system("touch {sandbox / "pwned"}")',
            f'__import__("pathlib").Path("{canary}").read_text()',
            f'__import__("os").remove("{canary}")',
        )
    )
    for hostile in escape_attempts:
        with pytest.raises(expressions.ExpressionSyntaxError):
            expressions.evaluate(hostile, {"x": 1.0})
    assert opened == []  # nothing was opened by the engine, canary included
    assert list(sandbox.iterdir()) == [canary]
    assert real_open(canary, encoding="utf-8").read() == "DO-NOT-READ"
    after = canary.stat()
    assert (after.st_mtime_ns, after.st_size) == (before.st_mtime_ns, before.st_size)


def test_hostile_inputs_cannot_open_a_socket(monkeypatch):
    created: list[tuple] = []

    class _TripwireSocket:
        def __init__(self, *args, **kwargs):
            created.append(args)
            raise AssertionError("expression engine tried to create a socket")

    monkeypatch.setattr(socket, "socket", _TripwireSocket)
    for hostile in HOSTILE_INPUTS:
        with pytest.raises(expressions.ExpressionSyntaxError):
            expressions.evaluate(hostile, {"x": 1.0})
    assert created == []


def _expressions_module_tree() -> ast.Module:
    source = Path(expressions.__file__).read_text(encoding="utf-8")
    return ast.parse(source)


ALLOWED_IMPORTS = {"__future__", "math", "re", "time", "dataclasses", "decimal", "fractions"}
FORBIDDEN_IMPORTS = {
    "os",
    "sys",
    "subprocess",
    "socket",
    "importlib",
    "ctypes",
    "pickle",
    "shutil",
    "pathlib",
    "tempfile",
    "builtins",
    "io",
    "http",
    "urllib",
    "requests",
    "signal",
    "threading",
    "multiprocessing",
    "marshal",
    "code",
    "pty",
}
FORBIDDEN_NAMES = {
    "eval",
    "exec",
    "compile",
    "__import__",
    "open",
    "input",
    "getattr",
    "setattr",
    "delattr",
    "globals",
    "locals",
    "vars",
    "breakpoint",
    "memoryview",
    "__builtins__",
}
FORBIDDEN_ATTRIBUTES = {"system", "popen", "spawn", "check_output", "check_call"}
#: Builtins the module is allowed to call at all (everything else must be local).
ALLOWED_BUILTIN_CALLS = {
    "abs",
    "bool",
    "dict",
    "enumerate",
    "float",
    "frozenset",
    "hasattr",
    "int",
    "isinstance",
    "len",
    "list",
    "max",
    "min",
    "range",
    "repr",
    "round",
    "set",
    "sorted",
    "str",
    "sum",
    "tuple",
}


def test_module_imports_only_the_safe_allowlist():
    tree = _expressions_module_tree()
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0
            imported.add((node.module or "").split(".")[0])
    assert imported <= ALLOWED_IMPORTS, f"unexpected import: {sorted(imported - ALLOWED_IMPORTS)}"
    assert imported.isdisjoint(FORBIDDEN_IMPORTS)
    # A future edit that adds `import os` (or Decimal-based tricks) fails here.
    assert "os" not in imported
    assert "sys" not in imported


def test_module_never_references_an_escape_hatch():
    tree = _expressions_module_tree()
    names = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
    assert names.isdisjoint(FORBIDDEN_NAMES), sorted(names & FORBIDDEN_NAMES)
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            # Walk every chain to its root: `os.path.join(...)` must be caught too.
            root: ast.expr = node
            while isinstance(root, ast.Attribute):
                assert not (root.attr.startswith("__") and root.attr.endswith("__")), root.attr
                assert root.attr not in FORBIDDEN_ATTRIBUTES, root.attr
                root = root.value
            if isinstance(root, ast.Name):
                assert root.id not in FORBIDDEN_IMPORTS, root.id
        assert not isinstance(node, (ast.Lambda, ast.Await, ast.Yield, ast.YieldFrom, ast.AsyncFunctionDef)), type(
            node
        ).__name__


def test_module_calls_only_its_own_functions_and_safe_builtins():
    tree = _expressions_module_tree()
    defined = {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            defined.update(alias.asname or alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            defined.update(alias.asname or alias.name for alias in node.names)
    called = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    # `function(...)` is the only dynamic call target, and it must be bound from
    # the FUNCTIONS whitelist rather than from anything the learner wrote.
    bindings = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == "function"
    ]
    assert len(bindings) == 1
    assert isinstance(bindings[0].value, ast.Subscript)
    assert isinstance(bindings[0].value.value, ast.Name) and bindings[0].value.value.id == "FUNCTIONS"
    unexpected = called - defined - ALLOWED_BUILTIN_CALLS - {"function"}
    assert unexpected == set(), f"unexpected callable: {sorted(unexpected)}"


# ===========================================================================
# 5. Grader integration and regression
# ===========================================================================
def test_expression_blank_accepts_an_equivalent_answer():
    result = _fill(EXPRESSION_BLANK, {"b1": "(x+1)^2"})
    part = result.parts[0]
    assert result.status == GradeStatus.CONFIRMED
    assert result.confirmed_score == D("3.00")
    assert result.is_fully_confirmed is True
    assert result.is_correct is True
    assert part.detail["outcome"] == "correct"
    assert part.detail["match"] == "expression"
    assert part.detail["equivalence"] == "expression"
    assert part.detail["samples_checked"] > 0


def test_expression_blank_literal_accepted_answer_wins_first():
    result = _fill(EXPRESSION_BLANK, {"b1": "  x^2+2x+1  "})
    part = result.parts[0]
    assert result.confirmed_score == D("3.00")
    assert part.detail["match"] == "exact"
    assert "samples_checked" not in part.detail


def test_expression_blank_marks_a_non_equivalent_answer_wrong():
    result = _fill(EXPRESSION_BLANK, {"b1": "x^2+2x+2"})
    part = result.parts[0]
    assert result.status == GradeStatus.CONFIRMED
    assert result.confirmed_score == D("0.00")
    assert result.is_correct is False
    assert part.detail["outcome"] == "wrong"
    assert part.detail["equivalence"] == "expression"


def test_expression_blank_with_review_policy_keeps_a_mismatch_pending():
    review_blank = {"b1": {**EXPRESSION_BLANK["b1"], "mismatch_policy": MismatchPolicy.REVIEW}}
    result = _fill(review_blank, {"b1": "x^2+2x+2"})
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None
    assert result.pending_max_score == D("3.00")
    assert "不等价" in result.parts[0].detail["reason"]


@pytest.mark.parametrize(
    "submitted,error_type,reason_fragment",
    [
        ('__import__("os").system("ls")', "syntax", "语法非法"),
        ("open('/etc/passwd')", "syntax", "语法非法"),
        ("lg(x)", "syntax", "语法非法"),
        ("9^9^9", "limit", "受限计算上限"),
        ("1" + "+1" * 99, "limit", "受限计算上限"),
        ("sqrt(x-8)", "domain", "无定义"),
        ("1/0", "domain", "无定义"),
    ],
)
def test_undecidable_expression_goes_to_review_with_a_specific_reason(submitted, error_type, reason_fragment):
    result = _fill(EXPRESSION_BLANK, {"b1": submitted})
    part = result.parts[0]
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None
    assert part.score is None
    assert part.status == GradeStatus.PENDING_REVIEW
    assert part.detail["error"] == error_type
    assert reason_fragment in part.detail["reason"]
    assert part.detail["message"]  # the engine's own message is preserved
    # The reviewer note repeats the reason for the item-level view.
    assert part.detail["reason"] in result.notes


def test_expression_blank_unknown_symbol_or_unit_goes_to_review():
    result = _fill(EXPRESSION_BLANK, {"b1": "x^2+2x+1 m"})
    part = result.parts[0]
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None
    assert part.detail["unknown_symbols"] == ["m"]
    assert "未登记符号" in part.detail["reason"]

    # A symbol the answer key does not use is never silently absorbed.
    zero_blank = {"b1": {"equivalence": "expression", "accepted_values": ["0"], "max_score": "3.00"}}
    zero_result = _fill(zero_blank, {"b1": "m"})
    assert zero_result.status == GradeStatus.PENDING_REVIEW
    assert zero_result.parts[0].detail["unknown_symbols"] == ["m"]

    # Renaming the symbol the key already uses stays correct.
    renamed = _fill(EXPRESSION_BLANK, {"b1": "(t+1)^2"})
    assert renamed.status == GradeStatus.CONFIRMED
    assert renamed.confirmed_score == D("3.00")


def test_expression_blank_timeout_goes_to_review():
    slow_blank = {"b1": {**EXPRESSION_BLANK["b1"], "expression_time_budget_ms": 0.001}}
    result = _fill(slow_blank, {"b1": "+".join(["x"] * 60)})
    part = result.parts[0]
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None
    assert part.detail["error"] == "timeout"
    assert "超时" in part.detail["reason"]


def test_expression_blank_without_a_registered_answer_goes_to_review():
    result = _fill({"b1": {"equivalence": "expression", "max_score": "3.00"}}, {"b1": "x+1"})
    assert result.status == GradeStatus.PENDING_REVIEW
    assert "缺少已登记的标准答案" in result.parts[0].detail["reason"]


def test_unregistered_equivalence_mode_is_never_guessed():
    blank = {"b1": {"equivalence": "symbolic", "accepted_values": ["x+1"], "max_score": "3.00"}}
    result = _fill(blank, {"b1": "x+1"})
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.confirmed_score is None
    assert "未登记的等价判定模式" in result.parts[0].detail["reason"]


def test_expression_mode_is_additive_to_the_answer_contract():
    payload = {
        "kind": "fill_blank",
        "blanks": {
            "b1": {
                "equivalence": "expression",
                "accepted_values": ["x^2+2x+1", "(x+1)^2"],
                "mismatch_policy": "wrong",
                "max_score": "3.00",
                "unit": {"whitelist": {"m": "1"}, "expected": "m"},
            }
        },
    }
    assert validate_answer_payload(payload, "fill_blank") == []
    # Documented limitation: expression mode reports units instead of converting
    # them, even when the blank carries a whitelist.
    with_unit = {
        "b1": {
            "equivalence": "expression",
            "accepted_values": ["10"],
            "unit": {"whitelist": {"m": "1", "cm": "0.01"}, "expected": "m"},
            "max_score": "3.00",
        }
    }
    assert _fill(with_unit, {"b1": "10"}).confirmed_score == D("3.00")
    converted_elsewhere = _fill(with_unit, {"b1": "1000 cm"})
    assert converted_elsewhere.status == GradeStatus.PENDING_REVIEW
    assert converted_elsewhere.parts[0].detail["unknown_symbols"] == ["cm"]
    # `accepted` is a grading-side alias; `accepted_values` stays the validated key.
    alias_payload = {
        "kind": "fill_blank",
        "blanks": {"b1": {"equivalence": "expression", "accepted": ["x^2+2x+1"], "max_score": "3.00"}},
    }
    assert validate_answer_payload(alias_payload, "fill_blank") != []
    assert _fill(alias_payload["blanks"], {"b1": "(x+1)^2"}).confirmed_score == D("3.00")


def test_mixed_blank_confirmation_and_review_are_reported_separately():
    blanks = {
        "b1": EXPRESSION_BLANK["b1"],
        "b2": {
            "equivalence": "expression",
            "accepted_values": ["2x+2"],
            "max_score": "1.00",
            "mismatch_policy": MismatchPolicy.WRONG,
        },
    }
    result = _fill(blanks, {"b1": "(x+1)^2", "b2": "sqrt(y-9)"}, max_score="4.00")
    assert result.status == GradeStatus.PENDING_REVIEW
    assert result.method == GradeMethod.MIXED
    assert result.confirmed_score == D("3.00")
    assert result.pending_max_score == D("1.00")
    assert result.is_fully_confirmed is False


def test_rule_snapshot_stays_compatible():
    with_expression = _fill(EXPRESSION_BLANK, {"b1": "(x+1)^2"})
    assert with_expression.rule_snapshot["blank_ids"] == ["b1"]
    assert with_expression.rule_snapshot["default_mismatch_policy"] == MismatchPolicy.REVIEW
    assert with_expression.rule_snapshot["rule"] == {}
    assert with_expression.rule_snapshot["expression_blanks"] == ["b1"]
    plain = _fill({"b1": {"accepted_values": ["1"], "max_score": "3.00"}}, {"b1": "1"})
    assert plain.rule_snapshot["expression_blanks"] == []
    assert plain.notes == []


def test_grade_result_shape_is_unchanged():
    plain = _fill({"b1": {"accepted_values": ["1"], "max_score": "3.00"}}, {"b1": "1"})
    assert set(plain.as_dict()) == {
        "status",
        "method",
        "confirmed_score",
        "max_score",
        "pending_max_score",
        "is_fully_confirmed",
        "is_correct",
        "parts",
        "notes",
    }
    assert set(plain.parts[0].as_dict()) == {"part_id", "score", "max_score", "status", "method", "detail"}
    assert set(plain.parts[0].detail) == {"outcome", "submitted"}


def test_blanks_without_the_flag_behave_exactly_as_before():
    numeric = {
        "b1": {
            "numeric": {"value": "10", "abs_tol": "0.1", "rel_tol": "0"},
            "max_score": "3.00",
            "mismatch_policy": MismatchPolicy.WRONG,
        }
    }
    assert _fill(numeric, {"b1": "10.1"}).confirmed_score == D("3.00")
    outside = _fill(numeric, {"b1": "10.11"})
    assert outside.confirmed_score == D("0.00")
    assert outside.parts[0].detail["outcome"] == "wrong"

    with_unit = {
        "b1": {
            "numeric": {"value": "1", "abs_tol": "0.001", "rel_tol": "0"},
            "unit": {"whitelist": {"m": "1", "cm": "0.01"}, "expected": "m"},
            "max_score": "3.00",
            "mismatch_policy": MismatchPolicy.WRONG,
        }
    }
    assert _fill(with_unit, {"b1": "100 cm"}).confirmed_score == D("3.00")
    unknown_unit = _fill(with_unit, {"b1": "10 furlong"})
    assert unknown_unit.status == GradeStatus.PENDING_REVIEW
    assert "未知或不允许的单位" in unknown_unit.parts[0].detail["reason"]

    missing_unit = _fill(with_unit, {"b1": "1"})
    assert missing_unit.status == GradeStatus.PENDING_REVIEW
    assert missing_unit.parts[0].detail["reason"] == "缺少单位"

    written_expression = _fill(numeric, {"b1": "5*2"})
    assert written_expression.status == GradeStatus.PENDING_REVIEW
    assert "表达式" in written_expression.parts[0].detail["reason"]
    assert written_expression.confirmed_score is None

    text_blank = {"b1": {"accepted_values": ["1/2"], "max_score": "3.00"}}
    assert _fill(text_blank, {"b1": "0.5"}).status == GradeStatus.PENDING_REVIEW
    assert _fill(text_blank, {"b1": "1/2"}).confirmed_score == D("3.00")
