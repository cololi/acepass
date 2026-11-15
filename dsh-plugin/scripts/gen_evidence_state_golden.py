"""Golden vectors for the evidence and knowledge-state rule functions.

The oracle is the real Python code, not a re-implementation: `compute_dimensions()`,
`refresh_node_state()` and the small helpers are imported unchanged from
`apps.learning.services.evidence` / `.state`, and the *storage* they sit on is replaced by an
in-memory fake object graph (exposure log, evidence table, anchors, contamination, state row).

That keeps the split honest: what is being pinned is the decision logic, which is exactly what
the Node port re-implements; the SQL is Phase 2 work.

The harness also patches `timezone.now` and `settings.DELAYED_VERIFICATION_HOURS` so every
vector is reproducible.
"""
import datetime as dt
import json
import os
import random
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
import django  # noqa: E402
from django.conf import settings  # noqa: E402
from decimal import Decimal  # noqa: E402

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.test")
django.setup()

from apps.common.enums import (  # noqa: E402
    EvidenceDimension,
    GradeMethod,
    GradeStatus,
    KnowledgeStateSummary,
    SessionMode,
    SessionStatus,
)
from apps.learning.services import anchors as anchors_mod  # noqa: E402
from apps.learning.services import evidence as ev  # noqa: E402
from apps.learning.services import state as st  # noqa: E402

UTC = dt.timezone.utc
BASE = dt.datetime(2026, 1, 1, tzinfo=UTC)

rng = random.Random(20260101)


# --------------------------------------------------------------------------- fakes


