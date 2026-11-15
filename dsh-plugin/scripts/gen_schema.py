"""Generate `src/store/schema.generated.ts` from the Django models themselves.

Hand-transcribing 59 tables (197 FKs, 59 JSON columns, 33 unique constraints, 6 checks, 334
indexed statements) would guarantee drift, so the schema is introspected from `_meta` instead: the Django
models stay the single source of truth until Phase 7 retires them.

**This script must never touch the database.** Django's `schema_editor` executes deferred DDL on
context exit, and `UniqueConstraint.constraint_sql()` can create indexes as a side effect, so
everything here is rendered offline from `_meta` + a compiler that never opens a cursor.

Type mapping follows the decisions in docs/dsh-migration/03 (§2.12):
- `DecimalField` -> TEXT  (SQLite REAL would silently change stored decimals)
- `DateTimeField` -> TEXT (ISO-8601 with an explicit offset, microsecond precision)
- `JSONField` -> TEXT + `json_valid()` CHECK
- `UUIDField` -> TEXT, `BooleanField` -> INTEGER 0/1
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

from django.apps import apps as django_apps  # noqa: E402
from django.db import connection  # noqa: E402
from decimal import Decimal  # noqa: E402
from django.db.models.sql.compiler import SQLCompiler  # noqa: E402
from django.db.models.sql.query import Query  # noqa: E402

OUR_APPS = {
    "accounts", "analytics", "audit", "exams", "ingestion", "knowledge",
    "interaction", "learning", "memory", "practice", "question_bank", "search", "tutoring",
}

FIELD_TYPES = {
    "UUIDField": "TEXT",
    "CharField": "TEXT",
    "TextField": "TEXT",
    "EmailField": "TEXT",
    "SlugField": "TEXT",
    "URLField": "TEXT",
    "FileField": "TEXT",
    "ImageField": "TEXT",
    "GenericIPAddressField": "TEXT",
    "IntegerField": "INTEGER",
    "BigIntegerField": "INTEGER",
    "SmallIntegerField": "INTEGER",
    "PositiveIntegerField": "INTEGER",
    "PositiveSmallIntegerField": "INTEGER",
    "PositiveBigIntegerField": "INTEGER",
    "AutoField": "INTEGER",
    "BigAutoField": "INTEGER",
    "SmallAutoField": "INTEGER",
    "BooleanField": "INTEGER",
    "FloatField": "REAL",
    "DecimalField": "TEXT",
    "DateTimeField": "TEXT",
    "DateField": "TEXT",
    "TimeField": "TEXT",
    "DurationField": "INTEGER",
    "JSONField": "TEXT",
    "BinaryField": "BLOB",
}

ON_DELETE = {
    "CASCADE": "CASCADE",
    "RESTRICT": "RESTRICT",
    "SET": "SET DEFAULT",
    "PROTECT": "RESTRICT",
    "SET_NULL": "SET NULL",
    "SET_DEFAULT": "SET DEFAULT",
    "DO_NOTHING": "NO ACTION",
}

JSON_CHECK = 'json_valid("{column}")'


def quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def sql_literal(value) -> str | None:
    """Render a Python default as a SQLite literal, or None when it must not be inlined."""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, Decimal):
        # A decimal literal must stay numeric: quoting it would compare as TEXT.
        return str(value)
    if isinstance(value, str):
        if "\x00" in value:
            return None
        return "'" + value.replace("'", "''") + "'"
    return None


FIELD_KINDS = {
    "UUIDField": "uuid",
    "DecimalField": "decimal",
    "DateTimeField": "datetime",
    "DateField": "date",
    "TimeField": "time",
    "BooleanField": "bool",
    "FloatField": "float",
    "JSONField": "json",
    "BinaryField": "blob",
    "DurationField": "duration",
}


def field_kind(field) -> str:
    """Semantic kind, so the Node codec knows what a TEXT column actually holds."""
    if getattr(field, "remote_field", None) is not None:
        return field_kind(field.target_field)
    name = type(field).__name__
    if name in FIELD_KINDS:
        return FIELD_KINDS[name]
    if name.startswith(("Integer", "BigInteger", "SmallInteger", "Positive")):
        return "int"
    if name.startswith(("Auto", "BigAuto", "SmallAuto")):
        return "int"
    return "text"


def column_type_for(field) -> str:
    """A relation column takes the type of the field it points at (`attempt_id` -> UUID -> TEXT)."""
    if getattr(field, "remote_field", None) is not None:
        return column_type_for(field.target_field)
    mapped = FIELD_TYPES.get(type(field).__name__)
    if mapped is None:
        raise SystemExit(f"unmapped field type {type(field).__name__} on {field.model._meta.db_table}.{field.name}")
    return mapped


def inline_params(sql: str, params: list) -> str:
    """Inline constants so the expression is usable inside a CHECK / partial index predicate."""
    if not params:
        return sql
    out = []
    index = 0
    position = 0
    while True:
        found = sql.find("%s", position)
        if found == -1:
            out.append(sql[position:])
            break
        out.append(sql[position:found])
        literal = sql_literal(params[index])
        if literal is None:
            raise SystemExit(f"cannot inline parameter {params[index]!r} in {sql!r}")
        out.append(literal)
        index += 1
        position = found + 2
    if index != len(params):
        raise SystemExit(f"parameter count mismatch in {sql!r} ({index} of {len(params)})")
    return "".join(out)


def render_where(condition, model) -> str:
    """Compile a `Q` to SQL without opening a cursor."""
    query = Query(model)
    where = condition.resolve_expression(query, allow_joins=False, reuse=None)
    compiler = SQLCompiler(query, connection, using="default")
    sql, params = where.as_sql(compiler, connection)
    return inline_params(sql, list(params))


def cast_decimal_columns(predicate: str, model) -> str:
    """Wrap TEXT-stored decimal columns in `CAST(... AS NUMERIC)` inside a predicate.

    `DecimalField` maps to TEXT to keep stored decimals exact, but a CHECK such as
    `0 <= score_weight <= 1` must compare numerically — as text, `'1.0' <= '1'` is false and a
    perfectly valid weight would be rejected.
    """
    meta = model._meta
    for field in meta.concrete_fields:
        if type(field).__name__ != "DecimalField":
            continue
        qualified = f"{quote(meta.db_table)}.{quote(field.attname)}"
        predicate = predicate.replace(qualified, f"CAST({qualified} AS NUMERIC)")
        predicate = predicate.replace(f"CAST(CAST({qualified} AS NUMERIC) AS NUMERIC)", f"CAST({qualified} AS NUMERIC)")
    return predicate


def auto_unique_name(table: str, columns: list[str]) -> str:
    """Django's automatic name for a `unique_together` constraint (`_create_index_name` + `_uniq`)."""
    from django.db.backends.utils import names_digest

    return f"{table}_{'_'.join(columns)}_{names_digest(table, *columns, length=8)}_uniq"


