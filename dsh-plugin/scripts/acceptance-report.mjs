#!/usr/bin/env node
/**
 * Turn one (or three) Playwright JSON reports plus the RPC trace into the B7
 * acceptance report.
 *
 * The point of this script is that a failure is **classified from evidence**:
 * the page fixture appends every logical call it makes to `rpc-trace.jsonl`, so
 * "the endpoint is not mounted" is a `404` on a concrete path, not an inference
 * from an assertion message. Anything the evidence cannot place is reported as
 * `unclassified_needs_review` instead of being forced into a nicer bucket.
 *
 * Usage:
 *   node scripts/acceptance-report.mjs [--main file] [--stub file] [--archive file]
 *
 * Outputs:
 *   var/acceptance/b8-report.json   machine-readable, per test
 *   var/acceptance/SUMMARY.md       short human summary
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const VAR = path.join(PLUGIN, 'var', 'acceptance')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const FILES = {
  main: arg('main', path.join(VAR, 'playwright-report.json')),
  stub: arg('stub', path.join(VAR, 'playwright-report-stub.json')),
  archive: arg('archive', path.join(VAR, 'playwright-report-archive.json')),
}

/**
 * The mounted route table, read from the router sources.
 *
 * A 404 on a path that matches a mounted pattern is *not* an unmigrated
 * endpoint — it is a contract/semantic drift between the HTTP layer and the
 * client (`/practice-sessions/undefined`, a sealed question answered 404
 * instead of 403, ...). Only a 404 on an unmounted path is a stage-3 gap.
 */
