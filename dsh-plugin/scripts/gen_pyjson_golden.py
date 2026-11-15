"""Golden vectors for the idempotency fingerprint.

`fingerprint()` hashes `json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str,
separators=(",", ":"))`. A stored record carries that digest, so after the data migration a retried
request must produce the *same* digest in Node or it turns an idempotent replay into a 409.

The payload travels as raw JSON **text** so the Node side can tell `1` from `1.0`: Python's
`json.loads` keeps the distinction (`int` vs `float`) and `json.dumps` writes them differently, and
a plain `JSON.parse` would collapse both to one JS number.
"""
import hashlib
import json
import sys
from decimal import Decimal

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "backend"))
import os  # noqa: E402

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")
import django  # noqa: E402

django.setup()

from apps.audit.services.idempotency import fingerprint  # noqa: E402

# The raw text is what both sides parse; keep it ASCII-safe JSON so the two parsers agree on the
# input before canonicalisation is even exercised.
PAYLOADS = [
    "{}",
    "[]",
    '{"b":1,"a":2}',
    '{"a":1.0,"b":1}',
    '{"score":0.1,"bonus":0.2}',
    '{"x":1e300,"y":1e-7,"z":-0.0}',
    '{"n":123456789012345678901234567890}',
    '{"f":3.141592653589793}',
    '{"name":"中文","emoji":"📚","tab":"a\\tb","newline":"a\\nb","quote":"a\\"b","backslash":"a\\\\b"}',
    '{"empty":"","null":null,"true":true,"false":false}',
    '{"nested":{"z":[1,2,{"y":[]}],"a":{}}}',
    '{"ids":["b","a","c"],"order_matters":[3,1,2]}',
    '{"deep":{"a":{"b":{"c":{"d":{"e":1}}}}}}',
    '{"unicode_escape":"\\u00e9\\u4e2d"}',
    '{"long":"' + "x" * 500 + '"}',
    '{"control":"\\u0001\\u001f\\u007f"}',
    '{"mixed":[1,"1",1.0,true,null,{"k":false}]}',
    '{"n":-9223372036854775808}',
    '{"n":9223372036854775807}',
    '{"price":"12.50","qty":2}',
]

# Values that only exist on the Python side go through `default=str`.
PYTHON_ONLY = [
    {"amount": Decimal("12.50")},
    {"amount": Decimal("0.0001")},
    {"when": __import__("datetime").datetime(2026, 1, 1, 12, 0, 0, 500)},
    {"uid": __import__("uuid").UUID("0b6f5f0a-1f0e-4c4a-9a3e-1234567890ab")},
]


def canonical(payload) -> str:
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str, separators=(",", ":"))


cases = []
for text in PAYLOADS:
    payload = json.loads(text)
    cases.append(
        {
            "json": text,
            "canonical": canonical(payload),
            "sha256": fingerprint(payload),
        }
    )

for payload in PYTHON_ONLY:
    cases.append(
        {
            # `python_only` marks payloads whose construction cannot be expressed in JSON; the Node
            # side receives the already-stringified scalar it must reproduce.
            "python_only": {key: str(value) for key, value in payload.items()},
            "canonical": canonical(payload),
            "sha256": fingerprint(payload),
        }
    )

json.dump(
    {
        "note": "canonical = json.dumps(sort_keys=True, ensure_ascii=False, default=str, separators=(',',':'))",
        "cases": cases,
    },
    sys.stdout,
    ensure_ascii=False,
    indent=1,
)
sys.stdout.write("\n")
