"""Search index documents: the retrieval projection of question content.

Answer-leak rule (hard, docs/03 §3)
----------------------------------
A ``SearchDocument`` holds only text a learner is allowed to see *before*
answering: question stems, option texts, shared-material text and
knowledge-node names/aliases. Answers, rubric criteria, explanations and grading
feedback are **never** copied into this table — not into ``text``, not into
``tokens``, not into ``term_frequencies`` and not into ``embedding``. The
projection is therefore answer-free by construction, so a retrieval bug cannot
leak an answer; ``apps/search/services/index.py`` is the only writer and it
builds every string from stem-shaped fields.
"""

from __future__ import annotations

from django.db import models

from apps.common.models import BaseModel


class SearchDocumentKind(models.TextChoices):
    """What one index row points at.

    ``QUESTION`` rows are scoped to a ``question_version``; ``NODE`` rows are
    scoped to a ``knowledge_node``. The two targets are also separated by the
    unique constraints below, so one row can never stand in for the other.
    """

    QUESTION = "question", "题目版本"
    NODE = "node", "考点"


class SearchDocument(BaseModel):
    """One retrievable unit: a question version or a knowledge node.

    ``project``/``subject`` are denormalised so scope predicates are cheap, but
    they are **not** trusted: ``index.visibility_filter`` re-derives the scope
    from the live relations (version status, subject's project, pool policy) on
    every query, which is what makes stale rows harmless.
    """

    project = models.ForeignKey("exams.ExamProject", on_delete=models.CASCADE, related_name="search_documents")
    subject = models.ForeignKey("exams.Subject", on_delete=models.CASCADE, related_name="search_documents")
    question = models.ForeignKey(
        "question_bank.Question", null=True, blank=True, on_delete=models.CASCADE, related_name="search_documents"
    )
    question_version = models.ForeignKey(
        "question_bank.QuestionVersion",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="search_documents",
    )
    knowledge_node = models.ForeignKey(
        "knowledge.KnowledgeNode", null=True, blank=True, on_delete=models.CASCADE, related_name="search_documents"
    )
    kind = models.CharField(max_length=16, choices=SearchDocumentKind.choices, db_index=True)
    #: Indexed source text: the stem-shaped strings the tokenizer was run over.
    #: Deliberately not a btree-indexed column (PostgreSQL refuses index rows
    #: above ~8 kB, and a long Chinese stem exceeds that); the searchable index
    #: is ``tokens``/``term_frequencies`` plus the scope index below.
    text = models.TextField(blank=True)
    #: Ordered token list, so a re-index is comparable and explainable.
    tokens = models.JSONField(default=list, blank=True)
    #: term → count, the per-document statistics BM25 scores against.
    term_frequencies = models.JSONField(default=dict, blank=True)
    doc_length = models.PositiveIntegerField(default=0)
    #: Vector channel data. Null means "never embedded", which is reported as
    #: such instead of being faked with a zero vector.
    embedding = models.JSONField(null=True, blank=True)
    embedding_model = models.CharField(max_length=120, blank=True)
    embedding_dim = models.PositiveIntegerField(null=True, blank=True)
    embedding_updated_at = models.DateTimeField(null=True, blank=True)
    #: Digest of the indexed revision, so the row names exactly what it holds.
    source_revision = models.CharField(max_length=64, blank=True)
    #: Index-time eligibility. The live filter in ``services/index.py`` is
    #: authoritative; this flag lets a stale row be excluded cheaply and makes
    #: the reason for an exclusion visible.
    is_searchable = models.BooleanField(default=True, db_index=True)
    exclusion_reason = models.CharField(max_length=200, blank=True)

    class Meta:
        db_table = "search_document"
        constraints = [
            models.UniqueConstraint(
                fields=["question_version", "kind"],
                condition=models.Q(question_version__isnull=False),
                name="uniq_search_doc_version_kind",
            ),
            models.UniqueConstraint(
                fields=["knowledge_node", "kind"],
                condition=models.Q(knowledge_node__isnull=False),
                name="uniq_search_doc_node_kind",
            ),
        ]
        indexes = [
            models.Index(fields=["project", "subject", "is_searchable"], name="search_doc_scope_idx"),
        ]
        ordering = ["id"]
        verbose_name = "检索文档"
        verbose_name_plural = "检索文档"

    def __str__(self) -> str:
        return f"{self.kind}#{self.id}"