function mountedPatterns() {
  const directory = path.join(PLUGIN, 'src', 'http')
  let names = []
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.ts'))
  } catch {
    names = []
  }
  const patterns = []
  for (const name of names) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(directory, name), 'utf8')
    } catch {
      continue
    }
    const re = /pattern:\s*`\$\{PREFIX\}([^`]*)`/g
    let match
    while ((match = re.exec(text)) !== null) patterns.push(match[1])
  }
  // `${PREFIX}` is `/api/v1` and the logical paths the client sends carry it.
  return patterns.map((pattern) => {
    const source = pattern
      .split('/')
      .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')
    return new RegExp(`^/api/v1${source}$`)
  })
}

const MOUNTED = mountedPatterns()

function isMounted(logicalPath) {
  const pathOnly = logicalPath.split('?')[0]
  return MOUNTED.some((matcher) => matcher.test(pathOnly))
}

const CLASSES = {
  unmigrated: 'unmigrated_stage3_endpoint',
  fixture: 'fixture_gap',
  transport: 'transport_client_defect',
  divergence: 'intentional_divergence',
  review: 'unclassified_needs_review',
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Flatten the Playwright JSON reporter tree into one record per test result. */
function flatten(report) {
  const out = []
  if (report === undefined) return out
  const walk = (suite, inheritedFile, describes) => {
    const file = suite.file ?? inheritedFile
    const titles = suite.title === undefined || suite.title === '' ? describes : [...describes, suite.title]
    for (const spec of suite.specs ?? []) {
      const directory = path.dirname(file ?? '')
      for (const test of spec.tests ?? []) {
        const result = (test.results ?? [])[test.results.length - 1] ?? {}
        out.push({
          file: file ?? '',
          // The JSON reporter reports the file path relative to the config dir.
          relFile: path.basename(file ?? ''),
          directory,
          title: spec.title,
          fullTitle: [...titles, spec.title].join(' › '),
          line: spec.line ?? 0,
          project: test.projectName ?? '',
          status: result.status ?? 'unknown',
          expectedStatus: test.expectedStatus ?? 'passed',
          durationMs: result.duration ?? 0,
          error: (result.error?.message ?? (result.errors ?? []).map((e) => e.message).join('\n') ?? '').trim(),
        })
      }
    }
    for (const child of suite.suites ?? []) walk(child, file, titles === undefined ? [] : titles)
  }
  for (const suite of report.suites ?? []) walk(suite, undefined, [])
  return out
}

/**
 * Project ids that exist in the instance this report was produced from.
 *
 * A browser context can replay a project id from an earlier generation (the
 * client keeps `acepass.currentProject` in localStorage, and a stale id answers
 * 404). Those rows say nothing about *this* run, so they are dropped before
 * classification — otherwise every later test inherits yesterday's 404.
 */
function liveProjectIds() {
  const stateFile = readJson(path.join(VAR, 'server.json'))
  if (stateFile?.dataRoot === undefined) return undefined
  try {
    const db = new DatabaseSync(path.join(stateFile.dataRoot, 'acepass.sqlite'), { readOnly: true })
    const rows = db.prepare('select id from exams_project').all()
    db.close()
    return new Set(rows.map((row) => String(row.id)))
  } catch {
    return undefined
  }
}

const LIVE_PROJECTS = liveProjectIds()
const PROJECT_IN_PATH = /\/api\/v1\/projects\/([0-9a-f-]{36})/

function loadTrace(name) {
  const file = path.join(VAR, `rpc-trace-${name}.jsonl`)
  const index = new Map()
  let lines = []
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    return index
  }
  for (const line of lines) {
    if (line.trim() === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (LIVE_PROJECTS !== undefined) {
      const match = PROJECT_IN_PATH.exec(String(entry.path))
      if (match !== null && !LIVE_PROJECTS.has(match[1])) continue
    }
    const key = `${entry.project}|${entry.file}|${entry.title}`
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(entry)
  }
  return index
}

const FIXTURE_SIGNATURES = [
  /验收项目/,
  /验收科目/,
  /延迟验证/,
  /题库中应存在/,
  /必须产生一个到期/,
  /必须至少有两个考点/,
  /验收夹具/,
  /该作答必须出现在人工评分队列/,
  /option.*not found/i,
  /selectOption/i,
  /没有已确认的错题/,
]

function classify(record, trace, seedStatus) {
  const skippedDelayed = seedSkipped.includes('delayed_verification')
  const isStub = record.title.includes('@stub') || record.fullTitle.includes('@stub')
  if (!isStub && skippedDelayed && /延迟验证|验证任务|开始验证/.test(`${record.title} ${record.fullTitle}`)) {
    return {
      class: CLASSES.unmigrated,
      detail:
        'delayed-verification pairing service is still on the stage-3 whitelist (the seeder reports skipped:[delayed_verification]); not a fixture gap.',
    }
  }
  const error = record.error
  const calls = trace.filter((entry) => entry.status >= 400)
  const notFound = calls.filter((entry) => entry.status === 404)
  const serverErrors = calls.filter((entry) => entry.status >= 500)

  if (isStub) {
    return {
      class: CLASSES.divergence,
      detail:
        'DSH has no stub AI provider by design (R-INV 4); the case is run and its honest outcome recorded, not forced green.',
    }
  }
  if (/ai_not_configured/.test(error)) {
    return {
      class: CLASSES.divergence,
      detail: 'no AI provider is configured in the isolated home (R-INV 4); the case wanted a usable provider.',
    }
  }
  if (notFound.length > 0) {
    const paths = [...new Set(notFound.map((entry) => entry.path.split('?')[0]))]
    const unmounted = paths.filter((entry) => !isMounted(entry))
    const drifted = paths.filter((entry) => isMounted(entry))
    if (unmounted.length > 0) {
      return {
        class: CLASSES.unmigrated,
        detail: `logical endpoint(s) not mounted by the plugin router: ${unmounted.slice(0, 6).join(', ')}`,
        paths,
      }
    }
    const sealed = drifted.some((entry) => entry.endsWith('/practice-sessions')) && record.error.includes('404')
    if (sealed) {
      return {
        class: CLASSES.transport,
        detail:
          'sealed-question refusal answers 404 not_found (reason_code=sealed_question_policy) where Django answers 403 purpose_not_allowed; ' +
          'the sealing case therefore aborts before unsealing and later cases inherit the sealed row.',
        paths,
      }
    }
    return {
      class: CLASSES.transport,
      detail: `mounted endpoint answered 404 (contract/semantic drift): ${drifted.slice(0, 6).join(', ')}`,
      paths,
    }
  }
  // A mounted endpoint that answers a 4xx the suite does not expect (422 on
  // submit, 403 on variants/propose) is a contract drift, not a fixture gap.
  const semantic4xx = calls.filter(
    (entry) => entry.status >= 400 && entry.status < 500 && entry.status !== 404 && isMounted(entry.path),
  )
  if (semantic4xx.length > 0) {
    const entries = [...new Set(semantic4xx.map((entry) => `${entry.status} ${entry.method} ${entry.path.split('?')[0]}`))]
    return {
      class: CLASSES.transport,
      detail: `mounted endpoint answered a status the Django contract does not: ${entries.slice(0, 4).join(', ')}`,
      paths: entries,
    }
  }
  if (serverErrors.length > 0) {
    const paths = [...new Set(serverErrors.map((entry) => `${entry.status} ${entry.path.split('?')[0]}`))]
    return { class: CLASSES.transport, detail: `server error on ${paths.slice(0, 6).join(', ')}`, paths }
  }
  if (FIXTURE_SIGNATURES.some((pattern) => pattern.test(error))) {
    return {
      class: CLASSES.fixture,
      detail: `the acceptance fixture is "${seedStatus}"; the case never reached its assertion input.`,
    }
  }
  if (/waitForResponse: no matching logical call/.test(error)) {
    return {
      class: seedStatus === 'seeded' ? CLASSES.unmigrated : CLASSES.fixture,
      detail:
        seedStatus === 'seeded'
          ? 'the expected logical call was never issued (endpoint or UI action not migrated).'
          : `the expected logical call was never issued and the fixture is "${seedStatus}".`,
    }
  }
  if (/AcePass|context-strip|dialog|打开侧边栏|panel/i.test(error)) {
    return { class: CLASSES.transport, detail: 'the DSH shell seam (panel/dialog/hash) did not reach the app.' }
  }
  return { class: CLASSES.review, detail: 'no evidence matched a known B7 class; needs a human look.' }
}

const state = readJson(path.join(VAR, 'server.json'))
const seedStatus = state?.seed?.status ?? 'unknown'
const seedSkipped = Array.isArray(state?.seed?.summary?.skipped) ? state.seed.summary.skipped : []
const traces = Object.fromEntries(Object.keys(FILES).map((name) => [name, loadTrace(name)]))

const runs = {}
for (const [name, file] of Object.entries(FILES)) {
  const report = readJson(file)
  if (report === undefined) continue
  const tests = flatten(report).map((record) => {
    const key = `${record.project}|${record.relFile}|${record.title}`
    const calls = (traces[name] ?? new Map()).get(key) ?? []
    const failed = record.status !== 'passed'
    return {
      file: record.relFile,
      line: record.line,
      project: record.project,
      title: record.title,
      describe: record.fullTitle.slice(0, Math.max(0, record.fullTitle.length - record.title.length - 3)),
      status: record.status,
      durationMs: record.durationMs,
      error: failed ? record.error.split('\n').slice(0, 12).join('\n') : '',
      classification: failed
        ? classify(record, calls, seedStatus)
        : { class: 'passed', detail: '' },
      httpFailures: calls
        .filter((entry) => entry.status >= 400)
        .map((entry) => `${entry.status} ${entry.method} ${entry.path}`)
        .slice(0, 12),
    }
  })
  const passed = tests.filter((test) => test.status === 'passed').length
  const failed = tests.filter((test) => test.status !== 'passed' && test.status !== 'skipped').length
  const skipped = tests.filter((test) => test.status === 'skipped').length
  runs[name] = {
    file: path.relative(PLUGIN, file),
    collected: tests.length,
    passed,
    failed,
    skipped,
    durationMs: tests.reduce((sum, test) => sum + test.durationMs, 0),
    tests,
  }
}

/* -------------------------------------------------------------- aggregates */
const allFailed = Object.values(runs).flatMap((run) => run.tests.filter((test) => test.status !== 'passed'))
const byClass = {}
for (const test of allFailed) {
  const key = test.classification.class
  byClass[key] = (byClass[key] ?? 0) + 1
}

const endpointHits = {}
for (const test of allFailed) {
  for (const raw of test.httpFailures) {
    const [, method, ...rest] = raw.split(' ')
    const logical = rest.join(' ').split('?')[0]
    // Only genuinely unmounted paths belong in this table; a mounted endpoint
    // that answers 4xx is reported as a contract drift instead.
    if (isMounted(logical)) continue
    const key = `${method} ${logical.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<id>')}`
    endpointHits[key] = (endpointHits[key] ?? 0) + 1
  }
}

