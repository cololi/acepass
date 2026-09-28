"""Restricted math-expression engine for formula blanks (acceptance C07).

This module is the *only* place where a learner-written formula may be given a
numeric meaning.  It is deliberately self-contained and dependency-free:

* no ``eval`` / ``exec`` / ``compile`` / ``__import__``, no attribute access, no
  subscripts, no strings, and no call to anything outside the function
  whitelist — ``__import__("os").system(...)``, ``open(...)``,
  ``(1).__class__``, ``"a"*10``, ``lambda: 1``, ``[x for x in ()]`` and
  ``x.__dict__`` are all **syntax errors**;
* every limit below is a named constant and raises :class:`ExpressionLimitError`
  (or :class:`ExpressionTimeout` for the wall-clock budget);
* the verdict for a comparison is three-valued.  ``UNKNOWN`` means "a human must
  look at this" and is never reported as correct or as wrong by the grader.

Grammar (recursive descent)::

    expression := term (('+' | '-') term)*
    term       := unary (('*' | '/') unary | implicit-factor)*
    unary      := ('+' | '-') unary | power
    power      := primary ('^' unary)?          # right associative: 2^3^2 = 2^(3^2)
    primary    := NUMBER | NAME | NAME '(' expression ')' | '(' expression ')'

* Numbers are decimal, optionally with an exponent (``1``, ``0.5``, ``2e3``).
* ``^`` binds tighter than unary minus, so ``-x^2`` is ``-(x^2)``.
* Implicit multiplication is supported as ``2x``, ``2(x+1)``, ``2sin(x)``,
  ``x y`` and ``(x+1)(x-1)``.  A name directly followed by ``(`` is always a
  *function call* and must be whitelisted, so ``x(x+1)`` is a syntax error while
  ``x*(x+1)`` works; that is what keeps ``eval(x)`` / ``exec(x)`` /
  ``__import__(x)`` from parsing as products of variables.
* Names are case-insensitive (``SIN(X)`` == ``sin(x)``).  A number directly
  followed by another number is a syntax error (``1.2.3``, ``2 3``).
* Whitelisted functions: ``sqrt``, ``abs``, ``sin``, ``cos``, ``tan``, ``log``
  (base 10), ``ln`` (natural), ``exp``.  Whitelisted constants: ``pi``, ``e``.
  Anything else in :func:`evaluate` is an unknown symbol -> syntax error.
* :func:`expressions_equivalent` parses in *inference* mode: an unknown name is
  treated as a free variable (renamed ``v0``, ``v1`` … by first appearance), so
  the letter a learner chooses does not matter.  The grader decides separately
  whether an extra free variable is a unit or an unknown symbol.

Every hard limit is listed once, here, with the constant that enforces it::

    MAX_INPUT_LENGTH        200 characters          ExpressionLimitError
    MAX_TOKENS              160 tokens              ExpressionLimitError
    MAX_AST_NODES           128 nodes               ExpressionLimitError
    MAX_DEPTH               12 nested levels        ExpressionLimitError
    MAX_EVAL_STEPS          4000 node visits        ExpressionLimitError
                            (one evaluation, or all sample points of one
                             comparison taken together)
    MAX_EXPONENT_MAGNITUDE  64                      ExpressionLimitError
    MAX_ABS_RESULT          1e30                    ExpressionLimitError
    MAX_VARIABLES           2 sampled variables     ExpressionLimitError
    MAX_SAMPLES             24 sample points        ExpressionLimitError
    DEFAULT_TIME_BUDGET_SECONDS 0.05 (50 ms)        ExpressionTimeout
    MAX_TIME_BUDGET_SECONDS     2.0 (hard ceiling)  clamped, never exceeded

Timing uses ``time.perf_counter`` only (no ``signal``, no threads): the deadline
is checked before parsing, before any verdict is issued, and every
``_TIME_CHECK_INTERVAL`` steps of evaluation, so a comparison cannot run past its
budget even if a future edit makes evaluation more expensive — and an expired
budget can never produce "equivalent".
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Hard limits
# ---------------------------------------------------------------------------
MAX_INPUT_LENGTH = 200
MAX_TOKENS = 160
MAX_AST_NODES = 128
MAX_DEPTH = 12
MAX_EVAL_STEPS = 4000
MAX_EXPONENT_MAGNITUDE = 64
MAX_ABS_RESULT = 1e30
MAX_VARIABLES = 2
MAX_SAMPLES = 24
DEFAULT_TIME_BUDGET_SECONDS = 0.05
MAX_TIME_BUDGET_SECONDS = 2.0
DEFAULT_TOLERANCE = 1e-9
SAMPLE_SEED = 20260214

#: Evaluation steps between two wall-clock checks (bounds timeout detection lag).
_TIME_CHECK_INTERVAL = 32

#: Functions a formula may call.  Nothing else is callable.
FUNCTIONS = {
    "sqrt": math.sqrt,
    "abs": abs,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "log": math.log10,
    "ln": math.log,
    "exp": math.exp,
}
CONSTANTS = {"pi": math.pi, "e": math.e}

#: Functions that are undefined on part of the real line: an expression that
#: contains one of them is never "total" (see :func:`_is_total`).
_PARTIAL_FUNCTIONS = frozenset({"sqrt", "log", "ln"})

# ---------------------------------------------------------------------------
# Verdicts
# ---------------------------------------------------------------------------
OUTCOME_EQUIVALENT = "equivalent"
OUTCOME_NOT_EQUIVALENT = "not_equivalent"
#: "A human must decide": unknown symbol, domain hole, limit or timeout.
OUTCOME_UNKNOWN = "unknown"

ERROR_SYNTAX = "syntax"
ERROR_LIMIT = "limit"
ERROR_DOMAIN = "domain"
ERROR_TIMEOUT = "timeout"


class ExpressionError(Exception):
    """Base class: any refusal the engine can produce."""

    code = "expression"


class ExpressionSyntaxError(ExpressionError):
    """Illegal token, unknown symbol/function, or malformed structure."""

    code = ERROR_SYNTAX


class ExpressionLimitError(ExpressionError):
    """A named hard limit (length/tokens/nodes/depth/steps/exponent/result)."""

    code = ERROR_LIMIT


class ExpressionDomainError(ExpressionError):
    """The expression is undefined at the point being evaluated."""

    code = ERROR_DOMAIN


class ExpressionTimeout(ExpressionError):
    """The wall-clock budget for this evaluation/comparison was exceeded."""

    code = ERROR_TIMEOUT


@dataclass(frozen=True)
class ExpressionVerdict:
    """Three-valued comparison result.  ``unknown`` is never "wrong"."""

    outcome: str
    reason: str = ""
    error_type: str | None = None
    samples_checked: int = 0
    sample: dict[str, float] | None = None

    @property
    def is_equivalent(self) -> bool:
        return self.outcome == OUTCOME_EQUIVALENT

    def as_dict(self) -> dict:
        return {
            "outcome": self.outcome,
            "reason": self.reason,
            "error_type": self.error_type,
            "samples_checked": self.samples_checked,
            "sample": dict(self.sample) if self.sample else None,
        }


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class _Token:
    kind: str  # "num" | "name" | "op" | "lparen" | "rparen"
    text: str
    value: float | None = None


_TOKEN_PATTERN = re.compile(
    r"(?P<number>(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)"
    r"|(?P<name>[A-Za-z_][A-Za-z0-9_]*)"
    r"|(?P<op>[+\-*/^])"
    r"|(?P<lparen>\()"
    r"|(?P<rparen>\))"
)


def _tokenize(source: str) -> list[_Token]:
    if not isinstance(source, str):
        raise ExpressionSyntaxError("表达式必须是字符串")
    if len(source) > MAX_INPUT_LENGTH:
        raise ExpressionLimitError(f"表达式长度超过上限（MAX_INPUT_LENGTH={MAX_INPUT_LENGTH}）")
    tokens: list[_Token] = []
    position = 0
    while position < len(source):
        char = source[position]
        if char.isspace():
            position += 1
            continue
        match = _TOKEN_PATTERN.match(source, position)
        if match is None:
            raise ExpressionSyntaxError(
                f"非法字符 {char!r}（位置 {position}）：表达式只允许数字、运算符、括号和白名单符号"
            )
        kind = match.lastgroup or "op"
        text = match.group()
        position = match.end()
        if kind == "number":
            value = float(text)
            if not math.isfinite(value):
                raise ExpressionLimitError(f"数值超出允许范围：{text!r}")
            tokens.append(_Token("num", text, value))
        else:
            tokens.append(_Token(kind, text))
        if len(tokens) > MAX_TOKENS:
            raise ExpressionLimitError(f"表达式 token 数超过上限（MAX_TOKENS={MAX_TOKENS}）")
    if not tokens:
        raise ExpressionSyntaxError("表达式为空")
    return tokens


# ---------------------------------------------------------------------------
# AST
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class _Node:
    kind: str  # "num" | "var" | "neg" | "call" | "bin"
    value: float | None = None
    op: str | None = None
    name: str | None = None
    left: _Node | None = None
    right: _Node | None = None


class _Parser:
    """Recursive descent parser.  ``variables is None`` means "infer names"."""

    def __init__(self, tokens: list[_Token], variables: set[str] | None):
        self.tokens = tokens
        self.variables = variables
        self.position = 0
        self.nodes = 0
        self.depth = 0

    # -- helpers ----------------------------------------------------------
    def _peek(self) -> _Token | None:
        return self.tokens[self.position] if self.position < len(self.tokens) else None

    def _next(self) -> _Token:
        token = self.tokens[self.position]
        self.position += 1
        return token

    def _node(self, kind: str, **fields) -> _Node:
        self.nodes += 1
        if self.nodes > MAX_AST_NODES:
            raise ExpressionLimitError(f"表达式 AST 节点数超过上限（MAX_AST_NODES={MAX_AST_NODES}）")
        return _Node(kind, **fields)

    def _enter(self) -> None:
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise ExpressionLimitError(f"表达式嵌套深度超过上限（MAX_DEPTH={MAX_DEPTH}）")

    def _leave(self) -> None:
        self.depth -= 1

    # -- grammar ----------------------------------------------------------
    def parse(self) -> _Node:
        node = self._parse_expression()
        leftover = self._peek()
        if leftover is not None:
            raise ExpressionSyntaxError(f"表达式存在多余内容 {leftover.text!r}（位置 {self.position}）")
        return node

    def _parse_expression(self) -> _Node:
        node = self._parse_term()
        while True:
            token = self._peek()
            if token is None or token.kind != "op" or token.text not in ("+", "-"):
                return node
            self._next()
            node = self._node("bin", op=token.text, left=node, right=self._parse_term())

    def _parse_term(self) -> _Node:
        node = self._parse_unary()
        while True:
            token = self._peek()
            if token is not None and token.kind == "op" and token.text in ("*", "/"):
                self._next()
                node = self._node("bin", op=token.text, left=node, right=self._parse_unary())
            elif token is not None and token.kind in ("name", "lparen"):
                # Implicit multiplication: `2x`, `2(x+1)`, `2sin(x)`, `(x+1)(x-1)`.
                node = self._node("bin", op="*", left=node, right=self._parse_unary())
            else:
                return node

    def _parse_unary(self) -> _Node:
        self._enter()
        try:
            token = self._peek()
            if token is not None and token.kind == "op" and token.text in ("+", "-"):
                self._next()
                operand = self._parse_unary()
                if token.text == "+":
                    return operand
                return self._node("neg", left=operand)
            return self._parse_power()
        finally:
            self._leave()

    def _parse_power(self) -> _Node:
        base = self._parse_primary()
        token = self._peek()
        if token is not None and token.kind == "op" and token.text == "^":
            self._next()
            # Right associative, and the exponent may itself be signed (`2^-1`).
            return self._node("bin", op="^", left=base, right=self._parse_unary())
        return base

    def _parse_primary(self) -> _Node:
        token = self._peek()
        if token is None:
            raise ExpressionSyntaxError("表达式意外结束")
        if token.kind == "num":
            self._next()
            return self._node("num", value=token.value)
        if token.kind == "lparen":
            self._next()
            self._enter()
            try:
                inner = self._parse_expression()
            finally:
                self._leave()
            self._expect_rparen()
            return inner
        if token.kind == "name":
            self._next()
            name = token.text.lower()
            following = self._peek()
            if following is not None and following.kind == "lparen":
                if name not in FUNCTIONS:
                    raise ExpressionSyntaxError(
                        f"未知函数 {token.text!r}：只允许 {', '.join(sorted(FUNCTIONS))}"
                    )
                self._next()
                self._enter()
                try:
                    argument = self._parse_expression()
                finally:
                    self._leave()
                self._expect_rparen()
                return self._node("call", name=name, left=argument)
            if name in FUNCTIONS:
                raise ExpressionSyntaxError(f"函数 {token.text!r} 缺少括号参数")
            if name in CONSTANTS:
                return self._node("num", value=CONSTANTS[name])
            if self.variables is not None and name not in self.variables:
                raise ExpressionSyntaxError(f"未知符号 {token.text!r}：不在允许的变量白名单中")
            return self._node("var", name=name)
        raise ExpressionSyntaxError(f"意外的符号 {token.text!r}（位置 {self.position}）")

    def _expect_rparen(self) -> None:
        token = self._peek()
        if token is None or token.kind != "rparen":
            raise ExpressionSyntaxError("括号不匹配")
        self._next()


def _parse(source: str, *, variables: set[str] | None) -> _Node:
    return _Parser(_tokenize(source), variables).parse()


def _parse_safely(source: str, *, variables: set[str] | None) -> _Node:
    """``_parse`` plus a RecursionError safety net (the limits should prevent it)."""
    try:
        return _parse(source, variables=variables)
    except RecursionError:
        raise ExpressionLimitError(f"表达式嵌套过深（MAX_DEPTH={MAX_DEPTH}）") from None


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------
def _budget(seconds: float | None) -> float:
    """Clamp a requested wall-clock budget into ``[0, MAX_TIME_BUDGET_SECONDS]``."""
    if seconds is None:
        return DEFAULT_TIME_BUDGET_SECONDS
    try:
        value = float(seconds)
    except (TypeError, ValueError):
        return DEFAULT_TIME_BUDGET_SECONDS
    if not math.isfinite(value) or value <= 0.0:
        return 0.0
    return min(value, MAX_TIME_BUDGET_SECONDS)


class _Evaluator:
    """Evaluates ASTs with a step counter and a wall-clock deadline.

    One instance may serve several evaluations (every sample point of one
    comparison): the step counter and the deadline then bound the *whole*
    comparison rather than each point separately.
    """

    def __init__(self, budget: float, deadline: float, variables: dict[str, float] | None = None):
        self.variables = variables or {}
        self.budget = budget
        self.deadline = deadline
        self.steps = 0

    def run(self, node: _Node, variables: dict[str, float] | None = None) -> float:
        if variables is not None:
            self.variables = variables
        self._check_deadline()
        return self._eval(node)

    def _check_deadline(self) -> None:
        if time.perf_counter() >= self.deadline:
            raise ExpressionTimeout(
                f"表达式判分超时（时间预算 {self.budget * 1000:.1f} ms，"
                f"MAX_TIME_BUDGET_SECONDS={MAX_TIME_BUDGET_SECONDS}）"
            )

    def _tick(self) -> None:
        self.steps += 1
        if self.steps > MAX_EVAL_STEPS:
            raise ExpressionLimitError(f"表达式求值步数超过上限（MAX_EVAL_STEPS={MAX_EVAL_STEPS}）")
        if self.steps % _TIME_CHECK_INTERVAL == 0:
            self._check_deadline()

    def _finite(self, value: float) -> float:
        value = float(value)
        if not math.isfinite(value) or abs(value) > MAX_ABS_RESULT:
            raise ExpressionLimitError(f"数值超出允许范围（MAX_ABS_RESULT={MAX_ABS_RESULT:g}）")
        return value

    def _eval(self, node: _Node) -> float:
        self._tick()
        kind = node.kind
        if kind == "num":
            return self._finite(float(node.value))
        if kind == "var":
            try:
                value = float(self.variables[node.name])
            except (KeyError, TypeError, ValueError):
                raise ExpressionDomainError(f"变量 {node.name!r} 没有赋值") from None
            return self._finite(value)
        if kind == "neg":
            return self._finite(-self._eval(node.left))
        if kind == "call":
            function = FUNCTIONS[node.name]
            argument = self._eval(node.left)
            try:
                return self._finite(function(argument))
            except OverflowError:
                raise ExpressionLimitError(
                    f"{node.name} 的结果超出允许范围（MAX_ABS_RESULT={MAX_ABS_RESULT:g}）"
                ) from None
            except ValueError:
                raise ExpressionDomainError(f"{node.name}({argument:g}) 在实数域无定义") from None
        left = self._eval(node.left)
        right = self._eval(node.right)
        if node.op == "+":
            return self._finite(left + right)
        if node.op == "-":
            return self._finite(left - right)
        if node.op == "*":
            return self._finite(left * right)
        if node.op == "/":
            if right == 0.0:
                raise ExpressionDomainError("除数为零")
            return self._finite(left / right)
        # "^"
        if abs(right) > MAX_EXPONENT_MAGNITUDE:
            raise ExpressionLimitError(f"指数绝对值超过上限（MAX_EXPONENT_MAGNITUDE={MAX_EXPONENT_MAGNITUDE}）")
        try:
            result = math.pow(left, right)
        except OverflowError:
            raise ExpressionLimitError(
                f"幂运算结果超出允许范围（MAX_ABS_RESULT={MAX_ABS_RESULT:g}）"
            ) from None
        except ValueError:
            raise ExpressionDomainError("幂运算在实数域无定义（0 的负数次幂或负数的非整数次幂）") from None
        return self._finite(result)


def evaluate(
    expr: str,
    variables: dict[str, float] | None = None,
    *,
    time_budget: float = DEFAULT_TIME_BUDGET_SECONDS,
) -> float:
    """Evaluate ``expr`` with a strict white-list of names; returns a float.

    Raises a typed error and never performs any I/O:

    * :class:`ExpressionSyntaxError` — unknown/illegal token or unknown symbol;
    * :class:`ExpressionLimitError` — a named hard limit was hit;
    * :class:`ExpressionDomainError` — undefined at this point (``1/0``,
      ``sqrt(-1)``, a variable without a value …);
    * :class:`ExpressionTimeout` — the wall-clock budget ran out.
    """
    bindings: dict[str, float] = {}
    for key, value in (variables or {}).items():
        name = str(key).lower()
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ExpressionDomainError(f"变量 {key!r} 的值不是实数") from None
        if not math.isfinite(number):
            raise ExpressionDomainError(f"变量 {key!r} 的值不是有限实数")
        bindings[name] = number
    node = _parse_safely(expr, variables=set(bindings))
    budget = _budget(time_budget)
    try:
        return _Evaluator(budget, time.perf_counter() + budget, bindings).run(node)
    except RecursionError:
        raise ExpressionLimitError(f"表达式嵌套过深（MAX_DEPTH={MAX_DEPTH}）") from None


# ---------------------------------------------------------------------------
# Structural normalisation (whitelisted algebra only -- deliberately not a CAS)
# ---------------------------------------------------------------------------
def _is_total(node: _Node) -> bool:
    """True when the expression is defined for every real value of its symbols.

    ``_fold`` rewrites ``a / b`` into ``a * b^-1``, so there is no ``/`` node
    left to inspect: a negative literal exponent marks the same hole.
    """
    if node.kind in ("num", "var"):
        return True
    if node.kind == "neg":
        return _is_total(node.left)
    if node.kind == "call":
        return node.name not in _PARTIAL_FUNCTIONS and _is_total(node.left)
    if node.kind == "bin":
        if node.op == "^":
            exponent = node.right
            if exponent.kind != "num" or float(exponent.value) < 0 or not float(exponent.value).is_integer():
                return False
        return _is_total(node.left) and _is_total(node.right)
    return True


def _fold_binary(op: str, left: float, right: float) -> float | None:
    """Constant folding.  Returns ``None`` (leave it symbolic) on any refusal."""
    try:
        if op == "+":
            value = left + right
        elif op == "-":
            value = left - right
        elif op == "*":
            value = left * right
        elif op == "^":
            if abs(right) > MAX_EXPONENT_MAGNITUDE:
                return None
            value = math.pow(left, right)
        else:
            return None
    except (OverflowError, ValueError, ZeroDivisionError):
        return None
    if not math.isfinite(value) or abs(value) > MAX_ABS_RESULT:
        return None
    return value


def _fold(node: _Node) -> _Node:
    """Apply the whitelisted simplifications (constant folding + identities)."""
    if node.kind in ("num", "var"):
        return node
    if node.kind == "neg":
        operand = _fold(node.left)
        if operand.kind == "num":
            return _Node("num", value=-float(operand.value))
        if operand.kind == "neg":
            return operand.left
        return _Node("neg", left=operand)
    if node.kind == "call":
        return _Node("call", name=node.name, left=_fold(node.left))

    left = _fold(node.left)
    right = _fold(node.right)
    op = node.op
    if op == "/":
        # a / b -> a * b^-1: equal wherever it is defined, and it makes `x/2`
        # and `0.5x`, or `1/x` and `x^-1`, structurally identical.
        return _fold(
            _Node("bin", op="*", left=left, right=_Node("bin", op="^", left=right, right=_Node("num", value=-1.0)))
        )
    if op == "^":
        if right.kind == "num" and float(right.value) == 1.0:
            return left
        if right.kind == "num" and float(right.value) == 0.0 and _is_total(left):
            return _Node("num", value=1.0)
    if left.kind == "num" and right.kind == "num":
        folded = _fold_binary(op, float(left.value), float(right.value))
        if folded is not None:
            return _Node("num", value=folded)
    if op == "+":
        if left.kind == "num" and float(left.value) == 0.0:
            return right
        if right.kind == "num" and float(right.value) == 0.0:
            return left
    elif op == "-":
        if right.kind == "num" and float(right.value) == 0.0:
            return left
    elif op == "*":
        if left.kind == "num" and float(left.value) == 1.0:
            return right
        if right.kind == "num" and float(right.value) == 1.0:
            return left
        # `x * 0 -> 0` is only sound when the other factor always exists.
        if left.kind == "num" and float(left.value) == 0.0 and _is_total(right):
            return _Node("num", value=0.0)
        if right.kind == "num" and float(right.value) == 0.0 and _is_total(left):
            return _Node("num", value=0.0)
    return _Node("bin", op=op, left=left, right=right)


def _collect_variables(node: _Node, names: dict[str, str]) -> dict[str, str]:
    """Rename symbols to ``v0``, ``v1`` … by first appearance (letter-agnostic)."""
    if node.kind == "var":
        if node.name not in names:
            names[node.name] = f"v{len(names)}"
    elif node.kind in ("neg", "call"):
        _collect_variables(node.left, names)
    elif node.kind == "bin":
        _collect_variables(node.left, names)
        _collect_variables(node.right, names)
    return names


def _number_text(value: float) -> str:
    return repr(float(value))


def _render(node: _Node, names: dict[str, str]) -> str:
    if node.kind == "num":
        return _number_text(float(node.value))
    if node.kind == "var":
        return names[node.name]
    if node.kind == "neg":
        if node.left.kind == "num":
            return _number_text(-float(node.left.value))
        return _sum_text(_negated_terms(node.left, names))
    if node.kind == "call":
        return f"({node.name} {_render(node.left, names)})"
    op = node.op
    if op in ("+", "-"):
        return _sum_text(_sum_terms(node, names))
    if op == "*":
        return _product_text(_product_terms(node, names))
    return f"(^ {_render(node.left, names)} {_render(node.right, names)})"


def _sum_terms(node: _Node, names: dict[str, str]) -> list[str]:
    if node.kind == "neg":
        return _negated_terms(node.left, names)
    if node.kind == "bin" and node.op == "+":
        return _sum_terms(node.left, names) + _sum_terms(node.right, names)
    if node.kind == "bin" and node.op == "-":
        return _sum_terms(node.left, names) + _negated_terms(node.right, names)
    if node.kind == "num" and float(node.value) == 0.0:
        return []
    return [_render(node, names)]


def _negated_terms(node: _Node, names: dict[str, str]) -> list[str]:
    if node.kind == "neg":
        return _sum_terms(node.left, names)
    if node.kind == "bin" and node.op == "+":
        return _negated_terms(node.left, names) + _negated_terms(node.right, names)
    if node.kind == "bin" and node.op == "-":
        return _negated_terms(node.left, names) + _sum_terms(node.right, names)
    if node.kind == "num":
        value = -float(node.value)
        return [] if value == 0.0 else [_number_text(value)]
    return [f"(neg {_render(node, names)})"]


def _sum_text(terms: list[str]) -> str:
    terms = [term for term in terms if term]
    if not terms:
        return _number_text(0.0)
    if len(terms) == 1:
        return terms[0]
    # Sorting makes `x + 2` and `2 + x` the same canonical form.
    return "(+ " + " ".join(sorted(terms)) + ")"


def _product_terms(node: _Node, names: dict[str, str]) -> list[str]:
    if node.kind == "bin" and node.op == "*":
        return _product_terms(node.left, names) + _product_terms(node.right, names)
    if node.kind == "num" and float(node.value) == 1.0:
        return []
    return [_render(node, names)]


def _product_text(terms: list[str]) -> str:
    terms = [term for term in terms if term]
    if not terms:
        return _number_text(1.0)
    if len(terms) == 1:
        return terms[0]
    return "(* " + " ".join(sorted(terms)) + ")"


def normalize_expression(expr: str) -> str:
    """Canonical form used for the structural fast path (and for debugging)."""
    folded = _fold(_parse_safely(expr, variables=None))
    return _render(folded, _collect_variables(folded, {}))


def free_variables(expr: str) -> tuple[str, ...]:
    """Symbols in ``expr`` that are not whitelisted functions/constants."""
    folded = _fold(_parse_safely(expr, variables=None))
    return tuple(sorted(_collect_variables(folded, {})))


# ---------------------------------------------------------------------------
# Deterministic sampling
# ---------------------------------------------------------------------------
#: Fixed sample points; 0 and negative values are included on purpose so that a
#: domain hole (`1/x`, `sqrt(x-5)`) is discovered instead of being assumed away.
_SAMPLE_POINTS = (
    -2.0,
    -1.5,
    -1.0,
    -0.5,
    -0.25,
    0.0,
    0.25,
    0.5,
    0.75,
    1.0,
    1.5,
    2.0,
    3.0,
    4.0,
    5.0,
    10.0,
)


def _seeded_values(count: int, seed: int = SAMPLE_SEED) -> list[float]:
    """Deterministic pseudo-random points from a fixed seed (no ``random``)."""
    state = seed & 0x7FFFFFFF
    values: list[float] = []
    for _ in range(max(0, count)):
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        values.append(round(-3.0 + (state / 0x7FFFFFFF) * 13.0, 6))
    return values


def _sample_values() -> list[float]:
    fixed = list(_SAMPLE_POINTS)
    return (fixed + _seeded_values(MAX_SAMPLES - len(fixed)))[:MAX_SAMPLES]


def _default_rows(variable_count: int) -> list[dict[str, float]]:
    if variable_count <= 0:
        return [{}]
    values = _sample_values()
    if variable_count == 1:
        return [{"v0": value} for value in values]
    return [
        {"v0": values[index], "v1": values[(index * 5 + 3) % len(values)]} for index in range(len(values))
    ]


def _sample_rows(variable_count: int, samples) -> list[dict[str, float]]:
    if samples is None:
        return _default_rows(variable_count)
    if isinstance(samples, (str, bytes)) or not hasattr(samples, "__iter__"):
        raise ExpressionLimitError("采样点必须是数值序列")
    wanted = max(1, variable_count)
    rows: list[dict[str, float]] = []
    for item in samples:
        if len(rows) >= MAX_SAMPLES:
            raise ExpressionLimitError(f"采样点数量超过上限（MAX_SAMPLES={MAX_SAMPLES}）")
        try:
            if isinstance(item, dict):
                row = {str(key): float(value) for key, value in item.items()}
            elif hasattr(item, "__iter__") and not isinstance(item, (str, bytes)):
                row = {f"v{index}": float(value) for index, value in enumerate(item)}
            elif wanted == 1 and not isinstance(item, bool):
                row = {"v0": float(item)}
            else:
                raise ExpressionLimitError(f"采样点格式无效：{wanted} 个变量需要 (v0, v1) 形式的采样点")
        except (TypeError, ValueError):
            raise ExpressionLimitError("采样点必须是实数") from None
        missing = [f"v{index}" for index in range(wanted) if f"v{index}" not in row]
        if missing:
            raise ExpressionLimitError(f"采样点缺少变量 {', '.join(missing)}")
        rows.append(row)
    return rows


def _close(left: float, right: float, tolerance: float) -> bool:
    """Relative tolerance with an absolute floor, so near-zero values behave."""
    return abs(left - right) <= tolerance * max(abs(left), abs(right), 1.0)


def _unknown(exc: ExpressionError, *, samples_checked: int = 0, sample: dict[str, float] | None = None) -> ExpressionVerdict:
    return ExpressionVerdict(
        outcome=OUTCOME_UNKNOWN,
        reason=str(exc),
        error_type=exc.code,
        samples_checked=samples_checked,
        sample=sample,
    )


def _timeout_verdict(budget: float, *, samples_checked: int = 0) -> ExpressionVerdict:
    return _unknown(
        ExpressionTimeout(
            f"表达式判分超时（时间预算 {budget * 1000:.1f} ms，MAX_TIME_BUDGET_SECONDS={MAX_TIME_BUDGET_SECONDS}）"
        ),
        samples_checked=samples_checked,
    )


def compare_expressions(
    left: str,
    right: str,
    *,
    samples=None,
    tolerance: float = DEFAULT_TOLERANCE,
    time_budget: float = DEFAULT_TIME_BUDGET_SECONDS,
) -> ExpressionVerdict:
    """Decide whether two formulas are the same function, or that it is unknown.

    Structural normalisation runs first, then deterministic sampling.  The
    result is ``equivalent`` only when **every** sample point evaluates and
    agrees; a syntax error, an unknown symbol, a limit or a timeout at any point
    yields ``unknown`` (the caller must send it to a human, never mark it wrong).
    """
    budget = _budget(time_budget)
    try:
        tolerance = abs(float(tolerance))
    except (TypeError, ValueError):
        tolerance = DEFAULT_TOLERANCE
    deadline = time.perf_counter() + budget
    if time.perf_counter() >= deadline:
        return _timeout_verdict(budget)
    try:
        left_node = _fold(_parse_safely(left, variables=None))
        right_node = _fold(_parse_safely(right, variables=None))
    except ExpressionError as exc:
        return _unknown(exc)
    except RecursionError:
        return _unknown(ExpressionLimitError(f"表达式嵌套过深（MAX_DEPTH={MAX_DEPTH}）"))

    left_names = _collect_variables(left_node, {})
    right_names = _collect_variables(right_node, {})
    # Parsing already used part of the budget: never report "equivalent" after it
    # ran out, not even through the structural fast path.
    if time.perf_counter() >= deadline:
        return _timeout_verdict(budget)
    if (
        _render(left_node, left_names) == _render(right_node, right_names)
        and _is_total(left_node)
        and _is_total(right_node)
    ):
        return ExpressionVerdict(
            outcome=OUTCOME_EQUIVALENT,
            reason="结构规范化后完全一致",
            samples_checked=0,
        )

    variable_count = max(len(left_names), len(right_names))
    if variable_count > MAX_VARIABLES:
        return _unknown(
            ExpressionLimitError(f"表达式变量数超过上限（MAX_VARIABLES={MAX_VARIABLES}）")
        )
    try:
        rows = _sample_rows(variable_count, samples)
    except ExpressionError as exc:
        return _unknown(exc)
    if not rows:
        return _unknown(ExpressionLimitError("没有可用的采样点，无法判定等价"))

    checked = 0
    evaluator = _Evaluator(budget, deadline)
    for row in rows:
        if time.perf_counter() >= deadline:
            return _timeout_verdict(budget, samples_checked=checked)
        left_bindings = {name: row[canonical] for name, canonical in left_names.items()}
        right_bindings = {name: row[canonical] for name, canonical in right_names.items()}
        try:
            left_value = evaluator.run(left_node, left_bindings)
            right_value = evaluator.run(right_node, right_bindings)
        except ExpressionError as exc:
            return _unknown(exc, samples_checked=checked, sample=dict(row))
        checked += 1
        if not _close(left_value, right_value, tolerance):
            return ExpressionVerdict(
                outcome=OUTCOME_NOT_EQUIVALENT,
                reason="在采样点上取值不同",
                samples_checked=checked,
                sample=dict(row),
            )
    # Every point agreed, but the budget must still hold at the moment the
    # "equivalent" verdict is issued.
    if time.perf_counter() >= deadline:
        return _timeout_verdict(budget, samples_checked=checked)
    return ExpressionVerdict(
        outcome=OUTCOME_EQUIVALENT,
        reason="全部采样点取值一致",
        samples_checked=checked,
    )


def expressions_equivalent(
    left: str,
    right: str,
    *,
    samples=None,
    tolerance: float = DEFAULT_TOLERANCE,
    time_budget: float = DEFAULT_TIME_BUDGET_SECONDS,
) -> bool | None:
    """``True`` / ``False`` / ``None`` (unknown -> send to human review)."""
    verdict = compare_expressions(
        left, right, samples=samples, tolerance=tolerance, time_budget=time_budget
    )
    if verdict.outcome == OUTCOME_EQUIVALENT:
        return True
    if verdict.outcome == OUTCOME_NOT_EQUIVALENT:
        return False
    return None
