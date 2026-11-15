"""Golden vectors for domain/grading/adapters.py::grade(). Output = GradeResult.as_dict() plus
confirmed_fraction and rule_snapshot (the snapshot is persisted, so it must match too)."""
import json, random, sys, itertools
from decimal import Decimal as D
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test"); django.setup()
from domain.grading import adapters  # noqa: E402

rng = random.Random(777)
cases = []
def add(qt, raw, payload, max_score, rule=None, rubric=None):
    rule = {} if rule is None else rule
    r = adapters.grade(question_type=qt, raw_answer=raw, answer_payload=payload, max_score=D(max_score), rule=rule, rubric=rubric)
    d = r.as_dict(); d["rule_snapshot"] = r.rule_snapshot; d["confirmed_fraction"] = None if r.confirmed_fraction is None else str(r.confirmed_fraction)
    cases.append({"question_type": qt, "raw_answer": raw, "answer_payload": payload, "max_score": max_score, "rule": rule, "rubric": rubric, "expected": json.loads(json.dumps(d, default=str))})

# ---- single choice
for sel in [None, [], "opt_a", "opt_b", ["opt_a"], ["opt_a", "opt_b"], [1], [None], ""]:
    for rule in [{}, {"wrong_score": "-1", "blank_score": "0.5"}, {"wrong_score": "x"}]:
        for payload in [{"kind": "single_choice", "correct_option_id": "opt_a"}, {"kind": "single_choice"}, {}, {"correct_option_id": ""}]:
            raw = {} if sel is None else ({"selected_option_ids": sel} if isinstance(sel, list) else {"selected_option_id": sel})
            add("single_choice", raw, payload, "2.50", rule)
add("single_choice", "not a dict", {"correct_option_id": "a"}, "1")
add("single_choice", {"selected_option_ids": [], "selected_option_id": "opt_a"}, {"correct_option_id": "opt_a"}, "3")

# ---- multiple choice
CORR = ["opt_a", "opt_c"]
sels = [None, [], ["opt_a"], ["opt_c"], ["opt_a", "opt_c"], ["opt_c", "opt_a"], ["opt_a", "opt_b"], ["opt_b"], ["opt_a", "opt_a"], ["opt_a", "opt_c", "opt_d"], "opt_a", [1, 2], ["opt_a", "opt_c", "opt_c"]]
pols = [{}, {"policy": "partial_credit", "partial_score": "1.5"}, {"policy": "partial_credit"}, {"policy": "partial_credit", "partial_score": "99"}, {"policy": "exact_match", "partial_score": "1"},
        {"policy": "partial_credit", "partial_score": "0"}, {"policy": "partial_credit", "partial_score": ""}, {"wrong_score": "-0.5", "blank_score": "0.25"}, {"policy": "bogus"}]
for sel in sels:
    for p in pols:
        for rule in [{}, {"policy": "partial_credit", "partial_score": "1", "wrong_score": "-1"}]:
            raw = {} if sel is None else {"selected_option_ids": sel}
            add("multiple_choice", raw, {"kind": "multiple_choice", "correct_option_ids": CORR, **p}, "3.00", rule)
add("multiple_choice", {"selected_option_id": "opt_a"}, {"correct_option_ids": ["opt_a"]}, "2")
add("multiple_choice", {"selected_option_ids": ["a"]}, {"correct_option_ids": []}, "2")
add("multiple_choice", {"selected_option_ids": ["a"]}, {"correct_option_ids": None}, "2")
add("multiple_choice", {"selected_option_ids": ["b", "a"]}, {"correct_option_ids": ["c", "a", "b"], "policy": "partial_credit", "partial_score": "1"}, "5")

# ---- true / false
for sub in [None, True, False, "true", 1, 0, "", []]:
    for corr in [True, False, None, "true", 1]:
        for rule in [{}, {"wrong_score": "-1", "blank_score": "0.2"}]:
            raw = {} if sub is None else {"value": sub}
            add("true_false", raw, {"kind": "true_false", "value": corr}, "1.00", rule)
add("true_false", {"value": None}, {"value": True}, "1")