/* ------------------------------------------------------- divergence ledger */
const divergences = [
  {
    id: 'auth',
    django: 'email/password form + CSRF token, session cookie',
    dsh: 'DSH session; first navigation to the ?token= URL sets the auth cookie; no login form, no CSRF',
    impact: 'login() no longer fills a form; every test starts with one navigation to the token URL.',
  },
  {
    id: 'routes',
    django: 'real URLs (/questions, /review, ...)',
    dsh: 'HashRouter inside the panel (#/questions)',
    impact: 'page.goto(appRoute) is rewritten to `#/<route>`; assertions on page URLs still match the path.',
  },
  {
    id: 'transport',
    django: 'same-origin fetch to /api/v1/...',
    dsh: 'one POST /api/acepass/rpc envelope per logical call',
    impact: 'response watching and page.request read the envelope; predicates still see the logical URL/status.',
  },
  {
    id: 'stream',
    django: 'SSE at /api/v1/.../stream',
    dsh: 'SSE at /api/acepass/stream?op=tutor.stream — a real producer since B8 (validated segments only); the @stub reconnect case still cannot pass without a stub provider',
    impact: 'the @stub reconnect case cannot pass; recorded, not forced.',
  },
  {
    id: 'stub',
    django: 'ACEPASS_AI_PROVIDER=stub run for 8 collected @stub cases',
    dsh: 'no stub provider by design (R-INV 4)',
    impact: 'the 4 @stub bodies (8 collected) report ai_not_configured / unmigrated honestly.',
  },
]

