/**
 * Syllabus word-list parsing — port of `apps/knowledge/services/outline.py`.
 *
 * A syllabus arrives as a word list: chapters, sections and points typed with indentation or
 * numbering. This parser turns one line into `(depth, name, aliases)`, and the alias rule is a
 * data-integrity guard rather than a nicety: `导数（微分）` and a separate `微分` line are the same
 * knowledge point, and importing both would split that point's score across two rows forever.
 *
 * One behaviour is deliberately odd and kept: `一、函数` keeps its numbering while `(1) 区间` loses
 * it. Python's numbering pattern requires whitespace *after* the marker (`\s+?`), so `一、函数`
 * never matches. The golden vectors pin this so a "cleaner" regex cannot silently change every
 * imported outline.
 */

/** `1`, `1.1`, `1.1.2`, `一、`, `（一）`, `(1)`. */
export const NUMBERING_PATTERN =
  /^\s*((?:\d+\.)*\d+|[一二三四五六七八九十]+|[（(]\s*[一二三四五六七八九十\d]+\s*[)）])\s*[.、．)）]?\s+?/
/** `- `, `* `, `• `, `· `. */
export const BULLET_PATTERN = /^\s*[-*•·]\s+/

const SYNONYM_PATTERNS = [
  /^([^（(\[]+)[（(\[]([^）)\]]+)[）)\]]\s*$/u,
  /^(.+?)\s*(?:别名|又称|同义词)\s*[:：]\s*(.+)$/u,
]

/** Depth → node kind, for the levels an outline usually has. */
export const KIND_BY_DEPTH: Record<number, string> = { 0: 'chapter', 1: 'section' }

export interface ParsedLine {
  depth: number
  name: string
  aliases: string[]
}

/** `导数（微分）` → `("导数", ["微分"])`; `导数 别名：微分, 求导` → the same. */
export function splitSynonyms(text: string): { name: string; aliases: string[] } {
  const cleaned = text.trim()
  for (const pattern of SYNONYM_PATTERNS) {
    const match = pattern.exec(cleaned)
    if (match === null) continue
    const name = match[1].replace(/^[ \t\-—:：]+|[ \t\-—:：]+$/g, '')
    const aliases = match[2]
      .split(/[,，、;；/]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    return { name: name === '' ? cleaned : name, aliases }
  }
  return { name: cleaned, aliases: [] }
}

/** Depth from indentation *and* numbering; the larger one wins. */
export function depthAndName(line: string): { depth: number; body: string } | null {
  if (line.trim() === '') return null
  const expanded = line.replace(/\t/g, '    ')
  const indent = expanded.length - expanded.replace(/^ +/, '').length
  const indentDepth = indent >= 2 ? Math.floor(indent / 2) : 0

  let body = expanded.trim()
  const bullet = BULLET_PATTERN.exec(body)
  if (bullet !== null) body = body.slice(bullet[0].length).trim()

  let numberDepth = 0
  const match = NUMBERING_PATTERN.exec(body)
  if (match !== null) {
    const number = match[1]
    // `1` is a chapter, `1.1` a section, `1.1.2` a point; `一、`/`（一）` carry one level.
    numberDepth = /^(?:\d+\.)*\d+$/.test(number) ? (number.match(/\./g) ?? []).length : 1
    body = body.slice(match[0].length).trim()
  }
  if (body === '') return null
  return { depth: Math.max(indentDepth, numberDepth), body }
}

/** One line of the word list, or `null` when it carries no node. */
export function parseOutlineLine(line: string): ParsedLine | null {
  const parsed = depthAndName(line)
  if (parsed === null) return null
  const { name, aliases } = splitSynonyms(parsed.body)
  if (name === '') return null
  return { depth: parsed.depth, name, aliases }
}
