import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Decimal, DecimalError, pyMax, pyMin } from '../src/domain/decimal.ts'

const g = JSON.parse(readFileSync(new URL('./golden/decimal.json', import.meta.url), 'utf8'))
const attempt = (f: () => Decimal | boolean) => {
  try { const v = f(); return { v: typeof v === 'boolean' ? v : v.toString() } }
  catch (e) { if (e instanceof DecimalError) return { err: e.code }; throw e }
}

test('parse(): str() representation including exponent matches CPython', () => {
  // Documented divergence: Python accepts non-ASCII decimal digits; we reject them (safe direction).
  const REJECTED_ON_PURPOSE = new Set(['١٢'])
  for (const p of g.parse) {
    if (REJECTED_ON_PURPOSE.has(p.in)) { assert.equal(p.error, undefined, 'python accepts it'); assert.throws(() => Decimal.parse(p.in), DecimalError); continue }
    if (p.error || p.special) { assert.throws(() => Decimal.parse(p.in), DecimalError, p.in); continue }
    const d = Decimal.parse(p.in)
    assert.equal(d.toString(), p.str, JSON.stringify(p.in))
    assert.deepEqual([d.sign, String(d.exp)], p.tuple, JSON.stringify(p.in))
  }
})

test(`binary ops: ${g.binary.length} pairs — add/sub/mul/div/cmp/max/min/abs, rounding & errors identical`, () => {
  let errors = 0
  for (const r of g.binary) {
    const A = Decimal.parse(r.a), B = Decimal.parse(r.b), w = `${r.a} , ${r.b}`
    assert.deepEqual(attempt(() => A.add(B)), r.add, `add ${w}`)
    assert.deepEqual(attempt(() => A.sub(B)), r.sub, `sub ${w}`)
    assert.deepEqual(attempt(() => A.mul(B)), r.mul, `mul ${w}`)
    assert.deepEqual(attempt(() => A.div(B)), r.div, `div ${w}`)
    assert.equal(A.cmp(B), r.cmp, `cmp ${w}`)
    assert.equal(pyMax(A, B).toString(), r.max, `max ${w}`)
    assert.equal(pyMin(A, B).toString(), r.min, `min ${w}`)
    assert.deepEqual(attempt(() => A.abs()), r.abs, `abs ${w}`)
    assert.equal(A.truthy, r.bool, `bool ${w}`)
    for (const k of ['add', 'sub', 'mul', 'div']) if ('err' in r[k]) errors++
  }
  assert.ok(errors > 100, 'the vectors must exercise the error paths')
})

test('division by small ints and multiplication by small ints (grading shapes)', () => {
  for (const u of g.unary) {
    const A = Decimal.parse(u.a)
    assert.deepEqual(attempt(() => A.div(Decimal.fromInt(u.n))), u.div_int, `${u.a} / ${u.n}`)
    assert.deepEqual(attempt(() => A.mul(Decimal.fromInt(u.d))), u.mul_int, `${u.a} * ${u.d}`)
  }
})

test('quantize(0.0001) — used by confirmed_fraction', () => {
  for (const q of g.quantize) assert.deepEqual(attempt(() => Decimal.parse(q.a).quantize(-4)), q.q4, q.a)
})

test('classic float traps are exact', () => {
  const d = (s: string) => Decimal.parse(s)
  assert.equal(d('0.1').add(d('0.2')).toString(), '0.3')
  assert.equal(d('1').div(d('3')).toString(), '0.3333333333333333333333333333')
  assert.equal(d('10').div(d('4')).toString(), '2.5')
  assert.equal(d('1e3').toString(), '1E+3')
  assert.equal(d('0.00').toString(), '0.00')
})