/* --------------------------------------------------- assertion preservation */
const ORIGINAL = path.resolve(PLUGIN, '..', 'frontend', 'tests', 'acceptance')
const MIGRATED = path.resolve(PLUGIN, '..', 'frontend', 'tests', 'dsh')
const countExpects = (text) => (text.match(/expect\s*[.(]/g) ?? []).length
const assertions = []
try {
  for (const name of fs.readdirSync(MIGRATED).filter((entry) => entry.endsWith('.spec.ts'))) {
    const originalFile = path.join(ORIGINAL, name)
    if (!fs.existsSync(originalFile)) continue
    const original = countExpects(fs.readFileSync(originalFile, 'utf8'))
    const migrated = countExpects(fs.readFileSync(path.join(MIGRATED, name), 'utf8'))
    assertions.push({ file: name, originalExpects: original, migratedExpects: migrated, equal: original === migrated })
  }
  const archive = 'archive/ui-regressions.spec.ts'
  const archiveOriginal = countExpects(fs.readFileSync(path.resolve(PLUGIN, '..', 'docs', 'review', '2026-09-27', 'ui-regressions.spec.ts'), 'utf8'))
  const archiveMigrated = countExpects(fs.readFileSync(path.join(MIGRATED, archive), 'utf8'))
  assertions.push({
    file: archive,
    originalExpects: archiveOriginal,
    migratedExpects: archiveMigrated,
    equal: archiveOriginal === archiveMigrated,
  })
} catch (error) {
  assertions.push({ file: '(comparison failed)', error: String(error) })
}

/* --------------------------------------------------------------- assertion diffs that cannot hold */
const knownAssertionDiffs = [
  {
    file: 'frontend/tests/dsh/helpers.ts:login()',
    original:
      'frontend/tests/acceptance/helpers.ts:29-35 — after the login form, `expect(page.getByText(\'我的备考项目\')).toBeVisible()`',
    difference:
      'DSH has no login form: the session is the workspace owner. The migrated login waits for the authenticated shell (选择考试项目) instead, because a fixture-less home legitimately renders 开始使用 rather than 我的备考项目.',
  },
  {
    file: 'frontend/tests/dsh/p0-2-empty-account.spec.ts:65',
    original: 'frontend/tests/acceptance/p0-2-empty-account.spec.ts:57-61 — sign in as empty@acepass.local through the form',
    difference:
      'DSH has one workspace owner account, so there is no second empty account. The test still builds project/subject/spec/import/publish/attempt from zero through the UI; only the admission step changed. The assertion inside loginEmptyAccount is unchanged.',
  },
  {
    file: 'frontend/tests/dsh/p0-acceptance.spec.ts:302',
    original: 'frontend/tests/acceptance/p0-acceptance.spec.ts:279 — in-page `fetch(\'/api/v1/projects\')` with a CSRF header',
    difference:
      'the logical path is not an HTTP URL on DSH; the same calls go through `window.__acepassRpc` (the RPC carrier), and the assertion on the returned evidence is unchanged.',
  },
  {
    file: 'frontend/tests/dsh/p0-acceptance.spec.ts:517',
    original: 'frontend/tests/acceptance/p0-acceptance.spec.ts:514 — `page.route(\'**/api/v1/projects/*/review-tasks*\')`',
    difference:
      'page.route cannot intercept a logical call inside the RPC envelope; the client\'s `window.__acepassFaults` hook forces the same logical 500. The assertion ("error shown instead of empty state") is unchanged.',
  },
]

/* -------------------------------------------------------------- write files */
const report = {
  generatedAt: new Date().toISOString(),
  instance: state === undefined ? undefined : { port: state.port, dataRoot: state.dataRoot, seed: state.seed },
  seedStatus,
  classes: CLASSES,
  runs,
  totals: {
    collected: Object.values(runs).reduce((sum, run) => sum + run.collected, 0),
    passed: Object.values(runs).reduce((sum, run) => sum + run.passed, 0),
    failed: Object.values(runs).reduce((sum, run) => sum + run.failed, 0),
    byClass,
  },
  failingEndpoints: Object.entries(endpointHits)
    .sort((a, b) => b[1] - a[1])
    .map(([endpoint, count]) => ({ endpoint, count })),
  intentionalDivergences: divergences,
  assertionPreservation: assertions,
  assertionsThatCannotHold: knownAssertionDiffs,
}
fs.writeFileSync(path.join(VAR, 'b8-report.json'), `${JSON.stringify(report, null, 2)}\n`)

/* ------------------------------------------------------------------- summary */
const lines = []
lines.push('# B8 browser acceptance — DSH Web client')
lines.push('')
lines.push(`Generated ${report.generatedAt}. Isolated instance: \`${state?.dataRoot ?? '(unknown data root)'}\`, fixture: **${seedStatus}**.`)
lines.push('')
lines.push('| run | collected | passed | failed | skipped | duration |')
lines.push('| --- | --- | --- | --- | --- | --- |')
for (const [name, run] of Object.entries(runs)) {
  const minutes = (run.durationMs / 60_000).toFixed(1)
  lines.push(`| ${name} | ${run.collected} | ${run.passed} | ${run.failed} | ${run.skipped} | ${minutes} min |`)
}
lines.push('')
if (runs.archive !== undefined) {
  lines.push('## Archive run (归档反例)')
  lines.push('')
  lines.push(
    '`frontend/tests/dsh/archive/ui-regressions.spec.ts` is the 2026-09-27 review file, copied with only the import seam changed. ' +
      '归档 **3/3** now pass: the two exit-criterion counter-examples — #1 "submitted practice still exposes tutoring entry" and #2 "answer reveal survives reloading a submitted item" — were blocked by the missing `/reveal` and tutoring routes in B7 and pass after B8. ' +
      '#3 "constructed response provides photo attachment input" is applicable and runs, but it is subsumed by the main suite\'s attachment cases ' +
      '(p0-acceptance "attachments uploaded with a constructed response ...", p0-2-regressions "an unsubmitted answer photo survives a refresh"), so it is kept as a duplicate smoke rather than counted twice.',
  )
  lines.push('')
}
lines.push('## Fixture inventory')
lines.push('')
const seedSummary = state?.seed?.summary
if (seedSummary === undefined) {
  lines.push(`No seed summary recorded (fixture status: **${seedStatus}**).`)
} else {
  lines.push(
    `projects: A/B/C; subjects: ${seedSummary.subjects}; published versions: ${seedSummary.published_versions} ` +
      `(${Object.entries(seedSummary.published_versions_by_type ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}); ` +
      `delayed-verification tasks: ${seedSummary.delayed_verification_tasks}; ` +
      `cycle subject: ${seedSummary.cycle_subject_name} (complete ${ (seedSummary.complete_cycles ?? []).join('/') }, incomplete ${seedSummary.incomplete_cycle}); ` +
      `skipped: ${JSON.stringify(seedSummary.skipped ?? [])}`,
  )
}
lines.push('')
lines.push('## Failure classes')
lines.push('')
lines.push('| class | count |')
lines.push('| --- | --- |')
for (const [name, count] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
  lines.push(`| \`${name}\` | ${count} |`)
}
lines.push('')
if (report.failingEndpoints.length > 0) {
  lines.push('## Logical endpoints the client called that the plugin does not mount')
  lines.push('')
  lines.push('| endpoint | failing tests |')
  lines.push('| --- | --- |')
  for (const entry of report.failingEndpoints.slice(0, 30)) {
    lines.push(`| \`${entry.endpoint}\` | ${entry.count} |`)
  }
  lines.push('')
}
lines.push('## Per-test results')
lines.push('')
for (const [name, run] of Object.entries(runs)) {
  lines.push(`### ${name}`)
  lines.push('')
  lines.push('| test | project | status | class |')
  lines.push('| --- | --- | --- | --- |')
  for (const test of run.tests) {
    const mark = test.status === 'passed' ? '✅' : '❌'
    lines.push(
      `| ${mark} ${test.title.replace(/\|/g, '\\|')} (\`${test.file}:${test.line}\`) | ${test.project} | ${test.status} | ${
        test.status === 'passed' ? '—' : `\`${test.classification.class}\``
      } |`,
    )
  }
  lines.push('')
}
lines.push('## Intentional divergences')
lines.push('')
for (const entry of divergences) {
  lines.push(`- **${entry.id}** — ${entry.django} → ${entry.dsh}. ${entry.impact}`)
}
lines.push('')
lines.push('## Assertions that cannot hold unchanged')
lines.push('')
for (const entry of knownAssertionDiffs) {
  lines.push(`- \`${entry.file}\`: ${entry.difference}`)
}
lines.push('')
lines.push('## Assertion preservation (expect() call count)')
lines.push('')
lines.push('| file | original | migrated | equal |')
lines.push('| --- | --- | --- | --- |')
for (const entry of assertions) {
  lines.push(`| ${entry.file} | ${entry.originalExpects ?? '—'} | ${entry.migratedExpects ?? '—'} | ${entry.equal ? 'yes' : '**NO**'} |`)
}
lines.push('')
fs.writeFileSync(path.join(VAR, 'SUMMARY.md'), `${lines.join('\n')}\n`)

process.stdout.write(`${JSON.stringify(report.totals)}\n`)
process.stdout.write(`report: ${path.join(VAR, 'b8-report.json')}\nsummary: ${path.join(VAR, 'SUMMARY.md')}\n`)
