import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseOutlineLine, splitSynonyms } from '../src/domain/outline.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/outline.json', import.meta.url), 'utf8'))

test(`outline: ${golden.cases.length} word-list lines parse like the Python parser`, () => {
  const failures: string[] = []
  for (const entry of golden.cases) {
    const parsed = parseOutlineLine(entry.line)
    const actual =
      entry.depth === null
        ? null
        : { depth: parsed?.depth, name: parsed?.name, aliases: parsed?.aliases }
    const expected =
      entry.depth === null ? null : { depth: entry.depth, name: entry.name, aliases: entry.aliases }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${JSON.stringify(entry.line)}\n  got  ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}`)
    }
  }
  assert.deepEqual(failures, [], `outline parse mismatches:\n${failures.join('\n')}`)
})

test('outline: numbering without a trailing space is kept in the name', () => {
  // Python's pattern requires whitespace after the marker, so these never match. Pinned because a
  // "cleaner" regex would change every imported outline.
  assert.deepEqual(parseOutlineLine('一、函数'), { depth: 0, name: '一、函数', aliases: [] })
  assert.deepEqual(parseOutlineLine('（一）集合'), { depth: 0, name: '（一）集合', aliases: [] })
  // ... and with a space the numbering is stripped.
  assert.deepEqual(parseOutlineLine('(1) 区间'), { depth: 1, name: '区间', aliases: [] })
})

test('outline: synonyms become aliases instead of a second knowledge point', () => {
  assert.deepEqual(splitSynonyms('导数（微分）'), { name: '导数', aliases: ['微分'] })
  assert.deepEqual(splitSynonyms('导数（微分，求导）'), { name: '导数', aliases: ['微分', '求导'] })
  assert.deepEqual(splitSynonyms('导数 别名：微分, 求导'), { name: '导数', aliases: ['微分', '求导'] })
  // A trailing bracket group with no name before it keeps the whole line as the name.
  assert.deepEqual(splitSynonyms('（函数）'), { name: '（函数）', aliases: [] })
})

test('outline: depth takes the larger of indentation and numbering', () => {
  assert.equal(parseOutlineLine('1.1 导数的定义')?.depth, 1)
  assert.equal(parseOutlineLine('1.1.1 极限')?.depth, 2)
  assert.equal(parseOutlineLine('  1 缩进一级')?.depth, 1, 'indentation alone can reach depth 1')
  assert.equal(parseOutlineLine('    1.1 缩进两级')?.depth, 2)
  assert.equal(parseOutlineLine('\t1 制表符缩进')?.depth, 2, 'a tab expands to four spaces = depth 2')
})
