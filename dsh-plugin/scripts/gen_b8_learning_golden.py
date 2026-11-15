#!/usr/bin/env python
"""Golden vectors for B8's two non-trivial projections: the search ranking layer and FSRS memory.

Both are computed by the **real Django functions over real model rows** on a throw-away PostgreSQL
test database, then written to ``tests/golden/b8_learning.json``:

* the tokenizer (``apps.search.services.tokenize``) over a corpus of stems, options and node names;
* the BM25 keyword channel and the reciprocal-rank fusion (``hybrid.search``) over a real index built
  by ``index.reindex_project`` — scores, ranks, excerpts and matched terms as the wire reports them;
* one memory card's FSRS schedule: three reviews at fixed instants plus the ``rebuild`` replay report.

Every instant is fixed and every identifier is a role name (``Q1``, ``N1``, ``CARD``), so a rerun
produces a byte-identical file. The Node side (`tests/b8_search_http.test.ts`,
`tests/b8_memory_http.test.ts`) compares its own output against this file.

Usage (from ``dsh-plugin/``)::

    ../backend/.venv/bin/python scripts/gen_b8_learning_golden.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone as dt_timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.db import connection  # noqa: E402
from django.test.utils import setup_test_environment  # noqa: E402

from apps.accounts.models import UserSettings  # noqa: E402
from apps.common.content import content_digest  # noqa: E402
from apps.exams.services import core as exams_services  # noqa: E402
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge  # noqa: E402
from apps.memory.models import MemoryCard  # noqa: E402
from apps.memory.services import scheduler as memory_service  # noqa: E402
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion  # noqa: E402
from apps.question_bank.services import core as question_services  # noqa: E402
from apps.search.services import hybrid as hybrid_service  # noqa: E402
from apps.search.services import index as index_service  # noqa: E402
from apps.search.services.tokenize import TOKENIZER_VERSION, term_frequencies, tokenize  # noqa: E402

OUT_JSON = ROOT / "dsh-plugin" / "tests" / "golden" / "b8_learning.json"
TEST_DB_NAME = "test_acepass_b8_golden"
connection.settings_dict["TEST"] = {**connection.settings_dict.get("TEST", {}), "NAME": TEST_DB_NAME}

#: Fixed instants: the scheduler must never read the wall clock in a golden vector.
T0 = datetime(2026, 3, 1, 9, 0, tzinfo=dt_timezone.utc)
T1 = T0 + timedelta(hours=10)
T2 = T1 + timedelta(days=3)
T3 = T2 + timedelta(days=12)

#: The tokenizer corpus: real strings of the shape the index actually stores.
TOKENIZER_CORPUS = [
    "验收判断：三角形内角和为 180 度。",
    "下列哪一项等于 3 + 4 × 2？",
    "判断题",
    "ＡＢＣ１２，第 3 题",
    "BM25 检索 3.14 与 50%",
    "光合作用与呼吸作用",
    "  多个   空白\t分隔  ",
    "emoji 😀 不算词",
    "",
    "，，。！？",
]

QUERIES = ["三角形内角和", "12 的一半", "bm25", "考点", "", "，。"]

EXCERPT_CASES = [
    {"text": "验收判断：三角形内角和为 180 度。", "terms": ["三角"]},
    {"text": "验收判断：三角形内角和为 180 度。", "terms": ["内角", "三角"]},
    {"text": "验收判断：三角形内角和为 180 度。", "terms": ["不存在的词"]},
    {"text": "短文本", "terms": ["短"]},
    {
        "text": "前" * 120 + "三角形内角和" + "后" * 120,
        "terms": ["三角形内角和"],
    },
]

PROJECT_NAME = "黄金向量项目"
SUBJECT_NAME = "黄金向量科目"


def build_world():
    User = get_user_model()
    owner = User.objects.create_user(
        email="b8-golden@example.invalid", password="golden-password-123", display_name="黄金向量"
    )
    UserSettings.objects.get_or_create(user=owner)

    project = exams_services.create_project(owner, name=PROJECT_NAME)
    subject = exams_services.create_subject(project, name=SUBJECT_NAME, total_score=100, pass_score=60)
    spec = exams_services.create_exam_spec_version(
        subject,
        created_by=owner,
        name="规范",
        total_score=100,
        pass_score=60,
        question_type_rules={"true_false": {"default_max_score": 2, "correct_score": 2, "wrong_score": 0}},
    )
    exams_services.publish_exam_spec_version(spec, actor=owner)
    syllabus = exams_services.create_syllabus_version(
        subject, created_by=owner, name="大纲", version_label="2026", is_user_provisional=True
    )
    exams_services.publish_syllabus_version(syllabus, actor=owner)
    return owner, project, subject, syllabus


def make_question(owner, subject, label: str, stem: str, node: KnowledgeNode) -> Question:
    content = {"blocks": [{"kind": "text", "text": stem}]}
    question = Question.objects.create(subject=subject, origin_type="user_authored", display_label=label)
    version = QuestionVersion.objects.create(
        question=question,
        version=1,
        question_type="true_false",
        content=content,
        status="draft",
        content_digest=content_digest(content),
        practice_max_score=2,
        revision_reason="golden",
        source_note="",
    )
    AnswerKeyVersion.objects.create(
        question_version=version,
        version=1,
        answer_payload={"kind": "true_false", "value": True},
        source_type="user",
        verification_status="checked",
        check_basis="黄金向量：自编题，不是历年真题",
    )
    QuestionKnowledge.objects.create(
        question_version=version, node=node, is_primary=True, score_weight=Decimal("1.0000"), mapping_revision=1
    )
    question_services.publish_question_version(version, actor=owner)
    question.refresh_from_db()
    return question


def search_vectors(owner, project, subject, syllabus):
    node_a = KnowledgeNode.objects.create(
        syllabus_version=syllabus, canonical_name="三角形考点", aliases=["内角和"], kind="point", display_order=0
    )
    node_b = KnowledgeNode.objects.create(
        syllabus_version=syllabus, canonical_name="运算考点", kind="point", display_order=1
    )
    questions = {
        "Q1": make_question(owner, subject, "判断-1", "验收判断：三角形内角和为 180 度。", node_a),
        "Q2": make_question(owner, subject, "判断-2", "验收判断：12 的一半是 6。", node_b),
    }
    index_service.reindex_project(project, subject=subject)

    # The corpus is the *stored* index rows, not the source strings: that is what BM25 reads.
    refs = {}
    refs[str(node_a.id)] = "N1"
    refs[str(node_b.id)] = "N2"
    for name, question in questions.items():
        version = question.current_published_version
        refs[str(question.id)] = name
        refs[str(version.id)] = name
    documents = [
        {
            "ref": refs[str(document.question_id)] if document.question_id else refs[str(document.knowledge_node_id)],
            "kind": document.kind,
            "text": document.text,
            "tokens": document.tokens,
            "term_frequencies": document.term_frequencies,
            "doc_length": document.doc_length,
        }
        for document in index_service.searchable_documents(user=owner, project=project, subject=subject)
    ]
    documents.sort(key=lambda row: row["ref"])

    by_id = {
        str(document.id): refs[str(document.question_id)] if document.question_id else refs[str(document.knowledge_node_id)]
        for document in index_service.searchable_documents(user=owner, project=project, subject=subject)
    }
    rows = list(index_service.searchable_documents(user=owner, project=project, subject=subject))
    scores = hybrid_service._bm25_scores(rows, list(hybrid_service._ordered_unique(tokenize("三角形内角和"))))
    ranked = [
        {"ref": by_id[document_id], "score": round(score, 6), "rank": rank}
        for document_id, score, rank in hybrid_service._rank(scores)
    ]

    queries = []
    for query in QUERIES:
        payload = hybrid_service.search(
            user=owner, project=project, query=query, subject_id=str(subject.id), limit=10, channel="hybrid"
        )
        queries.append(
            {
                "query": query,
                "query_tokens": payload["query_tokens"],
                "candidate_documents": payload["candidate_documents"],
                "fusion": payload["fusion"],
                "keyword": {
                    "requested": payload["channels"]["keyword"]["requested"],
                    "used": payload["channels"]["keyword"]["used"],
                    "reason": payload["channels"]["keyword"]["reason"],
                    "hits": payload["channels"]["keyword"]["hits"],
                },
                "vector": {
                    "requested": payload["channels"]["vector"]["requested"],
                    "available": payload["channels"]["vector"]["available"],
                    "used": payload["channels"]["vector"]["used"],
                    "provider": payload["channels"]["vector"]["provider"],
                    "is_stub": payload["channels"]["vector"]["is_stub"],
                    "documents_with_embeddings": payload["channels"]["vector"]["documents_with_embeddings"],
                },
                "notes": payload["notes"],
                "results": [
                    {
                        "ref": by_id[document["document_id"]],
                        "kind": document["kind"],
                        "display_label": document["display_label"],
                        "excerpt": document["excerpt"],
                        "keyword_score": document["keyword_score"],
                        "keyword_rank": document["keyword_rank"],
                        "vector_score": document["vector_score"],
                        "vector_rank": document["vector_rank"],
                        "fused_score": document["fused_score"],
                        "channels": document["channels"],
                        "matched_terms": document["matched_terms"],
                    }
                    for document in payload["results"]
                ],
            }
        )

    return {
        "tokenizer_version": TOKENIZER_VERSION,
        "corpus": documents,
        "bm25_query": "三角形内角和",
        "bm25_ranked": ranked,
        "queries": queries,
        "excerpt_cases": [
            {"text": case["text"], "terms": case["terms"], "expected": hybrid_service._excerpt(case["text"], case["terms"])}
            for case in EXCERPT_CASES
        ],
    }


def memory_vectors(owner, project, subject, question):
    card, _created = memory_service.get_or_create_card(user=owner, question=question)
    # A fixed due_at: otherwise the projection would carry the creation clock.
    card.due_at = T0
    card.last_reviewed_at = None
    card.save(update_fields=["due_at", "last_reviewed_at", "updated_at"])
    MemoryCard.objects.filter(id=card.id).update(due_at=T0, last_reviewed_at=None)

    reviews = []
    for index, (rating, moment) in enumerate((("good", T1), ("good", T2), ("again", T3))):
        card.refresh_from_db()
        result = memory_service.review_card(
            card=card,
            rating=rating,
            idempotency_key=f"golden-{index}",
            reviewed_at=moment,
        )
        reviews.append(
            {
                "rating": rating,
                "reviewed_at": moment.isoformat(),
                "phase": result["phase"],
                "phase_before": result["phase_before"],
                "due_at": result["due_at"],
                "interval_days": result["interval_days"],
                "elapsed_days": result["elapsed_days"],
                "scheduled_days": result["scheduled_days"],
                "retrievability": result["retrievability"],
                "stability": result["stability"],
                "difficulty": result["difficulty"],
                "is_lapse": result["is_lapse"],
                "reps": result["reps"],
                "lapses": result["lapses"],
            }
        )
    card.refresh_from_db()
    rebuild = memory_service.rebuild_card_from_logs(card)
    return {
        "card": {
            "phase": card.phase,
            "reps": card.reps,
            "lapses": card.lapses,
            "learning_step": card.learning_step,
            "scheduler_version": card.scheduler_version,
            "params_version": card.params_version,
            "desired_retention": card.desired_retention,
        },
        "reviews": reviews,
        "rebuild": {
            "matches": rebuild["matches"],
            "log_count": rebuild["log_count"],
            "compared_fields": rebuild["compared_fields"],
            "differing_fields": rebuild["differing_fields"],
            "unknown_params_versions": rebuild["unknown_params_versions"],
            "rebuilt": rebuild["rebuilt"],
            "stored": rebuild["stored"],
        },
    }


def main() -> int:
    setup_test_environment()
    old_name = connection.creation.create_test_db(verbosity=0, autoclobber=True)
    try:
        owner, project, subject, syllabus = build_world()
        search = search_vectors(owner, project, subject, syllabus)
        first_question = Question.objects.filter(subject=subject, display_label="判断-1").first()
        memory = memory_vectors(owner, project, subject, first_question)
    finally:
        from django.db import connections

        connections.close_all()
        connection.creation.destroy_test_db(old_name, verbosity=0)

    payload = {
        "generated_by": "dsh-plugin/scripts/gen_b8_learning_golden.py",
        "schema_version": 1,
        "tokenizer_version": TOKENIZER_VERSION,
        "tokenizer": [
            {"text": text, "tokens": tokenize(text), "term_frequencies": term_frequencies(tokenize(text))}
            for text in TOKENIZER_CORPUS
        ],
        "search": search,
        "memory": memory,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"tokenizer={len(payload['tokenizer'])} queries={len(search['queries'])} reviews={len(memory['reviews'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
