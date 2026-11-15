/**
 * Accounts: identity projection and the global study budget.
 *
 * Port of `backend/apps/accounts/api.py` + `apps/accounts/services/settings.py`.
 *
 * The three session endpoints (`auth/csrf`, `auth/login`, `auth/logout`) are **not** ported: the
 * plugin runs inside DSH, which owns authentication, and the accepted deployment decision is
 * single-user with workspace isolation (03 §0 D-2). What the web client actually reads — `auth/me`
 * and the study settings — keeps the same shape and the same error codes.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Instant } from '../domain/instant.ts'
import { findOne, insertRow, updateRow, countRows } from '../store/repository.ts'
import { transaction } from '../store/db.ts'
import { InvalidInput } from './errors.ts'

/** `MAX_DAILY_BUDGET_MINUTES` from `apps/accounts/models.py`. */
export const MAX_DAILY_BUDGET_MINUTES = 24 * 60
/** The share of project time reserved for undiagnosed points, capped by the model validator. */
export const MAX_UNDIAGNOSED_SHARE_PERCENT = 80

/** The one identity a workspace has; `src/index.ts` and the acceptance seeder both resolve this row. */
export const OWNER_EMAIL = 'owner@acepass.local'

const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const DEFAULT_DAILY_BUDGET_MINUTES = 60
const DEFAULT_UNDIAGNOSED_SHARE_PERCENT = 20
const DEFAULT_PRACTICE_TUTORING = 'allowed'

/** A budget split that sums to this much or less of the day is accepted. */
const BUDGET_TOTAL_TOLERANCE = 100.0001

export interface StudySettingsOut {
  timezone: string
  daily_budget_minutes: number
  project_budget_percent: Record<string, number>
  undiagnosed_time_share_percent: number
  default_practice_tutoring: string
}

export interface UserOut {
  id: string
  email: string
  display_name: string
  is_staff: boolean
  timezone: string
  daily_budget_minutes: number
  undiagnosed_time_share_percent: number
  /** True when the account exists but no exam project has been created yet. */
  needs_project_setup: boolean
  is_reviewer: boolean
}

export interface StudySettingsPatch {
  timezone?: string | null
  daily_budget_minutes?: number | null
  project_budget_percent?: Record<string, number | string> | null
  undiagnosed_time_share_percent?: number | null
}

/** `ZoneInfo(name)` succeeds; `Intl` rejects the same invalid names with a RangeError. */
export function isValidTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

function settingsToOut(row: Record<string, unknown>): StudySettingsOut {
  return {
    timezone: String(row.timezone),
    daily_budget_minutes: Number(row.daily_budget_minutes),
    project_budget_percent: (row.project_budget_percent ?? {}) as Record<string, number>,
    undiagnosed_time_share_percent: Number(row.undiagnosed_time_share_percent),
    default_practice_tutoring: String(row.default_practice_tutoring),
  }
}

/**
 * The single local user, created on first use.
 *
 * The accepted deployment is single-user with workspace isolation (03 §0 D-2), so there is no login:
 * the workspace owner *is* the user and DSH owns authentication. `src/index.ts` opens the store and
 * calls this before mounting the HTTP surface; the same call is what lets a headless tool (the
 * acceptance seeder) build a fixture without the plugin host.
 *
 * `` email `` is fixed rather than configurable on purpose: a second identity would contradict D-2
 * and split one workspace's data across two rows nobody can log in as.
 */
export function ensureOwner(db: DatabaseSync, now: Instant): string {
  const existing = findOne(db, 'accounts_user', { email: OWNER_EMAIL })
  if (existing !== null) return String(existing.id)
  const created = insertRow(
    db,
    'accounts_user',
    {
      password: '!', // never used: DSH authenticates, this column exists for storage parity
      email: OWNER_EMAIL,
      display_name: '本机用户',
      is_active: true,
      is_staff: false,
      is_superuser: false,
      date_joined: now,
    },
    { now },
  )
  return String(created.id)
}

/** `_settings_for()`: the row is created on first read, with the model defaults. */
export function ensureSettings(db: DatabaseSync, userId: string, now: Instant): Record<string, unknown> {
  const existing = findOne(db, 'accounts_user_settings', { user_id: userId })
  if (existing !== null) return existing
  return transaction(db, () => {
    // Re-check inside the transaction: two concurrent first reads must not create two rows.
    const raced = findOne(db, 'accounts_user_settings', { user_id: userId })
    if (raced !== null) return raced
    return insertRow(
      db,
      'accounts_user_settings',
      {
        user_id: userId,
        timezone: DEFAULT_TIMEZONE,
        daily_budget_minutes: DEFAULT_DAILY_BUDGET_MINUTES,
        project_budget_percent: {},
        undiagnosed_time_share_percent: DEFAULT_UNDIAGNOSED_SHARE_PERCENT,
        default_practice_tutoring: DEFAULT_PRACTICE_TUTORING,
      },
      { now },
    )
  })
}

