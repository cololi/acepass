"""``manage.py search_eval`` — reproducible retrieval acceptance evidence.

The command replays a gold query file against one project's index and prints,
per query, the rank of the first expected hit, recall@k and precision@k, and
every expectation that was not met together with the ids actually returned. It
also prints the channel availability, the tokenizer version and the document
counts, so the report names the exact configuration that produced it — a number
in this output can be re-derived later instead of being taken on trust.

Gold expectations come in three forms, and a query may mix them:

* ``expected_document_ids`` — exact ``SearchDocument`` ids;
* ``expected_question_ids`` — exact ``Question`` ids;
* ``expected_labels`` — human labels, resolved **at run time** against the
  current database: a question's ``display_label`` or a knowledge node's
  ``canonical_name``.

Labels exist because ids are generated per fixture load: a gold file written
against ids stops meaning anything after the acceptance database is rebuilt,
whereas "the question labelled 演示A-单选-1" keeps meaning the same thing. A label
that cannot be resolved is a hard error — it is never skipped, because silently
dropping an expectation would turn an unverifiable gold file into a passing one.
Resolution deliberately uses the *searchable* candidate set: a label that only
exists on content this user may not retrieve counts as unresolved, since a gold
expectation must describe retrievable content.

``recall@k`` counts satisfied expectation units (one unit per document id, per
question id and per label, so a label resolving to several versions is satisfied
by any of them), macro-averaged over queries. The exit code fails when that
average is below ``--min-recall`` **or** when any single query is — both numbers
are printed so an average can never hide a query that found nothing. With the
default ``--min-recall 0.0`` the command reports only and says so; it never
claims a pass it did not check.

    .venv/bin/python manage.py search_eval --project <uuid> --user <email> \\
        --gold gold.json --k 5,10 --min-recall 0.8

Author a gold file against a fresh fixture with the template printer, which
lists the labels/ids the current database actually has::

    .venv/bin/python manage.py search_eval --project <uuid> --user <email> \\
        --print-gold-template > gold.json

Gold file shape::

    {"queries": [{"id": "q1", "query": "光合作用",
                  "expected_labels": ["演示A-单选-1"],
                  "expected_document_ids": ["<uuid>"],
                  "expected_question_ids": ["<uuid>"],
                  "note": "为什么这条是期望结果"}]}
"""

from __future__ import annotations

import json
import os
from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from apps.common.enums import SearchChannel
from apps.common.errors import ScopeViolation
from apps.common.scope import require_project
from apps.search.models import SearchDocument, SearchDocumentKind
from apps.search.services import hybrid as hybrid_service
from apps.search.services import index as index_service
from apps.search.services import vector as vector_service
from apps.search.services.tokenize import TOKENIZER_VERSION


def parse_k_values(raw: str) -> list[int]:
    """Parse ``"5,10"`` into ``[5, 10]``, rejecting anything else."""
    values: list[int] = []
    for chunk in (raw or "").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            value = int(chunk)
        except ValueError as exc:
            raise CommandError(f"--k 只能是逗号分隔的正整数：{raw!r}") from exc
        if value < 1:
            raise CommandError(f"--k 必须是正整数：{raw!r}")
        values.append(value)
    if not values:
        raise CommandError("--k 不能为空，例如 --k 5,10")
    return sorted(set(values))


def load_gold(path: str) -> list[dict[str, Any]]:
    """Read and validate the gold file, refusing a query with no expectation."""
    if not os.path.isfile(path):
        raise CommandError(f"gold 文件不存在：{path}")
    with open(path, encoding="utf-8") as handle:
        try:
            payload = json.load(handle)
        except json.JSONDecodeError as exc:
            raise CommandError(f"gold 文件不是有效 JSON：{path}（{exc}）") from exc
    queries = payload.get("queries") if isinstance(payload, dict) else None
    if not isinstance(queries, list) or not queries:
        raise CommandError("gold 文件必须包含非空的 queries 数组")
    rows: list[dict[str, Any]] = []
    for index, item in enumerate(queries):
        if not isinstance(item, dict):
            raise CommandError(f"queries[{index}] 必须是对象")
        query_id = str(item.get("id") or f"q{index + 1}")
        query_text = str(item.get("query") or "").strip()
        document_ids = [str(value) for value in item.get("expected_document_ids") or []]
        question_ids = [str(value) for value in item.get("expected_question_ids") or []]
        labels = [str(value).strip() for value in item.get("expected_labels") or [] if str(value).strip()]
        if not query_text:
            raise CommandError(f"{query_id}: query 不能为空")
        if not document_ids and not question_ids and not labels:
            raise CommandError(
                f"{query_id}: 必须给出 expected_document_ids、expected_question_ids 或 expected_labels 之一"
            )
        rows.append(
            {
                "id": query_id,
                "query": query_text,
                "note": str(item.get("note") or ""),
                "expected_document_ids": document_ids,
                "expected_question_ids": question_ids,
                "expected_labels": labels,
            }
        )
    return rows


