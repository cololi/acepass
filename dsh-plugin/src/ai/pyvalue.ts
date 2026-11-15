/**
 * Python value semantics the AI contract depends on.
 *
 * The validators are written as `str(payload.get(...))[:300]`-style code in Python, so the exact
 * meaning of `str()`, of truthiness, of iteration and of slicing is part of the stored output —
 * not an implementation detail. Reusing JS defaults here would silently change what a model's
 * output becomes once it is stored (e.g. `str({})` is `{}` in JS but `{}` in Python only for
 * dicts; `str([])` is `[]`; `str(None)` is `None`).
 */
import { pyFloatRepr, pyIsSpace, pyStrRepr } from '../domain/pyfmt.ts'
import { pyStrip } from '../domain/pytext.ts'

/** A JSON number kept as its source lexeme.
 *
 * Python's `json.loads` keeps `2` as `int` and `2.0` as `float`, and `str()` of the two differs
 * (`"2"` vs `"2.0"`). A JS number has already lost that distinction, and the estimate/variant
 * validators store `str(Decimal(str(score)))`, so the lexeme has to survive the parse to keep the
 * stored decimal strings byte-identical. `plain()` converts these back to JS numbers on output.
 */
export class PyNumber {
  readonly text: string
  constructor(text: string) { this.text = text }
}

export function isPyNumber(value: unknown): value is PyNumber {
  return value instanceof PyNumber
}

/** Python `str(value)` for the JSON-shaped values that reach a model-output validator. */
export function pyStr(value: unknown): string {
  if (isPyNumber(value)) {
    // `str(float('inf'))` is `inf`, not the JSON literal `Infinity` that `json.loads` accepted.
    if (value.text === 'Infinity') return 'inf'
    if (value.text === '-Infinity') return '-inf'
    if (value.text === 'NaN') return 'nan'
    return value.text
  }
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') {
    // `str(float)` is `repr(float)` in Python 3; CPython prints -0.0 with its sign.
    if (Object.is(value, -0)) return '-0.0'
    if (Number.isInteger(value)) return String(value)
    return pyFloatRepr(value)
  }
  if (value === null || value === undefined) return 'None'
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{${entries.map(([key, item]) => `${pyStrRepr(key)}: ${pyRepr(item)}`).join(', ')}}`
  }
  return String(value)
}

/** Python `repr(value)` for a JSON value: strings are quoted, everything else uses `str`. */
export function pyRepr(value: unknown): string {
  return typeof value === 'string' ? pyStrRepr(value) : pyStr(value)
}

/** Python truthiness (an empty dict/list/string and numeric zero are all falsy). */
export function pyTruthy(value: unknown): boolean {
  if (isPyNumber(value)) return Number(value.text) !== 0
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (value === null || value === undefined) return false
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return true
}

/** `value or fallback`, with Python truthiness. */
export function pyOr<T, F>(value: T, fallback: F): T | F {
  return pyTruthy(value) ? value : fallback
}

export class PyTypeError extends TypeError {}
export class PyValueError extends Error {}

/**
 * Python `float(value)`.
 *
 * Accepts the same spellings `float()` accepts for the values a model can produce: surrounding
 * whitespace, `+`/`-`, `inf`/`infinity`/`nan` in any case, `.5`/`5.`, exponent forms, and
 * underscores between digits. Non-ASCII decimal digits are deliberately rejected (see
 * 04-parity-findings DIV-1: Python accepts them, this port refuses rather than guesses).
 */
export function pyFloat(value: unknown): number {
  if (isPyNumber(value)) return jsonNumberToFloat(value.text)
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === null || value === undefined) throw new PyTypeError('float() argument must be a string or a real number, not NoneType')
  if (typeof value !== 'string') throw new PyTypeError(`float() argument must be a string or a real number, not ${typeName(value)}`)
  const text = pyStrip(value)
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(text)
  if (special) {
    const negative = special[1] === '-'
    if (special[2].toLowerCase() === 'nan') return Number.NaN
    return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  }
  const body = /^([+-]?)(?:\d(?:_?\d)*)?(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?$/.exec(text)
  const hasDigit = /\d/.test(text)
  if (!body || !hasDigit) throw new PyValueError(`could not convert string to float: ${pyStrRepr(value)}`)
  // Reject the shapes the regex above would still admit: `_` adjacent to `.`/`e`, lone signs.
  if (/_(?:[.eE]|[+-]|$)|(?:[.eE]|^)_/.test(text)) throw new PyValueError(`could not convert string to float: ${pyStrRepr(value)}`)
  return Number(text.replaceAll('_', ''))
}

function jsonNumberToFloat(text: string): number {
  // JSON numbers cannot carry `nan`/`inf` tokens, so the ordinary conversion is exact here.
  return Number(text)
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return 'list'
  if (isPyNumber(value)) return 'float'
  return typeof value === 'object' ? 'dict' : typeof value
}

/** CPython `min(a, b)`: comparison-based, so `min(1.0, nan)` is `1.0`. */
export function pyMin(a: number, b: number): number {
  return b < a ? b : a
}
/** CPython `max(a, b)`: comparison-based, so `max(0.0, nan)` is `0.0`. */
export function pyMax(a: number, b: number): number {
  return b > a ? b : a
}
/** `max(0.0, min(1.0, value))` exactly as the registry writes it. */
export function pyClampUnit(value: number): number {
  return pyMax(0, pyMin(1, value))
}

/** Python `str` slicing is by code point; JS `String#slice` is by UTF-16 code unit. */
export function pySlice(value: string, length: number): string {
  return Array.from(value).slice(0, length).join('')
}