def collect_models():
    """Every table Django creates for our apps, including the implicit M2M through tables.

    `get_models()` only returns declared models, so the database tables Django creates for a plain
    `ManyToManyField` (`import_job_documents`, `import_candidate_source_regions`) were missing from
    the generated schema and the archive exported them empty with `no_model`. They are real tables
    with real rows, foreign keys and a unique pair, so the generator must enumerate them with
    `include_auto_created=True`; `_meta.auto_created` marks them without excluding anything else.
    """
    declared = [
        model
        for model in django_apps.get_models()
        if not model._meta.abstract and model._meta.app_label in OUR_APPS
    ]
    table_names = {model._meta.db_table for model in declared}
    created = [
        model
        for model in django_apps.get_models(include_auto_created=True)
        if model._meta.auto_created
        and model._meta.app_label in OUR_APPS
        # Only tables whose parents exist in this schema. `accounts_user_groups` references
        # `auth_group`/`auth_permission`, which are not part of this port (DSH owns identity), so
        # including it would create a dangling foreign key instead of a usable table.
        and all(field.remote_field.model._meta.db_table in table_names for field in model._meta.concrete_fields if field.is_relation)
    ]
    models = declared + created
    return sorted(models, key=lambda m: (m._meta.app_label, m.__name__))


def build_table(model, uniques, checks):
    meta = model._meta
    columns = []
    table_body = []
    index_statements = []

    for field in meta.concrete_fields:
        column_type = column_type_for(field)
        is_json = type(field).__name__ == "JSONField"
        columns.append(
            {
                "name": field.attname,
                "field": field.name,
                "type": column_type,
                "notNull": not field.null,
                "primaryKey": bool(field.primary_key),
                "json": is_json,
                "kind": field_kind(field),
                # Django quantises a DecimalField to `decimal_places` on save
                # (`format_number`); the store has to do the same or a stored weight
                # reads back as "0.5" where Postgres holds "0.5000".
                "decimalPlaces": getattr(field, "decimal_places", None)
                if type(field).__name__ == "DecimalField"
                else None,
            }
        )
        if is_json:
            if field.null:
                table_body.append(
                    f"CONSTRAINT {quote('json_' + field.attname)} CHECK ("
                    f'{quote(field.attname)} IS NULL OR {JSON_CHECK.format(column=field.attname)})'
                )
            else:
                table_body.append(
                    f"CONSTRAINT {quote('json_' + field.attname)} CHECK "
                    f"({JSON_CHECK.format(column=field.attname)})"
                )

    foreign_keys = []
    for field in meta.concrete_fields:
        if not getattr(field, "remote_field", None):
            continue
        target = field.target_field
        on_delete = field.remote_field.on_delete
        # Django exposes CASCADE/PROTECT/... as functions, so the name lives on the object itself.
        on_delete_name = getattr(on_delete, "__name__", type(on_delete).__name__).upper()
        action = ON_DELETE.get(on_delete_name)
        if action is None:
            raise SystemExit(f"unmapped on_delete {on_delete_name} on {meta.db_table}.{field.name}")
        foreign_keys.append(
            {
                "column": field.attname,
                "refTable": field.remote_field.model._meta.db_table,
                "refColumn": target.attname,
                "onDelete": action,
            }
        )
        table_body.append(
            f"FOREIGN KEY ({quote(field.attname)}) "
            f"REFERENCES {quote(field.remote_field.model._meta.db_table)} ({quote(target.attname)}) "
            f"ON DELETE {action}"
        )

    # `unique_together` is how Django declares the pair on an implicit M2M through model and it is
    # *not* part of `meta.constraints`; without this the two through tables would accept duplicate
    # (job, document) pairs that the Django database rejects.
    for names in meta.unique_together:
        unique_columns = [meta.get_field(name).attname for name in names]
        constraint_name = auto_unique_name(meta.db_table, unique_columns)
        quoted = ", ".join(quote(column) for column in unique_columns)
        table_body.append(f"CONSTRAINT {quote(constraint_name)} UNIQUE ({quoted})")
        uniques.append(
            {
                "table": meta.db_table,
                "name": constraint_name,
                "columns": unique_columns,
                "partial": False,
            }
        )

    for constraint in meta.constraints:
        kind = type(constraint).__name__
        if kind == "CheckConstraint":
            condition = getattr(constraint, "condition", None) or constraint.check
            predicate = render_where(condition, model)
            table_body.append(f"CONSTRAINT {quote(constraint.name)} CHECK ({cast_decimal_columns(predicate, model)})")
            checks.append({"table": meta.db_table, "name": constraint.name, "sql": predicate})
        elif kind == "UniqueConstraint":
            cols = ", ".join(quote(meta.get_field(name).attname) for name in constraint.fields)
            uniques.append(
                {
                    "table": meta.db_table,
                    "name": constraint.name,
                    "columns": [meta.get_field(name).attname for name in constraint.fields],
                    "partial": constraint.condition is not None,
                }
            )
            if constraint.condition is not None:
                predicate = render_where(constraint.condition, model)
                index_statements.append(
                    f"CREATE UNIQUE INDEX IF NOT EXISTS {quote(constraint.name)} ON {quote(meta.db_table)} "
                    f"({cols}) WHERE {predicate}"
                )
            else:
                table_body.append(f"CONSTRAINT {quote(constraint.name)} UNIQUE ({cols})")
        else:
            raise SystemExit(f"unhandled constraint {kind} on {meta.db_table}")

    for field in meta.concrete_fields:
        if field.db_index and not field.unique and not field.primary_key:
            name = f"{meta.db_table}_{field.column}_idx"
            index_statements.append(
                f"CREATE INDEX IF NOT EXISTS {quote(name)} ON {quote(meta.db_table)} ({quote(field.attname)})"
            )

    for index in meta.indexes:
        name = index.name
        if not index.fields:
            raise SystemExit(f"expression index needs manual handling: {meta.db_table}.{name}")
        parts = []
        for entry in index.fields:
            # `-field` means DESC in a Meta.indexes declaration.
            descending = entry.startswith("-")
            column = meta.get_field(entry[1:] if descending else entry).attname
            parts.append(quote(column) + (" DESC" if descending else ""))
        cols = ", ".join(parts)
        # Meta.indexes are never unique; uniqueness is expressed through UniqueConstraint above.
        statement = f"CREATE INDEX IF NOT EXISTS {quote(name)} ON {quote(meta.db_table)} ({cols})"
        if index.condition is not None:
            statement += f" WHERE {render_where(index.condition, model)}"
        index_statements.append(statement)

    column_lines = []
    for field in meta.concrete_fields:
        column_type = column_type_for(field)
        parts = [quote(field.attname), column_type]
        if field.primary_key:
            parts.append("PRIMARY KEY")
            if column_type == "INTEGER" and type(field).__name__ in {"AutoField", "BigAutoField", "SmallAutoField"}:
                parts.append("AUTOINCREMENT")
        else:
            if not field.null:
                parts.append("NOT NULL")
            if field.has_default() and not callable(field.default):
                literal = sql_literal(field.default)
                if literal is not None:
                    parts.append(f"DEFAULT {literal}")
        column_lines.append(" ".join(parts))

    create_table = (
        f"CREATE TABLE IF NOT EXISTS {quote(meta.db_table)} (\n  "
        + ",\n  ".join(column_lines + table_body)
        + "\n)"
    )

    table = {
        "name": meta.db_table,
        "app": meta.app_label,
        "model": model.__name__,
        "columns": columns,
        "foreignKeys": foreign_keys,
    }
    return table, create_table, index_statements


