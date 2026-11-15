/**
 * Python `str` semantics that the ingestion parsers depend on.
 *
 * Every offset this module produces is stored in the database and compared across imports: Python
 * indexes `str` by code point, so `source_char_start`/`source_char_end` and every `[:N]` truncation
 * must ignore UTF-16 surrogate pairs. `str.splitlines()` also splits on more than `\n`, and Python's
 * `\s`/`\w` are Unicode classes rather than JavaScript's ASCII ones — the regex fragments below
 * exist so a ported pattern means exactly what the Python pattern means.
 */
import { pyStrip } from '../pytext.ts'

/** Python `\s` as a character-class body (the same set `str.isspace()` reports). */
export const PY_SPACE_CLASS = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
/** `\s` */
export const PY_S = `[${PY_SPACE_CLASS}]`
/** `\s*` */
export const PY_S_STAR = `[${PY_SPACE_CLASS}]*`
/** `\d` — Python matches every Unicode decimal digit, not just `0-9`. */
export const PY_D = '[\\p{Nd}]'
/** The same class as a body, for use inside a larger character class. */
export const PY_D_CLASS = '\\p{Nd}'
/** `\w` — Python's word set is `[\\p{L}\\p{N}_]`, which matters for `\b` around CJK text. */
const PY_WORD = '[\\p{L}\\p{N}_]'

/** `(?<!...)(...)(?!...)` equivalent of Python's Unicode-aware `\b` around `pattern`. */
export function pyWordBoundary(pattern: string): string {
  return `(?<!${PY_WORD})(?:${pattern})(?!${PY_WORD})`
}

/** Python code-point length. */
export function pyCodePointLen(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Python slice `text[:length]` / `text[length:]`-style prefix truncation by code point. */
export function pyCodePointSlice(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join('')
}

/** `str.splitlines()` without keepends: splits on `\n`, `\r`, `\r\n`, `\v`, `\f`, `\x1c-\x1e`, `\x85`, `\u2028`, `\u2029`. */
export function pySplitlines(text: string): string[] {
  const chars = Array.from(text)
  const lines: string[] = []
  let start = 0
  let index = 0
  const breaks = new Set(['\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029'])
  while (index < chars.length) {
    const char = chars[index]
    if (char === '\r') {
      lines.push(chars.slice(start, index).join(''))
      index += chars[index + 1] === '\n' ? 2 : 1
      start = index
      continue
    }
    if (breaks.has(char)) {
      lines.push(chars.slice(start, index).join(''))
      index += 1
      start = index
      continue
    }
    index += 1
  }
  if (start < chars.length) lines.push(chars.slice(start).join(''))
  return lines
}

/**
 * `str.find(sub, start)` with code-point indices.
 *
 * Python returns the marker position in code points; `String.prototype.indexOf` would return UTF-16
 * units and drift by one for every emoji before the hit.
 */
export function pyFind(haystack: string, needle: string, start = 0): number {
  const haystackChars = Array.from(haystack)
  const needleChars = Array.from(needle)
  if (needleChars.length === 0) return start <= haystackChars.length ? start : -1
  for (let index = Math.max(0, start); index + needleChars.length <= haystackChars.length; index += 1) {
    let matched = true
    for (let offset = 0; offset < needleChars.length; offset += 1) {
      if (haystackChars[index + offset] !== needleChars[offset]) {
        matched = false
        break
      }
    }
    if (matched) return index
  }
  return -1
}

/** `str.rstrip(chars)` — strips only the listed characters, not a whitespace class. */
export function pyRstripChars(text: string, chars: string): string {
  const strip = new Set(Array.from(chars))
  const source = Array.from(text)
  let end = source.length
  while (end > 0 && strip.has(source[end - 1])) end -= 1
  return source.slice(0, end).join('')
}

/** `str.strip()` re-exported so parser files need one import for string semantics. */
export { pyStrip }

/** Python truthiness for the scalar/list shapes the parser keeps in its mutable state. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'boolean') return value
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return true
}

/** `str.isdigit()` for the labels a template can carry (decimal digits). */
export function pyIsDigit(text: string): boolean {
  return /^[\p{Nd}]+$/u.test(text)
}
