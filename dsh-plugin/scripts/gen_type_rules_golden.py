"""Golden vectors for `apps.exams.services.core._validate_type_rules`.

This is a pure validator over the `question_type_rules` JSON, so it can be driven directly: every
expected outcome below is the real function's return value or the exact `InvalidInput` it raised.

The rules are the gate between "a user typed some scoring numbers" and "a published exam spec", so
the messages and their order are part of the contract the UI shows.
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

from apps.common.errors import InvalidInput  # noqa: E402
from apps.exams.services.core import _validate_type_rules  # noqa: E402

CASES = [
    {},
    {"single_choice": {}},
    {"single_choice": {"default_max_score": "2", "wrong_score": "-0.5"}},
    {"single_choice": None},
    {"bogus_type": {}},
    {"bogus_type": {"default_max_score": "2"}},
    {"single_choice": "not a dict"},
    {"single_choice": ["a"]},
    {"single_choice": {"default_max_score": "abc"}},
    {"single_choice": {"default_max_score": "2", "wrong_score": "nope"}},
    {"single_choice": {"default_max_score": "-1"}},
    {"single_choice": {"default_max_score": "2", "wrong_score": "-1.5"}},
    {"single_choice": {"default_max_score": "2", "partial_score": "3"}},
    {"single_choice": {"default_max_score": "2", "blank_score": "2"}},
    {"single_choice": {"default_max_score": "2", "blank_score": "2.0001"}},
    {"single_choice": {"default_max_score": "", "wrong_score": "1"}},
    {"single_choice": {"default_max_score": None, "wrong_score": None}},
    {"single_choice": {"default_max_score": 2, "wrong_score": 1}},
    {"multiple_choice": {"default_max_score": "3", "partial_score": "1.5", "wrong_score": "0"}},
    {"fill_blank": {"default_max_score": None, "wrong_score": "-1"}},
    {"constructed_response": {"default_max_score": "10", "partial_score": "10"}},
    {
        "single_choice": {"default_max_score": "2"},
        "multiple_choice": {"default_max_score": "3", "partial_score": "9"},
    },
    {"true_false": {"default_max_score": "1", "wrong_score": "0.5"}},
    {"material": {"default_max_score": "0"}},
]

# Non-dict payloads reach the same function through the `not isinstance(rules, dict)` guard.
RAW_CASES = ["not a dict", ["a"], None, 5]

cases = []
for rules in CASES:
    try:
        _validate_type_rules(rules)
        cases.append({"input": rules, "ok": True})
    except InvalidInput as error:
        cases.append({"input": rules, "ok": False, "message": error.message, "details": error.details})
    except Exception as error:  # noqa: BLE001 - record anything unexpected instead of hiding it
        cases.append({"input": rules, "ok": False, "unexpected": f"{type(error).__name__}: {error}"})

for raw in RAW_CASES:
    try:
        _validate_type_rules(raw)
        cases.append({"raw_input": raw, "ok": True})
    except InvalidInput as error:
        cases.append({"raw_input": raw, "ok": False, "message": error.message, "details": error.details})
    except Exception as error:  # noqa: BLE001
        cases.append({"raw_input": raw, "ok": False, "unexpected": f"{type(error).__name__}: {error}"})

json.dump(
    {
        "source": "apps/exams/services/core.py::_validate_type_rules",
        "cases": cases,
    },
    sys.stdout,
    ensure_ascii=False,
    separators=(",", ":"),
)
sys.stdout.write("\n")
