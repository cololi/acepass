"""Export a live Django database into the `.acepass` archive format.

The archive is the contract between the two implementations, so it stores values in the *storage*
shape `node:sqlite` will hold, not in Django's shape: decimals as strings, instants as ISO-8601 with
an explicit offset, booleans as 0/1, JSON as JSON. That is the only way the two sides can agree on a
digest without one of them re-implementing the other's codec.

Layout::

    <archive>/manifest.json     schema fingerprint, per-table counts and digests, export metadata
    <archive>/<table>.jsonl     one JSON array per line, columns in `manifest.tables[*].columns` order

Usage::

    python scripts/export_db.py --out DIR --tables-json .cache/tables.json
"""
import argparse
import datetime as dt
import decimal
import hashlib
import json
import os
import uuid
from pathlib import Path

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
django.setup()

from django.apps import apps  # noqa: E402
from django.db import connection  # noqa: E402

FORMAT_VERSION = 1


def normalise(value):
    """Python value → the shape `node:sqlite` stores, so both sides digest the same bytes."""
    if value is None:
        return None
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, decimal.Decimal):
        # `str()` keeps the exponent the column was written with ("2.00", not "2").
        return str(value)
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=dt.timezone.utc)
        return value.isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (list, dict)):
        # Django JSONFields already hold plain structures; recurse so decimals inside them survive.
        if isinstance(value, list):
            return [normalise(item) for item in value]
        return {key: normalise(item) for key, item in value.items()}
    if isinstance(value, (int, float, str)):
        return value
    return str(value)


def canonical(row, columns):
    """The exact string both implementations hash: sorted keys, no whitespace, no ASCII escaping."""
    ordered = {name: row.get(name) for name in sorted(columns)}
    return json.dumps(ordered, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def columns_from_spec(table):
    return [column["name"] for column in table["columns"]]


def export_table(model, table, out_dir: Path):
    """One table → one JSONL file of JSON arrays, plus the digest of the canonical rows.

    `.values(*columns)` is deliberate: a column the model does not expose raises `FieldError` here
    instead of silently exporting `null`, which would make the reconciliation pass on bad data.
    """
    columns = columns_from_spec(table)
    pk = model._meta.pk.name
    digest = hashlib.sha256()
    count = 0
    path = out_dir / f"{table['name']}.jsonl"
    with path.open("w", encoding="utf-8") as handle:
        for raw_row in model._default_manager.order_by(pk).values(*columns).iterator(chunk_size=500):
            row = {name: normalise(raw_row[name]) for name in columns}
            digest.update(canonical(row, columns).encode("utf-8"))
            digest.update(b"\n")
            handle.write(json.dumps([row[name] for name in columns], ensure_ascii=False) + "\n")
            count += 1
    return count, digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--tables-json", required=True)
    args = parser.parse_args()

    spec = json.loads(Path(args.tables_json).read_text(encoding="utf-8"))
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # `include_auto_created` covers the implicit M2M through tables; without them the archive
    # writes an empty file and marks the table `no_model`, which silently loses rows.
    models = {
        model._meta.db_table: model for model in apps.get_models(include_auto_created=True)
    }
    manifest = {
        "format_version": FORMAT_VERSION,
        "source": {
            "engine": connection.vendor,
            "database": connection.settings_dict["NAME"],
            "django_version": django.get_version(),
        },
        "tables": [],
    }
    missing = []
    for table in spec["tables"]:
        model = models.get(table["name"])
        if model is None:
            # The table exists in the target schema but has no Django model (a through table, for
            # example). It is exported empty and reconciled as empty rather than silently skipped.
            missing.append(table["name"])
            (out_dir / f"{table['name']}.jsonl").write_text("", encoding="utf-8")
            manifest["tables"].append(
                {
                    "name": table["name"],
                    "columns": columns_from_spec(table),
                    "rows": 0,
                    "digest": hashlib.sha256().hexdigest(),
                    "no_model": True,
                }
            )
            continue
        rows, digest = export_table(model, table, out_dir)
        manifest["tables"].append(
            {"name": table["name"], "columns": columns_from_spec(table), "rows": rows, "digest": digest}
        )
    manifest["missing_models"] = missing
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    total = sum(entry["rows"] for entry in manifest["tables"])
    print(json.dumps({"tables": len(manifest["tables"]), "rows": total, "missing_models": missing}))


if __name__ == "__main__":
    main()
