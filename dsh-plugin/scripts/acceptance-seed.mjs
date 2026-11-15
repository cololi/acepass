#!/usr/bin/env node
/**
 * Seed the browser-acceptance fixture into one AcePass data root.
 *
 *   node scripts/acceptance-seed.mjs --data-root /tmp/seed-check
 *
 * Prints a single-line JSON summary on stdout (the browser harness parses the last JSON line) and
 * the human-readable form on stderr. The fixture itself is built by `acceptance-fixture.ts`, which
 * only calls `src/services/*` — this file is arguments, output and exit codes.
 *
 * Exit codes: 0 seeded, 1 failed (the error is printed on stderr), 2 bad arguments.
 */
import { seedAcceptanceFixture } from './acceptance-fixture.ts'
import { resolve as resolvePath } from 'node:path'

function usage() {
  return [
    'usage: acceptance-seed.mjs --data-root <dir> [--quiet] [--help]',
    '',
    '  --data-root <dir>  directory that will own acepass.sqlite (created when missing)',
    '  --quiet            print only the JSON summary on stdout',
    '',
    'Prints one JSON object on stdout with Django build()\'s keys.',
  ].join('\n')
}

function fail(message, exitCode) {
  process.stderr.write(`acceptance-seed: ${message}\n`)
  process.exit(exitCode)
}

const argv = process.argv.slice(2)
let dataRoot = null
let quiet = false
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--data-root' || arg === '--dataRoot') {
    dataRoot = argv[++index] ?? null
  } else if (arg === '--quiet') {
    quiet = true
  } else if (arg === '--help' || arg === '-h') {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  } else if (arg.startsWith('--data-root=')) {
    dataRoot = arg.slice('--data-root='.length)
  } else {
    fail(`unknown argument ${JSON.stringify(arg)}\n${usage()}`, 2)
  }
}
if (dataRoot === null || dataRoot.trim() === '') fail(`--data-root is required\n${usage()}`, 2)

const resolvedRoot = resolvePath(dataRoot)
try {
  const summary = seedAcceptanceFixture({ dataRoot: resolvedRoot })
  if (!quiet) {
    process.stderr.write(`acceptance-seed: seeded ${resolvedRoot}\n`)
    for (const [key, value] of Object.entries(summary)) {
      process.stderr.write(`  ${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}\n`)
    }
  }
  // Last stdout line, one line by design: acceptance-server.mjs parses stdout line by line.
  process.stdout.write(`${JSON.stringify(summary)}\n`)
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  fail(detail, 1)
}
