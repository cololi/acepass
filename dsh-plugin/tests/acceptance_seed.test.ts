/**
 * The B7 acceptance fixture must be reachable through the service layer, not just present in SQLite.
 *
 * These cases exist because the browser suite's greenness depends on data it did not create: if the
 * seeder wrote rows the service queries cannot see (wrong origin_type, an unpublished version, a
 * mapping on a stale revision), the browser run would fail for a reason that has nothing to do with
 * the page being tested. So every assertion here goes through a `src/services/*` read that a page
 * also uses, and compares against the numbers the seeder reported — the summary and the database
 * have to agree, because the harness trusts the summary.
 *
 * The delayed-verification chain is asserted through the production rules: the fixture drives a real
 * A → B → C pairing, so "C is due" has to be true according to `delayedIntervalStatus` — the same
 * function the review page and the start endpoint use. A hand-written task row could pass a naive
 * assertion while the product would still refuse to start it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openStore } from '../src/store/db.ts'
import { findOne, findRows } from '../src/store/repository.ts'
import { parseInstant } from '../src/domain/instant.ts'
import { ensureOwner } from '../src/services/accounts.ts'
import { listPapers, listProjects, listSubjects } from '../src/services/exams.ts'
import { listQuestions } from '../src/services/questions.ts'
import { cycleAnalysis } from '../src/services/cycles.ts'
import { delayedIntervalStatus } from '../src/services/pairing.ts'
import {
  CYCLE_INCOMPLETE_YEAR,
  CYCLE_YEARS,
  FIXTURE_PROJECT_NAMES,
  PROJECT_A,
  PROJECT_B,
  PROJECT_C,
  SUBJECT_CYCLES,
  SUBJECT_NAMES,
  seedAcceptanceFixture,
  type AcceptanceSeedSummary,
} from '../scripts/acceptance-fixture.ts'

/** A throwaway data root; the seeder owns the directory, the test only picks the name. */
function withDataRoot<T>(fn: (dataRoot: string) => T): T {
  const dataRoot = mkdtempSync(join(tmpdir(), 'acepass-seed-test-'))
  try {
    return fn(dataRoot)
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
}

/** Re-open the store the seeder wrote. `seedAcceptanceFixture` closes its own handle. */
function openSeeded(dataRoot: string): { db: DatabaseSync; close: () => void; userId: string } {
  const store = openStore({ path: join(dataRoot, 'acepass.sqlite') })
  // The seeder also created this row; resolving it through the service proves the same identity the
  // HTTP layer would use owns the fixture.
  const userId = ensureOwner(store.db, parseInstant('2026-01-01T00:00:00+00:00'))
  return { db: store.db, close: store.close, userId }
}

function activeFixtureProjects(db: DatabaseSync, userId: string): Record<string, unknown>[] {
  const byName = new Map(listProjects(db, userId).map((project) => [String(project.name), project]))
  return FIXTURE_PROJECT_NAMES.map((name) => {
    const project = byName.get(name)
    assert.ok(project, `active project ${name} must exist`)
    return project
  })
}

function fixtureSubjects(db: DatabaseSync, userId: string): Record<string, unknown>[] {
  return activeFixtureProjects(db, userId).flatMap((project) => listSubjects(db, userId, String(project.id)))
}

test('acceptance fixture: three active projects with the exact names the browser suite asserts on', () => {
  withDataRoot((dataRoot) => {
    const summary = seedAcceptanceFixture({ dataRoot })
    const { db, close, userId } = openSeeded(dataRoot)
    try {
      const projects = activeFixtureProjects(db, userId)
      assert.deepEqual(
        projects.map((project) => String(project.name)),
        [PROJECT_A, PROJECT_B, PROJECT_C],
      )
      assert.deepEqual(
        projects.map((project) => String(project.id)),
        [summary.project_a, summary.project_b, summary.project_c],
        'the summary must name the rows that actually ended up active',
      )
      assert.ok(projects.every((project) => project.is_archived === false))
      assert.equal(summary.archived_projects.length, 0, 'a fresh data root replaces nothing')

      // Django's build() counts the subjects of the three fixture projects: A:2, B:2 (one is the
      // cycle-analysis subject), C:1.
      const subjects = fixtureSubjects(db, userId)
      assert.equal(subjects.length, 5)
      assert.equal(summary.subjects, 5)
      const byProject = new Map<string, string[]>()
      for (const project of projects) {
        byProject.set(
          String(project.name),
          listSubjects(db, userId, String(project.id)).map((subject) => String(subject.name)),
        )
      }
      assert.deepEqual(byProject.get(PROJECT_A), [SUBJECT_NAMES[0], SUBJECT_NAMES[1]])
      assert.deepEqual(byProject.get(PROJECT_B), [SUBJECT_NAMES[2], SUBJECT_CYCLES])
      assert.equal(byProject.get(PROJECT_C)?.length, 1)
    } finally {
      close()
    }
  })
})

test('acceptance fixture: five published question types are queryable through the question service', () => {
  withDataRoot((dataRoot) => {
    const summary = seedAcceptanceFixture({ dataRoot })
    const { db, close, userId } = openSeeded(dataRoot)
    try {
      // Project A owns *two* subjects, and every subject carries the full blueprint set: the unit of
      // the fixture is (subject × 7 versions), never (project × 7). Querying by project id therefore
      // returns 14 here by design; the per-subject scope is what proves the blueprint.
      const projectA = activeFixtureProjects(db, userId)[0]
      const subjectsA = listSubjects(db, userId, String(projectA.id))
      assert.equal(subjectsA.length, 2)
      assert.equal(listQuestions(db, String(projectA.id), { limit: 100 }).length, 14)

      const typesPerSubject: string[][] = []
      for (const subject of subjectsA) {
        const questions = listQuestions(db, String(projectA.id), {
          subjectId: String(subject.id),
          limit: 100,
        })
        assert.equal(questions.length, 7, 'one published version per blueprint, three singles')
        assert.ok(
          questions.every((question) => question.published_version_id !== null),
          'every fixture question has a published version, not a draft',
        )
        assert.ok(
          questions.every((question) => question.has_trusted_answer === true),
          'every fixture answer is checked and undisputed, which is what `has_trusted_answer` reports',
        )
        assert.ok(
          questions.every((question) => (question.knowledge_nodes as string[]).length > 0),
          'every fixture version is mapped to a knowledge node',
        )
        typesPerSubject.push(questions.map((question) => String(question.question_type)).sort())
      }
      const expectedTypes = [
        'constructed_response',
        'fill_blank',
        'multiple_choice',
        'single_choice',
        'single_choice',
        'single_choice',
        'true_false',
      ]
      for (const types of typesPerSubject) {
        assert.deepEqual(types, expectedTypes, 'the five scorable types are present in every subject')
      }

      // The summary's own counters have to describe the same rows.
      assert.equal(summary.published_versions, 28, '7 versions × 4 subjects (A/B/C)')
      assert.deepEqual(summary.published_versions_by_type, {
        single_choice: 12,
        multiple_choice: 4,
        true_false: 4,
        fill_blank: 4,
        constructed_response: 4,
      })
    } finally {
      close()
    }
  })
})

test('acceptance fixture: the delayed-verification chain is due according to the real rules', () => {
  withDataRoot((dataRoot) => {
    const summary = seedAcceptanceFixture({ dataRoot })
    const { db, close, userId } = openSeeded(dataRoot)
    try {
      assert.equal(summary.delayed_verification_tasks, 2, 'one B task and the C task it produces')
      assert.deepEqual(summary.skipped, [], 'every fixture block is built through a real service')

      const projectC = activeFixtureProjects(db, userId)[2]
      const projectId = String(projectC.id)
      // Project C still carries its own subject, structure and seven published versions.
      assert.equal(listSubjects(db, userId, projectId).length, 1)
      assert.equal(listQuestions(db, projectId, { limit: 100 }).length, 7)

      const tasks = findRows(db, 'learning_study_task', { project_id: projectId })
      assert.deepEqual(
        tasks.map((task) => String(task.task_kind)).sort(),
        ['delayed_verification', 'paired_immediate'],
        'the chain is exactly B and C — no filler tasks',
      )
      const delayed = tasks.find((task) => task.task_kind === 'delayed_verification')!
      assert.equal(delayed.status, 'pending')
      assert.ok(delayed.question_id !== null, 'C is a real question, not a placeholder')

      // The anchor is B's own submission (30 minutes before seeding), and C was moved 1 minute back.
      const seededAt = parseInstant(summary.seeded_at)
      assert.equal(delayed.delay_anchor_at, seededAt - 30n * 60_000_000n)
      assert.equal(delayed.not_before, seededAt - 60_000_000n)
      assert.equal(delayed.due_at, delayed.not_before)

      const review = findRows(db, 'learning_review_task', { study_task_id: delayed.id })[0]
      assert.ok(review, 'a delayed task always carries its ReviewTask interval record')
      assert.equal(review.delay_hours, 24)
      assert.equal(review.anchor_source, 'trigger_event')
      assert.equal(review.not_before, delayed.not_before)
      assert.equal(review.was_started, false)

      // The engine agrees it is startable — the same call the review page and start endpoint make.
      const status = delayedIntervalStatus(db, delayed, seededAt)
      assert.equal(status.required, true)
      assert.equal(status.satisfied, true)
      assert.equal(status.reason, '')

      const pairings = findRows(db, 'knowledge_verification_pairing', { project_id: projectId })
      assert.equal(pairings.length, 1)
      assert.equal(pairings[0].is_active, true)
      assert.equal(pairings[0].delay_hours, 24)
      assert.ok(pairings[0].delayed_question_id !== null, 'the fixture pairing includes its C question')

      // Both chain attempts were graded, which is what produced the tasks.
      const attempts = findRows(db, 'practice_attempt', { project_id: projectId })
      assert.equal(attempts.length, 2)
      assert.ok(attempts.every((attempt) => attempt.current_grade_event_id !== null))
    } finally {
      close()
    }
  })
})

test('acceptance fixture: cycle analysis sees five complete cycles and excludes 2024 + the demo paper', () => {
  withDataRoot((dataRoot) => {
    const summary = seedAcceptanceFixture({ dataRoot })
    const { db, close, userId } = openSeeded(dataRoot)
    try {
      const report = cycleAnalysis(db, summary.cycle_subject_id)
      assert.equal(report.status, 'ok')
      assert.equal(report.complete_cycle_count, 5)
      assert.equal(report.used_cycle_count, 5)
      // `used_cycles` follows the report's newest-first ordering; the horizon is the same five years.
      assert.deepEqual([...(report.used_cycles as string[])].sort(), [...CYCLE_YEARS])
      assert.equal(summary.cycle_scored_items, 10, 'two scored items per complete cycle')
      assert.equal(
        (report.cycles as Record<string, unknown>[]).reduce(
          (total, cycle) => total + Number(cycle.scored_item_count),
          0,
        ),
        10,
      )

      const incomplete = report.incomplete_cycles as Record<string, unknown>[]
      const incompleteYears = incomplete.map((cycle) => String(cycle.cycle_key))
      assert.ok(incompleteYears.includes(CYCLE_INCOMPLETE_YEAR), '2024 must be reported as incomplete')
      assert.ok(incompleteYears.includes('2025'), 'the demo paper must be reported as excluded')
      const blocker = incomplete.find((cycle) => String(cycle.cycle_key) === CYCLE_INCOMPLETE_YEAR)
      assert.ok(
        (blocker?.blocking_reasons as { reason: string }[]).some(
          // A revision that is never confirmed never becomes the paper's effective revision, so
          // the excluded cycle is blocked one step earlier than "not confirmed" — the same reason
          // Django's unconfirmed 2024 revision produces.
          (row) => row.reason === 'no_effective_revision',
        ),
        'the incomplete cycle says why it is not counted',
      )
      const demo = incomplete.find((cycle) => String(cycle.cycle_key) === '2025')
      assert.ok(
        (demo?.blocking_reasons as { reason: string }[]).some((row) => row.reason === 'demo_or_mock'),
        'the demo paper is excluded by source kind, not by accident',
      )

      // Papers are queryable the way the page lists them.
      const paperCount = listPapers(db, userId, String(summary.project_b), {
        subjectId: summary.cycle_subject_id,
      }).length
      assert.equal(paperCount, 7, 'five complete cycles + 2024 + the demo paper')
    } finally {
      close()
    }
  })
})

test('acceptance fixture: re-running the same data root keeps exactly one active set', () => {
  withDataRoot((dataRoot) => {
    const first = seedAcceptanceFixture({ dataRoot })
    const second = seedAcceptanceFixture({ dataRoot })

    // Ids change because the fixture is rebuilt, not because the old one is reused…
    assert.notEqual(second.project_a, first.project_a)
    // …and the stable numbers do not move.
    for (const key of ['subjects', 'published_versions', 'cycle_scored_items'] as const) {
      assert.equal(second[key], first[key], `${key} must not change between runs`)
    }
    assert.equal(second.delayed_verification_tasks, 2)
    assert.equal(second.archived_projects.length, 3, 'the three old projects are retired by name')
    assert.deepEqual(
      second.archived_projects.map((project) => project.id).sort(),
      [first.project_a, first.project_b, first.project_c].sort(),
    )
    assert.ok(
      second.archived_projects.every((project) => project.retired_name.includes('验收归档')),
      'the retired generation is renamed, not deleted: its questions and history stay readable',
    )

    const { db, close, userId } = openSeeded(dataRoot)
    try {
      // Exactly one active set with the asserted names.
      assert.deepEqual(
        listProjects(db, userId).map((project) => String(project.name)),
        [PROJECT_A, PROJECT_B, PROJECT_C],
      )
      // The archived generation still exists (history is kept) — three more projects, all archived.
      const archived = listProjects(db, userId, { includeArchived: true }).filter(
        (project) => project.is_archived === true,
      )
      assert.equal(archived.length, 3)
      assert.equal(fixtureSubjects(db, userId).length, 5, 'subjects are not doubled either')

      // Published versions in the active projects are stable at 39 — no appended second generation.
      // 39 is the real shape: A 14 (2 subjects × 7), B 18 (7 + 11 cycle/demo), C 7. The summary's
      // `published_versions` counts only the four blueprint subjects (28), exactly like Django.
      const activeVersions = activeFixtureProjects(db, userId).reduce(
        (total, project) =>
          total +
          listQuestions(db, String(project.id), { limit: 200 }).filter(
            (question) => question.published_version_id !== null,
          ).length,
        0,
      )
      assert.equal(activeVersions, 39)
      assert.equal(second.published_versions, 28)
      // And the cycle subject was rebuilt rather than accumulating a second five-year horizon.
      const report = cycleAnalysis(db, second.cycle_subject_id)
      assert.equal(report.complete_cycle_count, 5)
      const oldCycleSubject = findOne(db, 'exams_subject', { id: first.cycle_subject_id })
      assert.ok(oldCycleSubject !== null, 'the first generation is still in the database')
      const oldReport = cycleAnalysis(db, first.cycle_subject_id)
      assert.equal(oldReport.complete_cycle_count, 5, 'archived generation is intact, not double-seeded')
    } finally {
      close()
    }
  })
})

test('acceptance fixture: the summary reports what a caller can rely on', () => {
  withDataRoot((dataRoot) => {
    const summary: AcceptanceSeedSummary = seedAcceptanceFixture({ dataRoot })
    assert.equal(summary.email, 'owner@acepass.local')
    assert.equal(summary.cycle_subject_name, SUBJECT_CYCLES)
    assert.deepEqual(summary.complete_cycles, [...CYCLE_YEARS])
    assert.equal(summary.incomplete_cycle, CYCLE_INCOMPLETE_YEAR)
    assert.equal(summary.data_root, dataRoot)
    assert.ok(summary.seeded_at.endsWith('+00:00'), 'timestamps are Python-ISO, not Date.toString()')
  })
})
