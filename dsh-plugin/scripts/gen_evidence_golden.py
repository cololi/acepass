#!/usr/bin/env python
"""Generate scenario-level golden vectors for the anchors / evidence / state ports.

Oracle: the real Django services running against a throw-away PostgreSQL database.
Unlike the exhaustive rule-function vectors (`gen_evidence_state_golden.py`), these
cases go through *real rows*: real sessions, items, grade events, exposure rows and
knowledge mappings, so the facts handed to the port are the ones the store layer
will actually produce.

The dump separates facts (what the port may read) from expected (what Django
returned). Facts are pre-resolved the way the Python service resolves them, so a
port that re-derives a rule differently — or that normalises a fact the original
does not — fails instead of agreeing with itself.

Usage (from `dsh-plugin/`):
    ../backend/.venv/bin/python scripts/gen_evidence_golden.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

from apps.common.enums import (  # noqa: E402
    EvidenceDimension,
    ExposureKind,
    GradeMethod,
    GradeStatus,
    SessionMode,
    SessionStatus,
)
from apps.exams.models import ExamProject, Subject, SyllabusVersion  # noqa: E402
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge, QuestionTemplate  # noqa: E402
from apps.learning.models import LearnerKnowledgeState  # noqa: E402
from apps.learning.services import anchors as anchors_service  # noqa: E402
from apps.learning.services import contamination as contamination_service  # noqa: E402
from apps.learning.services import evidence as evidence_service  # noqa: E402
from apps.learning.services import state as state_service  # noqa: E402
from apps.practice.models import (  # noqa: E402
    Attempt,
    ExposureEvent,
    GradeEvent,
    LearningEvidence,
    PracticeSession,
    SessionItem,
)
from apps.question_bank.models import (  # noqa: E402
    AnswerKeyVersion,
    Question,
    QuestionFamily,
    QuestionVersion,
)

OUT = Path(__file__).resolve().parents[1] / "tests" / "golden" / "evidence.json"

BASE = datetime(2026, 2, 1, 0, 0, tzinfo=timezone.utc)
DEFAULT_SUMMARY = "undiagnosed"


def iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


class Fixture:
    def __init__(self) -> None:
        User = get_user_model()
        self.user = User.objects.create_user(email="owner@example.invalid")
        self.project = ExamProject.objects.create(owner=self.user, name="P1")
        self.other_project = ExamProject.objects.create(owner=self.user, name="P2")
        self.subject = Subject.objects.create(project=self.project, name="S1")
        self.syllabus = SyllabusVersion.objects.create(subject=self.subject, name="SV1", status="published")
        self.t1 = QuestionTemplate.objects.create(subject=self.subject, name="T1", review_status="confirmed")
        self.t2 = QuestionTemplate.objects.create(subject=self.subject, name="T2", review_status="confirmed")
        self.delay_hours = int(getattr(settings, "DELAYED_VERIFICATION_HOURS", 24))
        self.nodes: dict[str, KnowledgeNode] = {}
        self.attempt_cases: list[dict] = []
        self.state_sequences: dict[str, list[dict]] = {}

    # -- fixture building -------------------------------------------------
    def node(self, name: str) -> KnowledgeNode:
        if name not in self.nodes:
            self.nodes[name] = KnowledgeNode.objects.create(syllabus_version=self.syllabus, canonical_name=name)
        return self.nodes[name]

    def question(
        self,
        name: str,
        mappings: list[tuple[str, QuestionTemplate]],
        *,
        family: QuestionFamily | None = None,
        answer_status: str = "checked",
        mapping_revision: int = 1,
    ) -> tuple[Question, QuestionVersion, AnswerKeyVersion]:
        question = Question.objects.create(subject=self.subject, origin_type="provided", is_demo=False, family=family)
        version = QuestionVersion.objects.create(
            question=question,
            version=1,
            question_type="single_choice",
            content={"stem": name},
            status="published",
            published_at=BASE - timedelta(days=30),
        )
        answer = AnswerKeyVersion.objects.create(
            question_version=version,
            version=1,
            answer_payload={"correct_option_id": "a"},
            source_type="user",
            verification_status=answer_status,
            checked_at=BASE - timedelta(days=30),
        )
        for node_name, template in mappings:
            QuestionKnowledge.objects.create(
                question_version=version,
                mapping_revision=mapping_revision,
                node=self.node(node_name),
                template=template,
                is_primary=True,
                score_weight="1.0000",
            )
        question.current_published_version = version
        question.save(update_fields=["current_published_version"])
        return question, version, answer

    def start_attempt(
        self,
        version: QuestionVersion,
        answer: AnswerKeyVersion | None,
        *,
        submitted_at: datetime,
        elapsed_ms: int = 60_000,
        mode: str = SessionMode.PRACTICE,
        status: str = SessionStatus.FINISHED,
        purpose: str = "practice",
        mapping_revision: int = 1,
        delivered_at: datetime | None = None,
        grade: dict | None = None,
    ) -> tuple[Attempt, SessionItem]:
        session = PracticeSession.objects.create(
            user=self.user, project=self.project, subject=self.subject, mode=mode, status=status
        )
        item = SessionItem.objects.create(
            session=session,
            ordinal=1,
            question_version=version,
            answer_key_version=answer,
            mapping_revision=mapping_revision,
            max_score="4.00",
            purpose=purpose,
            first_delivered_at=delivered_at if delivered_at is not None else submitted_at - timedelta(minutes=10),
        )
        attempt = Attempt.objects.create(
            session_item=item,
            user=self.user,
            project=self.project,
            raw_answer={"selected_option_id": "a"},
            submitted_at=submitted_at,
            elapsed_ms=elapsed_ms,
        )
        if grade is not None:
            event = GradeEvent.objects.create(
                attempt=attempt,
                status=grade.get("status", GradeStatus.CONFIRMED),
                method=grade.get("method", GradeMethod.DETERMINISTIC),
                grading_revision=grade.get("revision", 1),
                confirmed_score=grade.get("confirmed_score"),
                max_score=grade.get("max_score", "4.00"),
                pending_max_score=grade.get("pending_max_score", "0"),
                is_fully_confirmed=grade.get("is_fully_confirmed", True),
                grader_is_self=grade.get("grader_is_self", False),
                rule_snapshot={},
            )
            # Re-read so DecimalField values come back as Decimal: assignment does not coerce and
            # the service compares them arithmetically.
            event = GradeEvent.objects.get(id=event.id)
            attempt.current_grade_event = event
            attempt.grading_revision = grade.get("revision", 1)
            attempt.save(update_fields=["current_grade_event", "grading_revision"])
        return attempt, item

    def exposure(self, version: QuestionVersion, kind: str, at: datetime, *, reveals_answer: bool) -> None:
        ExposureEvent.objects.create(
            user=self.user,
            project=self.project,
            question=version.question,
            question_version=version,
            content_lineage=version.question.content_lineage,
            kind=kind,
            server_time=at,
            reveals_answer=reveals_answer,
        )

    # -- fact dumps: exactly what the port is allowed to read ---------------
    def anchor_facts(self) -> dict:
        def node_ids(version_id: str) -> list[str]:
            return sorted(
                {
                    str(node_id)
                    for node_id in QuestionKnowledge.objects.filter(question_version_id=version_id).values_list(
                        "node_id", flat=True
                    )
                }
            )

        attempts = [
            {
                "id": str(row.id),
                "project_id": str(row.project_id),
                "at": iso(row.submitted_at),
                "node_ids": node_ids(str(row.session_item.question_version_id)),
            }
            for row in Attempt.objects.select_related("session_item").all()
        ]
        teaching = [
            {
                "project_id": str(row.project_id),
                "at": iso(row.server_time),
                "node_ids": node_ids(str(row.question_version_id)),
            }
            for row in ExposureEvent.objects.filter(reveals_answer=True).all()
            if row.question_version_id
        ]
        return {"attempts": attempts, "teaching_exposures": teaching, "tutoring": []}

    def attempt_facts(self, attempt: Attempt, item: SessionItem) -> dict:
        version = item.question_version
        question = version.question
        grade = attempt.current_grade_event

        mappings = [
            {
                "nodeId": str(row.node_id),
                "nodeName": row.node.canonical_name,
                "templateId": str(row.template_id) if row.template_id else None,
                "mappingRevision": str(row.mapping_revision),
            }
            for row in QuestionKnowledge.objects.filter(question_version=version).select_related("node", "template")
        ]
        mappings.sort(key=lambda row: row["nodeName"])

        assisted, reasons = evidence_service._pre_submit_assistance(attempt)
        kinds: list[str] = []
        hint_before = False
        for reason in reasons:
            if reason.startswith("提交前已获得辅助暴露："):
                kinds = [kind.strip() for kind in reason.split("：", 1)[1].split(",")]
            elif reason == "提交前获得过提示":
                hint_before = True

        templates = {row["templateId"] for row in mappings if row["templateId"]}
        if len(templates) > 1:
            # The port carries one flag per attempt; a mapping set with several templates needs a
            # per-node flag. Refuse to emit an ambiguous case instead of picking one at random.
            raise SystemExit(f"ambiguous template set for attempt {attempt.id}: {sorted(templates)}")
        same_template_other_question = False
        if templates and len(mappings) == 1:
            template_id = next(iter(templates))
            same_template_other_question = (
                LearningEvidence.objects.filter(
                    user=self.user,
                    project_id=attempt.project_id,
                    knowledge_node_id=mappings[0]["nodeId"],
                    dimension=EvidenceDimension.INDEPENDENT_CORRECT,
                    qualifies=True,
                )
                .exclude(attempt=attempt)
                .filter(detail__template_id=template_id)
                .exists()
            )

        evaluated_at, evaluated_source = evidence_service._delay_evaluation_instant(attempt)
        anchor_at = None
        anchor_source = ""
        if mappings:
            anchor_at, anchor_source = anchors_service.latest_learning_anchor(
                user=self.user,
                project=attempt.project_id,
                node_id=mappings[0]["nodeId"],
                before=evaluated_at,
                exclude_attempt_id=attempt.id,
            )
        if evaluated_source != "first_presentation":
            # Only a server-side submission path reaches here; keep the port honest about it.
            pass

        contamination = [
            {"code": row["code"], "message": row["message"]}
            for row in contamination_service.attempt_exclusion_reasons(attempt=attempt)
        ]

        family = None
        if question.family_id:
            family = {
                "id": str(question.family_id),
                "relation_confirmed": bool(question.family.relation_confirmed),
                "has_other_question": question.family.questions.exclude(id=question.id).exists(),
            }

        return {
            "elapsedMs": attempt.elapsed_ms,
            "firstDeliveredAt": iso(item.first_delivered_at),
            "submittedAt": iso(attempt.submitted_at),
            "answerKeyUsable": bool(item.answer_key_version and item.answer_key_version.is_usable),
            "session": {"mode": item.session.mode, "status": item.session.status},
            "purpose": item.purpose,
            "grade": None
            if grade is None
            else {
                "status": grade.status,
                "isFullyConfirmed": grade.is_fully_confirmed,
                "confirmedScore": str(grade.confirmed_score) if grade.confirmed_score is not None else None,
                "maxScore": str(grade.max_score),
                "graderIsSelf": grade.grader_is_self,
                "method": grade.method,
            },
            "mappings": mappings,
            "assistance": {
                "answerRevealingKinds": kinds,
                "hintBeforeSubmit": hint_before,
            },
            "contamination": contamination,
            "sameTemplateOtherQuestion": same_template_other_question,
            "familyId": None if family is None else family["id"],
            "familyRelationConfirmed": False if family is None else family["relation_confirmed"],
            "familyHasOtherQuestions": False if family is None else family["has_other_question"],
            "anchor": {"at": iso(anchor_at), "source": anchor_source},
            "delayHours": self.delay_hours,
        }

    def state_rows(self, node: KnowledgeNode) -> list[dict]:
        # Deliberately no ORDER BY: the state projection builds `source_evidence_ids` in the order
        # the queryset yields, i.e. the database's natural order. Pinning a sort here would make the
        # golden agree with a re-sorted implementation instead of with the original.
        rows = LearningEvidence.objects.filter(
            user=self.user, project=self.project, knowledge_node=node, is_active=True
        ).select_related("attempt__session_item__question_version")
        return [
            {
                "id": str(row.id),
                "attemptId": str(row.attempt_id),
                "dimension": row.dimension,
                "qualifies": row.qualifies,
                "isCorrect": row.is_correct,
                "gradeEventId": str(row.grade_event_id) if row.grade_event_id else None,
                "templateId": (row.detail or {}).get("template_id"),
                "questionId": str(row.attempt.session_item.question_version.question_id),
                "computedAt": row.computed_at.isoformat(),
                "exclusionReasons": row.exclusion_reasons,
                "gradeRevision": row.grade_revision,
            }
            for row in rows
        ]

    def previous_state(self, node: KnowledgeNode) -> dict:
        state = LearnerKnowledgeState.objects.filter(
            user=self.user, project=self.project, syllabus_version=self.syllabus, node=node
        ).first()
        if state is None:
            return {"summary": DEFAULT_SUMMARY, "bestSummary": DEFAULT_SUMMARY}
        return {"summary": state.summary, "bestSummary": state.best_summary}

    def state_expected(self, node: KnowledgeNode) -> dict:
        state = LearnerKnowledgeState.objects.get(
            user=self.user, project=self.project, syllabus_version=self.syllabus, node=node
        )
        detail = state.detail or {}
        return {
            "summary": state.summary,
            "best_summary": state.best_summary,
            "independent_correct_count": state.independent_correct_count,
            "distinct_question_count": state.distinct_question_count,
            "distinct_template_count": state.distinct_template_count,
            "has_delayed_correct": state.has_delayed_correct,
            "recent_independent_attempts": state.recent_independent_attempts,
            "recent_independent_failures": state.recent_independent_failures,
            "needs_review": state.needs_review,
            "downgrade_reason": state.downgrade_reason,
            "rule_version": state.rule_version,
            "source_evidence_ids": state.source_evidence_ids,
            "detail": {
                "thresholds": detail.get("thresholds", {}),
                "independent_attempts": detail.get("independent_attempts", []),
                "missing_evidence": detail.get("missing_evidence", []),
            },
        }

    # -- one full attempt: build evidence, refresh state, snapshot -----------
    def finish(self, name: str, attempt: Attempt, item: SessionItem) -> None:
        expected_rows = [
            {
                "dimension": row["dimension"],
                "nodeId": str(row["node"].id),
                "qualifies": row["qualifies"],
                "isCorrect": row["is_correct"],
                "scoreFraction": str(row["score_fraction"]) if row["score_fraction"] is not None else None,
                "exclusionReasons": row["exclusion_reasons"],
                "detail": row["detail"],
            }
            for row in evidence_service.compute_dimensions(attempt)
        ]
        self.attempt_cases.append(
            {
                "name": name,
                "facts": self.attempt_facts(attempt, item),
                "expected_rows": expected_rows,
            }
        )
        evidence_service.rebuild_for_attempt(str(attempt.id))
        touched = {
            str(row.knowledge_node_id)
            for row in LearningEvidence.objects.filter(attempt=attempt, is_active=True)
            if row.knowledge_node_id
        }
        for node_id in sorted(touched):
            node = KnowledgeNode.objects.get(id=node_id)
            previous = self.previous_state(node)
            state_service.refresh_node_state(
                user=self.user, project=self.project, syllabus_version=self.syllabus, node=node
            )
            self.state_sequences.setdefault(node_id, []).append(
                {
                    "node_id": node_id,
                    "previous": previous,
                    "rows": self.state_rows(node),
                    "expected": self.state_expected(node),
                }
            )

    def anchor_cases(self) -> list[dict]:
        cases = []
        before = BASE
        for node_name in ("N3", "N4", "N1"):
            node = self.node(node_name)
            latest = (
                Attempt.objects.filter(project=self.project, submitted_at__lte=before)
                .order_by("-submitted_at")
                .first()
            )
            exclude = str(latest.id) if latest else None
            expected_anchor, expected_source = anchors_service.latest_learning_anchor(
                user=self.user,
                project=self.project,
                node_id=node.id,
                before=before,
                exclude_attempt_id=exclude,
            )
            cases.append(
                {
                    "query": {
                        "project_id": str(self.project.id),
                        "node_id": str(node.id),
                        "before": iso(before),
                        "exclude_attempt_id": exclude,
                    },
                    "expected": {
                        "anchor": expected_anchor.isoformat() if expected_anchor else None,
                        "source": expected_source,
                    },
                }
            )
        lonely = self.node("N9")
        expected_anchor, expected_source = anchors_service.latest_learning_anchor(
            user=self.user, project=self.project, node_id=lonely.id, before=before
        )
        cases.append(
            {
                "query": {
                    "project_id": str(self.project.id),
                    "node_id": str(lonely.id),
                    "before": iso(before),
                    "exclude_attempt_id": None,
                },
                "expected": {
                    "anchor": expected_anchor.isoformat() if expected_anchor else None,
                    "source": expected_source,
                },
            }
        )
        return cases


def build() -> dict:
    f = Fixture()

    # --- ordinary independent answers, in order, to build template history ---
    qa, va, aa = f.question("QA", [("N1", f.t1)])
    qb, vb, ab = f.question("QB", [("N1", f.t1)])
    qc, vc, ac = f.question("QC", [("N1", f.t2)])

    attempt, item = f.start_attempt(
        va, aa, submitted_at=BASE + timedelta(minutes=10), grade={"confirmed_score": "4.00", "max_score": "4.00"}
    )
    f.finish("independent-basic", attempt, item)

    attempt, item = f.start_attempt(
        vb, ab, submitted_at=BASE + timedelta(minutes=20), grade={"confirmed_score": "3.00", "max_score": "4.00"}
    )
    # 3/4 is not "correct" — the row must still be graded, and not independent.
    f.finish("graded-but-not-full-marks", attempt, item)

    attempt, item = f.start_attempt(
        vb, ab, submitted_at=BASE + timedelta(minutes=30), grade={"confirmed_score": "4.00", "max_score": "4.00"}
    )
    f.finish("template-variant", attempt, item)

    attempt, item = f.start_attempt(
        vc, ac, submitted_at=BASE + timedelta(minutes=40), grade={"confirmed_score": "4.00", "max_score": "4.00"}
    )
    f.finish("template-t2-no-sibling", attempt, item)

    # --- assistance: an answer delivered before the submission ---------------
    qd, vd, ad = f.question("QD", [("N2", f.t2)])
    attempt, item = f.start_attempt(
        vd,
        ad,
        submitted_at=BASE + timedelta(minutes=60),
        grade={"confirmed_score": "4.00", "max_score": "4.00"},
    )
    f.exposure(vd, ExposureKind.ANSWER_DELIVERED, BASE + timedelta(minutes=55), reveals_answer=True)
    f.finish("assisted-by-answer", attempt, item)

    # --- hint only: not answer-revealing, still blocks "unassisted" ----------
    qe, ve, ae = f.question("QE", [("N2", f.t2)])
    attempt, item = f.start_attempt(
        ve,
        ae,
        submitted_at=BASE + timedelta(minutes=70),
        grade={"confirmed_score": "4.00", "max_score": "4.00"},
    )
    f.exposure(ve, ExposureKind.HINT_DELIVERED, BASE + timedelta(minutes=65), reveals_answer=False)
    f.finish("assisted-by-hint", attempt, item)

    # --- pending grade -------------------------------------------------------
    qf, vf, af = f.question("QF", [("N2", f.t2)])
    attempt, item = f.start_attempt(
        vf,
        af,
        submitted_at=BASE + timedelta(minutes=80),
        grade={
            "status": GradeStatus.PENDING_REVIEW,
            "confirmed_score": None,
            "pending_max_score": "4.00",
            "is_fully_confirmed": False,
        },
    )
    f.finish("pending-review", attempt, item)

    # --- fully graded but wrong ---------------------------------------------
    qg, vg, ag = f.question("QG", [("N2", f.t2)])
    attempt, item = f.start_attempt(
        vg, ag, submitted_at=BASE + timedelta(minutes=90), grade={"confirmed_score": "0.00", "max_score": "4.00"}
    )
    f.finish("wrong-answer", attempt, item)

    # --- AI estimated only ---------------------------------------------------
    qh, vh, ah = f.question("QH", [("N2", f.t2)])
    attempt, item = f.start_attempt(
        vh,
        ah,
        submitted_at=BASE + timedelta(minutes=100),
        grade={
            "method": GradeMethod.AI_ESTIMATED,
            "confirmed_score": None,
            "max_score": "4.00",
            "is_fully_confirmed": False,
        },
    )
    f.finish("ai-estimated", attempt, item)

    # --- self-confirmed grade ------------------------------------------------
    qi, vi, ai = f.question("QI", [("N2", f.t2)])
    attempt, item = f.start_attempt(
        vi,
        ai,
        submitted_at=BASE + timedelta(minutes=110),
        grade={
            "method": GradeMethod.SELF_CONFIRMED,
            "confirmed_score": "4.00",
            "max_score": "4.00",
            "grader_is_self": True,
        },
    )
    f.finish("self-confirmed", attempt, item)

    # --- no trustworthy timing ----------------------------------------------
    qj, vj, aj = f.question("QJ", [("N2", f.t2)])
    attempt, item = f.start_attempt(
        vj,
        aj,
        submitted_at=BASE + timedelta(minutes=120),
        elapsed_ms=0,
        grade={"confirmed_score": "4.00", "max_score": "4.00"},
    )
    f.finish("no-elapsed-time", attempt, item)

    # --- answer key not checked ---------------------------------------------
    qk, vk, ak = f.question("QK", [("N2", f.t2)], answer_status="pending")
    attempt, item = f.start_attempt(
        vk, ak, submitted_at=BASE + timedelta(minutes=130), grade={"confirmed_score": "4.00", "max_score": "4.00"}
    )
    f.finish("unusable-answer-key", attempt, item)

    # --- verification still running -----------------------------------------
    ql, vl, al = f.question("QL", [("N2", f.t2)])
    attempt, item = f.start_attempt(
        vl,
        al,
        submitted_at=BASE + timedelta(minutes=140),
        mode=SessionMode.VERIFICATION,
        status=SessionStatus.ACTIVE,
        grade={"confirmed_score": "4.00", "max_score": "4.00"},
    )
    f.finish("verification-active", attempt, item)

    # --- near-duplicate family ----------------------------------------------
    family = QuestionFamily.objects.create(subject=f.subject, name="FAM", relation_confirmed=True)
    qm, vm, am = f.question("QM", [("N2", f.t2)], family=family)
    f.question("QM-sibling", [("N2", f.t2)], family=family)
    attempt, item = f.start_attempt(
        vm, am, submitted_at=BASE + timedelta(minutes=150), grade={"confirmed_score": "4.00", "max_score": "4.00"}
    )
    f.finish("near-duplicate-family", attempt, item)

    # --- mapping revision fallback ------------------------------------------
    qn, vn, an = f.question("QN", [("N2", f.t2)])
    attempt, item = f.start_attempt(
        vn,
        an,
        submitted_at=BASE + timedelta(minutes=160),
        mapping_revision=2,
        grade={"confirmed_score": "4.00", "max_score": "4.00"},
    )
    f.finish("mapping-revision-fallback", attempt, item)

    # --- external declaration before the attempt ----------------------------
    qo, vo, ao = f.question("QO", [("N2", f.t2)])
    attempt, item = f.start_attempt(
        vo,
        ao,
        submitted_at=BASE + timedelta(minutes=170),
        grade={"confirmed_score": "4.00", "max_score": "4.00"},
    )
    f.exposure(vo, ExposureKind.EXTERNAL_SEEN, BASE + timedelta(minutes=1), reveals_answer=False)
    f.finish("externally-seen", attempt, item)

    # --- delayed verification: 30h after the last training ------------------
    qp3, vp3, ap3 = f.question("QP3", [("N3", f.t1)])
    prior, prior_item = f.start_attempt(
        vp3,
        ap3,
        submitted_at=BASE - timedelta(hours=30),
        grade={"confirmed_score": "4.00", "max_score": "4.00"},
    )
    f.finish("prior-training-n3", prior, prior_item)
    qh3, vh3, ah3 = f.question("QH3", [("N3", f.t1)])
    attempt, item = f.start_attempt(
        vh3,
        ah3,
        submitted_at=BASE + timedelta(minutes=180),
        delivered_at=BASE - timedelta(hours=5),
        purpose="delayed_verification",
        grade={"confirmed_score": "4.00", "max_score": "4.00"},
    )
    # presented 5h after the prior training in wall-clock terms? No: the anchor is
    # the latest *completed* event before the presentation, so this one is 35h.
    f.finish("delayed-verified", attempt, item)

    # --- delayed verification too soon --------------------------------------
    qp4, vp4, ap4 = f.question("QP4", [("N4", f.t1)])
    prior, prior_item = f.start_attempt(
        vp4,
        ap4,
        submitted_at=BASE - timedelta(hours=5),
        grade={"confirmed_score": "4.00", "max_score": "4.00"},
    )
    f.finish("prior-training-n4", prior, prior_item)
    qh4, vh4, ah4 = f.question("QH4", [("N4", f.t1)])
    attempt, item = f.start_attempt(
        vh4,
        ah4,
        submitted_at=BASE + timedelta(minutes=190),
        delivered_at=BASE,
        purpose="delayed_verification",
        grade={"confirmed_score": "4.00", "max_score": "4.00"},
    )
    f.finish("delayed-too-soon", attempt, item)

    # --- ungraded attempt: evidence rows exist but no revision, so the state
    #     projection must ignore them entirely.
    qr, vr, ar = f.question("QR", [("N7", f.t1)])
    attempt, item = f.start_attempt(vr, ar, submitted_at=BASE + timedelta(minutes=200), grade=None)
    f.finish("no-grade-event", attempt, item)

    # --- needs_review: one independent success, then two failures -----------
    qs, vs, as_ = f.question("QS", [("N5", f.t1)])
    attempt, item = f.start_attempt(
        vs, as_, submitted_at=BASE + timedelta(minutes=210), grade={"confirmed_score": "4.00", "max_score": "4.00"}
    )
    f.finish("needs-review-first-success", attempt, item)
    for index, minutes in enumerate((220, 230)):
        attempt, item = f.start_attempt(
            vs,
            as_,
            submitted_at=BASE + timedelta(minutes=minutes),
            grade={"confirmed_score": "0.00", "max_score": "4.00"},
        )
        f.finish(f"needs-review-failure-{index}", attempt, item)

    return {
        "note": (
            "Generated by scripts/gen_evidence_golden.py. Facts are what the store layer resolves; "
            "expected values come from Django's real evidence/state services over real rows."
        ),
        "anchor_facts": f.anchor_facts(),
        "attempt_cases": f.attempt_cases,
        "anchor_cases": f.anchor_cases(),
        "state_sequences": [f.state_sequences[key] for key in sorted(f.state_sequences)],
    }


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        payload = build()
    finally:
        connection.creation.destroy_test_db(old_name, verbosity=0)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT}: {len(payload['attempt_cases'])} attempts, "
        f"{len(payload['anchor_cases'])} anchor cases, {len(payload['state_sequences'])} state sequences"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
