import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pyFormatFixed } from '../src/domain/pyfmt.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/pyfmt.json', import.meta.url), 'utf8'))

/** Python's float repr spells the infinities `inf`/`-inf`, which JS `Number()` does not accept. */
function parsePythonFloat(text: string): number {
  if (text === 'inf') return Number.POSITIVE_INFINITY
  if (text === '-inf') return Number.NEGATIVE_INFINITY
  if (text === 'nan') return Number.NaN
  return Number(text)
}

test(`pyFormatFixed(): ${golden.cases.length} values match CPython format(x, '.Nf')`, () => {
  const failures: string[] = []
  for (const entry of golden.cases) {
    const value = parsePythonFloat(entry.value)
    const got = pyFormatFixed(value, entry.places)
    if (got !== entry.expected) {
      failures.push(`${entry.value} places=${entry.places}: got ${got}, expected ${entry.expected}`)
    }
  }
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} mismatches`)
})

test('pyFormatFixed(): the mantissa-mask regression cases', () => {
  // The bit-pattern decoding used to read `hi & 0xffff` instead of `hi & 0xfffff`, dropping the top
  // four mantissa bits. Only a handful of values expose it, which is why this is a separate test.
  assert.equal(pyFormatFixed(2.625, 2), '2.62')
  assert.equal(pyFormatFixed(1.005, 2), '1.00')
  assert.equal(pyFormatFixed(-0.005, 2), '-0.01')
  assert.equal(pyFormatFixed(0.1 + 0.2, 17), '0.30000000000000004')
  assert.equal(pyFormatFixed(-0.0, 2), '-0.00')
  assert.equal(pyFormatFixed(0, 2), '0.00')
})

test('pyFormatFixed(): non-finite values print like Python', () => {
  assert.equal(pyFormatFixed(Number.POSITIVE_INFINITY, 2), 'inf')
  assert.equal(pyFormatFixed(Number.NEGATIVE_INFINITY, 2), '-inf')
  assert.equal(pyFormatFixed(Number.NaN, 2), 'nan')
})
