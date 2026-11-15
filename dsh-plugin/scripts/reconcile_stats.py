#!/usr/bin/env python3
"""PostgreSQL-side helpers for `scripts/reconcile_db.mjs` (B9 reconciliation re-run).

The Node driver needs four things from the *source* system that it cannot get through
`export_db.py`, because the exporter only writes rows:

1. ``introspect``  — which tables/columns this database actually has, so a source that is
   behind the code's migrations is reported instead of silently exporting a subset;
2. ``stats``       — the learner-visible aggregates computed **independently** of the archive,
   with plain SQL straight against PostgreSQL (the SQLite side runs the same SQL);
3. ``copy`` / ``migrate`` / ``drop`` — a scratch clone of the real database, used when the
   source is a historical snapshot: the clone is migrated with Django's own migrations and
   then exported, so the real ``acepass`` database is only ever read;
4. ``exists`` / ``drop`` — cleanup for the clone.

Every subcommand prints exactly one JSON object on stdout and exits non-zero on failure
(printing a JSON ``{"error": ...}`` object on stderr), so the Node side can treat the
process boundary as a typed interface rather than scraping human text.

Connection parameters come from the same ``POSTGRES_*`` variables Django reads, so the
driver, the exporter and this helper cannot disagree about which server they mean.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2] / "backend"
DEFAULT_SETTINGS = os.environ.get("ACEPASS_DJANGO_SETTINGS", "config.settings.dev")
PUBLIC_SCHEMA = "public"


def connection_params(database: str) -> dict:
    """The same defaults as ``backend/config/settings/base.py`` (dev machine)."""
    return {
        "host": os.environ.get("POSTGRES_HOST", "127.0.0.1"),
        "port": int(os.environ.get("POSTGRES_PORT", "5432")),
        "user": os.environ.get("POSTGRES_USER", "acepass"),
        "password": os.environ.get("POSTGRES_PASSWORD", "acepass_dev_pw"),
        "dbname": database,
        "connect_timeout": int(os.environ.get("POSTGRES_CONNECT_TIMEOUT", "10")),
    }


def connect(database: str):
    import psycopg

    return psycopg.connect(autocommit=True, **connection_params(database))


def introspect(database: str) -> dict:
    """Tables and columns in the public schema, plus the server version."""
    with connect(database) as connection, connection.cursor() as cursor:
        cursor.execute("select current_setting('server_version')")
        server_version = cursor.fetchone()[0]
        cursor.execute(
            "select table_name from information_schema.tables "
            "where table_schema = %s and table_type = 'BASE TABLE'",
            [PUBLIC_SCHEMA],
        )
        tables = sorted(row[0] for row in cursor.fetchall())
        cursor.execute(
            "select table_name, column_name from information_schema.columns "
            "where table_schema = %s",
            [PUBLIC_SCHEMA],
        )
        columns: dict[str, list[str]] = {}
        for table, column in cursor.fetchall():
            columns.setdefault(table, []).append(column)
    return {
        "database": database,
        "server_version": server_version,
        "tables": tables,
        "columns": {name: sorted(values) for name, values in sorted(columns.items())},
    }


def statistics(database: str, spec: dict) -> dict:
    """Run the aggregate SQL from `spec` and return its values.

    ``count`` statistics come back as ints; ``decimal_sum`` statistics are summed in
    ``decimal.Decimal`` and formatted with two decimals, so the Node side compares strings
    and never floats.
    """
    values: dict[str, object] = {}
    with connect(database) as connection, connection.cursor() as cursor:
        for item in spec["statistics"]:
            cursor.execute(item["sql"])
            rows = cursor.fetchall()
            if item["kind"] == "count":
                values[item["name"]] = int(rows[0][0]) if rows else 0
            elif item["kind"] == "decimal_sum":
                total = Decimal("0")
                for (raw,) in rows:
                    if raw is None:
                        continue
                    total += Decimal(str(raw))
                values[item["name"]] = f"{total:.2f}"
            else:  # pragma: no cover - the driver validates the spec it writes
                raise ValueError(f"unknown statistic kind {item['kind']!r}")
    return {"database": database, "statistics": values}


def create_database(database: str) -> dict:
    """Create an empty scratch database (tests, drills; never the real one)."""
    if database_exists(database):
        raise ValueError(f"database {database!r} already exists")
    from psycopg import sql

    with connect("postgres") as connection, connection.cursor() as cursor:
        cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    return {"database": database, "created": True}


def database_exists(database: str) -> bool:
    with connect("postgres") as connection, connection.cursor() as cursor:
        cursor.execute("select 1 from pg_database where datname = %s", [database])
        return cursor.fetchone() is not None


def copy_database(source: str, target: str) -> dict:
    """Clone `source` into a new `target` database.

    ``CREATE DATABASE ... TEMPLATE`` is a page-level copy (instant, exact). It needs the
    template to have no other sessions, so a ``pg_dump | psql`` fallback covers the case
    where a dev server is connected to the source database.
    """
    if source == target:
        raise ValueError("source and target database names must differ")
    if database_exists(target):
        raise ValueError(f"target database {target!r} already exists")

    import psycopg
    from psycopg import sql

    try:
        with connect("postgres") as connection, connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("CREATE DATABASE {} TEMPLATE {}").format(
                    sql.Identifier(target), sql.Identifier(source)
                )
            )
        return {"method": "template", "source": source, "target": target}
    except psycopg.Error as template_error:
        template_message = str(template_error).strip()

    pg_dump = _which("pg_dump")
    psql = _which("psql")
    if pg_dump is None or psql is None:
        raise RuntimeError(
            "TEMPLATE copy failed and pg_dump/psql are not on PATH: " + template_message
        )

    # The target must exist before `psql -d target` can replay into it.
    with connect("postgres") as connection, connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("CREATE DATABASE {}").format(sql.Identifier(target))
        )

    params = connection_params(source)
    env = dict(os.environ, PGPASSWORD=params["password"])
    common = ["-h", params["host"], "-p", str(params["port"]), "-U", params["user"]]
    dump = subprocess.run(
        [pg_dump, "--no-owner", "--no-privileges", *common, "-d", source],
        capture_output=True,
        env=env,
    )
    if dump.returncode != 0:
        raise RuntimeError(
            "TEMPLATE copy failed (" + template_message + ") and pg_dump failed: "
            + dump.stderr.decode("utf-8", "replace").strip()
        )
    restore = subprocess.run(
        [psql, *common, "-d", target, "-v", "ON_ERROR_STOP=1", "-q"],
        input=dump.stdout,
        capture_output=True,
        env=env,
    )
    if restore.returncode != 0:
        raise RuntimeError(
            "pg_restore into " + target + " failed: " + restore.stderr.decode("utf-8", "replace").strip()
        )
    return {"method": "pg_dump", "source": source, "target": target}


def _which(name: str) -> str | None:
    import shutil

    return shutil.which(name)


def model_counts() -> dict:
    """Setup Django (no connection) and report the model/table cardinality.

    `57 declared models + 2 auto-created M2M through tables = 59 schema tables` is the number the
    migration docs quote; reading it from Django's own registry is the only honest source. The
    filter mirrors `scripts/gen_schema.py::OUR_APPS` + its "parents must be in this schema" rule,
    which is what excludes `accounts_user_groups` (it references `auth_group`, which this port
    does not have); the driver cross-checks the result against `tables.json`, so a drift between
    the two shows up as an error instead of a silently wrong count.
    """
    our_apps = {
        "accounts",
        "analytics",
        "audit",
        "exams",
        "ingestion",
        "interaction",
        "knowledge",
        "learning",
        "memory",
        "practice",
        "question_bank",
        "search",
        "tutoring",
    }
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", DEFAULT_SETTINGS)
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    import django

    django.setup()
    from django.apps import apps

    declared = [
        model
        for model in apps.get_models()
        if not model._meta.abstract and model._meta.app_label in our_apps
    ]
    declared_tables = {model._meta.db_table for model in declared}
    auto_created = [
        model
        for model in apps.get_models(include_auto_created=True)
        if model._meta.auto_created
        and model._meta.app_label in our_apps
        and all(
            field.remote_field.model._meta.db_table in declared_tables
            for field in model._meta.concrete_fields
            if field.is_relation
        )
    ]
    return {
        "django_version": django.get_version(),
        "declared_models": len(declared),
        "model_tables": len(declared) + len(auto_created),
        "auto_created_tables": sorted(model._meta.db_table for model in auto_created),
    }


def migrate(database: str) -> dict:
    """Apply Django's migrations to a scratch database (never the real one)."""
    os.environ["DJANGO_SETTINGS_MODULE"] = DEFAULT_SETTINGS
    os.environ["POSTGRES_DB"] = database
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    import django

    django.setup()
    from django.core.management import call_command
    from django.db import connection

    call_command("migrate", verbosity=0, interactive=False)
    with connection.cursor() as cursor:
        cursor.execute("select count(*) from django_migrations")
        applied = int(cursor.fetchone()[0])
    connection.close()
    return {"database": database, "migrated": True, "applied_migrations": applied}