def label_key(value: str) -> str:
    """Label lookup key: trimmed and case-folded so ASCII labels still match."""
    return str(value).strip().casefold()


def build_label_index(documents) -> dict[str, dict[str, Any]]:
    """Map every retrievable label to the ids it stands for, per document kind."""
    index: dict[str, dict[str, Any]] = {}
    for document in documents:
        if document.kind == SearchDocumentKind.QUESTION and document.question is not None:
            label = (document.question.display_label or "").strip()
            kind = "question"
            ids = {
                str(document.id),
                str(document.question_id) if document.question_id else "",
            }
        elif document.kind == SearchDocumentKind.NODE and document.knowledge_node is not None:
            label = (document.knowledge_node.canonical_name or "").strip()
            kind = "node"
            ids = {
                str(document.id),
                str(document.knowledge_node_id) if document.knowledge_node_id else "",
            }
        else:  # pragma: no cover - the model constrains kind/target together
            continue
        if not label:
            continue
        entry = index.setdefault(
            label_key(label), {"label": label, "kinds": set(), "ids": set(), "documents": set(), "subjects": set()}
        )
        entry["kinds"].add(kind)
        entry["ids"].update(value for value in ids if value)
        entry["documents"].add(str(document.id))
        entry["subjects"].add(str(document.subject_id))
    return index


def resolve_units(row: dict[str, Any], label_index: dict[str, dict[str, Any]]) -> tuple[list[dict], list[str]]:
    """Turn one gold row into expectation units, reporting unresolved labels.

    One unit per expectation, so a label that resolves to several versions is
    satisfied by any one of them instead of deflating recall@k.
    """
    units: list[dict[str, Any]] = []
    unresolved: list[str] = []
    for document_id in row["expected_document_ids"]:
        units.append({"form": "document_id", "value": document_id, "ids": {document_id}})
    for question_id in row["expected_question_ids"]:
        units.append({"form": "question_id", "value": question_id, "ids": {question_id}})
    for label in row["expected_labels"]:
        entry = label_index.get(label_key(label))
        if entry is None:
            unresolved.append(label)
            continue
        units.append({"form": "label", "value": label, "ids": set(entry["ids"])})
    return units, unresolved


def hit_ids(hit: dict[str, Any]) -> set[str]:
    """Every id a returned hit can be recognised by."""
    ids: set[str] = set()
    for field in ("document_id", "question_id", "knowledge_node_id"):
        value = hit.get(field)
        if value:
            ids.add(str(value))
    return ids