export function getUserOut(db: DatabaseSync, userId: string, now: Instant): UserOut {
  const user = findOne(db, 'accounts_user', { id: userId })
  if (user === null) throw new InvalidInput('用户不存在')
  const settings = ensureSettings(db, userId, now)
  // Django asks `.exists()`, and more than one project per owner is the normal case. `findOne`
  // throws on ambiguity (the repository's deliberate discipline), so counting is the right read.
  const hasProjects = countRows(db, 'exams_project', { owner_id: userId }) > 0
  const isStaff = Boolean(user.is_staff)
  return {
    id: String(user.id),
    email: String(user.email),
    display_name: String(user.display_name ?? ''),
    is_staff: isStaff,
    timezone: String(settings.timezone),
    daily_budget_minutes: Number(settings.daily_budget_minutes),
    undiagnosed_time_share_percent: Number(settings.undiagnosed_time_share_percent),
    needs_project_setup: !hasProjects,
    is_reviewer: isStaff,
  }
}

export function getStudySettings(db: DatabaseSync, userId: string, now: Instant): StudySettingsOut {
  return settingsToOut(ensureSettings(db, userId, now))
}

export function patchStudySettings(
  db: DatabaseSync,
  userId: string,
  payload: StudySettingsPatch,
  now: Instant,
): StudySettingsOut {
  // The API validates before touching the service, in this order, and an invalid value is refused
  // rather than clamped — a budget the user did not ask for is worse than an error.
  if (payload.timezone !== null && payload.timezone !== undefined) {
    if (!isValidTimezone(payload.timezone)) {
      throw new InvalidInput('时区无效', { details: { timezone: payload.timezone } })
    }
  }
  if (payload.daily_budget_minutes !== null && payload.daily_budget_minutes !== undefined) {
    const minutes = payload.daily_budget_minutes
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_DAILY_BUDGET_MINUTES) {
      throw new InvalidInput(`每日预算必须在 0 到 ${MAX_DAILY_BUDGET_MINUTES} 分钟之间`)
    }
  }
  if (payload.undiagnosed_time_share_percent !== null && payload.undiagnosed_time_share_percent !== undefined) {
    const share = payload.undiagnosed_time_share_percent
    if (!Number.isInteger(share) || share < 0 || share > MAX_UNDIAGNOSED_SHARE_PERCENT) {
      throw new InvalidInput('未诊断内容时间占比必须在 0 到 80 之间')
    }
  }

  return transaction(db, () => {
    const current = ensureSettings(db, userId, now)
    const patch: Record<string, unknown> = {}

    // `if timezone_name:` — an empty string is falsy in Python, so it must not clear the field.
    if (payload.timezone) patch.timezone = payload.timezone
    if (payload.daily_budget_minutes !== null && payload.daily_budget_minutes !== undefined) {
      patch.daily_budget_minutes = payload.daily_budget_minutes
    }
    if (payload.undiagnosed_time_share_percent !== null && payload.undiagnosed_time_share_percent !== undefined) {
      patch.undiagnosed_time_share_percent = payload.undiagnosed_time_share_percent
    }

    if (payload.project_budget_percent !== null && payload.project_budget_percent !== undefined) {
      const activeIds = new Set(
        (
          db
            .prepare('SELECT "id" FROM "exams_project" WHERE "owner_id" = ? AND "is_archived" = 0')
            .all(userId) as { id: string }[]
        ).map((row) => String(row.id)),
      )
      const cleaned: Record<string, number> = {}
      for (const [rawProjectId, rawPercent] of Object.entries(payload.project_budget_percent)) {
        const projectId = String(rawProjectId)
        if (!activeIds.has(projectId)) {
          throw new InvalidInput('预算分配包含不存在的项目或已归档项目', { details: { project_id: projectId } })
        }
        const percent = typeof rawPercent === 'number' ? rawPercent : Number(rawPercent)
        if (!Number.isFinite(percent)) {
          throw new InvalidInput('预算比例必须是数字', { details: { project_id: projectId } })
        }
        if (percent < 0) {
          throw new InvalidInput('预算比例不能为负数', { details: { project_id: projectId } })
        }
        cleaned[projectId] = percent
      }
      if (Object.keys(cleaned).length > 0) {
        const total = Object.values(cleaned).reduce((sum, value) => sum + value, 0)
        if (total > BUDGET_TOTAL_TOLERANCE) {
          throw new InvalidInput('预算比例合计不能超过 100%', { details: { total } })
        }
      }
      patch.project_budget_percent = cleaned
    }

    updateRow(db, 'accounts_user_settings', current.id, patch, { now })
    return settingsToOut(ensureSettings(db, userId, now))
  })
}
