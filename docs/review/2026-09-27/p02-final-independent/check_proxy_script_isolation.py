"""Safe C05 black-box check: all Docker calls are intercepted; no real Docker mutation.

Runs the unmodified committed proxy script in a disposable filesystem fixture.
A fake local .env sentinel must survive a verifier that promises isolation.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile

source = Path('/Users/cololi/Documents/AcePass')
fixture = Path(tempfile.mkdtemp(prefix='acepass-proxy-isolation-shim-'))
(fixture / 'scripts').mkdir()
(fixture / 'infra/docker/certs').mkdir(parents=True)
(fixture / 'bin').mkdir()
shutil.copyfile(source / 'scripts/verify_proxy.sh', fixture / 'scripts/verify_proxy.sh')
shutil.copyfile(source / 'infra/docker/docker-compose.yml', fixture / 'infra/docker/docker-compose.yml')
# The committed tree lacks .env.example. Supply a fake template here solely to
# isolate the independent overwrite/delete issue from that packaging failure.
(fixture / 'infra/docker/.env.example').write_text('TEST_TEMPLATE_DEFAULT=fake-fixture-only\n')
sentinel = 'TEST_EXISTING_CONFIGURATION=preserve-this-fake-sentinel\n'
(fixture / 'infra/docker/.env').write_text(sentinel)
(fixture / 'infra/docker/certs/tls.crt').write_text('fake-cert\n')
(fixture / 'infra/docker/certs/tls.key').write_text('fake-key\n')
shim = fixture / 'bin/docker'
shim.write_text('''#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DOCKER_SHIM_LOG"
case "$*" in
  *" build api"*) exit 42;;
  *) exit 0;;
esac
''')
shim.chmod(0o755)
env = dict(os.environ)
for key in ('COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'COMPOSE_PROFILES'):
    env.pop(key, None)
env['PATH'] = str(fixture / 'bin') + ':' + env['PATH']
env['DOCKER_SHIM_LOG'] = str(fixture / 'docker-calls.txt')
result = subprocess.run(['bash', 'scripts/verify_proxy.sh', 'full-stack'], cwd=fixture, env=env, capture_output=True, text=True)
(fixture / 'stdout.txt').write_text(result.stdout + result.stderr)
calls = (fixture / 'docker-calls.txt').read_text().splitlines()
summary = {
    'mode': 'safe-shell-shim-no-real-docker',
    'fixture': str(fixture),
    'intentional_stop_at_build_exit_code': result.returncode,
    'docker_calls': calls,
    'default_compose_project': 'acepass (name declared in unchanged docker-compose.yml)',
    'existing_env_preserved': (fixture / 'infra/docker/.env').read_text() == sentinel,
    'template_overwrote_existing_env': 'TEST_TEMPLATE_DEFAULT=' in (fixture / 'infra/docker/.env').read_text(),
    'cleanup_contains_volume_deletion': any('down -v --remove-orphans' in call for call in calls),
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
