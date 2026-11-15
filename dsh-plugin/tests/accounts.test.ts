import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstant } from '../src/domain/instant.ts'
import { openStore } from '../src/store/db.ts'
import { insertRow } from '../src/store/repository.ts'
import {
  MAX_DAILY_BUDGET_MINUTES,
  ensureSettings,
  getStudySettings,
  getUserOut,
  isValidTimezone,
  patchStudySettings,
} from '../src/services/accounts.ts'
import { InvalidInput, toErrorEnvelope } from '../src/services/errors.ts'
import type { DatabaseSync } from 'node:sqlite'

const NOW = parseInstant('2026-02-01T00:00:00+00:00')

function storeWithUser(): { db: DatabaseSync; close: () => void; userId: string } {
  const handle = openStore({ path: ':memory:' })
  const user = insertRow(
    handle.db,
    'accounts_user',
    {
      // The Django user table requires a password hash even though the plugin never checks one:
      // DSH owns authentication, so this column is storage parity, not an auth path.
      password: '!',
      email: 'a@example.com',
      display_name: '阿测',
      is_active: 1,
      is_staff: 0,
      is_superuser: 0,
      date_joined: NOW,
    },
    { now: NOW },
  )
  return { db: handle.db, close: handle.close, userId: String(user.id) }
}

test('accounts: the settings row is created with the model defaults on first read', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const settings = getStudySettings(db, userId, NOW)
    assert.deepEqual(settings, {
      timezone: 'Asia/Shanghai',
      daily_budget_minutes: 60,
      project_budget_percent: {},
      undiagnosed_time_share_percent: 20,
      default_practice_tutoring: 'allowed',
    })
    // Reading twice must not create a second row.
    ensureSettings(db, userId, NOW)
    const count = db.prepare('SELECT COUNT(*) AS n FROM "accounts_user_settings"').get() as { n: number }
    assert.equal(count.n, 1)
  } finally {
    close()
  }
})

test('accounts: /auth/me reports an honest "needs project setup"', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const before = getUserOut(db, userId, NOW)
    assert.equal(before.email, 'a@example.com')
    assert.equal(before.display_name, '阿测')
    assert.equal(before.is_staff, false)
    assert.equal(before.is_reviewer, false)
    assert.equal(before.needs_project_setup, true, 'no project yet')

    insertRow(
      db,
      'exams_project',
      { owner_id: userId, name: '考研数学', description: '', is_archived: 0, display_order: 0 },
      { now: NOW },
    )
    assert.equal(getUserOut(db, userId, NOW).needs_project_setup, false)
  } finally {
    close()
  }
})

test('accounts: patch applies only the provided fields', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const updated = patchStudySettings(db, userId, { daily_budget_minutes: 120 }, NOW)
    assert.equal(updated.daily_budget_minutes, 120)
    assert.equal(updated.timezone, 'Asia/Shanghai', 'untouched fields keep their value')

    const tz = patchStudySettings(db, userId, { timezone: 'Europe/Berlin' }, NOW)
    assert.equal(tz.timezone, 'Europe/Berlin')
    assert.equal(tz.daily_budget_minutes, 120)
  } finally {
    close()
  }
})

test('accounts: an empty timezone is rejected by validation, before the service truthiness rule', () => {
  // `update_study_settings` uses `if timezone_name:` (so "" would be ignored), but the API validates
  // first and `ZoneInfo("")` raises — the quirk is unreachable through the HTTP path, and this layer
  // matches the HTTP path. Refusing is also the safer half of the pair.
  const { db, close, userId } = storeWithUser()
  try {
    patchStudySettings(db, userId, { timezone: 'Europe/Berlin' }, NOW)
    assert.throws(() => patchStudySettings(db, userId, { timezone: '' }, NOW), /时区无效/)
    assert.equal(getStudySettings(db, userId, NOW).timezone, 'Europe/Berlin', 'the stored zone is untouched')
  } finally {
    close()
  }
})

