#!/usr/bin/env python
"""Empirical probe for B8: the knowledge domain, the pairing chain and tag suggestions.

Everything runs against the **real** Django services and the real Ninja router on a throw-away
PostgreSQL test database (``test_acepass_b8_knowledge``):

* HTTP: question templates, verification pairings (create / replay / idempotency conflict / detail),
  the knowledge map, the prerequisite graph (including the cycle refusal), node prerequisites, and
  tag suggestions (no model → 503; a scripted test double → inert proposals only).
* Service: `apps.learning.services.pairing.on_attempt_graded` driven by real sessions and attempts,
  so the recorded task fields are what Django itself produced.

The scripted provider is a **test double**, not a shipped stub: `is_stub=True` is recorded so no
report can mistake it for a real model, and the no-model case is recorded separately.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/probe_b8_knowledge.py

Writes ``docs/dsh-migration/17-b8-knowledge-probe.json`` only.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test import Client, override_settings  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402
from django.utils import timezone  # noqa: E402

import ai.providers.base as providers  # noqa: E402
from apps.audit.models import IdempotencyRecord, LLMRun  # noqa: E402
from apps.exams.models import ExamProject, ExamSpecVersion, Subject, SyllabusVersion  # noqa: E402
from apps.knowledge.models import (  # noqa: E402
    KnowledgeNode,
    KnowledgeRelation,
    QuestionTemplate,
    TagSuggestion,
    VerificationPairing,
)
from apps.knowledge.services import core as knowledge_core  # noqa: E402
from apps.learning.models import ReviewTask, StudyTask  # noqa: E402
from apps.learning.services import pairing as pairing_service  # noqa: E402
from apps.practice.models import Attempt, SessionItem  # noqa: E402
from apps.practice.services import attempts as attempt_services  # noqa: E402
from apps.practice.services import sessions as session_services  # noqa: E402
from apps.knowledge.models import QuestionKnowledge  # noqa: E402
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion  # noqa: E402
from apps.common.content import content_digest  # noqa: E402

OUT_JSON = ROOT / "docs" / "dsh-migration" / "17-b8-knowledge-probe.json"
TEST_DB_NAME = "test_acepass_b8_knowledge"
connection.settings_dict["TEST"] = {**connection.settings_dict.get("TEST", {}), "NAME": TEST_DB_NAME}

UNSET = object()
CASES: list[dict] = []
#: The *unscrubbed* payload of each case, so a follow-up request can reuse a real identifier.
RAW: dict[str, object] = {}
SYMBOLS: dict[str, str] = {}
AUTO_NAMES: dict[str, str] = {}
CLIENT = Client()
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
REF_RE = re.compile(r"REF_\d{3}")
TIME_KEYS = {
    "created_at",
    "updated_at",
    "reviewed_at",
    "decided_at",
    "generated_at",
    "as_of",
    "not_before",
    "due_at",
    "delay_anchor_at",
    "submitted_at",
    "started_at",
    "finished_at",
    "published_at",
    "checked_at",
}


# ---------------------------------------------------------------------------
# recording helpers
# ---------------------------------------------------------------------------
def _auto_name(value: str) -> str:
    name = SYMBOLS.get(value)
    if name is None:
        name = f"REF_{len(SYMBOLS):03d}"
        AUTO_NAMES[name] = value
        SYMBOLS[value] = name
    return name


def reg(name: str, value) -> str:
    text = str(getattr(value, "id", value))
    SYMBOLS[text] = name
    return text


def sym(value) -> str | None:
    return None if value is None else _auto_name(str(value))


def symbolize_text(text: str) -> str:
    return UUID_RE.sub(lambda match: _auto_name(match.group(0)), text)


def scrub(value, key: str | None = None):
    if isinstance(value, dict):
        return {name: scrub(item, name) for name, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [scrub(item, key) for item in value]
    if isinstance(value, str):
        if key in TIME_KEYS:
            return "<now>"
        return symbolize_text(value)
    return value


def record(case_id: str, op: str, title: str, *, request: dict, status, payload, before: dict, after: dict) -> dict:
    entry = {
        "case": case_id,
        "op": op,
        "title": title,
        "request": scrub(request),
        "status": status,
        "response": scrub(payload),
        "row_delta": {name: after[name] - before[name] for name in before if after[name] != before[name]},
    }
    if isinstance(payload, dict) and "error" in payload:
        entry["error_envelope"] = scrub(payload["error"])
    CASES.append(entry)
    RAW[case_id] = payload
    return entry


def call(case_id: str, op: str, title: str, method: str, path: str, *, json_body=UNSET, key=UNSET) -> dict:
    headers = {}
    if key is not UNSET:
        headers["HTTP_IDEMPOTENCY_KEY"] = key
    before = db_counts()
    if json_body is not UNSET:
        response = getattr(CLIENT, method)(
            path, data=json.dumps(json_body, ensure_ascii=False), content_type="application/json", **headers
        )
    else:
        response = getattr(CLIENT, method)(path, **headers)
    after = db_counts()
    payload = json.loads(response.content.decode("utf-8")) if response.content else None
    return record(
        case_id,
        op,
        title,
        request={
            "method": method.upper(),
            "path": path,
            "json_body": None if json_body is UNSET else json_body,
            "idempotency_key": None if key is UNSET else key,
        },
        status=response.status_code,
        payload=payload,
        before=before,
        after=after,
    )


def db_counts() -> dict:
    return {
        "audit_idempotency_record": IdempotencyRecord.objects.count(),
        "audit_llm_run": LLMRun.objects.count(),
        "knowledge_node": KnowledgeNode.objects.count(),
        "knowledge_question_template": QuestionTemplate.objects.count(),
        "knowledge_verification_pairing": VerificationPairing.objects.count(),
        "knowledge_relation": KnowledgeRelation.objects.count(),
        "knowledge_tag_suggestion": TagSuggestion.objects.count(),
        "knowledge_question_mapping": QuestionKnowledge.objects.count(),
        "learning_study_task": StudyTask.objects.count(),
        "learning_review_task": ReviewTask.objects.count(),
        "practice_attempt": Attempt.objects.count(),
    }


def task_row(task: StudyTask) -> dict:
    return {
        "id": sym(task.id),
        "task_kind": task.task_kind,
        "status": task.status,
        "question_id": sym(task.question_id),
        "knowledge_node_id": sym(task.knowledge_node_id),
        "pairing_version": task.pairing_version,
        "origin_session_item_id": sym(task.origin_session_item_id),
        "trigger_event": task.trigger_event,
        "delay_anchor_at": None if task.delay_anchor_at is None else "<now>",
        "not_before": None if task.not_before is None else "<now>",
        "due_at": None if task.due_at is None else "<now>",
        "estimated_minutes": task.estimated_minutes,
        "reason_codes": task.reason_codes,
        "rule_version": task.rule_version,
        "deficit_notice": task.deficit_notice,
        "invalidated_reason": task.invalidated_reason,
    }


def interval_status(status: dict) -> dict:
    return {
        "required": status["required"],
        "satisfied": status["satisfied"],
        "reason": scrub(status.get("reason", "")),
        "anchor_source": status.get("anchor_source"),
        "has_not_before": status.get("not_before") is not None,
    }


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------
def make_question(subject, label: str, *, checked: bool = True, score: str = "2.00"):
    content = {
        "blocks": [{"kind": "text", "text": f"探针题 {label}：3 + 4 等于多少？"}],
        "options": [
            {"id": "opt_a", "label": "A", "blocks": [{"kind": "text", "text": "7"}]},
            {"id": "opt_b", "label": "B", "blocks": [{"kind": "text", "text": "8"}]},
        ],
    }
    question = Question.objects.create(subject=subject, origin_type="user_authored", display_label=label)
    version = QuestionVersion.objects.create(
        question=question,
        version=1,
        question_type="single_choice",
        content=content,
        status="published",
        content_digest=content_digest(content),
        practice_max_score=score,
        estimated_seconds=60,
        revision_reason="probe",
        source_note="",
    )
    answer = AnswerKeyVersion.objects.create(
        question_version=version,
        version=1,
        answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
        source_type="user",
        verification_status="checked",
        is_disputed=not checked,
        check_basis="探针",
    )
    question.current_published_version = version
    question.save(update_fields=["current_published_version", "updated_at"])
    return question, version, answer


def answer_for(version: QuestionVersion) -> dict:
    payload = version.answer_keys.filter(is_disputed=False).first().answer_payload
    return {"type": "single_choice", "selected_option_ids": [payload["correct_option_id"]]}


class ScriptedProvider(providers.BaseProvider):
    """A deterministic test double (never shipped); `is_stub=True` is recorded in the audit row."""

    name = "probe-scripted"
    capabilities = ("suggest_tags",)
    is_stub = True

    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.calls = 0

    def call(self, request: providers.AiRequest) -> providers.AiCallResult:
        self.calls += 1
        return providers.AiCallResult(
            payload=self.payload,
            raw_text=json.dumps(self.payload, ensure_ascii=False),
            prompt_tokens=11,
            completion_tokens=22,
            cost_cents="0.0000",
            cost_known=True,
            attempts=1,
            latency_ms=3,
            is_stub=True,
            provider=self.name,
        )


def build() -> None:
    User = get_user_model()
    owner = User.objects.create_user(email="b8-probe@example.invalid", password="probe-password-123", display_name="探针")
    other = User.objects.create_user(email="b8-other@example.invalid", password="probe-password-123", display_name="他人")
    project = ExamProject.objects.create(owner=owner, name="知识探针项目")
    other_project = ExamProject.objects.create(owner=other, name="他人项目")
    subject = Subject.objects.create(project=project, name="数学", code="MATH", total_score=100, pass_score=60)
    other_subject = Subject.objects.create(project=other_project, name="物理", code="PHY", total_score=100, pass_score=60)
    ExamSpecVersion.objects.create(
        subject=subject,
        version=1,
        name="探针规范",
        total_score=100,
        pass_score=60,
        question_type_rules={"single_choice": {"default_max_score": "2.00", "wrong_score": "0.00"}},
        status="published",
        published_at=timezone.now(),
        rule_source_note="探针",
    )
    syllabus = SyllabusVersion.objects.create(
        subject=subject, name="数学大纲", version_label="2026", status="published", is_user_provisional=True
    )
    other_syllabus = SyllabusVersion.objects.create(
        subject=other_subject, name="物理大纲", version_label="2026", status="published", is_user_provisional=False
    )
    nodes = {
        name: KnowledgeNode.objects.create(
            syllabus_version=syllabus, canonical_name=name, kind="point", code=f"C{index}", display_order=index
        )
        for index, name in enumerate(["alpha", "beta", "gamma"])
    }
    other_node = KnowledgeNode.objects.create(syllabus_version=other_syllabus, canonical_name="delta", kind="point")

    questions = {}
    for label, name in [("Q-A", "alpha"), ("Q-B", "beta"), ("Q-C", "gamma")]:
        question, version, _answer = make_question(subject, label)
        questions[label] = (question, version)
        QuestionKnowledge.objects.create(
            question_version=version, mapping_revision=1, node_id=nodes[name].id, is_primary=True, score_weight="1.0000"
        )
    untrusted_question, untrusted_version, _ = make_question(subject, "Q-X", checked=False)
    QuestionKnowledge.objects.create(
        question_version=untrusted_version,
        mapping_revision=1,
        node_id=nodes["alpha"].id,
        is_primary=True,
        score_weight="1.0000",
    )

    for name, value in [
        ("PROJECT", project),
        ("OTHER_PROJECT", other_project),
        ("SUBJECT", subject),
        ("OTHER_SUBJECT", other_subject),
        ("SYLLABUS", syllabus),
        ("OTHER_SYLLABUS", other_syllabus),
        ("NODE_ALPHA", nodes["alpha"]),
        ("NODE_BETA", nodes["beta"]),
        ("NODE_GAMMA", nodes["gamma"]),
        ("OTHER_NODE", other_node),
        ("QUESTION_A", questions["Q-A"][0]),
        ("QUESTION_B", questions["Q-B"][0]),
        ("QUESTION_C", questions["Q-C"][0]),
        ("VERSION_A", questions["Q-A"][1]),
        ("VERSION_B", questions["Q-B"][1]),
        ("VERSION_C", questions["Q-C"][1]),
        ("QUESTION_X", untrusted_question),
        ("VERSION_X", untrusted_version),
    ]:
        reg(name, value)

    CLIENT.force_login(owner)
    base = f"/api/v1/projects/{project.id}"

    # ---------------------------------------------------------------- templates
    call("T01", "templates", "模板列表为空", "get", f"{base}/question-templates")
    call(
        "T02",
        "templates",
        "创建模板（201，名称去空白后成为身份）",
        "post",
        f"{base}/question-templates",
        json_body={"subject_id": str(subject.id), "name": "  计算题  ", "description": "两步运算"},
    )
    call(
        "T03",
        "templates",
        "同名模板复用同一行，description 更新",
        "post",
        f"{base}/question-templates",
        json_body={"subject_id": str(subject.id), "name": "计算题", "description": "更新说明"},
    )
    call("T04", "templates", "空名称被拒", "post", f"{base}/question-templates",
         json_body={"subject_id": str(subject.id), "name": "   "})
    call("T05", "templates", "缺 subject_id 是体校验 400", "post", f"{base}/question-templates",
         json_body={"name": "缺科目"})
    call("T06", "templates", "跨项目科目越权 404", "get",
         f"{base}/question-templates?subject_id={other_subject.id}")

    # ---------------------------------------------------------------- pairings
    pairing_body = {
        "subject_id": str(subject.id),
        "node_id": str(nodes["alpha"].id),
        "immediate_question_id": str(questions["Q-B"][0].id),
        "baseline_question_id": str(questions["Q-A"][0].id),
        "delay_hours": 24,
        "note": "探针配对",
    }
    created = call("P01", "pairings", "创建 A/B 配对（201，gap 明示缺 C）", "post",
                   f"{base}/verification-pairings", json_body=pairing_body, key="probe-pairing-1")
    pairing_id = (RAW.get("P01") or {}).get("id")
    call("P02", "pairings", "同键同载荷重放", "post", f"{base}/verification-pairings",
         json_body=pairing_body, key="probe-pairing-1")
    call("P03", "pairings", "同键异载荷 409", "post", f"{base}/verification-pairings",
         json_body={**pairing_body, "immediate_question_id": str(questions["Q-C"][0].id)},
         key="probe-pairing-1")
    call("P04", "pairings", "缺 Idempotency-Key 409", "post", f"{base}/verification-pairings",
         json_body={**pairing_body, "node_id": str(nodes["beta"].id)})
    call("P05", "pairings", "考点不属于该科目 404", "post", f"{base}/verification-pairings",
         json_body={**pairing_body, "node_id": str(other_node.id)}, key="probe-pairing-2")
    call("P06", "pairings", "B 题不存在 404", "post", f"{base}/verification-pairings",
         json_body={**pairing_body, "immediate_question_id": "00000000-0000-0000-0000-000000000000"},
         key="probe-pairing-3")
    call("P07", "pairings", "delay_hours=0 被拒", "post", f"{base}/verification-pairings",
         json_body={**pairing_body, "node_id": str(nodes["beta"].id), "delay_hours": 0}, key="probe-pairing-4")
    call("P08", "pairings", "B/C 与基准题重复 → 422 structure_invalid", "post",
         f"{base}/verification-pairings",
         json_body={
             **pairing_body,
             "node_id": str(nodes["beta"].id),
             "delayed_question_id": str(questions["Q-B"][0].id),
         },
         key="probe-pairing-5")
    call(
        "P09",
        "pairings",
        "补齐 C 题是第 2 版（gap 为空）",
        "post",
        f"{base}/verification-pairings",
        json_body={**pairing_body, "delayed_question_id": str(questions["Q-C"][0].id)},
        key="probe-pairing-6",
    )
    call("P10", "pairings", "配对列表（新版本在前）", "get", f"{base}/verification-pairings")
    if pairing_id:
        call("P11", "pairings", "配对详情含候选题", "get", f"{base}/verification-pairings/{pairing_id}")
    call("P12", "pairings", "他人项目的配对详情 404", "get",
         f"/api/v1/projects/{other_project.id}/verification-pairings/{pairing_id}")

    # ---------------------------------------------------------------- knowledge map
    call("K01", "knowledge_map", "缺 subject_id 是查询校验 400", "get", f"{base}/knowledge-map")
    call("K02", "knowledge_map", "知识地图（无状态时 undiagnosed）", "get",
         f"{base}/knowledge-map?subject_id={subject.id}")
    from apps.learning.models import LearnerKnowledgeState  # noqa: E402

    LearnerKnowledgeState.objects.create(
        user=owner,
        project=project,
        node=nodes["alpha"],
        syllabus_version=syllabus,
        summary="independent",
        best_summary="delayed_verified",
        independent_correct_count=2,
        distinct_question_count=2,
        distinct_template_count=1,
        has_delayed_correct=True,
        needs_review=False,
        downgrade_reason="",
        detail={},
        as_of=timezone.now(),
        rule_version="p2-c04",
    )
    call("K03", "knowledge_map", "有状态行时投影真实证据", "get",
         f"{base}/knowledge-map?subject_id={subject.id}")
    call("K04", "knowledge_map", "他人项目科目越权 404", "get",
         f"{base}/knowledge-map?subject_id={other_subject.id}")

    # ---------------------------------------------------------------- relations
    relation_body = {
        "syllabus_version_id": str(syllabus.id),
        "from_node_id": str(nodes["alpha"].id),
        "to_node_id": str(nodes["gamma"].id),
        "relation_type": "prerequisite",
        "note": "先学 alpha",
    }
    edge = call("R01", "relations", "加边（201）", "post", f"{base}/knowledge-relations",
                json_body=relation_body, key="probe-relation-1")
    relation_id = (RAW.get("R01") or {}).get("id")
    call("R02", "relations", "同键重放", "post", f"{base}/knowledge-relations",
         json_body=relation_body, key="probe-relation-1")
    call("R03", "relations", "反向成环 → 400 + cycle_names", "post", f"{base}/knowledge-relations",
         json_body={**relation_body, "from_node_id": str(nodes["gamma"].id),
                    "to_node_id": str(nodes["alpha"].id)},
         key="probe-relation-2")
    call("R04", "relations", "自环被拒", "post", f"{base}/knowledge-relations",
         json_body={**relation_body, "to_node_id": str(nodes["alpha"].id)}, key="probe-relation-3")
    call("R05", "relations", "未知关系类型被拒", "post", f"{base}/knowledge-relations",
         json_body={**relation_body, "to_node_id": str(nodes["beta"].id), "relation_type": "depends_on"},
         key="probe-relation-4")
    call("R06", "relations", "跨项目大纲 404", "post", f"{base}/knowledge-relations",
         json_body={**relation_body, "syllabus_version_id": str(other_syllabus.id)}, key="probe-relation-5")
    call("R07", "relations", "图（1 条边 / 3 个考点）", "get", f"{base}/knowledge-relations")
    if relation_id:
        call("R08", "relations", "停用边（200，行保留）", "delete",
             f"{base}/knowledge-relations/{relation_id}?reason=方向写错")
    call("R09", "relations", "停用后图里没有活跃边", "get", f"{base}/knowledge-relations")
    call("R10", "relations", "停用未知关系 404", "delete", f"{base}/knowledge-relations/{other_node.id}")
    call("R11", "relations", "重新加边复活同一行", "post", f"{base}/knowledge-relations",
         json_body={**relation_body, "note": "再来一次"}, key="probe-relation-6")

    # ---------------------------------------------------------------- prerequisites
    call("Q01", "prerequisites", "依赖考点的前置（未诊断视为未满足）", "get",
         f"{base}/knowledge-nodes/{nodes['gamma'].id}/prerequisites")
    call("Q02", "prerequisites", "考点不存在 404", "get",
         f"{base}/knowledge-nodes/{other_node.id}/prerequisites")

    # ---------------------------------------------------------------- tag suggestions
    with override_settings(AI_PROVIDER="none", AI_ALLOW_STUB=False):
        providers.set_provider_override(None)
        call("A01", "tag_suggestions", "无模型时列表为空", "get",
             f"{base}/question-versions/{questions['Q-A'][1].id}/tag-suggestions")
        call("A02", "tag_suggestions", "无模型时生成 → 503 ai_not_configured", "post",
             f"{base}/question-versions/{questions['Q-A'][1].id}/tag-suggestions",
             json_body={}, key="probe-tags-1")
        call("A03", "tag_suggestions", "失败后同键可重试（claim 已释放）", "post",
             f"{base}/question-versions/{questions['Q-A'][1].id}/tag-suggestions",
             json_body={}, key="probe-tags-1")
    call("A04", "tag_suggestions", "未知版本 404", "get",
         f"{base}/question-versions/{other_node.id}/tag-suggestions")

    # A scripted provider: the proposals are inert data, and only syllabus names survive.
    providers.set_provider_override(
        ScriptedProvider(
            {
                "tags": [
                    {"name": "gamma", "confidence": 0.9, "rationale": "题干涉及 gamma"},
                    {"name": "不在大纲", "confidence": 0.8, "rationale": "编造"},
                ]
            }
        )
    )
    try:
        suggestion = call("A05", "tag_suggestions", "脚本化模型只产候选（is_stub 记录）", "post",
                          f"{base}/question-versions/{questions['Q-A'][1].id}/tag-suggestions",
                          json_body={}, key="probe-tags-2")
        suggestion_id = (RAW.get("A05") or {}).get("id")
        call("A06", "tag_suggestions", "采纳写入新的辅助映射修订（权重 0）", "post",
             f"{base}/tag-suggestions/{suggestion_id}/accept",
             json_body={"node_names": ["gamma"], "note": "人工核对"})
        call("A07", "tag_suggestions", "重复采纳被拒", "post", f"{base}/tag-suggestions/{suggestion_id}/accept",
             json_body={"node_names": ["gamma"]})
        call("A08", "tag_suggestions", "标签建议列表（含 latest_mappings）", "get",
             f"{base}/question-versions/{questions['Q-A'][1].id}/tag-suggestions")
    finally:
        providers.set_provider_override(None)

    # ---------------------------------------------------------------- pairing service chain
    probe_pairing_chain(
        owner=owner,
        project=project,
        subject=subject,
        node=nodes["alpha"],
        baseline=questions["Q-A"][0],
        immediate=questions["Q-B"][0],
        delayed=questions["Q-C"][0],
    )


def probe_pairing_chain(*, owner, project, subject, node, baseline, immediate, delayed) -> None:
    """Drive a real A → B → C chain; record the tasks the production rules produced."""
    pairing = knowledge_core.create_verification_pairing(
        project=project,
        subject=subject,
        node=node,
        baseline_question=baseline,
        immediate_question=immediate,
        delayed_question=delayed,
        delay_hours=24,
        actor=owner,
        note="探针链",
    )
    reg("CHAIN_PAIRING", pairing)
    now = timezone.now()

    def answer_one(question, *, presented_at, submitted_at) -> Attempt:
        session = session_services.create_session(
            user=owner, project=project, subject=subject, question_ids=[str(question.id)]
        )
        item = session.items.get()
        session_services.presentation(item=item, user=owner, now=presented_at)
        attempt, _grade = attempt_services.submit_attempt(
            session_item_id=str(item.id), user=owner, raw_answer=answer_for(item.question_version), now=submitted_at
        )
        return attempt

    before = db_counts()
    attempt_a = answer_one(
        baseline,
        presented_at=now - timedelta(hours=30, minutes=5),
        submitted_at=now - timedelta(hours=30),
    )
    created_b = pairing_service.on_attempt_graded(str(attempt_a.id))
    after = db_counts()
    b_task = StudyTask.objects.filter(pairing=pairing, task_kind="paired_immediate").first()
    record(
        "S01",
        "pairing_service",
        "A 判分后创建一个 B（每个活跃配对各一个；本库有 3 个 A 配对）",
        request={"method": "service", "path": "pairing.on_attempt_graded", "attempt_id": sym(attempt_a.id)},
        status="service",
        payload={"created": created_b, "b_task": None if b_task is None else task_row(b_task)},
        before=before,
        after=after,
    )

    before = db_counts()
    replay = pairing_service.on_attempt_graded(str(attempt_a.id))
    after = db_counts()
    record(
        "S02",
        "pairing_service",
        "重放同一 attempt 不产生第二个任务",
        request={"method": "service", "path": "pairing.on_attempt_graded", "attempt_id": sym(attempt_a.id)},
        status="service",
        payload={"created": replay, "paired_immediate_count": StudyTask.objects.filter(pairing=pairing).count()},
        before=before,
        after=after,
    )

    before = db_counts()
    b_version = (
        QuestionVersion.objects.filter(question_id=b_task.question_id, status="published")
        .order_by("-version")
        .first()
    )
    attempt_b = answer_one(
        b_task.question,
        presented_at=now - timedelta(minutes=35),
        submitted_at=now - timedelta(minutes=30),
    )
    created_c = pairing_service.on_attempt_graded(str(attempt_b.id))
    after = db_counts()
    c_task = StudyTask.objects.filter(
        pairing=pairing, task_kind="delayed_verification", origin_session_item__isnull=False
    ).first()
    review = ReviewTask.objects.filter(study_task=c_task).first() if c_task else None
    record(
        "S03",
        "pairing_service",
        "B 判分后创建 C（锚点是 B 的提交时间）",
        request={"method": "service", "path": "pairing.on_attempt_graded", "attempt_id": sym(attempt_b.id)},
        status="service",
        payload={
            "created": created_c,
            "c_task": None if c_task is None else task_row(c_task),
            "b_version_id": sym(b_version.id if b_version else None),
            "anchor_equals_b_submission": bool(c_task and c_task.delay_anchor_at == attempt_b.submitted_at),
            "not_before_minus_anchor_hours": (
                None if c_task is None else round((c_task.not_before - c_task.delay_anchor_at).total_seconds() / 3600, 2)
            ),
            "review_task": (
                None
                if review is None
                else {
                    "delay_hours": review.delay_hours,
                    "anchor_source": review.anchor_source,
                    "was_started": review.was_started,
                    "not_before_matches_task": review.not_before == c_task.not_before,
                }
            ),
        },
        before=before,
        after=after,
    )

    record(
        "S04",
        "pairing_service",
        "到期前 delayed_interval_status 不可开始",
        request={"method": "service", "path": "pairing.delayed_interval_status"},
        status="service",
        payload=interval_status(pairing_service.delayed_interval_status(task=c_task, now=now)),
        before=db_counts(),
        after=db_counts(),
    )

    before = db_counts()
    due = now - timedelta(minutes=1)
    c_task.not_before = due
    c_task.due_at = due
    c_task.save(update_fields=["not_before", "due_at", "updated_at"])
    ReviewTask.objects.filter(study_task=c_task).update(not_before=due, updated_at=now)
    after = db_counts()
    record(
        "S05",
        "pairing_service",
        "把 C 的截止时间挪到过去后可开始（夹具链的最后一步）",
        request={"method": "service", "path": "fixture.move_deadline"},
        status="service",
        payload=interval_status(pairing_service.delayed_interval_status(task=c_task, now=now)),
        before=before,
        after=after,
    )

    before = db_counts()
    # A *related* learning event: the question is mapped to the pairing's own node, which is what
    # the anchor rule looks at (an attempt on another node must not move anything).
    later_attempt = answer_one(
        baseline,
        presented_at=now - timedelta(minutes=12),
        submitted_at=now - timedelta(minutes=10),
    )
    pairing_service.on_attempt_graded(str(later_attempt.id))
    reconciled = pairing_service.reconcile_delayed_tasks()
    after = db_counts()
    c_task.refresh_from_db()
    record(
        "S06",
        "pairing_service",
        "新的训练事件把待开始的 C 顺延（reconcile）",
        request={"method": "service", "path": "pairing.reconcile_delayed_tasks"},
        status="service",
        payload={
            "reconciled": reconciled,
            "c_not_before_is_after_later_attempt": c_task.not_before > later_attempt.submitted_at,
            "reason_codes": c_task.reason_codes,
            "interval": interval_status(pairing_service.delayed_interval_status(task=c_task, now=now)),
        },
        before=before,
        after=after,
    )


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        build()
    finally:
        providers.set_provider_override(None)
        from django.db import connections

        connections.close_all()
        connection.creation.destroy_test_db(old_name, verbosity=0)
    payload = {
        "database": "postgresql (throw-away test database)",
        "settings": "config.settings.test (AI_PROVIDER overridden to none for the 503 cases)",
        "cases": CASES,
        # Every id the report refers to, so a reader can map `REF_0xx` back to a real row.
        "symbols": dict(sorted(AUTO_NAMES.items())),
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"cases={len(CASES)}")
    for op in sorted({case["op"] for case in CASES}):
        print(f"  {op}: {sum(1 for case in CASES if case['op'] == op)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
