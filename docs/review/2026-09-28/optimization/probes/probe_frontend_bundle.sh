#!/usr/bin/env bash
# W4 verifier probe ③ — measure a built frontend bundle independently.
#
# Usage: bash probe_frontend_bundle.sh <dist-dir> <label>
#
# Reports, for the *entry* chunk (the module script referenced by index.html, and
# also the index-*.js glob as a cross-check):
#   * raw bytes and gzip bytes
#   * how many times the string "katex" occurs (the first-screen chunk must not
#     carry KaTeX after the optimisation)
#   * how many JS chunks the build emitted (lazy loading means more than one)
#   * every dist/assets/*.js with its bytes and gzip bytes
#
# Writes JSON to stdout and, when W4_PROBE_OUT is set, to that path too.
set -euo pipefail

DIST="${1:?usage: probe_frontend_bundle.sh <dist-dir> <label>}"
LABEL="${2:?usage: probe_frontend_bundle.sh <dist-dir> <label>}"
OUT="${W4_PROBE_OUT:-}"

python3 - "$DIST" "$LABEL" "$OUT" <<'PY'
import gzip
import json
import os
import re
import sys
from pathlib import Path

dist = Path(sys.argv[1])
label = sys.argv[2]
out = sys.argv[3] if len(sys.argv) > 3 else ""

if not dist.is_dir():
    raise SystemExit(f"no such dist dir: {dist}")

index_html = dist / "index.html"
html = index_html.read_text(encoding="utf-8") if index_html.exists() else ""
entry_refs = re.findall(r'<script[^>]+type="module"[^>]+src="([^"]+)"', html)
entry_files = [dist / ref.lstrip("/") for ref in entry_refs]
modulepreload_refs = re.findall(r'<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"', html)
preload_files = [dist / ref.lstrip("/") for ref in modulepreload_refs]
glob_entry = sorted(dist.glob("assets/index-*.js"))

assets = sorted((dist / "assets").glob("*.js")) if (dist / "assets").is_dir() else []
css = sorted((dist / "assets").glob("*.css")) if (dist / "assets").is_dir() else []


def size(path: Path) -> dict:
    raw = path.read_bytes()
    return {
        "file": path.name,
        "bytes": len(raw),
        "gzip_bytes": len(gzip.compress(raw, compresslevel=9)),
    }


def katex_hits(path: Path) -> int:
    try:
        return path.read_text(encoding="utf-8", errors="ignore").casefold().count("katex")
    except Exception:
        return -1


entry = []
for path in entry_files:
    if path.exists():
        row = size(path)
        row["referenced_by_index_html"] = True
        row["katex_occurrences"] = katex_hits(path)
        entry.append(row)
for path in glob_entry:
    if any(row["file"] == path.name for row in entry):
        continue
    row = size(path)
    row["referenced_by_index_html"] = path.name in html
    row["katex_occurrences"] = katex_hits(path)
    entry.append(row)

katex_chunks = [row for row in (size(p) | {"katex_occurrences": katex_hits(p)} for p in assets)
                if row["katex_occurrences"] > 0]

report = {
    "label": label,
    "dist": str(dist),
    "entry_chunks": entry,
    "entry_js_bytes": sum(row["bytes"] for row in entry),
    "entry_js_gzip_bytes": sum(row["gzip_bytes"] for row in entry),
    "entry_katex_occurrences": sum(row["katex_occurrences"] for row in entry),
    "first_screen_files": [size(p) for p in preload_files if p.exists()],
    "first_screen_bytes": sum(size(p)["bytes"] for p in preload_files if p.exists())
    + sum(row["bytes"] for row in entry),
    "first_screen_gzip_bytes": sum(size(p)["gzip_bytes"] for p in preload_files if p.exists())
    + sum(row["gzip_bytes"] for row in entry),
    "modulepreload_refs": modulepreload_refs,
    "js_chunk_count": len(assets),
    "js_chunks": [size(p) for p in assets],
    "css_chunks": [size(p) for p in css],
    "dist_total_bytes": sum(p.stat().st_size for p in dist.rglob("*") if p.is_file()),
    "chunks_containing_katex": [row["file"] for row in katex_chunks],
    "index_html_script_refs": entry_refs,
}

text = json.dumps(report, ensure_ascii=False, indent=2)
print(text)
if out:
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(text, encoding="utf-8")
    print(f"W4PROBE wrote {out}", file=sys.stderr)
PY
