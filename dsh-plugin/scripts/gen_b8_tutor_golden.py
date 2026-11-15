#!/usr/bin/env python
"""Extract the B8 serialization golden from the real Django probe.

The probe (`scripts/probe_b8_tutor.py` → `docs/dsh-migration/17-b8-tutor-probe.json`) records the
wire shape each endpoint really returns. This generator keeps only what a port must not drift on —
the **field set** of every projection, plus the few literals that carry meaning (the `provider_status`
message, `p0_capabilities`) — so `tests/b8_tutor_http.test.ts` and `tests/b8_practice_ai_http.test.ts`
can compare the Node serializers field by field instead of by review.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/gen_b8_tutor_golden.py

Re-running is byte-identical: the source JSON is deterministic and the output is sorted.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / "docs" / "dsh-migration" / "17-b8-tutor-probe.json"
OUT = ROOT / "dsh-plugin" / "tests" / "golden" / "b8_tutor.json"


def main() -> int:
    payload = json.loads(PROBE.read_text(encoding="utf-8"))
    by_case = {case["case"]: case for case in payload["cases"]}

    def response(case_id: str):
        return by_case[case_id]["response"]

    def keys(value) -> list[str]:
        return sorted(value.keys()) if isinstance(value, dict) else []

    def first(rows) -> dict:
        return rows[0] if isinstance(rows, list) and rows else {}

    segments = response("T13")
    transcript_segments = segments.get("segments") or []
    estimate = response("P11")
    diagnosis = response("P13")
    follow_up_questions = diagnosis.get("follow_up_questions") or []
    stream = response("T10")
    stream_data = stream.get("data") or []

    golden = {
        "source": "docs/dsh-migration/17-b8-tutor-probe.json (real Django, config.settings.test)",
        "generated_by": "dsh-plugin/scripts/gen_b8_tutor_golden.py",
        "projections": {
            # `provider_status()` + the two settings the UI shows.
            "ai_status": {
                "keys": keys(response("A01")),
                "provider": response("A01").get("provider"),
                "configured": response("A01").get("configured"),
                "is_stub": response("A01").get("is_stub"),
                "capabilities": response("A01").get("capabilities"),
                "p0_capabilities": response("A01").get("p0_capabilities"),
                "message": response("A01").get("message"),
                "max_retries": response("A01").get("max_retries"),
                "total_timeout_seconds": response("A01").get("total_timeout_seconds"),
            },
            # `TutorJobOut` — the POST answer and the GET read are the same projection.
            "tutor_job": {
                "keys": keys(response("T06")),
                "read_keys": keys(response("T08")),
                "unavailable": {
                    "status": response("T06").get("status"),
                    "error_code": response("T06").get("error_code"),
                    "is_stub": response("T06").get("is_stub"),
                    "segment_count": response("T06").get("segment_count"),
                    "result_blocks": response("T06").get("result_blocks"),
                },
            },
            "tutor_session": {"keys": keys(response("T01"))},
            "tutor_segments": {
                "keys": keys(segments),
                "segment_keys": keys(first(transcript_segments)),
                "unavailable": {
                    "keys": keys(response("T09")),
                    "segment_count": response("T09").get("segment_count"),
                    "is_stale": response("T09").get("is_stale"),
                },
            },
            "tutor_stream": {
                "status_keys": keys(stream_data[0]) if stream_data else [],
                "segment_keys": keys(next((row for row in stream_data if "index" in row), {})),
                "done_keys": keys(stream_data[-1]) if stream_data else [],
                "events": stream.get("events"),
                # An unavailable job streams status + done and no content at all.
                "unavailable_events": stream.get("events"),
            },
            "ai_run": {"keys": keys(first(response("A06")))},
            "transcription_list": {"keys": keys(response("P01"))},
            "transcription": {"keys": keys(response("P06"))},
            "estimate": {
                "keys": keys(estimate),
                "criteria_keys": keys(first(estimate.get("criteria") or [])),
                "state_keys": keys(response("P09")),
                "empty_state_keys": keys(response("P09")),
            },
            "diagnosis": {
                "keys": keys(diagnosis),
                "cause_keys": keys(first(diagnosis.get("causes") or [])),
                "follow_up_keys": keys(first(follow_up_questions)),
            },
            "diagnosis_follow_up": {"keys": keys(response("P14"))},
            "error_envelope": {"keys": sorted(response("P03").get("error", {}).keys())},
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(golden, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
