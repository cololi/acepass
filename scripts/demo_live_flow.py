"""Drive the real HTTP API to produce genuine runtime state.

Used for deployment/backup verification: it logs in like a real client, creates
sessions across both demo projects, submits every question type, uploads a real
PNG asset and reads the practice report. Everything it creates is demo-fixture
data, so nothing here is evidence about a real exam.
"""

from __future__ import annotations

import io
import json
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

BASE = "http://127.0.0.1:8000"
EMAIL = "e2e@acepass.local"
PASSWORD = "E2eBrowser!2026"


class Client:
    def __init__(self) -> None:
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = ""

    def request(self, method: str, path: str, body=None, *, key: str | None = None, raw: bytes | None = None, ctype: str = "application/json"):
        headers = {"Accept": "application/json"}
        if self.csrf:
            headers["X-CSRFToken"] = self.csrf
        if key:
            headers["Idempotency-Key"] = key
        data = None
        if raw is not None:
            data = raw
            headers["Content-Type"] = ctype
        elif body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
        try:
            with self.opener.open(request) as response:
                return response.status, _decode(response.read(), response.headers.get("Content-Type", ""))
        except urllib.error.HTTPError as exc:
            return exc.code, _decode(exc.read(), exc.headers.get("Content-Type", ""))

    def login(self) -> None:
        self.request("GET", "/api/v1/auth/csrf")
        for cookie in self.jar:
            if cookie.name == "csrftoken":
                self.csrf = cookie.value
        status, payload = self.request("POST", "/api/v1/auth/login", {"email": EMAIL, "password": PASSWORD})
        assert status == 200, payload
        for cookie in self.jar:
            if cookie.name == "csrftoken":
                self.csrf = cookie.value


def _decode(payload: bytes, content_type: str):
    """JSON bodies are parsed; binary downloads are reported by size only."""
    if not payload:
        return None
    if "json" in content_type:
        return json.loads(payload.decode("utf-8"))
    return {"bytes": len(payload), "content_type": content_type}


def png_bytes() -> bytes:
    """A real 2x2 PNG so the upload path validates actual image content."""
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), (200, 30, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


def main() -> int:
    client = Client()
    client.login()
    status, projects = client.request("GET", "/api/v1/projects")
    assert status == 200 and projects, projects
    project = projects[0]
    status, subjects = client.request("GET", f"/api/v1/projects/{project['id']}/subjects")
    subject = subjects[0]
    status, questions = client.request("GET", f"/api/v1/projects/{project['id']}/questions?limit=100&subject_id={subject['id']}")
    assert status == 200, questions

    by_type: dict[str, list[dict]] = {}
    for question in questions:
        by_type.setdefault(question["question_type"] or "", []).append(question)

    submitted = 0
    from PIL import Image  # noqa: F401  (import kept for the type checker)

    def fill_blank_answer(question: dict) -> dict:
        """Fill exactly the blanks this question defines (never invent blank ids)."""
        status, presentation = client.request(
            "GET", f"/api/v1/projects/{project['id']}/session-items/{question['_item_id']}/presentation"
        )
        assert status == 200, presentation
        blanks = {blank["blank_id"]: "10.1" for blank in presentation["stem"]["blanks"]}
        if "b1" in blanks:
            blanks["b1"] = "-2"
        return {"type": "fill_blank", "blanks": blanks}

    answers = {
        "single_choice": lambda _q: {"type": "single_choice", "selected_option_ids": ["opt_a"]},
        "multiple_choice": lambda _q: {"type": "multiple_choice", "selected_option_ids": ["opt_a", "opt_c"]},
        "true_false": lambda _q: {"type": "true_false", "value": False},
        "fill_blank": fill_blank_answer,
        "constructed_response": lambda _q: {
            "type": "constructed_response",
            "text": "运维校验脚本提交的作答过程。",
        },
    }
    for question_type, make_answer in answers.items():
        candidates = by_type.get(question_type) or []
        leaf = next((q for q in candidates if q["has_trusted_answer"]), None)
        if leaf is None:
            continue
        status, session = client.request(
            "POST",
            f"/api/v1/projects/{project['id']}/practice-sessions",
            {"mode": "practice", "subject_id": subject["id"], "question_ids": [leaf["id"]]},
            key=f"ops-session-{question_type}",
        )
        assert status == 201, session
        item_id = session["items"][0]["session_item_id"]
        client.request("GET", f"/api/v1/projects/{project['id']}/session-items/{item_id}/presentation")
        answer = make_answer({"id": leaf["id"], "_item_id": item_id})
        status, result = client.request(
            "POST",
            f"/api/v1/projects/{project['id']}/session-items/{item_id}/submit",
            {"answer": answer, "confidence": "sure"},
            key=f"ops-submit-{question_type}",
        )
        assert status == 200, result
        submitted += 1

    # A real image upload through the private storage adapter, then a download.
    boundary = "----acepassops"
    image = png_bytes()
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="role"\r\n\r\npast_paper_page\r\n'
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="ops-check.png"\r\n'
        "Content-Type: image/png\r\n\r\n"
    ).encode("utf-8") + image + f"\r\n--{boundary}--\r\n".encode("utf-8")
    status, asset = client.request(
        "POST",
        f"/api/v1/projects/{project['id']}/assets",
        raw=body,
        ctype=f"multipart/form-data; boundary={boundary}",
    )
    assert status == 201, asset
    status, _download = client.request("GET", f"/api/v1/projects/{project['id']}/assets/{asset['id']}")
    assert status == 200, "asset download failed"

    status, plan = client.request("POST", "/api/v1/study-plans/today/generate", {"refresh": False}, key="ops-plan")
    assert status == 200, plan
    status, report = client.request("GET", f"/api/v1/projects/{project['id']}/reports/practice")
    assert status == 200, report

    print(
        json.dumps(
            {
                "projects": len(projects),
                "submitted_types": submitted,
                "asset_id": asset["id"],
                "plan_tasks": len(plan["tasks"]),
                "report_attempts": sum(bucket["attempts"] for bucket in report["totals"].values()),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
