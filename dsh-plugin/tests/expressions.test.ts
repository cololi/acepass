import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as X from '../src/domain/expressions.ts'
import { pyFloatRepr, pyFormatG } from '../src/domain/pyfmt.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/expressions.json', import.meta.url), 'utf8'))
const BUDGET = 2.0
const unnum = (v: any) => (v && typeof v === 'object' && '$' in v ? ({ nan: NaN, inf: Infinity, '-inf': -Infinity } as any)[v.$] : v)
const closeTo = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b))

test('limits match the Python constants', () => {
  const g = golden.limits
  assert.equal(X.MAX_INPUT_LENGTH, g.MAX_INPUT_LENGTH); assert.equal(X.MAX_TOKENS, g.MAX_TOKENS)
  assert.equal(X.MAX_AST_NODES, g.MAX_AST_NODES); assert.equal(X.MAX_DEPTH, g.MAX_DEPTH)
  assert.equal(X.MAX_EVAL_STEPS, g.MAX_EVAL_STEPS); assert.equal(X.MAX_EXPONENT_MAGNITUDE, g.MAX_EXPONENT_MAGNITUDE)
  assert.equal(X.MAX_ABS_RESULT, g.MAX_ABS_RESULT); assert.equal(X.MAX_VARIABLES, g.MAX_VARIABLES)
  assert.equal(X.MAX_SAMPLES, g.MAX_SAMPLES); assert.equal(X.DEFAULT_TOLERANCE, g.DEFAULT_TOLERANCE)
  assert.equal(X.SAMPLE_SEED, g.SAMPLE_SEED)
})

test('sampling grid is bit-identical (LCG needs BigInt)', () => {
  const s = golden.sampling
  assert.deepEqual([...X.SAMPLE_POINTS], s.fixed)
  assert.deepEqual(X.seededValues(8), s.seeded_8)
  assert.deepEqual(X.sampleValues(), s.values)
  assert.deepEqual(X.defaultRows(1), s.rows1)
  assert.deepEqual(X.defaultRows(2), s.rows2)
})

test(`compare(): ${golden.compare.length} vectors, outcome/error/reason/samples/sample identical`, () => {
  for (const c of golden.compare) {
    const opts = { timeBudget: BUDGET, ...(c.samples !== undefined ? { samples: c.samples } : {}) }
    const got = X.verdictToDict(X.compareExpressions(c.left, c.right, opts))
    assert.deepEqual(got, c.verdict, `compare(${JSON.stringify(c.left)}, ${JSON.stringify(c.right)})`)
    assert.equal(X.expressionsEquivalent(c.left, c.right, opts), c.equivalent)
  }
})

test(`normalize()/free_variables(): ${golden.normalize.length} vectors, canonical strings identical`, () => {
  for (const n of golden.normalize) {
    if (n.error) {
      assert.throws(() => X.normalizeExpression(n.expr), (e: any) => e instanceof X.ExpressionError && e.code === n.error, n.expr)
    } else {
      assert.equal(X.normalizeExpression(n.expr), n.normalized, n.expr)
      assert.deepEqual(X.freeVariables(n.expr), n.free, n.expr)
    }
  }
})

test(`evaluate(): ${golden.evaluate.length} vectors, values and error classes identical`, () => {
  for (const e of golden.evaluate) {
    if (e.error) assert.throws(() => X.evaluate(e.expr, e.vars, { timeBudget: BUDGET }), (x: any) => x.code === e.error.code, `${e.expr} -> ${e.error.code}`)
    else assert.ok(closeTo(X.evaluate(e.expr, e.vars, { timeBudget: BUDGET }), unnum(e.value)), e.expr)
  }
})

test('every hostile input is a syntax/limit refusal, never a value', () => {
  for (const h of ['__import__("os").system("x")', 'open("/etc/passwd").read()', '(1).__class__', '"a"*10', 'lambda: 1', '[x for x in ()]', 'x.__dict__',
    'eval(x)', 'exec(x)', 'globals()', '__import__(x)', 'os.system(x)', '1;2', 'x if x else 1', 'toString(1)', 'x.constructor', 'constructor(1)', '__proto__.x']) {
    assert.throws(() => X.evaluate(h, { x: 1 }), (e: any) => e instanceof X.ExpressionError && ['syntax', 'limit'].includes(e.code), h)
    const v = X.compareExpressions(h, '1', { timeBudget: BUDGET })
    assert.equal(v.outcome, 'unknown', h)
  }
})

test('prototype-chain names are plain unknown symbols, not properties', () => {
  // Cordis/JS hazard that Python does not have: a variable named like an Object.prototype member.
  assert.equal(X.compareExpressions('constructor', 'constructor', { timeBudget: BUDGET }).outcome, 'equivalent')
  assert.throws(() => X.evaluate('hasOwnProperty', {}), X.ExpressionSyntaxError)
  assert.throws(() => X.evaluate('toString', { x: 1 }), X.ExpressionSyntaxError)
  assert.equal(X.evaluate('valueof', { valueof: 3 }), 3)
})

test('time budget: an expired budget can never produce equivalent (property, not golden)', () => {
  const v = X.compareExpressions('x^2+2x+1', '(x+1)^2', { timeBudget: 0 })
  assert.equal(v.outcome, 'unknown'); assert.equal(v.errorType, 'timeout')
  assert.equal(X.expressionsEquivalent('x', 'x', { timeBudget: -1 }), null)
  assert.equal(X.expressionsEquivalent('x', 'x', { timeBudget: Number.NaN }), null)
  assert.equal(X.expressionsEquivalent('x', 'x', { timeBudget: Number.POSITIVE_INFINITY }), null) // inf is not finite -> 0, as Python
})

test('python formatting helpers', () => {
  const cases: [number, string][] = [[0.5, '0.5'], [1, '1.0'], [1e16, '1e+16'], [1e15, '1000000000000000.0'], [1.5e-5, '1.5e-05'], [0.0001, '0.0001'], [123456789.123, '123456789.123'], [-0.0, '-0.0'], [1e30, '1e+30'], [2 ** 53, '9007199254740992.0']]
  for (const [x, want] of cases) assert.equal(pyFloatRepr(x), want, String(x))
  assert.equal(pyFormatG(1e30), '1e+30'); assert.equal(pyFormatG(2.5), '2.5'); assert.equal(pyFormatG(-3), '-3'); assert.equal(pyFormatG(1234567), '1.23457e+06'); assert.equal(pyFormatG(0.0001), '0.0001'); assert.equal(pyFormatG(0.00001), '1e-05')
})

test('STATIC: the engine source cannot execute code, read files or touch the network', () => {
  for (const file of ['expressions.ts', 'pyfmt.ts']) {
    const src = readFileSync(new URL(`../src/domain/${file}`, import.meta.url), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""')
    for (const bad of [/\beval\s*\(/, /\bFunction\s*\(/, /new\s+Function/, /\bimport\s*\(/, /\brequire\s*\(/, /['"`]node:/, /\bprocess\b/, /\bglobalThis\b/, /\bfetch\b/, /\bvm\b/, /child_process/, /\bWebAssembly\b/, /\bsetTimeout\b/])
      assert.doesNotMatch(code, bad, `${file} must not contain ${bad}`)
    assert.ok(!/^import .*from '(?!\.\/)/m.test(src), `${file} may only import sibling domain modules`)
  }
})