test('accounts: invalid values are refused with the documented codes and messages', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const cases: [Record<string, unknown>, string][] = [
      [{ timezone: 'Mars/Olympus' }, '时区无效'],
      [{ daily_budget_minutes: -1 }, `每日预算必须在 0 到 ${MAX_DAILY_BUDGET_MINUTES} 分钟之间`],
      [{ daily_budget_minutes: MAX_DAILY_BUDGET_MINUTES + 1 }, `每日预算必须在 0 到 ${MAX_DAILY_BUDGET_MINUTES} 分钟之间`],
      [{ undiagnosed_time_share_percent: 81 }, '未诊断内容时间占比必须在 0 到 80 之间'],
    ]
    for (const [payload, message] of cases) {
      assert.throws(
        () => patchStudySettings(db, userId, payload as never, NOW),
        (error: unknown) => {
          assert.ok(error instanceof InvalidInput)
          assert.equal(error.message, message)
          const envelope = toErrorEnvelope(error)
          assert.equal(envelope.status, 400)
          assert.equal(envelope.body.error.code, 'invalid_input')
          return true
        },
        JSON.stringify(payload),
      )
    }
  } finally {
    close()
  }
})

test('accounts: a rejected patch leaves the row untouched', () => {
  const { db, close, userId } = storeWithUser()
  try {
    assert.throws(() => patchStudySettings(db, userId, { timezone: 'Mars/Olympus', daily_budget_minutes: 90 }, NOW))
    const settings = getStudySettings(db, userId, NOW)
    assert.equal(settings.daily_budget_minutes, 60, 'a validation failure must not half-apply')
    assert.equal(settings.timezone, 'Asia/Shanghai')
  } finally {
    close()
  }
})

test('accounts: budget percentages must reference active projects and sum to <= 100', () => {
  const { db, close, userId } = storeWithUser()
  try {
    const active = insertRow(
      db,
      'exams_project',
      { owner_id: userId, name: 'A', description: '', is_archived: 0, display_order: 0 },
      { now: NOW },
    )
    const archived = insertRow(
      db,
      'exams_project',
      { owner_id: userId, name: 'B', description: '', is_archived: 1, display_order: 1 },
      { now: NOW },
    )

    const ok = patchStudySettings(db, userId, { project_budget_percent: { [String(active.id)]: 60 } }, NOW)
    assert.deepEqual(ok.project_budget_percent, { [String(active.id)]: 60 })

    assert.throws(
      () => patchStudySettings(db, userId, { project_budget_percent: { [String(archived.id)]: 10 } }, NOW),
      /预算分配包含不存在的项目或已归档项目/,
      'an archived project cannot hold budget',
    )
    assert.throws(
      () => patchStudySettings(db, userId, { project_budget_percent: { [String(active.id)]: -5 } }, NOW),
      /预算比例不能为负数/,
    )
    assert.throws(
      () => patchStudySettings(db, userId, { project_budget_percent: { [String(active.id)]: 100.0002 } }, NOW),
      /预算比例合计不能超过 100%/,
    )
    // The tolerance is 100.0001, so exactly 100.0001 is still accepted.
    const atTolerance = patchStudySettings(
      db,
      userId,
      { project_budget_percent: { [String(active.id)]: 100.0001 } },
      NOW,
    )
    assert.equal(atTolerance.project_budget_percent[String(active.id)], 100.0001)
  } finally {
    close()
  }
})

test('accounts: timezone validation matches IANA names', () => {
  for (const valid of ['UTC', 'Asia/Shanghai', 'Europe/Berlin', 'America/Los_Angeles', 'Etc/GMT-5']) {
    assert.equal(isValidTimezone(valid), true, valid)
  }
  for (const invalid of ['Mars/Olympus', '', 'UTC+8', 'not a zone']) {
    assert.equal(isValidTimezone(invalid), false, invalid)
  }
})

test('accounts: /auth/me reads an owner with several projects instead of throwing on ambiguity', () => {
  const { db, close, userId } = storeWithUser()
  try {
    for (const name of ['项目一', '项目二', '项目三']) {
      insertRow(
        db,
        'exams_project',
        { owner_id: userId, name, description: '', target_date: null, is_archived: false, archived_at: null },
        { now: NOW },
      )
    }
    // `findOne` throws when a predicate matches more than one row; `needs_project_setup` is an
    // `exists()`, so three projects must answer false rather than fail the whole profile read.
    const profile = getUserOut(db, userId, NOW)
    assert.equal(profile.needs_project_setup, false)
    assert.equal(profile.email, 'a@example.com')
  } finally {
    close()
  }
})