def evaluate_query(response: dict[str, Any], row: dict[str, Any], units: list[dict], k_values: list[int]) -> dict:
    """Rank/metric summary of one query's response against its expectations."""
    results = response.get("results") or []

    def satisfied_ids(limit: int) -> set[str]:
        ids: set[str] = set()
        for hit in results[:limit]:
            ids |= hit_ids(hit)
        return ids

    def first_relevant_rank() -> int | None:
        for position, hit in enumerate(results, start=1):
            returned = hit_ids(hit)
            if any(returned & unit["ids"] for unit in units):
                return position
        return None

    first_hit_rank = first_relevant_rank()
    recall: dict[str, float] = {}
    precision: dict[str, float] = {}
    matched_by_k: dict[str, int] = {}
    for k in k_values:
        returned = satisfied_ids(k)
        matched = sum(1 for unit in units if returned & unit["ids"])
        recall[str(k)] = round(matched / len(units), 6) if units else 0.0
        precision[str(k)] = round(matched / k, 6)
        matched_by_k[str(k)] = matched
    widest = max(k_values)
    returned_widest = satisfied_ids(widest)
    missed_units = [unit for unit in units if not (returned_widest & unit["ids"])]
    return {
        "first_hit_rank": first_hit_rank,
        "expected_count": len(units),
        "recall": recall,
        "precision": precision,
        "matched": matched_by_k,
        "channels_used": sorted(
            name for name, status in (response.get("channels") or {}).items() if status.get("used")
        ),
        "notes": list(response.get("notes") or []),
        "returned_top": [
            {
                "rank": position,
                "document_id": hit.get("document_id"),
                "question_id": hit.get("question_id"),
                "knowledge_node_id": hit.get("knowledge_node_id"),
                "kind": hit.get("kind"),
                "display_label": hit.get("display_label"),
            }
            for position, hit in enumerate(results[:widest], start=1)
        ],
        "misses": [
            {
                "expected_form": unit["form"],
                "expected_id": unit["value"],
                "resolved_ids": sorted(unit["ids"]),
                "returned_top_ids": [hit.get("document_id") for hit in results[:widest]],
            }
            for unit in missed_units
        ],
    }


