/**
 * Stop the isolated DSH instance after the run.
 *
 * `ACEPASS_KEEP_SERVER=1` keeps it alive for a follow-up run or for manual
 * inspection; the next boot reuses a healthy instance either way.
 */
import { spawnSync } from 'node:child_process'
import { REPO, SERVER_SCRIPT } from './state'

export default function globalTeardown(): void {
  if (process.env.ACEPASS_KEEP_SERVER === '1') return
  spawnSync(process.execPath, [SERVER_SCRIPT, '--stop'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
  })
}
