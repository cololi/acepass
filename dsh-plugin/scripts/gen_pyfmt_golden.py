"""Golden vectors for `pyfmt.pyFormatFixed` — `format(x, '.<places>f')` as CPython prints it.

This is a *value* comparison, not a scenario comparison: a formatting bug only shows up on a few
numbers (the mantissa-mask bug turned `2.625` into `2.00` and everything else looked fine), so the
coverage has to be exhaustive rather than illustrative.

`repr(float)` is emitted so the Node side reconstructs the *identical* double — every Python float
repr round-trips exactly through `Number()`.
"""
import json
import math
import random
import sys

rng = random.Random(424242)

BOUNDARY = [
    0.0, -0.0, 1.0, -1.0, 0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5,
    1.005, 2.625, -0.005, 0.125, 0.375, 0.625, 0.875,
    1 / 3, 2 / 3, 1 / 7, 22 / 7, 1e-7, 1e-300, 5e-324, 1.7976931348623157e308,
    123456789.123456789, 0.1 + 0.2, 1e15, 1e16, 1e17, -1e15,
    2**53, 2**53 + 1, -(2**53), 0.00005, 0.000049999999999999996,
    float("inf"), float("-inf"), float("nan"),
]

PLACES = [0, 1, 2, 3, 6]


def random_float():
    kind = rng.randrange(6)
    if kind == 0:
        return rng.uniform(-1000, 1000)
    if kind == 1:
        return rng.uniform(-1, 1)
    if kind == 2:
        return rng.uniform(0, 1) * 10 ** rng.randint(-300, 300)
    if kind == 3:
        # values whose decimal expansion sits right on a rounding boundary
        return rng.randrange(-10**6, 10**6) / 1000 + rng.choice([0.0005, 0.0015, -0.0005, 0.0025])
    if kind == 4:
        return float(rng.randrange(-(2**31), 2**31))
    return rng.uniform(-1e6, 1e6)


VALUES = BOUNDARY + [random_float() for _ in range(1600)]

cases = []
for value in VALUES:
    text = repr(value)
    for places in PLACES:
        cases.append({"value": text, "places": places, "expected": format(value, f".{places}f")})

json.dump(
    {
        "source": "CPython format(float, '.<places>f') — exact binary value, round-half-even",
        "note": "usage is the delayed-verification reason string; a wrong digit silently changes stored reasons",
        "cases": cases,
    },
    sys.stdout,
    ensure_ascii=False,
    separators=(",", ":"),
)
sys.stdout.write("\n")