def drop(database: str) -> dict:
    """Terminate sessions and drop a scratch database."""
    if database in {"postgres", "template0", "template1"}:
        raise ValueError(f"refusing to drop system database {database!r}")
    from psycopg import sql

    with connect("postgres") as connection, connection.cursor() as cursor:
        cursor.execute(
            "select pg_terminate_backend(pid) from pg_stat_activity "
            "where datname = %s and pid <> pg_backend_pid()",
            [database],
        )
        cursor.execute(
            sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(database))
        )
    return {"database": database, "dropped": True}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="command", required=True)

    introspect_parser = subparsers.add_parser("introspect", help="tables and columns of a database")
    introspect_parser.add_argument("--database", required=True)

    stats_parser = subparsers.add_parser("stats", help="run the statistics SQL from a JSON spec")
    stats_parser.add_argument("--database", required=True)
    stats_parser.add_argument("--spec", required=True)

    exists_parser = subparsers.add_parser("exists", help="does the database exist")
    exists_parser.add_argument("--database", required=True)

    subparsers.add_parser("models", help="declared vs auto-created Django model tables")

    create_parser = subparsers.add_parser("create", help="create an empty scratch database")
    create_parser.add_argument("--database", required=True)

    copy_parser = subparsers.add_parser("copy", help="clone a database into a new one")
    copy_parser.add_argument("--source", required=True)
    copy_parser.add_argument("--target", required=True)

    migrate_parser = subparsers.add_parser("migrate", help="apply Django migrations to a scratch database")
    migrate_parser.add_argument("--database", required=True)

    drop_parser = subparsers.add_parser("drop", help="drop a scratch database")
    drop_parser.add_argument("--database", required=True)
    return parser


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "introspect":
            result = introspect(args.database)
        elif args.command == "stats":
            spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
            result = statistics(args.database, spec)
        elif args.command == "exists":
            result = {"database": args.database, "exists": database_exists(args.database)}
        elif args.command == "models":
            result = model_counts()
        elif args.command == "create":
            result = create_database(args.database)
        elif args.command == "copy":
            result = copy_database(args.source, args.target)
        elif args.command == "migrate":
            result = migrate(args.database)
        elif args.command == "drop":
            result = drop(args.database)
        else:  # pragma: no cover - argparse rejects this first
            raise ValueError(f"unknown command {args.command!r}")
    except Exception as error:  # noqa: BLE001 - the driver needs one machine-readable shape
        print(json.dumps({"error": {"code": type(error).__name__, "message": str(error)}}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