class Command(BaseCommand):
    help = "Evaluate hybrid retrieval against a gold query file and report recall@k honestly."

    def add_arguments(self, parser):
        parser.add_argument("--project", required=True, help="项目 UUID（必须属于 --user）")
        parser.add_argument("--user", required=True, help="用户邮箱；检索按该用户的权限范围执行")
        parser.add_argument("--gold", default="", help="gold 查询文件路径（JSON）；--print-gold-template 时不需要")
        parser.add_argument("--k", default="5,10", help="逗号分隔的 k 值，默认 5,10")
        parser.add_argument("--json", action="store_true", help="只输出一个 JSON 对象")
        parser.add_argument(
            "--min-recall",
            type=float,
            default=0.0,
            help="recall@k 下限；默认 0.0 表示只报告不判定（不会假装通过）",
        )
        parser.add_argument(
            "--channel",
            default=SearchChannel.HYBRID.value,
            choices=list(SearchChannel.values),
            help="评估使用的检索通道，默认 hybrid",
        )
        parser.add_argument(
            "--print-gold-template",
            action="store_true",
            help="打印当前项目可用标签/ID 的 gold 文件骨架后退出（用于在重建后的库上编写 gold）",
        )

    def handle(self, *args, **options):
        k_values = parse_k_values(options["k"])
        min_recall = float(options["min_recall"])
        channel = options["channel"]

        user = get_user_model().objects.filter(email__iexact=str(options["user"]).strip()).first()
        if user is None:
            raise CommandError(f"用户不存在：{options['user']}")
        try:
            project = require_project(user, options["project"])
        except ScopeViolation as exc:
            raise CommandError(f"项目不存在或不属于该用户：{options['project']}（{exc.message}）") from exc

        candidates = index_service.searchable_documents(user=user, project=project)
        label_index = build_label_index(list(candidates))

        if options["print_gold_template"]:
            template = self._gold_template(project, user, label_index)
            self.stdout.write(json.dumps(template, ensure_ascii=False, indent=2))
            if not label_index:
                raise CommandError(
                    "当前项目没有可检索的索引文档，标签清单为空：请先重建索引"
                    "（POST /projects/<project_id>/search/reindex，或调用 reindex_project），"
                    "再生成 gold 模板；否则写出的 gold 文件无法解析任何标签。"
                )
            return
        if not options["gold"]:
            raise CommandError("--gold 是必需的（除非使用 --print-gold-template）")

        rows = load_gold(options["gold"])
        widest = max(k_values)
        queries: list[dict[str, Any]] = []
        unresolved_labels: list[dict[str, str]] = []
        for row in rows:
            units, unresolved = resolve_units(row, label_index)
            for label in unresolved:
                unresolved_labels.append({"query_id": row["id"], "label": label})
            response = (
                hybrid_service.search(
                    user=user,
                    project=project,
                    query=row["query"],
                    limit=widest,
                    channel=channel,
                )
                if units
                else {"results": [], "channels": {}, "notes": [], "candidate_documents": candidates.count()}
            )
            evaluation = evaluate_query(response, row, units, k_values)
            queries.append({**row, **evaluation, "candidate_documents": response.get("candidate_documents", 0)})

        document_counts = {
            "searchable_documents": candidates.count(),
            "question_documents": candidates.filter(kind=SearchDocumentKind.QUESTION).count(),
            "node_documents": candidates.filter(kind=SearchDocumentKind.NODE).count(),
            "documents_with_embeddings": candidates.exclude(embedding__isnull=True).count(),
            "index_rows_for_project": SearchDocument.objects.filter(project=project).count(),
            "excluded_index_rows": SearchDocument.objects.filter(project=project, is_searchable=False).count(),
            "distinct_labels": len(label_index),
        }
        channel_status = {
            "keyword": {"available": True, "reason": None, "k1": hybrid_service.BM25_K1, "b": hybrid_service.BM25_B},
            "vector": vector_service.vector_availability(),
        }

        scored = [query for query in queries if query["expected_count"]]
        aggregate_recall = {
            str(k): round(sum(query["recall"][str(k)] for query in scored) / len(scored), 6) if scored else 0.0
            for k in k_values
        }
        aggregate_precision = {
            str(k): round(sum(query["precision"][str(k)] for query in scored) / len(scored), 6) if scored else 0.0
            for k in k_values
        }
        reciprocal_ranks = [1 / query["first_hit_rank"] if query["first_hit_rank"] else 0.0 for query in scored]
        thresholds = {
            str(k): {
                "mean_recall": aggregate_recall[str(k)],
                "min_recall": min_recall,
                "queries_below_threshold": sum(1 for query in scored if query["recall"][str(k)] < min_recall),
                "passed": bool(scored)
                and aggregate_recall[str(k)] >= min_recall
                and all(query["recall"][str(k)] >= min_recall for query in scored),
            }
            for k in k_values
        }
        passed = not unresolved_labels and all(status["passed"] for status in thresholds.values())
        report = {
            "command": "search_eval",
            "tokenizer_version": TOKENIZER_VERSION,
            "channel": channel,
            "project_id": str(project.id),
            "user": user.email,
            "gold": os.path.abspath(options["gold"]),
            "k_values": k_values,
            "min_recall": min_recall,
            "threshold_applied": min_recall > 0.0,
            "passed": passed,
            "unresolved_labels": unresolved_labels,
            "document_counts": document_counts,
            "channels": channel_status,
            "queries": queries,
            "aggregate": {
                "query_count": len(rows),
                "scored_query_count": len(scored),
                "mean_recall": aggregate_recall,
                "mean_precision": aggregate_precision,
                "mrr": round(sum(reciprocal_ranks) / len(reciprocal_ranks), 6) if reciprocal_ranks else 0.0,
            },
            "thresholds": thresholds,
        }

        if options["json"]:
            self.stdout.write(json.dumps(report, ensure_ascii=False))
        else:
            self._print_text(report)

        if unresolved_labels:
            detail = ", ".join(f"{item['query_id']}:{item['label']}" for item in unresolved_labels)
            raise CommandError(
                f"gold 文件有 {len(unresolved_labels)} 个标签无法解析：{detail}。"
                "标签必须匹配当前库中可检索内容的题目 display_label 或考点 canonical_name；"
                "请先重建索引，或用 --print-gold-template 查看可用标签。"
            )
        if not passed:
            failed = ", ".join(
                f"recall@{k}={thresholds[str(k)]['mean_recall']:.3f}<{min_recall:.3f}"
                for k in k_values
                if not thresholds[str(k)]["passed"]
            )
            raise CommandError(f"检索评估未达标：{failed}")

    def _gold_template(self, project, user, label_index: dict[str, dict[str, Any]]) -> dict[str, Any]:
        """A gold skeleton naming the labels/ids this database currently has."""
        questions = []
        nodes = []
        for entry in sorted(label_index.values(), key=lambda item: (item["label"], sorted(item["ids"]))):
            payload = {
                "label": entry["label"],
                "document_ids": sorted(entry["documents"]),
                "resolved_ids": sorted(entry["ids"]),
            }
            (questions if "question" in entry["kinds"] else nodes).append(payload)
        return {
            "command": "search_eval",
            "note": (
                "把 query 换成真实检索词；expected_labels 用 available.questions/nodes 里的 label，"
                "这样 gold 文件在重建数据库后依然可复现。expected_document_ids/expected_question_ids 仅在"
                "需要精确锁定时使用。"
            ),
            "tokenizer_version": TOKENIZER_VERSION,
            "project_id": str(project.id),
            "user": user.email,
            "distinct_labels": len(label_index),
            "index_empty": not label_index,
            "available": {"questions": questions, "nodes": nodes},
            "queries": [
                {
                    "id": "example-1",
                    "query": "<在此填写检索词>",
                    "expected_labels": [],
                    "expected_document_ids": [],
                    "expected_question_ids": [],
                    "note": "至少填写一种期望；标签无法解析会让命令失败",
                }
            ],
        }

    def _print_text(self, report: dict[str, Any]) -> None:
        write = self.stdout.write
        write(
            f"search_eval tokenizer={report['tokenizer_version']} channel={report['channel']} "
            f"project={report['project_id']} user={report['user']}"
        )
        write(f"gold={report['gold']} queries={len(report['queries'])} k={report['k_values']}")
        counts = report["document_counts"]
        write(
            "documents searchable={searchable_documents} question={question_documents} node={node_documents} "
            "with_embeddings={documents_with_embeddings} index_rows={index_rows_for_project} "
            "excluded_rows={excluded_index_rows} distinct_labels={distinct_labels}".format(**counts)
        )
        keyword = report["channels"]["keyword"]
        write(f"channel keyword available=True reason=- k1={keyword['k1']} b={keyword['b']}")
        vector = report["channels"]["vector"]
        write(
            f"channel vector available={vector['available']} model={vector['model']} "
            f"dimension={vector['dimension']} provider={vector['provider']} reason={vector['reason'] or '-'}"
        )
        for query in report["queries"]:
            metrics = " ".join(
                f"recall@{k}={query['recall'][str(k)]:.3f} precision@{k}={query['precision'][str(k)]:.3f}"
                for k in report["k_values"]
            )
            write(
                f"query id={query['id']} rank={query['first_hit_rank'] or '-'} {metrics} "
                f"channels={','.join(query['channels_used']) or '-'} "
                f"expected={query['expected_count']} candidate_documents={query['candidate_documents']}"
            )
            if query["note"]:
                write(f"  note={query['note']}")
            for note in query["notes"]:
                write(f"  channel_note={note}")
            if query["first_hit_rank"] is None and query["expected_count"]:
                write("  first_hit=NONE")
            for miss in query["misses"]:
                returned = ",".join(str(value) for value in miss["returned_top_ids"]) or "-"
                write(
                    f"  miss {miss['expected_form']}={miss['expected_id']} "
                    f"resolved={','.join(miss['resolved_ids']) or '-'} returned_top={returned}"
                )
        aggregate = report["aggregate"]
        mean_recall = " ".join(f"recall@{k}={aggregate['mean_recall'][str(k)]:.3f}" for k in report["k_values"])
        mean_precision = " ".join(
            f"precision@{k}={aggregate['mean_precision'][str(k)]:.3f}" for k in report["k_values"]
        )
        write(
            f"aggregate queries={aggregate['query_count']} scored={aggregate['scored_query_count']} "
            f"{mean_recall} {mean_precision} mrr={aggregate['mrr']:.3f}"
        )
        for k in report["k_values"]:
            status = report["thresholds"][str(k)]
            write(
                f"threshold k={k} mean_recall={status['mean_recall']:.3f} min_recall={status['min_recall']:.3f} "
                f"queries_below={status['queries_below_threshold']} passed={status['passed']}"
            )
        if report["unresolved_labels"]:
            for item in report["unresolved_labels"]:
                write(f"unresolved_label query={item['query_id']} label={item['label']}")
        if not report["threshold_applied"]:
            write("threshold_applied=False：--min-recall 为 0，本次只报告，不判定通过")
        write(f"result passed={report['passed']}")