# ---- fill blank: text
def blank(**kw): return {"max_score": "2.00", **kw}
text_specs = [
  blank(accepted_values=["-2", "−2"]), blank(accepted_values=["Hello"], normalization={"case_insensitive": True}),
  blank(accepted_values=["a b"], normalization={"collapse_internal_spaces": True}), blank(accepted_values=["ABC"], normalization={"fullwidth_to_halfwidth": True}),
  blank(accepted_values=["ＡＢＣ"], normalization={"unicode_nfkc": True}), blank(accepted_values=["x"], normalization={"strip_whitespace": False}),
  blank(accepted_values=["straße"], normalization={"case_insensitive": True}), blank(accepted=["alias"]), blank(accepted_values=[]), blank(accepted_values=["ok"], mismatch_policy="wrong"),
  blank(accepted_values=["ok"], mismatch_policy="review"), blank(accepted_values=["ok"], mismatch_policy="weird"), {"accepted_values": ["no score key"]}, blank(accepted_values=[1, 2.5, None]),
  blank(accepted_values=["ok"], normalization={"delete_symbols": True, "case_insensitive": 1}),
]
subs = ["-2", "−2", " -2 ", "hello", "HELLO", "a   b", "ABC", "ＡＢＣ", "abc", "x", " x ", "STRASSE", "straße", "alias", "ok", "nope", "", "   ", None, 5, 2.5, True, "\u00a0ok\u00a0", "ok\u3000", "İ", "Σ"]
for spec in text_specs:
    for s in subs:
        for rule in [{}, {"mismatch_policy": "wrong"}]:
            add("fill_blank", {"blanks": {"b1": s}} if s is not None else {"blanks": {}}, {"kind": "fill_blank", "blanks": {"b1": spec}}, "2.00", rule)
# multi-blank, per-blank default split, missing, extra
add("fill_blank", {"blanks": {"b1": "1", "b2": "2", "b3": "3"}}, {"blanks": {"b1": {"accepted_values": ["1"]}, "b2": {"accepted_values": ["2"]}, "b3": {"accepted_values": ["9"], "mismatch_policy": "wrong"}}}, "10")
add("fill_blank", {"blanks": {"b1": "1"}}, {"blanks": {"b1": {"accepted_values": ["1"]}, "b2": {"accepted_values": ["2"]}}}, "3")
add("fill_blank", {"blanks": {"zzz": "1"}}, {"blanks": {"b1": {"accepted_values": ["1"]}}}, "1")
add("fill_blank", {"blanks": "x"}, {"blanks": {"b1": {"accepted_values": ["1"]}}}, "1")
add("fill_blank", {}, {"blanks": {}}, "1"); add("fill_blank", {}, {}, "1"); add("fill_blank", None, {"blanks": {"b1": {"accepted_values": ["1"]}}}, "1")
add("fill_blank", {"blanks": {"b1": "1", "b2": "1", "b3": "1"}}, {"blanks": {k: {"accepted_values": ["1"]} for k in ("b1", "b2", "b3")}}, "1")
add("fill_blank", {"blanks": {"b1": "1", "b2": "1", "b3": "1"}}, {"blanks": {k: {"accepted_values": ["1"]} for k in ("b1", "b2", "b3")}}, "10")
add("fill_blank", {"blanks": {"b1": "1", "b2": "1", "b3": "1", "b4": "1", "b5": "1", "b6": "1", "b7": "1"}}, {"blanks": {f"b{i}": {"accepted_values": ["1"]} for i in range(1, 8)}}, "100")

# ---- fill blank: numeric / units
num_specs = [
  {"numeric": {"value": "10", "abs_tol": "0.1"}}, {"numeric": {"value": "10", "rel_tol": "0.05"}}, {"numeric": {"value": "10", "abs_tol": "0.1", "rel_tol": "0.05"}},
  {"numeric": {"value": "10"}, "unit": {"expected": "m", "whitelist": {"m": "1", "cm": "0.01", "km": "1000"}}},
  {"numeric": {"value": "10", "unit_conversions": {"cm": "0.01", "m": "1"}, "expected_unit": "m"}},
  {"numeric": {"value": "10"}, "unit": {"expected": "m", "unit_optional": True, "whitelist": {"m": "1"}}},
  {"numeric": {"value": "10"}, "unit": {"expected": "m"}}, {"numeric": {"value": "10"}, "unit": {"whitelist": {"m": "1"}}}, {"numeric": {"value": "10"}},
  {"numeric": {"value": "abc"}}, {"numeric": {"value": None}}, {"numeric": {"value": "10"}, "unit": {"expected": "m", "whitelist": {"m": "1", "cm": "0"}}},
  {"numeric": {"value": "10"}, "unit": {"expected": "m", "whitelist": {"m": "0", "cm": "1"}}}, {"numeric": {"value": "1e2", "abs_tol": "1"}}, {"numeric": {"value": "0"}},
  {"numeric": {"value": "3.14159", "abs_tol": "0.001"}, "mismatch_policy": "wrong"}, {"numeric": {"value": "-5", "abs_tol": "x", "rel_tol": "y"}},
  {"numeric": {"value": "0.3"}, "mismatch_policy": "wrong"}, {"numeric": {"value": "1", "abs_tol": "1e-30"}},
]
num_subs = ["10", "10.0", "10.1", "10.2", "9.95", "10 m", "10m", "1000 cm", "1000cm", "10 km", "0.01 km", "10 kg", "10.5", "-5", "-5.0", "1/2", "10/1", "2x", "(1)", "abc", "", "1e1", "+10", ".5", "5.", "0.1+0.2", "0.3", "0.30", "10 米", "10,5", "1 000", "3.14", "3.1416", "1e400", "0", "-0", "10m2", "10 m ", " 10 ", "١٠", "10e", "1e+1 m", "100", "99.9", "1e2"]
for spec in num_specs:
    for s in num_subs:
        for rule in [{}, {"mismatch_policy": "wrong"}]:
            add("fill_blank", {"blanks": {"b1": s}}, {"blanks": {"b1": {"max_score": "1.50", **spec}}}, "1.50", rule)

