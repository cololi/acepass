import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parsePyJson, pyJsonCanonical, pyJsonString } from '../src/store/pyjson.ts'

const golden = JSON.parse(readFileSync(new URL('./golden/pyjson.json', import.meta.url), 'utf8'))

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

test(`pyjson: ${golden.cases.length} payloads canonicalise and hash like json.dumps`, () => {
  const failures: string[] = []
  for (const entry of golden.cases) {
    // A python-only payload (Decimal/date/UUID) reaches Node already stringified by `default=str`.
    const payload = entry.json === undefined ? entry.python_only : parsePyJson(entry.json)
    const canonical = pyJsonCanonical(payload)
    if (canonical !== entry.canonical) {
      failures.push(`${entry.json ?? JSON.stringify(entry.python_only)}\n  got  ${canonical}\n  want ${entry.canonical}`)
      continue
    }
    if (sha256(canonical) !== entry.sha256) failures.push(`${entry.json}: digest differs`)
  }
  assert.deepEqual(failures, [], `canonicalisation mismatches:\n${failures.join('\n')}`)
})

test('pyjson: an integer and a float with the same value are different payloads', () => {
  // Python: json.dumps(1) == "1", json.dumps(1.0) == "1.0", and their fingerprints differ.
  assert.equal(pyJsonCanonical(parsePyJson('1')), '1')
  assert.equal(pyJsonCanonical(parsePyJson('1.0')), '1.0')
  assert.equal(pyJsonCanonical(parsePyJson('1e0')), '1.0')
  assert.notEqual(sha256(pyJsonCanonical(parsePyJson('{"n":1}'))), sha256(pyJsonCanonical(parsePyJson('{"n":1.0}'))))
})

test('pyjson: floats print with repr(), not with JavaScript number formatting', () => {
  assert.equal(pyJsonCanonical(parsePyJson('{"z":-0.0}')), '{"z":-0.0}')
  assert.equal(pyJsonCanonical(parsePyJson('{"x":1e300}')), '{"x":1e+300}')
  assert.equal(pyJsonCanonical(parsePyJson('{"x":1e-7}')), '{"x":1e-07}')
  assert.equal(pyJsonCanonical(parsePyJson('{"x":3.0}')), '{"x":3.0}')
})

test('pyjson: string escaping follows Python, not JSON.stringify', () => {
  // Python escapes C0 controls as \u00XX (lowercase) and leaves DEL raw.
  assert.equal(pyJsonString('\u0001\u001f\u007f'), '"\\u0001\\u001f\u007f"')
  assert.equal(pyJsonString('é中📚'), '"é中📚"')
  assert.equal(pyJsonString('a"b\\c\n'), '"a\\"b\\\\c\\n"')
  // DEL is emitted raw by both Python and JSON.stringify, so it is *not* a divergence.
  assert.equal(pyJsonString('\u007f'), JSON.stringify('\u007f'))
})

test('pyjson: keys are sorted by code point and duplicate keys keep the last value', () => {
  assert.equal(pyJsonCanonical(parsePyJson('{"b":1,"a":2}')), '{"a":2,"b":1}')
  assert.equal(pyJsonCanonical(parsePyJson('{"a":1,"a":2}')), '{"a":2}')
  // U+1F4DA (astral) sorts after U+FFFF; UTF-16 code-unit order would invert this.
  assert.equal(pyJsonCanonical({ '\uFFFF': 1, '📚': 2 }), '{"\uFFFF":1,"📚":2}')
})

test('pyjson: the parser rejects malformed input instead of guessing', () => {
  for (const bad of ['{', '{"a":}', '[1,]', 'tru', '{"a" 1}', '01', '1 2', '"unterminated', '{"a":"\u0001"}']) {
    assert.throws(() => parsePyJson(bad), SyntaxError, `expected a refusal for ${JSON.stringify(bad)}`)
  }
})
