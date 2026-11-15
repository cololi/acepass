/** Strict coach boundary: any problem rejects the entire candidate in the service. */
import type { ValidationProblem, ValidationResult } from './validators.ts'
import { DIAGNOSIS_ERROR_TYPES } from './prompts.ts'
import { COACH_PURPOSES } from './coach_prompts.ts'
import { isPyNumber, pySlice } from './pyvalue.ts'

export interface CoachValidationOptions {
  allowed_citations: ReadonlySet<string>
  allowed_key_point_ids?: ReadonlySet<string>
  max_hint_level?: number
  allowed_step_ids?: ReadonlySet<string>
}
const forbidden = new Set(['score', 'scores', 'mastery', 'mastered', 'probability', 'pass_rate', 'confirmed_score', 'grade', 'passed'])
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && !isPyNumber(v)
export function validateCoachReply(purpose: string, payload: unknown, options: CoachValidationOptions): ValidationResult<Record<string, unknown>> {
  const problems: ValidationProblem[] = []
  const bad = (code: string, path: string) => { problems.push({ code, path, message: `教练输出无效：${path} (${code})`, severity: 'blocking' }) }
  if (!object(payload)) { bad('not_object', ''); return [{}, problems] }
  const map = payload
  if (!(COACH_PURPOSES as readonly string[]).includes(purpose)) { bad('invalid_purpose', 'purpose'); return [{}, problems] }
  function scan(v: unknown, path = '', depth = 0): void {
    if (depth > 20) { bad('too_deep', path); return }
    if (Array.isArray(v)) { if (v.length > 40) bad('too_long', path); v.slice(0, 40).forEach((x, i) => scan(x, `${path}.${i}`, depth + 1)) }
    else if (object(v)) for (const [k, x] of Object.entries(v)) { if (forbidden.has(k.toLowerCase())) bad('forbidden_field', `${path}.${k}`); scan(x, `${path}.${k}`, depth + 1) }
  }
  scan(payload)
  function str(v: unknown, path: string, required = false, max = 4000): string {
    if (typeof v !== 'string') { bad('invalid_string', path); return '' }
    if (required && !v.trim()) bad('empty_string', path)
    if (Array.from(v).length > max) bad('too_long', path)
    return pySlice(v, max)
  }
  function list(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) { bad('invalid_list', path); return [] }
    if (v.length > 40) bad('too_long', path)
    return v.slice(0, 40)
  }
  function strings(key: string, allowed?: ReadonlySet<string>, required = true): string[] {
    if (!required && map[key] === undefined) return []
    return list(map[key], key).map((x, i) => {
      const s = str(x, `${key}.${i}`, true, allowed ? 200 : 4000)
      if (allowed && !allowed.has(s)) bad(key === 'citations' ? 'unknown_citation' : 'unknown_id', `${key}.${i}`)
      return s
    })
  }
  function blocks(key: string): Record<string, unknown>[] {
    return list(map[key], key).map((v, i) => {
      const path = `${key}.${i}`
      if (!object(v)) { bad('invalid_block', path); return {} }
      if (v.kind === 'text') return { kind: 'text', text: str(v.text, path, true) }
      if (v.kind === 'math') return { kind: 'math', latex: str(v.latex, path, true) }
      if (v.kind === 'list') {
        const items = list(v.items, path).map(x => str(x, path, true))
        if (!items.length) bad('empty_block', path)
        return { kind: 'list', items }
      }
      bad('invalid_block', path); return {}
    })
  }
  const clean: Record<string, unknown> = {
    coach_message: str(payload.coach_message, 'coach_message', true),
    citations: strings('citations', options.allowed_citations),
    missing_information: strings('missing_information', undefined, false),
  }
  if (purpose === 'recall_check' || purpose === 'self_explain_check') {
    const allowed = options.allowed_key_point_ids ?? new Set<string>()
    const covered = strings('key_points_covered', allowed), missing = strings('key_points_missing', allowed)
    if (covered.some(id => missing.includes(id))) bad('key_point_overlap', 'key_points_covered')
    Object.assign(clean, { key_points_covered: covered, key_points_missing: missing, cannot_judge: strings('cannot_judge'), next_question: str(payload.next_question, 'next_question') })
  } else if (purpose === 'hint') {
    const level = isPyNumber(payload.hint_level) ? Number(payload.hint_level.text) : payload.hint_level
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > Math.min(3, options.max_hint_level ?? 2)) bad('invalid_hint_level', 'hint_level')
    if (typeof payload.reveals_answer !== 'boolean') bad('invalid_boolean', 'reveals_answer')
    if (payload.reveals_answer === true && ((options.max_hint_level ?? 2) < 3 || Number(level) < 3)) bad('answer_disclosure', 'reveals_answer')
    const hintBlocks = blocks('hint_blocks')
    if (!hintBlocks.length) bad('empty_blocks', 'hint_blocks')
    Object.assign(clean, { hint_level: level, hint_blocks: hintBlocks, reveals_answer: payload.reveals_answer, next_question: str(payload.next_question, 'next_question') })
  } else if (purpose === 'misconception_probe') {
    if (!(DIAGNOSIS_ERROR_TYPES as readonly unknown[]).includes(payload.error_type)) bad('invalid_error_type', 'error_type')
    Object.assign(clean, { error_type: payload.error_type, evidence: strings('evidence'), cannot_judge: strings('cannot_judge'), next_question: str(payload.next_question, 'next_question') })
  } else if (purpose === 'encode_briefing') {
    const ids = new Set<string>()
    const points = list(payload.key_points, 'key_points').map((v, i) => {
      if (!object(v)) { bad('invalid_key_point', `key_points.${i}`); return {} }
      const id = str(v.id, `key_points.${i}.id`, true, 200)
      if (ids.has(id)) bad('duplicate_id', `key_points.${i}.id`)
      if (options.allowed_key_point_ids && !options.allowed_key_point_ids.has(id)) bad('unknown_id', `key_points.${i}.id`)
      ids.add(id)
      if (typeof v.required !== 'boolean') bad('invalid_boolean', `key_points.${i}.required`)
      return { id, text: str(v.text, `key_points.${i}.text`, true), required: v.required }
    })
    if (!points.length) bad('empty_key_points', 'key_points')
    clean.blocks = blocks('blocks'); clean.key_points = points
  } else {
    clean.highlights = strings('highlights'); clean.next_focus = strings('next_focus')
    clean.step_ids = strings('step_ids', options.allowed_step_ids ?? new Set(), false)
  }
  // cannot_judge is the documented missing-information alias for honest abstention.
  clean.missing_information = [...new Set([...(clean.missing_information as string[]), ...((clean.cannot_judge ?? []) as string[])])].slice(0, 40)
  return [clean, problems]
}
