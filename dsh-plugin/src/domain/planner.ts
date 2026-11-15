/**
 * Daily planning under one global budget — the parts that are pure functions.
 *
 * Port of `backend/apps/learning/services/planner.py`. The full planner reads tasks, states,
 * pairings and memory cards; those candidate queries belong to the store layer (phase 2). What is
 * ported here is the arithmetic that has to be *identical*, because it decides how many minutes each
 * project gets and how long a question is worth:
 *
 * - `allocateBudget` — largest-remainder split with a daily rotation, so the same project is not
 *   always first and a same-day retry produces the same split.
 * - `questionMinutes` — the per-question minute estimate (`estimated_seconds`, else a per-type
 *   default).
 * - `nextDay` / `planDeltaMinutes` — the two one-line helpers the plan payload reports.
 *
 * Deliberate port of the documented-but-unimplemented behaviour (D26/D27): nothing here redistributes
 * an unfinished project's balance to the others, because the Python implementation does not.
 */
import { pyFormatG, pyRound } from './pyfmt.ts'

/** Rule version stored on generated plans. */
export const RULE_VERSION = 'p0-1'

/** Minutes per question type when the version has no estimate of its own. */
export const DEFAULT_MINUTES_BY_TYPE: ReadonlyMap<string, number> = new Map([
  ['constructed_response', 15],
  ['fill_blank', 3],
])

/** `date.max` in Python, used as the sort key for projects without a target date. */
const DATE_MAX = '9999-12-31'
const EPOCH_DAY = Date.UTC(1970, 0, 1) / 86_400_000

export interface BudgetProjectFact {
  id: string
  name: string
  /** `project.target_date` as `YYYY-MM-DD`, or null. */
  target_date: string | null
  /** `project.created_at` as an ISO instant; only relative order matters. */
  created_at: string
}

export interface AllocateBudgetInput {
  /** The owner's active projects, in the order the caller already read them. */
  projects: BudgetProjectFact[]
  /**
   * `user.settings.project_budget_percent` as ordered pairs: a JSON object keyed by project id.
   * Order matters because the percentages are summed in it.
   */
  percentages: Array<[string, number | string]>
  budget_minutes: number
  /** `YYYY-MM-DD`. */
  on_date: string
}

export interface BudgetAllocation {
  projects: Array<{ project_id: string; project_name: string; percent: number; minutes: number }>
  notes: string[]
  rotation_offset: number
  project_order: string[]
}

/** Whole days between two `YYYY-MM-DD` dates. */
function dayNumber(isoDate: string): number {
  return Math.round(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000)
}

function rotationRank(rotated: readonly BudgetProjectFact[], projectId: string): number {
  const index = rotated.findIndex((project) => project.id === projectId)
  return index === -1 ? rotated.length : index
}

/**
 * Split the integer budget across projects.
 *
 * Base order: target date, then creation time. The daily rotation shift is
 * `days_since_epoch % active_project_count`, so the same project is not always first. Remainders go
 * out by largest fractional part, then by rotated order, which keeps a same-day retry identical.
 */
export function allocateBudget(input: AllocateBudgetInput): BudgetAllocation {
  const projects = input.projects
  if (projects.length === 0) {
    return { projects: [], notes: ['没有进行中的项目'], rotation_offset: 0, project_order: [] }
  }

  const ordered = [...projects].sort((left, right) => {
    const leftDate = left.target_date ?? DATE_MAX
    const rightDate = right.target_date ?? DATE_MAX
    if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1
    if (left.created_at === right.created_at) return 0
    return left.created_at < right.created_at ? -1 : 1
  })
  const offset = ((dayNumber(input.on_date) - EPOCH_DAY) % ordered.length + ordered.length) % ordered.length
  const rotated = [...ordered.slice(offset), ...ordered.slice(0, offset)]

  const notes: string[] = []
  let raw: Array<[BudgetProjectFact, number]>
  if (input.percentages.length > 0) {
    const percentages = new Map(input.percentages.map(([id, value]) => [id, Number(value)]))
    raw = ordered.map((project) => [project, percentages.get(project.id) ?? 0])
    let assignedPercent = 0
    for (const [, percent] of raw) assignedPercent += percent
    if (assignedPercent < 100) {
      notes.push(
        `用户指定比例合计 ${pyFormatG(assignedPercent)}%，其余 ${pyFormatG(100 - assignedPercent)}% 不分配`,
      )
    }
    if (assignedPercent <= 0) notes.push('用户指定比例均为 0：本日不分配任何项目时间')
  } else {
    raw = ordered.map((project) => [project, 100.0 / ordered.length])
    notes.push('未指定项目比例：按进行中项目等分')
  }

  const base = new Map<string, number>()
  const fractions: Array<[string, number, number]> = []
  for (const [project, percent] of raw) {
    const value = (input.budget_minutes * percent) / 100.0
    // Python's `int()` truncates toward zero; the value is never negative here.
    const floor = Math.trunc(value)
    base.set(project.id, floor)
    fractions.push([project.id, value - floor, rotationRank(rotated, project.id)])
  }
  let allocated = 0
  for (const value of base.values()) allocated += value
  let remainder = input.budget_minutes - allocated
  // `sorted(..., key=(-fraction, rank))`: stable, so equal keys keep insertion order.
  const ranked = [...fractions].sort((left, right) => {
    if (left[1] !== right[1]) return right[1] - left[1]
    return left[2] - right[2]
  })
  for (const [projectId] of ranked) {
    if (remainder <= 0) break
    base.set(projectId, (base.get(projectId) as number) + 1)
    remainder -= 1
  }

  const allocations = raw.map(([project, percent]) => ({
    project_id: project.id,
    project_name: project.name,
    percent: pyRound(percent, 4),
    minutes: base.get(project.id) as number,
  }))
  allocations.sort((left, right) => rotationRank(rotated, left.project_id) - rotationRank(rotated, right.project_id))
  return {
    projects: allocations,
    notes,
    rotation_offset: offset,
    project_order: ordered.map((project) => project.id),
  }
}

/** The facts `questionMinutes` reads from a question's current version. */
export interface QuestionMinutesFacts {
  /** The published version's `estimated_seconds`, else null/undefined. */
  estimated_seconds: number | null
  question_type: string
}

/**
 * `_question_minutes`: an explicit estimate wins, otherwise a per-type default.
 *
 * `round()` here is CPython's, i.e. halfway values round to the nearest **even** number:
 * 90s → 2 minutes, 150s → 2 minutes.
 */
export function questionMinutes(facts: QuestionMinutesFacts): number {
  if (facts.estimated_seconds !== null && facts.estimated_seconds !== undefined && facts.estimated_seconds) {
    return Math.max(1, pyRound(facts.estimated_seconds / 60, 0))
  }
  return DEFAULT_MINUTES_BY_TYPE.get(facts.question_type) ?? 2
}

/** `next_day`: the date after `on_date` (`YYYY-MM-DD` in, `YYYY-MM-DD` out). */
export function nextDay(onDate: string): string {
  const next = new Date(Date.parse(`${onDate}T00:00:00Z`) + 86_400_000)
  return next.toISOString().slice(0, 10)
}

/** `plan_delta_minutes`: budget minus what was actually allocated. */
export function planDeltaMinutes(plan: { daily_budget_minutes: number; allocated_minutes: number }): number {
  return plan.daily_budget_minutes - plan.allocated_minutes
}
