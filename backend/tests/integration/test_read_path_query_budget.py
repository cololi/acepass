"""W2 regression guard: the two hot list endpoints must not query per row.

``GET /projects/{id}/questions`` and ``GET /projects/{id}/practice-sessions`` are
the two read paths a real user hits constantly, and both used to issue a handful
of queries *per returned row* (current published version, latest version, trusted
answer key, knowledge mappings, item gate walk, item count, attempt count).

The guard here is deliberately written as *"the number of queries does not grow
when the fixture doubles"*, not as *"exactly N queries"*: a magic constant rots
whenever an unrelated query is added around the endpoint, while a dependency on
the row count is precisely the defect being fixed. A generous absolute ceiling
(``≤ 12``) is asserted next to it so a regression that reintroduces a constant
number of queries is caught too.

``test_*_payload_is_exactly`` pins the whole serialised payload (field set, field
order, values and row order) so "fewer queries" can never be bought with a
changed response, and ``test_practice_sessions_keep_the_per_item_gate`` pins the
verification gate that must stay a *per item* decision.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from apps.common.enums import (
    OriginType,
    QuestionType,
    QuestionVersionStatus,
    SessionMode,
    SessionStatus,
    VerificationStatus,
)
from apps.exams.models import ExamProject, Subject, SyllabusVersion
from apps.knowledge.models import KnowledgeNode, QuestionKnowledge
from apps.practice.models import Attempt, PracticeSession, SessionItem
from apps.question_bank.models import AnswerKeyVersion, Question, QuestionVersion

pytestmark = pytest.mark.django_db

#: Fixture instants are pinned so the golden payloads below are reproducible.
BASE_TIME = datetime(2026, 3, 1, 9, 0, tzinfo=UTC)
#: A mock exam that can never be "due" while this test exists.
FAR_FUTURE = datetime(2099, 1, 1, 0, 0, tzinfo=UTC)

#: Absolute ceiling for one list request (auth + scope + the list's own work).
QUERY_BUDGET = 12

#: The fixture's question identities, so the goldens below stay readable.
Q_PUBLISHED, Q_DRAFT, Q_EMPTY, Q_DISPUTED, Q_UNCHECKED, Q_MAPPED = 10, 11, 12, 13, 14, 15
#: The fixture's session identities.
S_PRACTICE, S_EXAM, S_FINISHED, S_OTHER = 20, 21, 22, 23


def _pk(value: int) -> uuid.UUID:
    return uuid.UUID(int=value)


def _ago(minutes: int) -> datetime:
    return BASE_TIME - timedelta(minutes=minutes)


# --------------------------------------------------------------------------
# fixture builders
# --------------------------------------------------------------------------
def _add_question(
    world: dict,
    *,
    qid: int,
    label: str,
    order: int,
    versions: list[dict],
    published: int | None,
    answer_keys: list[dict] | None = None,
    mappings: list[tuple[str, bool]] | None = None,
) -> Question:
    """One question identity plus its versions, keys and knowledge mappings.

    ``versions`` is ``[{"version": 1, "type": ..., "status": ...}, ...]``;
    ``published`` is the version number ``current_published_version`` points at.
    """
    question = Question.objects.create(
        id=_pk(qid),
        subject=world["subject"],
        display_label=label,
        origin_type=OriginType.DEMO,
        is_demo=True,
    )
    created: dict[int, QuestionVersion] = {}
    for spec in versions:
        created[spec["version"]] = QuestionVersion.objects.create(
            id=_pk(qid * 100 + spec["version"]),
            question=question,
            version=spec["version"],
            question_type=spec["type"],
            content={"blocks": [{"kind": "text", "text": label}]},
            status=spec["status"],
        )
    if published is not None:
        Question.objects.filter(id=question.id).update(current_published_version=created[published])
    for index, spec in enumerate(answer_keys or []):
        AnswerKeyVersion.objects.create(
            id=_pk(qid * 1000 + index),
            question_version=created[spec["of"]],
            version=index + 1,
            answer_payload={"kind": "single_choice", "correct_option_id": "opt_a"},
            verification_status=spec["status"],
            is_disputed=spec.get("disputed", False),
        )
    if mappings:
        mapping_version = published if published is not None else versions[-1]["version"]
        for index, (node_name, is_primary) in enumerate(mappings):
            QuestionKnowledge.objects.create(
                id=_pk(qid * 2000 + index),
                question_version=created[mapping_version],
                mapping_revision=1,
                node=world["nodes"][node_name],
                is_primary=is_primary,
            )
    Question.objects.filter(id=question.id).update(created_at=_ago(order))
    return question


def _add_session(
    world: dict,
    *,
    sid: int,
    order: int,
    mode: str,
    status: str,
    items: list[tuple[Question, bool]],
    exam_deadline: datetime | None = None,
) -> PracticeSession:
    """One practice session; ``items`` is ``[(question, has_attempt), ...]``."""
    session = PracticeSession.objects.create(
        id=_pk(sid),
        user=world["owner"],
        project=world["project"],
        subject=world["subject"],
        mode=mode,
        status=status,
        exam_deadline=exam_deadline,
    )
    for ordinal, (question, has_attempt) in enumerate(items, start=1):
        version = QuestionVersion.objects.filter(question=question).order_by("-version").first()
        item = SessionItem.objects.create(
            id=_pk(sid * 100 + ordinal),
            session=session,
            ordinal=ordinal,
            question_version=version,
            max_score=Decimal("2.00"),
        )
        if has_attempt:
            Attempt.objects.create(
                id=_pk(sid * 1000 + ordinal),
                session_item=item,
                user=world["owner"],
                project=world["project"],
                raw_answer={"kind": "single_choice", "option_id": "opt_a"},
                submitted_at=_ago(order),
            )
    PracticeSession.objects.filter(id=session.id).update(created_at=_ago(order))
    return session


def _build_questions(world: dict, *, first: int, count: int) -> list[Question]:
    """``count`` questions whose per-row work is as expensive as it gets."""
    letters = "abcdefghijklmnopqrstuvwxyz"
    created: list[Question] = []
    for step in range(count):
        created.append(
            _add_question(
                world,
                qid=first + step,
                label=f"读路径题-{letters[step]}",
                order=100 + step,
                versions=[
                    {"version": 1, "type": QuestionType.SINGLE_CHOICE, "status": QuestionVersionStatus.PUBLISHED},
                    {"version": 2, "type": QuestionType.MULTIPLE_CHOICE, "status": QuestionVersionStatus.DRAFT},
                ],
                published=1,
                answer_keys=[
                    {"of": 1, "status": VerificationStatus.CHECKED},
                    {"of": 2, "status": VerificationStatus.DISPUTED, "disputed": True},
                ],
                mappings=[("数与式", True), ("几何初步", False)],
            )
        )
    world["questions"].extend(created)
    return created


def _build_sessions(world: dict, *, first: int, count: int) -> list[PracticeSession]:
    """``count`` practice sessions, each with an item and half of them graded."""
    pool = world["versioned_questions"]
    created: list[PracticeSession] = []
    for step in range(count):
        question = pool[step % len(pool)]
        created.append(
            _add_session(
                world,
                sid=first + step,
                order=200 + step,
                mode=SessionMode.PRACTICE,
                status=SessionStatus.ACTIVE,
                items=[(question, step % 2 == 0)],
            )
        )
    world["sessions"].extend(created)
    return created


@pytest.fixture
def world(owner) -> dict:
    """A tiny but complete project: every branch of both list serialisers.

    Ids and timestamps are pinned, so the payloads below are exact and stable.
    """
    project = ExamProject.objects.create(id=_pk(1), owner=owner, name="读路径项目")
    subject = Subject.objects.create(
        id=_pk(2),
        project=project,
        name="科目一",
        display_order=1,
        total_score=Decimal("100.00"),
        pass_score=Decimal("60.00"),
    )
    syllabus = SyllabusVersion.objects.create(
        id=_pk(3), subject=subject, name="读路径大纲", version_label="v1", created_by=owner
    )
    #: ``display_order`` deliberately disagrees with the node ids, so the golden
    #: payload pins *which* ordering the mapping list is serialised in.
    node_a = KnowledgeNode.objects.create(
        id=_pk(4), syllabus_version=syllabus, canonical_name="数与式", display_order=1
    )
    node_b = KnowledgeNode.objects.create(
        id=_pk(5), syllabus_version=syllabus, canonical_name="几何初步", display_order=0
    )
    state: dict = {
        "owner": owner,
        "project": project,
        "subject": subject,
        "nodes": {"数与式": node_a, "几何初步": node_b},
        "questions": [],
        "sessions": [],
    }

    # 1. published v1 + a later draft v2: question_type comes from the published
    #    version, latest_version from the newest one. A checked key hides behind a
    #    disputed newer one.
    q_published = _add_question(
        state,
        qid=Q_PUBLISHED,
        label="单选-已发布含最新草稿",
        order=0,
        versions=[
            {"version": 1, "type": QuestionType.SINGLE_CHOICE, "status": QuestionVersionStatus.PUBLISHED},
            {"version": 2, "type": QuestionType.MULTIPLE_CHOICE, "status": QuestionVersionStatus.DRAFT},
        ],
        published=1,
        answer_keys=[
            {"of": 1, "status": VerificationStatus.CHECKED},
            {"of": 2, "status": VerificationStatus.DISPUTED, "disputed": True},
        ],
        mappings=[("数与式", True), ("几何初步", False)],
    )
    # 2. draft only: no published version, type taken from the latest version.
    q_draft = _add_question(
        state,
        qid=Q_DRAFT,
        label="多选-仅草稿",
        order=1,
        versions=[
            {"version": 1, "type": QuestionType.MULTIPLE_CHOICE, "status": QuestionVersionStatus.DRAFT},
        ],
        published=None,
    )
    # 3. no version at all.
    q_empty = _add_question(state, qid=Q_EMPTY, label="无版本", order=2, versions=[], published=None)
    # 4. published, but its only key is disputed.
    q_disputed = _add_question(
        state,
        qid=Q_DISPUTED,
        label="单选-答案有争议",
        order=3,
        versions=[
            {"version": 1, "type": QuestionType.SINGLE_CHOICE, "status": QuestionVersionStatus.PUBLISHED},
        ],
        published=1,
        answer_keys=[{"of": 1, "status": VerificationStatus.DISPUTED, "disputed": True}],
    )
    # 5. published, key not checked yet.
    q_unchecked = _add_question(
        state,
        qid=Q_UNCHECKED,
        label="单选-答案待核对",
        order=4,
        versions=[
            {"version": 1, "type": QuestionType.SINGLE_CHOICE, "status": QuestionVersionStatus.PUBLISHED},
        ],
        published=1,
        answer_keys=[{"of": 1, "status": VerificationStatus.PENDING}],
    )
    # 6. published with two primary mappings, created in reverse node order: the
    #    payload must come back in the queryset's own (node) order.
    q_mapped = _add_question(
        state,
        qid=Q_MAPPED,
        label="单选-双主考点",
        order=5,
        versions=[
            {"version": 1, "type": QuestionType.SINGLE_CHOICE, "status": QuestionVersionStatus.PUBLISHED},
        ],
        published=1,
        answer_keys=[{"of": 1, "status": VerificationStatus.CHECKED}],
        mappings=[("几何初步", True), ("数与式", True)],
    )
    state["questions"].extend([q_published, q_draft, q_empty, q_disputed, q_unchecked, q_mapped])
    #: Questions that actually carry a version (a session item needs one).
    state["versioned_questions"] = [q_published, q_draft, q_disputed, q_unchecked, q_mapped]
    state["key_questions"] = {
        "published": q_published,
        "draft": q_draft,
        "empty": q_empty,
        "disputed": q_disputed,
        "unchecked": q_unchecked,
        "mapped": q_mapped,
    }

    # Sessions: an active practice run with a graded item, an active mock exam
    # (hides grading by mode), a finished run, and a second active practice run on
    # unrelated content (the per-item gate must leave it alone).
    state["key_sessions"] = {
        "practice": _add_session(
            state,
            sid=S_PRACTICE,
            order=0,
            mode=SessionMode.PRACTICE,
            status=SessionStatus.ACTIVE,
            items=[(q_published, True), (q_mapped, False)],
        ),
        "exam": _add_session(
            state,
            sid=S_EXAM,
            order=1,
            mode=SessionMode.MOCK_EXAM,
            status=SessionStatus.ACTIVE,
            items=[(q_mapped, False)],
            exam_deadline=FAR_FUTURE,
        ),
        "finished": _add_session(
            state,
            sid=S_FINISHED,
            order=2,
            mode=SessionMode.PRACTICE,
            status=SessionStatus.FINISHED,
            items=[(q_published, True)],
        ),
        "other": _add_session(
            state,
            sid=S_OTHER,
            order=3,
            mode=SessionMode.PRACTICE,
            status=SessionStatus.ACTIVE,
            items=[(q_unchecked, False)],
        ),
    }
    state["sessions"].extend(state["key_sessions"].values())
    return state


def _queries(factory):
    with CaptureQueriesContext(connection) as captured:
        result = factory()
    return result, len(captured.captured_queries)


def _questions_url(world: dict) -> str:
    return f"/api/v1/projects/{world['project'].id}/questions?limit=50"


def _sessions_url(world: dict) -> str:
    return f"/api/v1/projects/{world['project'].id}/practice-sessions?limit=50"


# --------------------------------------------------------------------------
# query budget: independent of the number of rows
# --------------------------------------------------------------------------
def test_questions_list_query_count_does_not_grow_with_rows(api, world):
    first, small_queries = _queries(lambda: api.get(_questions_url(world)))
    assert first.status_code == 200
    small_rows = len(first.json())
    assert small_rows == len(world["questions"])

    _build_questions(world, first=100, count=small_rows)

    second, big_queries = _queries(lambda: api.get(_questions_url(world)))
    assert second.status_code == 200
    assert len(second.json()) == small_rows * 2, "the fixture must actually double the rows"
    assert big_queries == small_queries, (
        f"questions_list issued {small_queries} queries for {small_rows} rows and "
        f"{big_queries} for {small_rows * 2} rows: the endpoint still queries per row"
    )
    assert big_queries <= QUERY_BUDGET, f"questions_list {big_queries} queries > budget {QUERY_BUDGET}"


def test_practice_sessions_list_query_count_does_not_grow_with_rows(api, world):
    first, small_queries = _queries(lambda: api.get(_sessions_url(world)))
    assert first.status_code == 200
    small_rows = len(first.json())
    assert small_rows == len(world["sessions"])

    _build_sessions(world, first=100, count=small_rows)

    second, big_queries = _queries(lambda: api.get(_sessions_url(world)))
    assert second.status_code == 200
    assert len(second.json()) == small_rows * 2, "the fixture must actually double the rows"
    assert big_queries == small_queries, (
        f"practice_sessions_list issued {small_queries} queries for {small_rows} rows and "
        f"{big_queries} for {small_rows * 2} rows: the endpoint still queries per row"
    )
    assert big_queries <= QUERY_BUDGET, f"practice_sessions_list {big_queries} queries > budget {QUERY_BUDGET}"


# --------------------------------------------------------------------------
# semantics that must survive the optimisation
# --------------------------------------------------------------------------
def test_practice_sessions_keep_the_per_item_gate(api, world):
    """A running verification hides only the content it actually covers."""
    before = {row["session_id"]: row for row in api.get(_sessions_url(world)).json()}
    assert before[str(world["key_sessions"]["practice"].id)]["grading_hidden"] is False
    assert before[str(world["key_sessions"]["other"].id)]["grading_hidden"] is False
    assert before[str(world["key_sessions"]["exam"].id)]["grading_hidden"] is True

    # A verification run that has presented the first practice session's question.
    verification = _add_session(
        world,
        sid=30,
        order=90,
        mode=SessionMode.VERIFICATION,
        status=SessionStatus.ACTIVE,
        items=[(world["key_questions"]["published"], False)],
    )
    SessionItem.objects.filter(session=verification).update(first_delivered_at=_ago(91))

    after = {row["session_id"]: row for row in api.get(_sessions_url(world)).json()}
    assert after[str(world["key_sessions"]["practice"].id)]["grading_hidden"] is True, (
        "an item covered by a running verification must still be withheld"
    )
    assert after[str(world["key_sessions"]["other"].id)]["grading_hidden"] is False, (
        "the gate is per item: unrelated content must not be withheld"
    )


def test_empty_session_and_page_past_the_end(api, world):
    """The annotated counts and the prefetch must behave on the empty edges."""
    empty = _add_session(
        world,
        sid=40,
        order=50,
        mode=SessionMode.PRACTICE,
        status=SessionStatus.ACTIVE,
        items=[],
    )
    row = next(row for row in api.get(_sessions_url(world)).json() if row["session_id"] == str(empty.id))
    assert row["item_count"] == 0
    assert row["submitted_count"] == 0
    assert row["grading_hidden"] is False

    # A page past the end (questions paginate) and a subject with no run at all
    # (sessions do not paginate) both short-circuit before the prefetch runs.
    project_id = world["project"].id
    assert api.get(f"/api/v1/projects/{project_id}/questions?limit=5&offset=500").json() == []
    empty_subject = Subject.objects.create(id=_pk(6), project=world["project"], name="空科目", display_order=2)
    empty_page = api.get(f"/api/v1/projects/{project_id}/practice-sessions?limit=5&subject_id={empty_subject.id}")
    assert empty_page.json() == []


# --------------------------------------------------------------------------
# golden payloads: field set, field order, values and row order
# --------------------------------------------------------------------------
def _question_row(
    *,
    qid: int,
    label: str,
    question_type: str | None,
    published_version: int | None,
    latest_version: int | None,
    has_trusted_answer: bool,
    knowledge_nodes: list[str],
) -> dict:
    return {
        "id": str(_pk(qid)),
        "subject_id": str(_pk(2)),
        "display_label": label,
        "origin_type": "demo",
        "is_demo": True,
        "question_type": question_type,
        "published_version_id": str(_pk(published_version)) if published_version else None,
        "latest_version": latest_version,
        "has_trusted_answer": has_trusted_answer,
        "knowledge_nodes": knowledge_nodes,
    }


def _session_row(
    *,
    sid: int,
    mode: str,
    status: str,
    order: int,
    item_count: int,
    submitted_count: int,
    grading_hidden: bool,
    exam_deadline: datetime | None = None,
) -> dict:
    return {
        "session_id": str(_pk(sid)),
        "subject_id": str(_pk(2)),
        "mode": mode,
        "status": status,
        "created_at": _ago(order).isoformat(),
        "item_count": item_count,
        "submitted_count": submitted_count,
        "grading_hidden": grading_hidden,
        "exam_deadline": exam_deadline.isoformat() if exam_deadline else None,
        "expired_at": None,
    }


EXPECTED_QUESTIONS = [
    _question_row(
        qid=Q_PUBLISHED,
        label="单选-已发布含最新草稿",
        question_type="single_choice",
        published_version=Q_PUBLISHED * 100 + 1,
        latest_version=2,
        has_trusted_answer=True,
        knowledge_nodes=["数与式"],
    ),
    _question_row(
        qid=Q_DRAFT,
        label="多选-仅草稿",
        question_type="multiple_choice",
        published_version=None,
        latest_version=1,
        has_trusted_answer=False,
        knowledge_nodes=[],
    ),
    _question_row(
        qid=Q_EMPTY,
        label="无版本",
        question_type=None,
        published_version=None,
        latest_version=None,
        has_trusted_answer=False,
        knowledge_nodes=[],
    ),
    _question_row(
        qid=Q_DISPUTED,
        label="单选-答案有争议",
        question_type="single_choice",
        published_version=Q_DISPUTED * 100 + 1,
        latest_version=1,
        has_trusted_answer=False,
        knowledge_nodes=[],
    ),
    _question_row(
        qid=Q_UNCHECKED,
        label="单选-答案待核对",
        question_type="single_choice",
        published_version=Q_UNCHECKED * 100 + 1,
        latest_version=1,
        has_trusted_answer=False,
        knowledge_nodes=[],
    ),
    _question_row(
        qid=Q_MAPPED,
        label="单选-双主考点",
        question_type="single_choice",
        published_version=Q_MAPPED * 100 + 1,
        latest_version=1,
        has_trusted_answer=True,
        #: KnowledgeNode.Meta.ordering is (syllabus_version, display_order,
        #: canonical_name) and the mapping queryset orders by node, so this is
        #: display order — *not* node id and *not* insertion order.
        knowledge_nodes=["几何初步", "数与式"],
    ),
]

EXPECTED_SESSIONS = [
    _session_row(
        sid=S_PRACTICE,
        mode="practice",
        status="active",
        order=0,
        item_count=2,
        submitted_count=1,
        grading_hidden=False,
    ),
    _session_row(
        sid=S_EXAM,
        mode="mock_exam",
        status="active",
        order=1,
        item_count=1,
        submitted_count=0,
        grading_hidden=True,
        exam_deadline=FAR_FUTURE,
    ),
    _session_row(
        sid=S_FINISHED,
        mode="practice",
        status="finished",
        order=2,
        item_count=1,
        submitted_count=1,
        grading_hidden=False,
    ),
    _session_row(
        sid=S_OTHER,
        mode="practice",
        status="active",
        order=3,
        item_count=1,
        submitted_count=0,
        grading_hidden=False,
    ),
]


def test_questions_list_payload_is_exactly(api, world):
    body = api.get(_questions_url(world)).json()
    assert body == EXPECTED_QUESTIONS
    # Key order is part of the contract too (the schema below is serialised
    # positionally), so pin it rather than relying on dict equality.
    assert list(body[0]) == list(EXPECTED_QUESTIONS[0])


def test_practice_sessions_list_payload_is_exactly(api, world):
    body = api.get(_sessions_url(world)).json()
    assert body == EXPECTED_SESSIONS
    assert list(body[0]) == list(EXPECTED_SESSIONS[0])