# ---- fill blank: expression mode
expr_specs = [
  {"equivalence": "expression", "accepted_values": ["x^2+2x+1"]}, {"equivalence": "expression", "accepted_values": ["x^2+2x+1", "(x+1)^2"], "mismatch_policy": "wrong"},
  {"equivalence": "expression", "accepted": ["2x+2"]}, {"equivalence": "expression", "accepted_values": []}, {"equivalence": "expression"},
  {"equivalence": "expression", "accepted_values": ["sin(x)^2+cos(x)^2"], "mismatch_policy": "wrong"}, {"equivalence": "expression", "accepted_values": ["x+1"], "numeric": {"value": "1"}, "unit": {"expected": "m"}},
  {"equivalence": "expression", "accepted_values": ["x/2"], "expression_tolerance": "0.01", "mismatch_policy": "wrong"}, {"equivalence": "expression", "accepted_values": ["x"], "expression_tolerance": "abc"},
  {"equivalence": "expression", "accepted_values": ["x"], "expression_tolerance": 5, "mismatch_policy": "wrong"}, {"equivalence": "expression", "accepted_values": ["x"], "expression_time_budget_ms": 2000, "mismatch_policy": "wrong"},
  {"equivalence": "expression", "accepted_values": ["x"], "expression_time_budget_ms": "bad"}, {"equivalence": "symbolic", "accepted_values": ["x"]}, {"equivalence": "", "accepted_values": ["x"]},
  {"equivalence": "expression", "accepted_values": ["x^2"], "normalization": {"case_insensitive": True}}, {"equivalence": "expression", "accepted_values": ["1/x"], "mismatch_policy": "wrong"},
  {"equivalence": "expression", "accepted_values": ["sqrt(x)"], "mismatch_policy": "wrong"}, {"equivalence": "expression", "accepted_values": ["a*b"], "mismatch_policy": "wrong"},
]
expr_subs = ["x^2+2x+1", "(x+1)^2", "x^2 + 2x + 1", "x^2+2x", "2x+2", "2(x+1)", "t*2+2", "2t+2", "2x^2 m", "2x+2 m", "2x+2m", "x^2", "X^2", "(X+1)^2", "sin(x)^2+cos(x)^2", "1", "2", "x/2", "0.5x", "0.51x", "0.5000001x", "x", "y", "x+y", "1/x", "x^-1", "sqrt(x)", "x^0.5", "sqrt(x^2)", "a*b", "b*a", "a*c", "__import__('os')", "eval(x)", "1;2", "x^100", "2^65", "x/0", "", "x +", "((x)", "x^2 + 2*x + 1 ", "2 x", "x2", "e", "pi", "x*pi", "log(x)", "ln(x)", "foo(x)", "1e400", "x"*201, "+".join(["x"] * 70), "x^2+2x+1+0"]
for spec in expr_specs:
    for s in expr_subs:
        for rule in [{}, {"mismatch_policy": "wrong"}]:
            add("fill_blank", {"blanks": {"b1": s}}, {"blanks": {"b1": {"max_score": "3.00", **spec}}}, "3.00", rule)
add("fill_blank", {"blanks": {"b1": "x^2+2x+1", "b2": "7", "b3": "wrong"}}, {"blanks": {"b1": {"equivalence": "expression", "accepted_values": ["(x+1)^2"], "max_score": "3"}, "b2": {"numeric": {"value": "7"}, "max_score": "1"}, "b3": {"accepted_values": ["right"], "mismatch_policy": "wrong", "max_score": "1"}}}, "5")

# ---- constructed response
rub = {"criteria": [{"criterion_id": "c1", "text": "写出公式", "max_score": "2", "required": True}, {"criterion_id": "c2", "text": "代入", "max_score": "1.5"}, {"criterion_id": 3, "max_score": "bad"}, "junk", {"text": "no id", "max_score": "1"}]}
for rb in [rub, {}, {"criteria": []}, None, {"criteria": "x"}, {"criteria": [{"criterion_id": "only", "max_score": "5"}]}]:
    add("constructed_response", {"text": "answer"}, {"kind": "constructed_response", "rubric_required": True}, "5", {}, rb)

# ---- unsupported / material
add("material", {}, {}, "0"); add("essay", {}, {}, "1"); add("", {}, {}, "1")
print(json.dumps({"cases": cases}, ensure_ascii=False))