/** `len(str)`, counted in code points. */
export function pyLen(value: string): number {
  return Array.from(value).length
}

/** `"sep".join(str(item) for item in items)`. Python would raise on non-str; stringifying keeps
 * the port total without changing any well-typed output (the registry only joins strings). */
export function pyJoin(separator: string, items: readonly unknown[]): string {
  return items.map((item) => pyStr(item)).join(separator)
}

/** Python's `for item in (value or [])` for the values a JSON payload can carry.
 *
 * Lists iterate their items, strings iterate code points, dicts iterate keys, and every falsy
 * value iterates nothing. A truthy non-iterable makes Python raise TypeError; the validators
 * treat that as "no items" instead of crashing the request (documented deviation: Python would
 * answer 500 on a model that returned `"doubts": 5`).
 */
export function pyIterOrEmpty(value: unknown): unknown[] {
  // A truthy non-iterable (e.g. a number) makes Python raise TypeError; the validators treat it as
  // "no items" rather than failing the request (see the deviation note in the migration report).
  if (!pyTruthy(value)) return []
  if (isPyNumber(value)) return []
  if (typeof value === 'string') return Array.from(value)
  if (Array.isArray(value)) return value
  if (typeof value === 'object') return Object.keys(value as object)
  return []
}

/** Python `str.isalnum()` prefix used by `re`'s `\w` for `str` patterns: letters + numbers. */
function isPyWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch)
}

/**
 * `re.sub(r"[\s\W_]+", "", str(value or "")).lower()`.
 *
 * `\W` in a Python `str` pattern is Unicode-aware (`中` is a word character), while JS `\W`
 * without `u` is ASCII-only. The character class keeps Python word characters and drops `_`
 * (the pattern lists `_` explicitly), which is what the variant leak scan compares against.
 */
export function normalizedForCompare(value: unknown): string {
  const text = pyTruthy(value) ? pyStr(value) : ''
  let kept = ''
  for (const ch of text) {
    if (ch !== '_' && isPyWordChar(ch)) kept += ch
  }
  return kept.toLowerCase()
}

/** Convert `PyNumber` wrappers back into ordinary JSON numbers for storage/passthrough. */
export function plain(value: unknown): unknown {
  if (isPyNumber(value)) return Number(value.text)
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = plain(item)
    return out
  }
  return value
}

/* ------------------------------------------------------------------ JSON parsing */

/**
 * `json.loads(_strip_code_fence(text))` with numeric lexemes preserved.
 *
 * `_strip_code_fence` is duplicated in five services with cosmetically different bodies; they all
 * reduce to: strip, drop the first line after a leading fence, drop a trailing fence, strip again.
 * The Python-oracle vectors pin that equivalence.
 */
export function stripCodeFence(rawText: unknown): string {
  const original = rawText === null || rawText === undefined ? '' : pyStr(rawText)
  let cleaned = pyStrip(original)
  if (cleaned.startsWith('```')) {
    // `split("\n", 1)[-1]`: drop the first line, or keep the whole string when there is no newline.
    const newline = cleaned.indexOf('\n')
    if (newline >= 0) cleaned = cleaned.slice(newline + 1)
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3)
  }
  return pyStrip(cleaned)
}

export function parseModelJson(rawText: unknown): unknown {
  return new JsonParser(stripCodeFence(rawText)).parseTop()
}

