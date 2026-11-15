/**
 * Python `str` methods whose exact semantics grading depends on. `normalize_text` is applied to
 * both the submission and the accepted answers, so a different notion of "whitespace" or
 * "case-fold" silently changes which answers are marked correct.
 */
import { pyIsSpace } from './pyfmt.ts'

/** `str.strip()` — strips Python's whitespace set, not JS's. */
export function pyStrip(text: string): string {
  const chars = Array.from(text)
  let a = 0, b = chars.length
  while (a < b && pyIsSpace(chars[a])) a++
  while (b > a && pyIsSpace(chars[b - 1])) b--
  return chars.slice(a, b).join('')
}
/** `" ".join(text.split())` */
export function pyCollapseSpaces(text: string): string {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    if (pyIsSpace(ch)) { if (cur) { out.push(cur); cur = '' } } else cur += ch
  }
  if (cur) out.push(cur)
  return out.join(' ')
}
/**
 * `str.casefold()`. JS has no casefold; `toLowerCase` differs on a handful of characters. The ones
 * that matter for answers are applied explicitly (full case folding: ß→ss, ſ→s, final sigma, etc.);
 * the remainder falls back to lowercase. Covered by golden vectors; extend the table if a vector fails.
 */
const FOLD: Record<string, string> = {
  'ß': 'ss', 'ẞ': 'ss', 'ſ': 's', 'ς': 'σ', 'İ': 'i̇', 'ŉ': 'ʼn', 'ǰ': 'ǰ', 'ΐ': 'ΐ', 'ΰ': 'ΰ', 'և': 'եւ',
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st', 'µ': 'μ', 'ϐ': 'β', 'ϑ': 'θ',
  'ϕ': 'φ', 'ϖ': 'π', 'ϰ': 'κ', 'ϱ': 'ρ', 'ϵ': 'ε', 'ẛ': 'ṡ', 'ι': 'ι',
}
export function pyCasefold(text: string): string {
  let out = ''
  for (const ch of text) out += FOLD[ch] ?? ch.toLowerCase()
  return out
}
