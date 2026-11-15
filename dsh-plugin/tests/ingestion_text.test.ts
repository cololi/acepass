import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  applyAnswerMatches,
  attachCrossPageContinua,
  attachSourcePages,
  detectPageContinuations,
  parseAnswerPage,
  parsePaste,
  type ParsedSegment,
} from '../src/domain/ingestion/text_parser.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/ingestion_text.json', import.meta.url), 'utf8'))

test(`ingestion text: ${golden.parse.length} paste cases parse like the Python parser`, () => {
  const failures: string[] = []
  for (const entry of golden.parse) {
    const actual = parsePaste(entry.text, { structureOnly: entry.structure_only })
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(actual)), entry.segments)
    } catch {
      failures.push(
        `structure_only=${entry.structure_only} ${JSON.stringify(entry.text).slice(0, 80)}\n  got  ${JSON.stringify(actual).slice(0, 600)}\n  want ${JSON.stringify(entry.segments).slice(0, 600)}`,
      )
    }
  }
  assert.deepEqual(failures, [], `parsePaste mismatches:\n${failures.join('\n')}`)
})

test(`ingestion text: ${golden.answer_page.length} answer pages parse like the Python parser`, () => {
  const failures: string[] = []
  for (const entry of golden.answer_page) {
    const actual = parseAnswerPage(entry.text)
    try {
      assert.deepEqual(actual, entry.result)
    } catch {
      failures.push(
        `${JSON.stringify(entry.text).slice(0, 60)}\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(entry.result)}`,
      )
    }
  }
  assert.deepEqual(failures, [], `parseAnswerPage mismatches:\n${failures.join('\n')}`)
})

test(`ingestion text: ${golden.match.length} answer-match cases match like the Python parser`, () => {
  const failures: string[] = []
  for (const entry of golden.match) {
    const segments = structuredClone(entry.segments) as ParsedSegment[]
    const actual = applyAnswerMatches(segments, structuredClone(entry.entries))
    try {
      assert.deepEqual(actual, entry.result)
    } catch {
      failures.push(`${entry.name}\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(entry.result)}`)
    }
  }
  assert.deepEqual(failures, [], `applyAnswerMatches mismatches:\n${failures.join('\n')}`)
})

test(`ingestion text: ${golden.source_pages.length} source-page cases attach like the Python parser`, () => {
  const failures: string[] = []
  for (const entry of golden.source_pages) {
    const actual = attachSourcePages(structuredClone(entry.segments) as ParsedSegment[], entry.text, entry.page_map)
    try {
      assert.deepEqual(actual, entry.result)
    } catch {
      failures.push(`${entry.name}\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(entry.result)}`)
    }
  }
  assert.deepEqual(failures, [], `attachSourcePages mismatches:\n${failures.join('\n')}`)
})

test(`ingestion text: ${golden.continuations.length} page-break cases detect like the Python parser`, () => {
  const failures: string[] = []
  for (const entry of golden.continuations) {
    const actual = detectPageContinuations(entry.pages)
    try {
      assert.deepEqual(actual, entry.result)
    } catch {
      failures.push(`${entry.name}\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(entry.result)}`)
    }
  }
  assert.deepEqual(failures, [], `detectPageContinuations mismatches:\n${failures.join('\n')}`)
})

test(`ingestion text: ${golden.cross_page.length} cross-page cases span like the Python parser`, () => {
  const failures: string[] = []
  for (const entry of golden.cross_page) {
    const continuations = detectPageContinuations(entry.pages)
    const actual = attachCrossPageContinua(
      structuredClone(entry.segments) as ParsedSegment[],
      entry.text,
      entry.page_map,
      continuations,
    )
    try {
      assert.deepEqual(actual, entry.result)
    } catch {
      failures.push(`${entry.name}\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(entry.result)}`)
    }
  }
  assert.deepEqual(failures, [], `attachCrossPageContinua mismatches:\n${failures.join('\n')}`)
})

// ---------------------------------------------------------------- pinned rules
test('ingestion text: Python word boundaries do not split a CJK run', () => {
  // `选A项` has no `\b` at the letter in Python, so the answer is reported as unusable rather than
  // silently read as option A. JavaScript's ASCII `\b` would have matched here.
  const [segment] = parsePaste('【题型】单选\n【题干】x\n【选项】A. 甲\nB. 乙\n【答案】选A项\n')
  assert.equal(segment.answer_status_known, false)
  assert.deepEqual(segment.answer_payload, {})
})

test('ingestion text: astral characters count as one code point', () => {
  const segments = parsePaste('【题干】' + '😀'.repeat(1001) + '\n')
  assert.equal(Array.from(segments[0].source_excerpt).length, 1000)
})

test('ingestion text: a material parent lists its children and children point back', () => {
  const segments = parsePaste('【材料】读材料\n【子题1】\n【题干】问一\n【答案】A\n【子题2】\n【题干】问二\n【答案】B\n')
  assert.deepEqual(
    segments.map((segment) => segment.question_type),
    ['material', 'single_choice', 'single_choice'],
  )
  assert.equal(segments[0].local_id, 'm1')
  assert.deepEqual(segments[1].parent_local_id, segments[0].local_id)
  assert.deepEqual(segments[0].child_local_ids, [segments[1].local_id, segments[2].local_id])
})
