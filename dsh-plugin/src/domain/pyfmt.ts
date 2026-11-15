/**
 * Python-compatible number/string formatting.
 *
 * Needed for parity, not for looks: the canonical form used by the expression grader's structural
 * fast path is built from `repr(float)`, and user-visible reasons embed `{x!r}` / `{x:g}` / `{x:.1f}`.
 */

/** `repr(float)` as CPython prints it (shortest round-trip digits; exponent form when decpt<=-4 or >16). */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  const sign = x < 0 ? '-' : ''
  const [mantissa, exp] = Math.abs(x).toExponential().split('e')
  const digits = mantissa.replace('.', '')
  const decpt = Number(exp) + 1
  if (decpt <= -4 || decpt > 16) {
    const e = decpt - 1
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    return `${sign}${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`
}

/** `format(x, 'g')` — six significant digits, trailing zeros stripped. */
export function pyFormatG(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0' : '0'
  const [mantissa, exp] = Math.abs(x).toExponential(5).split('e')
  const e = Number(exp)
  const sign = x < 0 ? '-' : ''
  if (e < -4 || e >= 6) {
    const m = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa
    return `${sign}${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
  }
  const fixed = Math.abs(x).toFixed(Math.max(0, 5 - e))
  return sign + (fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed)
}

/**
 * `round(x, places)` for a float, as CPython returns it.
 *
 * CPython rounds the exact binary value to `places` decimals (ties to even) and then reads the
 * resulting decimal string back as a float. `Math.round` breaks ties upwards and only handles
 * integers, so e.g. `round(2.5) == 2` and `round(2.675, 2) == 2.67` have no direct JS equivalent.
 */
export function pyRound(x: number, places: number): number {
  if (Number.isNaN(x)) return x
  if (!Number.isFinite(x)) throw new RangeError('cannot round infinity')
  if (x === 0) return x
  const negative = x < 0
  const rounded = pyFormatFixed(x, places)
  const value = Number(rounded)
  return negative ? value : value
}

/** `repr(str)` for the characters that can appear in our messages. */
export function pyStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === quote) out += `\\${quote}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (c < 0x20 || (c >= 0x7f && c < 0xa1)) out += `\\x${c.toString(16).padStart(2, '0')}`
    else out += ch
  }
  return quote + out + quote
}

/** `str.isspace()` for one character (Unicode White_Space plus the C0 separators CPython counts). */
export function pyIsSpace(ch: string): boolean {
  return /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u.test(ch)
}

/** Exact binary decomposition of a finite double: `|x| === m * 2**e` with `m` a BigInt. */
function decompose(x: number): { m: bigint; e: number } {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, Math.abs(x))
  const hi = view.getUint32(0)
  const lo = view.getUint32(4)
  const expBits = (hi >>> 20) & 0x7ff
  const mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  if (expBits === 0) return { m: mantissa, e: -1074 }
  return { m: mantissa | (1n << 52n), e: expBits - 1075 }
}

/**
 * `format(x, '.<places>f')` as CPython prints it.
 *
 * CPython rounds the *exact binary value* of the double with round-half-even; `toFixed` rounds the
 * decimal expansion and breaks ties away from zero, so it disagrees on values like `1.005`
 * (`'1.00'` in Python, `'1.01'` with `toFixed`). The reason strings embed these numbers, so the
 * rounding has to be reproduced, not approximated.
 */
export function pyFormatFixed(x: number, places: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  const negative = x < 0 || Object.is(x, -0)
  const { m, e } = decompose(x)
  const scale = 10n ** BigInt(places)
  let numerator = m * scale
  let denominator = 1n
  if (e >= 0) numerator <<= BigInt(e)
  else denominator = 1n << BigInt(-e)
  // round-half-even to an integer number of units in the last place
  let units = numerator / denominator
  const remainder = numerator % denominator
  const twice = remainder * 2n
  if (twice > denominator || (twice === denominator && units % 2n === 1n)) units += 1n
  let digits = units.toString()
  if (places > 0) {
    digits = digits.padStart(places + 1, '0')
    digits = `${digits.slice(0, -places)}.${digits.slice(-places)}`
  }
  // Python prints "-0.00" for a negative value that rounds to zero, so the sign is kept.
  return negative ? `-${digits}` : digits
}

