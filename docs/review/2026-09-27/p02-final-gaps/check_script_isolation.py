#!/usr/bin/env python3
"""C05 evidence: run the *committed* release-gate script under a Docker shim.

This is the evidence runner for the round that closed the final four P0.2 gaps.
It complements the migrated official test (``backend/tests/integration/
test_p0_2_final_gaps.py``) by printing the raw Docker call log, so a reviewer can
see *what* the script asked Docker to do without running Docker at all.

The fixture contains a complete copy of the committed tree the script needs
(``verify_proxy.sh``, ``gen-dev-certs.sh``, the compose file, ``.env.example`` and
a built ``frontend/dist``), plus a fake existing ``infra/docker/.env`` sentinel.
Every ``docker`` call is intercepted; no container, image, volume or network is
ever touched.

Usage:
    python3 docs/review/2026-09-27/p02-final-gaps/check_script_isolation.py
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]

SHIM = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_SHIM_LOG"
case "$*" in
  *"FAIL_PATTERN"*) exit 42;;
  *"config --format json"*)
    env_file=""; previous=""
    for arg in "$@"; do
      if [ "$previous" = "--env-file" ]; then env_file="$arg"; fi
      previous="$arg"
    done
    tag="$(sed -n 's/^ACEPASS_IMAGE_TAG=//p' "$env_file" 2>/dev/null | head -1)"
    printf '{"services":{"api":{"image":"acepass-backend:%s"}}}\\n' "$tag"
    exit 0;;
  *) exit 0;;
esac
"""

SENTINEL = "TEST_EXISTING_CONFIGURATION=preserve-this-fake-sentinel\n"


def build_fixture(tmp: Path, fail_pattern: str) -> tuple[Path, Path, Path]:
    root = tmp / "repo"
    (root / "scripts").mkdir(parents=True)
    (root / "infra/docker").mkdir(parents=True)
    (root / "infra/docker/certs").mkdir(parents=True)
    (root / "frontend/dist").mkdir(parents=True)
    for relative in (
        "scripts/verify_proxy.sh",
        "scripts/gen-dev-certs.sh",
        "infra/docker/docker-compose.yml",
        "infra/docker/.env.example",
    ):
        shutil.copyfile(REPO_ROOT / relative, root / relative)
    (root / "frontend/dist/index.html").write_text('<div id="root">AcePass</div>\n')
    (root / "infra/docker/.env").write_text(SENTINEL)

    bin_dir = tmp / "bin"
    bin_dir.mkdir()
    shim = bin_dir / "docker"
    shim.write_text(SHIM.replace("FAIL_PATTERN", fail_pattern))
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    python3 = bin_dir / "python3"
    python3.write_text(f'#!/usr/bin/env bash\nexec "{sys.executable}" "$@"\n')
    python3.chmod(0o755)
    return root, bin_dir, tmp / "docker-calls.txt"


def run(mode: str, fail_pattern: str) -> dict:
    tmp = Path(tempfile.mkdtemp(prefix=f"acepass-c05-{mode}-"))
    root, bin_dir, log = build_fixture(tmp, fail_pattern)
    log.write_text("")
    env = dict(os.environ)
    for key in ("COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_PROFILES", "ACEPASS_TLS_DIR"):
        env.pop(key, None)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["DOCKER_SHIM_LOG"] = str(log)
    result = subprocess.run(
        ["bash", "scripts/verify_proxy.sh", mode],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    calls = [line for line in log.read_text().splitlines() if line.strip()]
    env_after = (root / "infra/docker/.env").read_text()
    image_removals = [call for call in calls if call.startswith("image rm ")]
    summary = {
        "mode": mode,
        "safe_shell_shim": True,
        "shim_fail_pattern": fail_pattern,
        "script_exit_code": result.returncode,
        "stdout_tail": (result.stdout + result.stderr).strip().splitlines()[-3:],
        "docker_calls": calls,
        "default_project_acepass_used": any("--project-name acepass " in call for call in calls),
        "down_targets_only_own_project": all(
            "--project-name acepass-verify-" in call for call in calls if " down " in call
        ),
        "existing_env_preserved": env_after == SENTINEL,
        "template_overwrote_existing_env": "TEST_TEMPLATE_DEFAULT" in env_after,
        "project_env_file_used": any("--env-file" in call and "/infra/docker/.env " in call for call in calls),
        "temp_workdir_removed": not any(
            Path(call.split("--env-file ")[1].split()[0]).parent.exists()
            for call in calls
            if "--env-file " in call
        ),
        "image_removals": image_removals,
        "removals_are_own_tag_only": all(
            "acepass-backend:acepass-verify-" in call for call in image_removals
        ),
        "fixture": str(root),
    }
    shutil.rmtree(tmp, ignore_errors=True)
    return summary


def main() -> int:
    report = {
        "source_paths": [
            "scripts/verify_proxy.sh",
            "infra/docker/.env.example",
            ".github/workflows/ci.yml",
        ],
        "runs": [
            run("full-stack", "build api"),
            run("component", "network create"),
        ],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    checks = report["runs"]
    ok = all(
        item["existing_env_preserved"]
        and not item["default_project_acepass_used"]
        and not item["template_overwrote_existing_env"]
        and not item["project_env_file_used"]
        and item["script_exit_code"] == 42
        and item["removals_are_own_tag_only"]
        and (
            item["mode"] != "full-stack"
            or (
                item["down_targets_only_own_project"]
                and item["temp_workdir_removed"]
                and len(item["image_removals"]) == 1
            )
        )
        for item in checks
    )
    print(f"\nC05 isolation evidence: {'ok' if ok else 'NOT OK'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
