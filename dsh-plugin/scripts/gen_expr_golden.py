"""Golden vectors for backend/domain/grading/expressions.py -> tests/golden/expressions.json.

Timing-dependent behaviour (time_budget) is deliberately NOT part of the vectors: those cases are
asserted by property tests in the Node suite. Everything else must be bit-identical.
"""
import json, math, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from domain.grading import expressions as E  # noqa: E402

BUDGET = 2.0  # generous so wall-clock never decides a vector

def num(x):
    if isinstance(x, float) and math.isnan(x): return {"$": "nan"}
    if isinstance(x, float) and math.isinf(x): return {"$": "inf" if x > 0 else "-inf"}
    return x

PAIRS = [
 ("x^2+2x+1","(x+1)^2"),("sin(x)^2+cos(x)^2","1"),("x/2","0.5x"),("1/x","x^-1"),("x+2","2+x"),
 ("2x","x*2"),("(x+1)(x-1)","x^2-1"),("x^2","x^3"),("ln(exp(x))","x"),("sqrt(x^2)","abs(x)"),
 ("sqrt(x)","x^0.5"),("log(100)","2"),("pi","3.14159"),("e","exp(1)"),("-x^2","-(x^2)"),("2^3^2","512"),
 ("2^-1","0.5"),("x*0","0"),("0*sqrt(x)","0"),("x^0","1"),("1/x*x","1"),("x-x","0"),("a+b","b+a"),("a+b","x+y"),
 ("a*b","b*a"),("a+b+c","a+b+c"),("x^2+y^2","y^2+x^2"),("x+y","x-y"),("SIN(X)","sin(x)"),("tan(x)","sin(x)/cos(x)"),
 ("x^2","(-x)^2"),("2x+3","3+2x"),("1.5","3/2"),("1e3","1000"),(".5","0.5"),("0.1+0.2","0.3"),
 ("x/(x)","1"),("(x^2-1)/(x-1)","x+1"),("x","x+1e-12"),("x","x+1e-6"),("exp(x)*exp(-x)","1"),
 ("log(x)","ln(x)/ln(10)"),("sqrt(x-5)","sqrt(x-5)"),("abs(x)","x"),("2(x+1)","2x+2"),("x y","y x"),
 ("x(x+1)","x*x+x"),("1;2","1"),("x","__import__(x)"),("eval(x)","1"),("1.2.3","1"),("2 3","6"),("","1"),("x+","1"),
 ("(x","x"),("x)","x"),("foo(x)","x"),("sin","x"),("x^100","x^100"),("x^65","1"),("10^30","1e30"),("10^31","1e31"),
 ("1/0","1"),("sqrt(-1)","1"),("x^2+x^2+x^2","3x^2"),("a*b*c","c*b*a"),("x+y+z","z+y+x"),
 ("0","-0"),("--x","x"),("+x","x"),("-(-x)","x"),("x*1","x"),("1*x","x"),("x+0","x"),("0+x","x"),("x-0","x"),
 ("x^1","x"),("(x)","x"),("((x))","x"),("2*3","6"),("2^0.5*2^0.5","2"),("1e400","1"),("9"*50,"1"),
]
HOSTILE = ['__import__("os").system("touch /tmp/pwned")','open("/etc/passwd").read()',"(1).__class__.__bases__",'"a"*10',
 "lambda: 1","[x for x in ()]","x.__dict__","eval(x)","exec(x)","globals()","__import__(x)","os.system(x)","1;2","x if x else 1"]
LIMITS = ["1+"*100+"1","("*13+"x"+")"*13,"x"+"+x"*80,"+".join(["x"]*70),"x"*201,"1"+"+1"*81,"-"*20+"x","x^"*30+"x",
 "((((((((((((x))))))))))))","(((((((((((((x)))))))))))))"]

out = {"limits": {k: getattr(E, k) for k in ("MAX_INPUT_LENGTH","MAX_TOKENS","MAX_AST_NODES","MAX_DEPTH","MAX_EVAL_STEPS",
        "MAX_EXPONENT_MAGNITUDE","MAX_ABS_RESULT","MAX_VARIABLES","MAX_SAMPLES","DEFAULT_TOLERANCE","SAMPLE_SEED")},
       "compare": [], "normalize": [], "evaluate": [], "sampling": []}

for l, r in PAIRS + [(h, "1") for h in HOSTILE] + [(x, x) for x in LIMITS]:
    v = E.compare_expressions(l, r, time_budget=BUDGET)
    out["compare"].append({"left": l, "right": r, "verdict": v.as_dict(), "equivalent": E.expressions_equivalent(l, r, time_budget=BUDGET)})
for s in [p for pair in PAIRS for p in pair] + HOSTILE + LIMITS:
    try: n = E.normalize_expression(s); fv = list(E.free_variables(s)); e = None
    except E.ExpressionError as exc: n = None; fv = None; e = exc.code
    out["normalize"].append({"expr": s, "normalized": n, "free": fv, "error": e})
EVALS = [("x^2+2x+1",{"x":3}),("sin(pi/2)",{}),("sqrt(16)",{}),("log(1000)",{}),("ln(e)",{}),("2^0.5",{}),("1/3",{}),("x/y",{"x":1,"y":0}),
 ("x",{}),("x",{"X":2.5}),("x+y",{"x":1,"y":2}),("exp(100)",{}),("exp(10)",{}),("tan(pi/2)",{}),("(-8)^(1/3)",{}),("0^-1",{}),
 ("2^64",{}),("2^65",{}),("10^30",{}),("10^30*10",{}),("abs(-3)",{}),("-x^2",{"x":3}),("2^3^2",{}),("2x",{"x":4}),("2(3+4)",{}),
 ("x y",{"x":2,"y":5}),("1e30",{}),("1e31",{}),("sqrt(-4)",{}),("e^2",{}),("pi*2",{}),("SIN(0)",{}),("z",{"x":1})]
for ex, vs in EVALS:
    try: val = num(E.evaluate(ex, vs, time_budget=BUDGET)); err = None
    except E.ExpressionError as exc: val = None; err = {"code": exc.code}
    out["evaluate"].append({"expr": ex, "vars": vs, "value": val, "error": err})
out["sampling"] = {"fixed": list(E._SAMPLE_POINTS), "values": E._sample_values(), "seeded_8": E._seeded_values(8),
                   "rows1": E._default_rows(1), "rows2": E._default_rows(2)}
# custom samples
for l, r, smp in [("x","x",[1,2,3]),("x","2x",[0]),("x","2x",[1]),("x+y","y+x",[[1,2],[3,4]]),("x","x",[]),("x","x",list(range(25))),
                  ("x","x",[{"v0":1.0}]),("x+y","y+x",[1,2])]:
    v = E.compare_expressions(l, r, samples=smp, time_budget=BUDGET)
    out["compare"].append({"left": l, "right": r, "samples": smp, "verdict": v.as_dict(), "equivalent": E.expressions_equivalent(l, r, samples=smp, time_budget=BUDGET)})
print(json.dumps(out, indent=1, ensure_ascii=False))