class FakeQuery:
    """Minimal stand-in for a queryset: chainable, and `exists()`/`__iter__` are preset."""

    def __init__(self, *, rows=None, exists=None, on_filter=None):
        self._rows = rows or []
        self._exists = exists
        self._on_filter = on_filter

    def filter(self, **kwargs):
        if self._on_filter is not None:
            return self._on_filter(kwargs)
        return self

    def exclude(self, **kwargs):
        return self

    def select_related(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def exists(self):
        return bool(self._exists)

    def __iter__(self):
        return iter(self._rows)

    def __len__(self):
        return len(self._rows)


class FakeManager:
    def __init__(self, factory):
        self._factory = factory

    def filter(self, **kwargs):
        return self._factory(kwargs)


def dt_at(hours):
    return BASE + dt.timedelta(seconds=int(round(hours * 3600)))


def dt_iso(value):
    return None if value is None else value.isoformat()


# --------------------------------------------------------------------- node / graph


class FakeNode:
    def __init__(self, node_id, canonical_name, syllabus_version_id="sv1"):
        self.id = node_id
        self.canonical_name = canonical_name
        self.syllabus_version_id = syllabus_version_id
        self.syllabus_version = SimpleNamespace(id=syllabus_version_id, is_user_provisional=False)


class FakeMapping:
    def __init__(self, node, template, mapping_revision="r1"):
        self.node = node
        self.template = template
        self.mapping_revision = mapping_revision


class FakeMappings:
    def __init__(self, mappings, *, by_revision):
        self._all = mappings
        self._by_revision = by_revision

    def filter(self, **kwargs):
        return FakeMappings(self._all, by_revision=True) if self._by_revision else FakeMappings([], by_revision=True)

    def select_related(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def __iter__(self):
        return iter(self._all)


class FakeExposures:
    """Exposure log: only the two queries `_pre_submit_assistance` makes are modelled."""

    def __init__(self, kinds, hint):
        self._kinds = kinds
        self._hint = hint

    def filter(self, **kwargs):
        if "reveals_answer" in kwargs:
            rows = [SimpleNamespace(kind=k) for k in self._kinds]
            return FakeQuery(rows=rows, exists=bool(rows))
        if "kind__in" in kwargs:
            return FakeQuery(rows=[], exists=self._hint)
        raise AssertionError(f"unexpected exposure query: {sorted(kwargs)}")


def build_attempt(spec, *, same_template_other, contamination_rows):
    """Assemble the faked object graph `compute_dimensions` walks."""
    grade_spec = spec["grade"]
    if grade_spec is None:
        grade = None
    else:
        grade = SimpleNamespace(
            status=grade_spec["status"],
            is_fully_confirmed=grade_spec["is_fully_confirmed"],
            confirmed_score=None if grade_spec["confirmed_score"] is None else Decimal(grade_spec["confirmed_score"]),
            max_score=None if grade_spec["max_score"] is None else Decimal(grade_spec["max_score"]),
            grader_is_self=grade_spec["grader_is_self"],
            method=grade_spec["method"],
        )

    session = SimpleNamespace(
        mode=spec["session"]["mode"],
        status=spec["session"]["status"],
        origin_task_id=spec["session"].get("origin_task_id"),
    )
    answer_key = SimpleNamespace(is_usable=spec["answer_key_usable"])
    question = SimpleNamespace(
        id="q1",
        family=None if spec.get("family") is None else SimpleNamespace(
            id=spec["family"], relation_confirmed=True, questions=FakeQuery(exists=spec["family_has_other_questions"])
        ),
        family_id=spec.get("family_id"),
        subject=None,
    )
    question_version = SimpleNamespace(
        id="qv1",
        question_id=spec["question_id"],
        question=question,
        knowledge_mappings=FakeMappings(spec["_mappings"], by_revision=True),
    )
    session_item = SimpleNamespace(
        first_delivered_at=None if spec.get("first_delivered_at") is None else dt.datetime.fromisoformat(spec["first_delivered_at"]),
        question_version_id="qv1",
        question_version=question_version,
        session=session,
        mapping_revision=spec.get("mapping_revision", "r1"),
        answer_key_version=answer_key,
        purpose=spec.get("purpose", "practice"),
        answer_key_version_id="akv1",
    )
    attempt = SimpleNamespace(
        id="attempt1",
        user="user1",
        project_id="project1",
        submitted_at=dt.datetime.fromisoformat(spec["submitted_at"]),
        elapsed_ms=spec["elapsed_ms"],
        session_item=session_item,
        current_grade_event=grade,
        grading_revision=1 if grade is not None else 0,
    )
    return attempt


# ---------------------------------------------------------------- patch the storage


class Patched:
    def __init__(self, *, same_template_other, contamination_rows, exposure_kinds, hint, anchor, delay_hours):
        self.same_template_other = same_template_other
        self.contamination_rows = contamination_rows
        self.exposure_kinds = exposure_kinds
        self.hint = hint
        self.anchor = anchor
        self.delay_hours = delay_hours
        self._saved = {}

    def __enter__(self):
        self._saved["LE"] = ev.LearningEvidence
        self._saved["EX"] = ev.ExposureEvent
        self._saved["contam"] = ev.contamination.attempt_exclusion_reasons
        self._saved["anchor"] = anchors_mod.latest_learning_anchor
        self._saved["hours"] = getattr(settings, "DELAYED_VERIFICATION_HOURS", 24)

        ev.LearningEvidence = SimpleNamespace(objects=FakeManager(lambda kw: FakeQuery(exists=self.same_template_other)))
        ev.ExposureEvent = SimpleNamespace(objects=FakeManager(lambda kw: FakeExposures(self.exposure_kinds, self.hint).filter(**kw)))
        ev.contamination.attempt_exclusion_reasons = lambda attempt=None: list(self.contamination_rows)
        anchors_mod.latest_learning_anchor = lambda **kwargs: self.anchor
        settings.DELAYED_VERIFICATION_HOURS = self.delay_hours
        return self

    def __exit__(self, *exc):
        ev.LearningEvidence = self._saved["LE"]
        ev.ExposureEvent = self._saved["EX"]
        ev.contamination.attempt_exclusion_reasons = self._saved["contam"]
        anchors_mod.latest_learning_anchor = self._saved["anchor"]
        settings.DELAYED_VERIFICATION_HOURS = self._saved["hours"]
        return False


def jsonable(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dt.datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


# ----------------------------------------------------------------- compute_dimensions

GRADES = [
    None,
    {"status": GradeStatus.CONFIRMED, "is_fully_confirmed": True, "confirmed_score": "2.00", "max_score": "2.00", "grader_is_self": False, "method": GradeMethod.DETERMINISTIC},
    {"status": GradeStatus.CONFIRMED, "is_fully_confirmed": True, "confirmed_score": "1.00", "max_score": "2.00", "grader_is_self": False, "method": GradeMethod.DETERMINISTIC},
    {"status": GradeStatus.CONFIRMED, "is_fully_confirmed": True, "confirmed_score": "0.00", "max_score": "2.00", "grader_is_self": False, "method": GradeMethod.DETERMINISTIC},
    {"status": GradeStatus.CONFIRMED, "is_fully_confirmed": True, "confirmed_score": "2.00", "max_score": "2.00", "grader_is_self": True, "method": GradeMethod.SELF_CONFIRMED},
    {"status": GradeStatus.CONFIRMED, "is_fully_confirmed": True, "confirmed_score": "2.00", "max_score": "2.00", "grader_is_self": False, "method": GradeMethod.AI_ESTIMATED},
    {"status": GradeStatus.PENDING_REVIEW, "is_fully_confirmed": False, "confirmed_score": None, "max_score": "2.00", "grader_is_self": False, "method": GradeMethod.DETERMINISTIC},
    {"status": GradeStatus.ESTIMATED, "is_fully_confirmed": False, "confirmed_score": "2.00", "max_score": "2.00", "grader_is_self": False, "method": GradeMethod.AI_ESTIMATED},
    {"status": GradeStatus.CONFIRMED, "is_fully_confirmed": True, "confirmed_score": "2.00", "max_score": "0.00", "grader_is_self": False, "method": GradeMethod.DETERMINISTIC},
    {"status": GradeStatus.CONFIRMED, "is_fully_confirmed": True, "confirmed_score": "2.00", "max_score": None, "grader_is_self": False, "method": GradeMethod.DETERMINISTIC},
    # A negative maximum is nonsense data, but `is_grade_correct` has a specific guard for it
    # (`max_score <= 0`) that a fixture without it cannot see.
    {"status": GradeStatus.CONFIRMED, "is_fully_confirmed": True, "confirmed_score": "-2.00", "max_score": "-2.00", "grader_is_self": False, "method": GradeMethod.DETERMINISTIC},
    {"status": GradeStatus.CONFIRMED, "is_fully_confirmed": True, "confirmed_score": "1.00", "max_score": "-2.00", "grader_is_self": False, "method": GradeMethod.DETERMINISTIC},
    {"status": GradeStatus.CONFIRMED, "is_fully_confirmed": True, "confirmed_score": "1.50", "max_score": "1.50", "grader_is_self": False, "method": GradeMethod.MIXED},
]

SESSIONS = [
    {"mode": SessionMode.PRACTICE, "status": SessionStatus.FINISHED},
    {"mode": SessionMode.PRACTICE, "status": SessionStatus.ACTIVE},
    {"mode": SessionMode.VERIFICATION, "status": SessionStatus.ACTIVE},
    {"mode": SessionMode.VERIFICATION, "status": SessionStatus.FINISHED},
    {"mode": SessionMode.MOCK_EXAM, "status": SessionStatus.ACTIVE},
    {"mode": SessionMode.MOCK_EXAM, "status": SessionStatus.FINISHED},
    {"mode": SessionMode.PRACTICE, "status": SessionStatus.ABANDONED},
]

ASSISTANCE = [
    ([], False),
    ([], True),
    (["answer_delivered"], False),
    (["explanation_delivered", "answer_delivered"], False),
    (["answer_delivered", "answer_delivered", "hint_delivered"], True),
]

CONTAMINATIONS = [
    [],
    [{"code": "lineage_seen_in_other_project", "message": "该题在其他项目中已见过"}],
    [
        {"code": "proofread_preview", "message": "该题在录入校对预览中出现过"},
        {"code": "presented_never_submitted", "message": "该题此前已下发但未提交作答"},
    ],
]

ANCHORS = [
    (None, "none"),
    (dt_at(-1), "training"),
    (dt_at(-24), "first_presentation"),
    (BASE + dt.timedelta(hours=-24, microseconds=-1), "first_presentation"),
    (BASE + dt.timedelta(hours=-24, microseconds=1), "training"),
    (dt_at(-30), "training"),
    (dt_at(-0.5), "training"),
]

PURPOSES = ["practice", "delayed_verification", "verification"]

DIMENSION_CASES = []


def add_dimension_case(spec, *, same_template_other, contamination_rows, exposure_kinds, hint, anchor, delay_hours):
    spec["_mappings"] = [FakeMapping(FakeNode("n1", "考点一"), SimpleNamespace(id=spec["template_id"]) if spec.get("template_id") else None)]
    for key in ("template_id",):
        spec.pop(key, None)
    attempt = build_attempt(spec, same_template_other=same_template_other, contamination_rows=contamination_rows)
    with Patched(
        same_template_other=same_template_other,
        contamination_rows=contamination_rows,
        exposure_kinds=exposure_kinds,
        hint=hint,
        anchor=anchor,
        delay_hours=delay_hours,
    ):
        rows = ev.compute_dimensions(attempt)

    expected = [
        {
            "node_id": row["node"].id,
            "dimension": str(row["dimension"]),
            "qualifies": row["qualifies"],
            "is_correct": row["is_correct"],
            "score_fraction": None if row["score_fraction"] is None else str(row["score_fraction"]),
            "exclusion_reasons": list(row["exclusion_reasons"]),
            "detail": jsonable(row["detail"]),
        }
        for row in rows
    ]
    # The input the Node port receives: everything the fake resolved, nothing about the ORM.
    public_spec = {k: v for k, v in spec.items() if not k.startswith("_")}
    public_spec["mappings"] = [
        {
            "node_id": "n1",
            "node_name": "考点一",
            "template_id": spec.get("template_id_resolved"),
            "mapping_revision": spec.get("mapping_revision", "r1"),
        }
    ]
    public_spec["family_relation_confirmed"] = bool(spec.get("family"))
    public_spec["contamination"] = list(contamination_rows)
    public_spec["same_template_other_question"] = same_template_other
    public_spec["assistance"] = {"answer_revealing_kinds": list(exposure_kinds), "hint_before_submit": hint}
    public_spec["anchor"] = None if anchor is None else {"at": None if anchor[0] is None else anchor[0].isoformat(), "source": anchor[1]}
    public_spec["delay_hours"] = delay_hours
    DIMENSION_CASES.append({"input": jsonable(public_spec), "expected": {"rows": expected}})


FACTORS = {
    "grade": GRADES,
    "session": SESSIONS,
    "assistance": ASSISTANCE,
    "contamination": CONTAMINATIONS,
    "timing": [1500, 0, 1],
    "template": [(None, False), (None, True), ("t1", False), ("t1", True)],
    "family": [(None, False), (None, True), ("fam1", False), ("fam1", True)],
    "usable": [True, False],
    "anchor": ANCHORS,
    "purpose": PURPOSES,
}

# Every gate open at once: a fully-qualifying attempt. Single flips and pairwise flips from this
# base are what actually exercise the rules — a random sample almost never reaches them.
BASE_SELECTION = {
    "grade": 1,          # confirmed, full marks, deterministic
    "session": 0,        # practice / finished
    "assistance": 0,     # no exposure, no hint
    "contamination": 0,  # no exclusion reasons
    "timing": 0,         # elapsed_ms > 0
    "template": 3,       # template t1, another question on the same template
    "family": 0,         # no family -> not a near duplicate
    "usable": 0,         # answer key usable
    "anchor": 5,         # 30h ago -> past the 24h window
    "purpose": 1,        # delayed_verification
}


def build_spec(selection):
    grade = FACTORS["grade"][selection["grade"]]
    session = FACTORS["session"][selection["session"]]
    kinds, hint = FACTORS["assistance"][selection["assistance"]]
    contamination = FACTORS["contamination"][selection["contamination"]]
    elapsed = FACTORS["timing"][selection["timing"]]
    template_id, same_template = FACTORS["template"][selection["template"]]
    family, family_other = FACTORS["family"][selection["family"]]
    usable = FACTORS["usable"][selection["usable"]]
    anchor = FACTORS["anchor"][selection["anchor"]]
    purpose = FACTORS["purpose"][selection["purpose"]]

    spec = {
        "question_id": "q1",
        "elapsed_ms": elapsed,
        "submitted_at": (BASE - dt.timedelta(hours=1)).isoformat(),
        "first_delivered_at": (BASE - dt.timedelta(hours=3)).isoformat(),
        "answer_key_usable": usable,
        "session": dict(session),
        "purpose": purpose,
        "mapping_revision": "r1",
        "grade": grade,
        "family": family,
        "family_id": family,
        "family_has_other_questions": family_other,
        "template_id": template_id,
        "template_id_resolved": template_id,
    }
    add_dimension_case(
        spec,
        same_template_other=same_template,
        contamination_rows=contamination,
        exposure_kinds=kinds,
        hint=hint,
        anchor=anchor,
        delay_hours=24,
    )


def systematic_selections():
    """base + every single flip + every pair of flips (full pairwise coverage)."""
    keys = list(FACTORS)
    yield dict(BASE_SELECTION)
    for key in keys:
        for index in range(len(FACTORS[key])):
            if index == BASE_SELECTION[key]:
                continue
            yield {**BASE_SELECTION, key: index}
    for i, first in enumerate(keys):
        for second in keys[i + 1:]:
            for a in range(len(FACTORS[first])):
                if a == BASE_SELECTION[first]:
                    continue
                for b in range(len(FACTORS[second])):
                    if b == BASE_SELECTION[second]:
                        continue
                    yield {**BASE_SELECTION, first: a, second: b}


def sample_dimension_cases():
    for selection in systematic_selections():
        build_spec(selection)
    # A small random tail for combinations the systematic sweep does not reach.
    keys = list(FACTORS)
    for _ in range(90):
        selection = {k: rng.randrange(len(FACTORS[k])) for k in keys}
        build_spec(selection)


def boundary_cases():
    """The 24h boundary and the delivered-at/submitted-at fallback are called out by name."""
    for anchor_at, label in [
        (BASE + dt.timedelta(hours=-24), "exactly 24h"),
        (BASE + dt.timedelta(hours=-24, microseconds=-1), "1us short"),
        (BASE + dt.timedelta(hours=-24, microseconds=1), "1us over"),
        (BASE + dt.timedelta(hours=-23, minutes=-59, seconds=-59, microseconds=-999999), "1us short again"),
    ]:
        spec = {
            "question_id": "q1",
            "elapsed_ms": 1500,
            "submitted_at": BASE.isoformat(),
            "first_delivered_at": None,  # forces the submission fallback
            "answer_key_usable": True,
            "session": {"mode": SessionMode.VERIFICATION, "status": SessionStatus.FINISHED},
            "purpose": "delayed_verification",
            "mapping_revision": "r1",
            "grade": GRADES[1],
            "family": None,
            "family_id": None,
            "family_has_other_questions": False,
            "template_id": "t1",
            "template_id_resolved": "t1",
        }
        add_dimension_case(
            spec,
            same_template_other=False,
            contamination_rows=[],
            exposure_kinds=[],
            hint=False,
            anchor=(anchor_at, "training"),
            delay_hours=24,
        )
    # A custom delay window (config is not hard-coded to 24).
    for hours in [0, 1, 72]:
        spec = {
            "question_id": "q1",
            "elapsed_ms": 1500,
            "submitted_at": BASE.isoformat(),
            "first_delivered_at": (BASE - dt.timedelta(hours=48)).isoformat(),
            "answer_key_usable": True,
            "session": {"mode": SessionMode.PRACTICE, "status": SessionStatus.FINISHED},
            "purpose": "practice",
            "mapping_revision": "r1",
            "grade": GRADES[1],
            "family": "fam1",
            "family_id": "fam1",
            "family_has_other_questions": False,
            "template_id": None,
            "template_id_resolved": None,
        }
        add_dimension_case(
            spec,
            same_template_other=True,
            contamination_rows=[],
            exposure_kinds=[],
            hint=False,
            anchor=(BASE - dt.timedelta(hours=30), "training"),
            delay_hours=hours,
        )
    # No mappings at all -> no rows.
    spec = {
        "question_id": "q1",
        "elapsed_ms": 1500,
        "submitted_at": BASE.isoformat(),
        "first_delivered_at": None,
        "answer_key_usable": True,
        "session": {"mode": SessionMode.PRACTICE, "status": SessionStatus.FINISHED},
        "purpose": "practice",
        "mapping_revision": "r1",
        "grade": GRADES[1],
        "family": None,
        "family_id": None,
        "family_has_other_questions": False,
        "template_id": None,
        "template_id_resolved": None,
    }
    attempt = build_attempt({**spec, "_mappings": []}, same_template_other=False, contamination_rows=[])
    with Patched(same_template_other=False, contamination_rows=[], exposure_kinds=[], hint=False, anchor=(None, "none"), delay_hours=24):
        rows = ev.compute_dimensions(attempt)
    public = {k: v for k, v in spec.items() if not k.startswith("_")}
    public.update(
        mappings=[],
        contamination=[],
        same_template_other_question=False,
        assistance={"answer_revealing_kinds": [], "hint_before_submit": False},
        anchor=None,
        delay_hours=24,
    )
    DIMENSION_CASES.append({"input": jsonable(public), "expected": {"rows": []}})


# ------------------------------------------------------------- summary / helpers

SUMMARY_CASES = []
for independent_correct in range(0, 6):
    for distinct_questions in range(0, 6):
        for distinct_templates in range(0, 4):
            for has_delayed in [False, True]:
                for assisted_only in [False, True]:
                    for confirmed_gap in [False, True]:
                        for needs_review in [False, True]:
                            SUMMARY_CASES.append(
                                {
                                    "input": {
                                        "independent_correct": independent_correct,
                                        "distinct_questions": distinct_questions,
                                        "distinct_templates": distinct_templates,
                                        "has_delayed_correct": has_delayed,
                                        "assisted_only": assisted_only,
                                        "confirmed_gap": confirmed_gap,
                                        "needs_review": needs_review,
                                    },
                                    "expected": st._summary_from_counts(
                                        independent_correct=independent_correct,
                                        distinct_questions=distinct_questions,
                                        distinct_templates=distinct_templates,
                                        has_delayed_correct=has_delayed,
                                        assisted_only=assisted_only,
                                        confirmed_gap=confirmed_gap,
                                        needs_review=needs_review,
                                    ),
                                }
                            )

MISSING_CASES = [
    {
        "input": {"independent_correct": a, "distinct_templates": b, "has_delayed_correct": c},
        "expected": st._missing_evidence(independent_correct=a, distinct_templates=b, has_delayed_correct=c),
    }
    for a in range(0, 6)
    for b in range(0, 4)
    for c in [False, True]
]

GRADE_CORRECT_CASES = []
for grade_spec in GRADES:
    grade = build_attempt(
        {
            "question_id": "q1",
            "elapsed_ms": 1,
            "submitted_at": BASE.isoformat(),
            "first_delivered_at": None,
            "answer_key_usable": True,
            "session": {"mode": SessionMode.PRACTICE, "status": SessionStatus.FINISHED},
            "mapping_revision": "r1",
            "grade": grade_spec,
            "family": None,
            "family_id": None,
            "family_has_other_questions": False,
            "_mappings": [],
        },
        same_template_other=False,
        contamination_rows=[],
    ).current_grade_event
    GRADE_CORRECT_CASES.append({"input": grade_spec, "expected": ev.is_grade_correct(grade)})

FRACTION_CASES = []
for grade_spec in GRADES:
    grade = build_attempt(
        {
            "question_id": "q1",
            "elapsed_ms": 1,
            "submitted_at": BASE.isoformat(),
            "first_delivered_at": None,
            "answer_key_usable": True,
            "session": {"mode": SessionMode.PRACTICE, "status": SessionStatus.FINISHED},
            "mapping_revision": "r1",
            "grade": grade_spec,
            "family": None,
            "family_id": None,
            "family_has_other_questions": False,
            "_mappings": [],
        },
        same_template_other=False,
        contamination_rows=[],
    ).current_grade_event
    frac = ev._fraction(grade)
    FRACTION_CASES.append({"input": grade_spec, "expected": None if frac is None else str(frac)})
# A few scores whose fraction needs rounding under ROUND_HALF_EVEN / 4dp quantisation.
for score, maximum in [("1", "3"), ("2", "3"), ("1", "7"), ("0.00005", "1"), ("5", "6"), ("1", "8"), ("1", "-2"), ("-1", "-2"), ("-1", "3")]:
    grade = SimpleNamespace(confirmed_score=Decimal(score), max_score=Decimal(maximum))
    FRACTION_CASES.append(
        {
            "input": {"confirmed_score": score, "max_score": maximum},
            "expected": None if ev._fraction(grade) is None else str(ev._fraction(grade)),
        }
    )

CONFIRMATION_CASES = [
    {
        "input": {"mode": mode, "status": status},
        "expected": ev.confirmation_ok(SimpleNamespace(session=SimpleNamespace(mode=mode, status=status))),
    }
    for mode in [SessionMode.PRACTICE, SessionMode.VERIFICATION, SessionMode.MOCK_EXAM]
    for status in [SessionStatus.ACTIVE, SessionStatus.FINISHED, SessionStatus.ABANDONED]
]

# --------------------------------------------------------------- refresh_node_state


class FakeEvidenceRow:
    def __init__(self, *, row_id, dimension, qualifies, is_correct, grade_event_id, template_id, computed_at, question_id, attempt_id):
        self.id = row_id
        self.dimension = dimension
        self.qualifies = qualifies
        self.is_correct = is_correct
        self.grade_event_id = grade_event_id
        self.detail = {} if template_id is None else {"template_id": template_id}
        self.computed_at = computed_at
        self.attempt_id = attempt_id
        self.exclusion_reasons = []
        self.attempt = SimpleNamespace(session_item=SimpleNamespace(question_version=SimpleNamespace(question_id=question_id)))


class FakeState:
    def __init__(self, summary, best_summary):
        self.summary = summary
        self.best_summary = best_summary
        self.as_of = BASE
        self.detail = {}
        self.source_evidence_ids = []
        self.rule_version = None
        self.downgrade_reason = ""
        self.saved = False

    def save(self):
        self.saved = True

    def to_dict(self):
        return jsonable(
            {
                "summary": self.summary,
                "best_summary": self.best_summary,
                "independent_correct_count": self.independent_correct_count,
                "distinct_question_count": self.distinct_question_count,
                "distinct_template_count": self.distinct_template_count,
                "has_delayed_correct": self.has_delayed_correct,
                "recent_independent_attempts": self.recent_independent_attempts,
                "recent_independent_failures": self.recent_independent_failures,
                "needs_review": self.needs_review,
                "downgrade_reason": self.downgrade_reason,
                "rule_version": self.rule_version,
                "source_evidence_ids": self.source_evidence_ids,
                "detail": self.detail,
                "saved": self.saved,
            }
        )


def build_evidence_rows(rows_spec):
    rows = []
    for index, spec in enumerate(rows_spec):
        rows.append(
            FakeEvidenceRow(
                row_id=spec.get("id", f"e{index}"),
                dimension=spec["dimension"],
                qualifies=spec["qualifies"],
                is_correct=spec["is_correct"],
                grade_event_id=spec.get("grade_event_id"),
                template_id=spec.get("template_id"),
                computed_at=dt.datetime.fromisoformat(spec["computed_at"]),
                question_id=spec.get("question_id", "q1"),
                attempt_id=spec.get("attempt_id", f"a{index}"),
            )
        )
    return rows


def run_state_case(rows_spec, prev_summary, prev_best, *, delay_hours=24):
    node = FakeNode("n1", "考点一")
    rows = build_evidence_rows(rows_spec)
    fake_state = FakeState(prev_summary, prev_best)
    saved = {}
    saved["LE"] = st.LearningEvidence
    saved["LKS"] = st.LearnerKnowledgeState
    saved["now"] = st.timezone.now

    st.LearningEvidence = SimpleNamespace(objects=FakeManager(lambda kw: FakeQuery(rows=rows)))
    st.LearnerKnowledgeState = SimpleNamespace(objects=SimpleNamespace(get_or_create=lambda **kw: (fake_state, False)))
    st.timezone.now = lambda: BASE
    import apps.knowledge.models as knowledge_models

    saved["km"] = knowledge_models.KnowledgeNode
    knowledge_models.KnowledgeNode = FakeNode
    try:
        result = st.refresh_node_state(user="user1", project="project1", syllabus_version="sv1", node=node)
        return result.to_dict()
    finally:
        st.LearningEvidence = saved["LE"]
        st.LearnerKnowledgeState = saved["LKS"]
        st.timezone.now = saved["now"]
        knowledge_models.KnowledgeNode = saved["km"]


STATE_CASES = []
STATE_SUMMARY_ORDER = [
    KnowledgeStateSummary.UNDIAGNOSED,
    KnowledgeStateSummary.NEEDS_FOUNDATION,
    KnowledgeStateSummary.COMPLETES_WITH_HINTS,
    KnowledgeStateSummary.INDEPENDENT,
    KnowledgeStateSummary.HANDLES_UNSEEN,
    KnowledgeStateSummary.DELAYED_VERIFIED,
]

STATE_ROW_POOL = []


def row(dimension, qualifies, is_correct, *, grade_event_id="g1", template_id=None, computed_at="2026-01-01T00:00:00+00:00", question_id="q1"):
    return {
        "dimension": dimension,
        "qualifies": qualifies,
        "is_correct": is_correct,
        "grade_event_id": grade_event_id,
        "template_id": template_id,
        "computed_at": computed_at,
        "question_id": question_id,
    }


INV = EvidenceDimension.INDEPENDENT_CORRECT
DEL = EvidenceDimension.DELAYED_VERIFICATION
UNA = EvidenceDimension.UNASSISTED_COMPLETION
REP = EvidenceDimension.REPEAT_PRACTICE

STATE_ROW_POOL = [
    [],
    [row(INV, True, True)],
    [row(INV, True, True, template_id="t1", question_id="q1")],
    [row(INV, True, True, template_id="t1", question_id="q1"), row(INV, True, True, template_id="t1", question_id="q2")],
    [
        row(INV, True, True, template_id="t1", question_id="q1"),
        row(INV, True, True, template_id="t2", question_id="q2"),
        row(INV, True, True, template_id="t2", question_id="q3"),
    ],
    [
        row(INV, True, True, template_id="t1", question_id="q1"),
        row(INV, True, True, template_id="t1", question_id="q2"),
        row(INV, True, True, template_id="t1", question_id="q3"),
        row(DEL, True, True),
    ],
    [
        row(INV, True, True, template_id="t2", question_id="q1"),
        row(INV, True, True, template_id="t2", question_id="q2"),
        row(INV, True, True, template_id="t2", question_id="q3"),
        row(DEL, True, True),
    ],
    # recent-window: 3 independent rows, newest two wrong -> needs_review
    [
        row(INV, True, True, template_id="t1", question_id="q1", computed_at="2026-01-01T00:00:00+00:00"),
        row(INV, True, False, template_id="t1", question_id="q2", computed_at="2026-01-01T01:00:00+00:00"),
        row(INV, True, False, template_id="t1", question_id="q3", computed_at="2026-01-01T02:00:00+00:00"),
        row(DEL, True, True),
    ],
    # only one failure in the window -> no downgrade
    [
        row(INV, True, True, template_id="t1", question_id="q1", computed_at="2026-01-01T00:00:00+00:00"),
        row(INV, True, True, template_id="t1", question_id="q2", computed_at="2026-01-01T01:00:00+00:00"),
        row(INV, True, False, template_id="t1", question_id="q3", computed_at="2026-01-01T02:00:00+00:00"),
    ],
    # window of 2 rows, both wrong -> needs_review but independent_correct == 0
    [
        row(INV, True, False, question_id="q1", computed_at="2026-01-01T00:00:00+00:00"),
        row(INV, True, False, question_id="q2", computed_at="2026-01-01T01:00:00+00:00"),
    ],
    # old failures beyond the recent window must not count
    [
        row(INV, True, False, question_id="q1", computed_at="2025-12-01T00:00:00+00:00"),
        row(INV, True, False, question_id="q2", computed_at="2025-12-02T00:00:00+00:00"),
        row(INV, True, True, question_id="q3", template_id="t1", computed_at="2026-01-01T01:00:00+00:00"),
        row(INV, True, True, question_id="q4", template_id="t1", computed_at="2026-01-01T02:00:00+00:00"),
        row(INV, True, True, question_id="q5", template_id="t2", computed_at="2026-01-01T03:00:00+00:00"),
    ],
    # ties on computed_at: the stable-sort order decides which rows are "recent"
    [
        row(INV, True, False, question_id="q1", computed_at="2026-01-01T00:00:00+00:00"),
        row(INV, True, True, question_id="q2", template_id="t1", computed_at="2026-01-01T00:00:00+00:00"),
        row(INV, True, False, question_id="q3", computed_at="2026-01-01T00:00:00+00:00"),
        row(INV, True, True, question_id="q4", template_id="t1", computed_at="2026-01-01T00:00:00+00:00"),
    ],
    # non-qualifying independent rows still count towards distinct questions? no -> only qualified
    [
        row(INV, False, True, question_id="q1", template_id="t1"),
        row(INV, True, True, question_id="q2", template_id="t1"),
    ],
    # assisted-only: unassisted_completion wrong-but-correct-flag combo
    [row(UNA, False, True)],
    [row(UNA, False, True), row(INV, True, True, question_id="q2", template_id="t1")],
    # confirmed gap
    [row(UNA, False, False)],
    [row(UNA, False, False, grade_event_id=None)],
    [row(REP, True, False)],
    [row(REP, True, False, grade_event_id=None)],
    [row(REP, True, None)],
    # template ids that are not strings (str() of a truthy non-str still groups)
    [row(INV, True, True, template_id="7", question_id="q1"), row(INV, True, True, template_id="7", question_id="q2")],
    # delayed rows that do not qualify
    [row(DEL, False, True)],
    # more than 200 evidence ids -> truncation
    [row(INV, True, True, question_id=f"q{i}", template_id="t1", computed_at=f"2026-01-01T{i % 24:02d}:00:00+00:00") for i in range(210)],
]

for rows_spec in STATE_ROW_POOL:
    for prev_summary, prev_best in [
        (KnowledgeStateSummary.UNDIAGNOSED, KnowledgeStateSummary.UNDIAGNOSED),
        (KnowledgeStateSummary.INDEPENDENT, KnowledgeStateSummary.INDEPENDENT),
        (KnowledgeStateSummary.NEEDS_REVIEW, KnowledgeStateSummary.DELAYED_VERIFIED),
        (KnowledgeStateSummary.DELAYED_VERIFIED, KnowledgeStateSummary.DELAYED_VERIFIED),
        (KnowledgeStateSummary.NEEDS_FOUNDATION, KnowledgeStateSummary.HANDLES_UNSEEN),
        (KnowledgeStateSummary.HANDLES_UNSEEN, KnowledgeStateSummary.UNDIAGNOSED),
    ]:
        expected = run_state_case(rows_spec, prev_summary, prev_best)
        STATE_CASES.append(
            {
                "input": {"rows": jsonable(rows_spec), "prev_summary": str(prev_summary), "prev_best_summary": str(prev_best)},
                "expected": expected,
            }
        )

# A random state sweep so the summary/ordering interactions are covered beyond the pool.
for _ in range(150):
    n = rng.randint(0, 9)
    rows_spec = []
    for i in range(n):
        dimension = rng.choice([INV, INV, INV, DEL, UNA, REP])
        rows_spec.append(
            row(
                dimension,
                rng.choice([True, False]),
                rng.choice([True, False, None]),
                grade_event_id=rng.choice(["g1", None]),
                template_id=rng.choice([None, "t1", "t2", "t3"]),
                computed_at=(BASE + dt.timedelta(hours=rng.randint(-40, 0))).isoformat(),
                question_id=rng.choice(["q1", "q2", "q3", "q4"]),
            )
        )
    prev_summary = rng.choice(STATE_SUMMARY_ORDER + [KnowledgeStateSummary.NEEDS_REVIEW])
    prev_best = rng.choice(STATE_SUMMARY_ORDER)
    expected = run_state_case(rows_spec, prev_summary, prev_best)
    STATE_CASES.append(
        {
            "input": {"rows": jsonable(rows_spec), "prev_summary": str(prev_summary), "prev_best_summary": str(prev_best)},
            "expected": expected,
        }
    )


# ------------------------------------------------------------------------------ emit

sample_dimension_cases()
boundary_count = len(DIMENSION_CASES)
boundary_cases()

# Keep every distinct outcome, but only a few representative inputs per outcome: the sample above
# explores 4000+ combinations and most of them collapse to the same six rows. Every vector that
# survives here is still produced by the real Python code, and every distinct reason list is kept.
_seen = {}
_unique = []
for case in DIMENSION_CASES[:boundary_count]:
    signature = json.dumps(case["expected"], ensure_ascii=False, sort_keys=True)
    if _seen.get(signature, 0) >= 2:
        continue
    _seen[signature] = _seen.get(signature, 0) + 1
    _unique.append(case)
DIMENSION_CASES = _unique + DIMENSION_CASES[boundary_count:]

def coverage_stats(cases):
    """Which outcome each dimension reached, so the fixture's coverage is auditable."""
    stats = {}
    for case in cases:
        for row in case["expected"]["rows"]:
            bucket = stats.setdefault(row["dimension"], {"qualifies_true": 0, "qualifies_false": 0, "reasons": set()})
            bucket["qualifies_true" if row["qualifies"] else "qualifies_false"] += 1
            for reason in row["exclusion_reasons"]:
                bucket["reasons"].add(reason)
    return {
        dimension: {
            "qualifies_true": values["qualifies_true"],
            "qualifies_false": values["qualifies_false"],
            "distinct_reasons": len(values["reasons"]),
        }
        for dimension, values in sorted(stats.items())
    }


payload = {
    "source": {
        "evidence": "backend/apps/learning/services/evidence.py",
        "state": "backend/apps/learning/services/state.py",
        "evidence_rule_version": ev.RULE_VERSION,
        "state_rule_version": st.RULE_VERSION,
        "harness": "in-memory fake object graph; no database rows are read or written",
    },
    "dimensions": DIMENSION_CASES,
    "summary_from_counts": SUMMARY_CASES,
    "missing_evidence": MISSING_CASES,
    "grade_correct": GRADE_CORRECT_CASES,
    "fraction": FRACTION_CASES,
    "confirmation_ok": CONFIRMATION_CASES,
    "state": STATE_CASES,
    "coverage": {
        "dimensions": coverage_stats(DIMENSION_CASES),
        "state_summaries": sorted({case["expected"]["summary"] for case in STATE_CASES}),
        "state_best_summaries": sorted({case["expected"]["best_summary"] for case in STATE_CASES}),
        "needs_review_true": sum(1 for case in STATE_CASES if case["expected"]["needs_review"]),
        "downgrade_reason_present": sum(1 for case in STATE_CASES if case["expected"]["downgrade_reason"]),
    },
}
json.dump(payload, sys.stdout, ensure_ascii=False, sort_keys=False, separators=(",", ":"))
sys.stdout.write("\n")