def main():
    models = collect_models()
    tables = []
    create_tables = []
    index_statements = []
    uniques = []
    checks = []
    for model in models:
        table, create, extras = build_table(model, uniques, checks)
        tables.append(table)
        create_tables.append(create)
        index_statements.extend(extras)

    seen = set()
    deduped_indexes = []
    for statement in index_statements:
        if statement in seen:
            continue
        seen.add(statement)
        deduped_indexes.append(statement)

    payload_tables = json.dumps(tables, ensure_ascii=False, indent=1)
    payload_tables_create = json.dumps(create_tables, ensure_ascii=False, indent=1)
    payload_indexes = json.dumps(deduped_indexes, ensure_ascii=False, indent=1)

    sys.stdout.write(
        "/**\n"
        " * @generated by `scripts/gen_schema.py` from the Django models — do not edit by hand.\n"
        " *\n"
        " * Run `npm run schema` after changing any `backend/apps/<app>/models.py`. `schema.test.ts`\n"
        " * re-runs the"
        " * generator and fails when this file has drifted from the models.\n"
        " */\n\n"
        "export const SCHEMA_VERSION = 2\n\n"
        "export interface ColumnDef {\n"
        "  name: string\n"
        "  field: string\n"
        "  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB'\n"
        "  notNull: boolean\n"
        "  primaryKey: boolean\n"
        "  json: boolean\n"
        "  kind: ColumnKind\n"
        "  /** DecimalField `decimal_places`: the store quantises on write, like Django. */\n"
        "  decimalPlaces: number | null\n"
        "}\n\n"
        "export type ColumnKind =\n"
        "  | 'uuid'\n"
        "  | 'text'\n"
        "  | 'decimal'\n"
        "  | 'datetime'\n"
        "  | 'date'\n"
        "  | 'time'\n"
        "  | 'bool'\n"
        "  | 'int'\n"
        "  | 'float'\n"
        "  | 'json'\n"
        "  | 'blob'\n"
        "  | 'duration'\n\n"
        "export interface ForeignKeyDef {\n"
        "  column: string\n"
        "  refTable: string\n"
        "  refColumn: string\n"
        "  onDelete: string\n"
        "}\n\n"
        "export interface TableDef {\n"
        "  name: string\n"
        "  app: string\n"
        "  model: string\n"
        "  columns: ColumnDef[]\n"
        "  foreignKeys: ForeignKeyDef[]\n"
        "}\n\n"
        f"export const TABLES: TableDef[] = {payload_tables}\n\n"
        f"export const CREATE_TABLES: string[] = {payload_tables_create}\n\n"
        f"export const CREATE_INDEXES: string[] = {payload_indexes}\n\n"
        "export interface UniqueConstraintDef {\n"
        "  table: string\n"
        "  name: string\n"
        "  columns: string[]\n"
        "  /** A partial constraint only applies to rows matching its predicate. */\n"
        "  partial: boolean\n"
        "}\n\n"
        "export interface CheckConstraintDef {\n"
        "  table: string\n"
        "  name: string\n"
        "  sql: string\n"
        "}\n\n"
        f"export const UNIQUE_CONSTRAINTS: UniqueConstraintDef[] = {json.dumps(uniques, ensure_ascii=False, indent=1)}\n\n"
        f"export const CHECK_CONSTRAINTS: CheckConstraintDef[] = {json.dumps(checks, ensure_ascii=False, indent=1)}\n"
    )


if __name__ == "__main__":
    main()
