/**
 * Python-compatible JSON canonicalisation, for idempotency fingerprints.
 *
 * The digest a request is deduplicated on is
 * `sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str, separators=(',',':')))`.
 * Two details cannot be reproduced with `JSON.parse` + `JSON.stringify`:
 *
 * 1. `1` and `1.0` are different payloads to Python (`int` vs `float`), and they hash differently.
 *    JS has one number type, so the parser keeps the distinction explicitly by wrapping tokens that
 *    contain a fraction or exponent in {@link PyFloat}.
 * 2. Python prints floats with `repr()` (`1.0`, `1e-07`, `-0.0`) and escapes strings with its own
 *    table (`\u0001` but a raw DEL), not with JavaScript's `JSON.stringify` escaping.
 *
 * Wrapping is exact: the payload an API request carries is parsed from text, so the token is still
 * available at the only moment the distinction can be recovered.
 */
import { pyFloatRepr } from '../domain/pyfmt.ts'

/** A number that arrived as a JSON float token (`1.0`, `1e3`) rather than an integer token. */
export class PyFloat {
  value: number
  constructor(value: number) {
    this.value = value
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const WHITESPACE = new Set([' ', '\t', '\n', '\r'])

/**
 * Parse JSON while remembering which numbers were written as floats.
 *
 * Duplicate object keys keep the last value, as `json.loads` does.
 */
export function parsePyJson(text: string): unknown {
  let index = 0

  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at offset ${index}`)
  }

  const skipWhitespace = () => {
    while (index < text.length && WHITESPACE.has(text[index])) index += 1
  }

  const parseString = (): string => {
    if (text[index] !== '"') fail('expected a string')
    index += 1
    let out = ''
    for (;;) {
      if (index >= text.length) fail('unterminated string')
      const ch = text[index]
      if (ch === '"') {
        index += 1
        return out
      }
      if (ch === '\\') {
        index += 1
        const escape = text[index]
        index += 1
        switch (escape) {
          case '"': out += '"'; break
          case '\\': out += '\\'; break
          case '/': out += '/'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case 'n': out += '\n'; break
          case 'r': out += '\r'; break
          case 't': out += '\t'; break
          case 'u': {
            const hex = text.slice(index, index + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid \\u escape')
            out += String.fromCharCode(parseInt(hex, 16))
            index += 4
            break
          }
          default:
            fail(`invalid escape \\${escape}`)
        }
        continue
      }
      if (ch < ' ') fail('unescaped control character')
      out += ch
      index += 1
    }
  }

  const parseValue = (): unknown => {
    skipWhitespace()
    const ch = text[index]
    if (ch === '{') {
      index += 1
      const object: Record<string, unknown> = {}
      skipWhitespace()
      if (text[index] === '}') {
        index += 1
        return object
      }
      for (;;) {
        skipWhitespace()
        const key = parseString()
        skipWhitespace()
        if (text[index] !== ':') fail('expected ":"')
        index += 1
        object[key] = parseValue()
        skipWhitespace()
        if (text[index] === ',') {
          index += 1
          continue
        }
        if (text[index] === '}') {
          index += 1
          return object
        }
        fail('expected "," or "}"')
      }
    }
    if (ch === '[') {
      index += 1
      const array: unknown[] = []
      skipWhitespace()
      if (text[index] === ']') {
        index += 1
        return array
      }
      for (;;) {
        array.push(parseValue())
        skipWhitespace()
        if (text[index] === ',') {
          index += 1
          continue
        }
        if (text[index] === ']') {
          index += 1
          return array
        }
        fail('expected "," or "]"')
      }
    }
    if (ch === '"') return parseString()
    if (text.startsWith('true', index)) {
      index += 4
      return true
    }
    if (text.startsWith('false', index)) {
      index += 5
      return false
    }
    if (text.startsWith('null', index)) {
      index += 4
      return null
    }
    NUMBER.lastIndex = index
    const match = NUMBER.exec(text)
    if (match === null) fail('unexpected token')
    index = NUMBER.lastIndex
    const token = match![0]
    const value = Number(token)
    // `1e3` and `1.0` are floats to Python even though both are integral.
    if (/[.eE]/.test(token)) return new PyFloat(value)
    // Python ints are arbitrary precision, so a token beyond 2^53 must not be rounded here.
    return Number.isSafeInteger(value) ? value : BigInt(token)
  }

  const result = parseValue()
  skipWhitespace()
  if (index !== text.length) fail('trailing data')
  return result
}

/** Compare two strings by Unicode code point, as Python's `sorted()` does. */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  const length = Math.min(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!
    if (diff !== 0) return diff
  }
  return left.length - right.length
}

/** Python's `json` string escaping with `ensure_ascii=False`. */
export function pyJsonString(text: string): string {
  let out = '"'
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\b') out += '\\b'
    else if (ch === '\f') out += '\\f'
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
    // Everything else, including DEL and non-ASCII, is emitted raw — that is what Python does.
    else out += ch
  }
  return `${out}"`
}

/** `json.dumps(value, sort_keys=True, ensure_ascii=False, default=str, separators=(',',':'))` */
export function pyJsonCanonical(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (value instanceof PyFloat) return pyFloatRepr(value.value)
  if (typeof value === 'number') {
    // An integral number is a Python `int`; anything else is a float.
    return Number.isInteger(value) ? String(value) : pyFloatRepr(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return pyJsonString(value)
  if (Array.isArray(value)) return `[${value.map(pyJsonCanonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    entries.sort(([a], [b]) => compareCodePoints(a, b))
    return `{${entries.map(([key, item]) => `${pyJsonString(key)}:${pyJsonCanonical(item)}`).join(',')}}`
  }
  // `default=str`: anything else becomes the string form of the value.
  return pyJsonString(String(value))
}