class JsonParser {
  private index = 0
  private readonly text: string
  constructor(text: string) { this.text = text }

  parseTop(): unknown {
    const value = this.parseValue()
    this.skipWhitespace()
    if (this.index < this.text.length) this.fail('Extra data')
    return value
  }

  private fail(message: string): never {
    throw new SyntaxError(`${message}: char ${this.index}`)
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && ' \t\n\r'.includes(this.text[this.index])) this.index++
  }

  private parseValue(): unknown {
    this.skipWhitespace()
    const ch = this.text[this.index]
    if (ch === undefined) this.fail('Expecting value')
    if (ch === '{') return this.parseObject()
    if (ch === '[') return this.parseArray()
    if (ch === '"') return this.parseString()
    if (ch === 't') return this.parseLiteral('true', true)
    if (ch === 'f') return this.parseLiteral('false', false)
    if (ch === 'n') return this.parseLiteral('null', null)
    // Python's json module accepts these three constants even though they are not RFC 8259 JSON.
    if (ch === 'N' && this.text.startsWith('NaN', this.index)) {
      this.index += 3
      return new PyNumber('NaN')
    }
    if (ch === 'I' && this.text.startsWith('Infinity', this.index)) {
      this.index += 8
      return new PyNumber('Infinity')
    }
    if (ch === '-' && this.text.startsWith('-Infinity', this.index)) {
      this.index += 9
      return new PyNumber('-Infinity')
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.parseNumber()
    this.fail('Expecting value')
  }

  private parseLiteral(word: string, value: unknown): unknown {
    if (this.text.slice(this.index, this.index + word.length) !== word) this.fail('Expecting value')
    this.index += word.length
    return value
  }

  private parseObject(): Record<string, unknown> {
    this.index++ // {
    const out: Record<string, unknown> = {}
    this.skipWhitespace()
    if (this.text[this.index] === '}') { this.index++; return out }
    for (;;) {
      this.skipWhitespace()
      if (this.text[this.index] !== '"') this.fail('Expecting property name enclosed in double quotes')
      const key = this.parseString()
      this.skipWhitespace()
      if (this.text[this.index] !== ':') this.fail("Expecting ':' delimiter")
      this.index++
      // Assigning an existing key keeps its original position, like a Python dict update.
      out[key] = this.parseValue()
      this.skipWhitespace()
      const ch = this.text[this.index]
      if (ch === ',') { this.index++; continue }
      if (ch === '}') { this.index++; return out }
      this.fail("Expecting ',' delimiter")
    }
  }

  private parseArray(): unknown[] {
    this.index++ // [
    const out: unknown[] = []
    this.skipWhitespace()
    if (this.text[this.index] === ']') { this.index++; return out }
    for (;;) {
      out.push(this.parseValue())
      this.skipWhitespace()
      const ch = this.text[this.index]
      if (ch === ',') { this.index++; continue }
      if (ch === ']') { this.index++; return out }
      this.fail("Expecting ',' delimiter")
    }
  }

  private parseString(): string {
    this.index++ // opening quote
    let out = ''
    for (;;) {
      const ch = this.text[this.index]
      if (ch === undefined) this.fail('Unterminated string')
      if (ch === '"') { this.index++; return out }
      if (ch === '\\') {
        this.index++
        const esc = this.text[this.index]
        this.index++
        switch (esc) {
          case '"': out += '"'; break
          case '\\': out += '\\'; break
          case '/': out += '/'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case 'n': out += '\n'; break
          case 'r': out += '\r'; break
          case 't': out += '\t'; break
          case 'u': {
            const hex = this.text.slice(this.index, this.index + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid \\uXXXX escape')
            out += String.fromCharCode(Number.parseInt(hex, 16))
            this.index += 4
            break
          }
          default: this.fail('Invalid \\escape')
        }
        continue
      }
      if (ch < ' ') this.fail('Invalid control character')
      out += ch
      this.index++
    }
  }

  private parseNumber(): PyNumber {
    const rest = this.text.slice(this.index)
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)
    if (!match) this.fail('Expecting value')
    const literal = match[0]
    this.index += literal.length
    return new PyNumber(literal)
  }
}

/** Python `re`'s `\s` set, for the few patterns shared with the content validator. */
export const PY_SPACE_CLASS = '[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'

/** `str.isspace()` for one character, re-exported so callers use one notion of whitespace. */
export { pyIsSpace, pyStrip }
