/**
 * Python `decimal.Decimal` semantics under the DEFAULT context, as used by `domain/grading`:
 * prec=28, rounding=ROUND_HALF_EVEN, Emax=999999, Emin=-999999, traps = {InvalidOperation,
 * DivisionByZero, Overflow}. Ported from CPython's `_pydecimal.py` (`_fix`, `_normalize`,
 * `__add__`, `__mul__`, `__truediv__`, `_rescale`, `quantize`, `__str__`), because grading output
 * embeds `str(Decimal)` (including its exponent) and stores it, so the representation must match.
 *
 * Deliberate gaps (all of them reject instead of guessing):
 *  - NaN / Infinity / sNaN strings are not parsed (`DecimalError('invalid')`). Python would accept them.
 *  - Non-ASCII decimal digits are not parsed.
 * Operations that Python would answer with an exception (overflow, 0/0, x/0) throw `DecimalError`.
 */
export const PREC = 28
export const EMAX = 999999
export const EMIN = -999999
const ETINY = EMIN - PREC + 1
const ETOP = EMAX - PREC + 1

export type DecimalErrorCode = 'invalid' | 'overflow' | 'division_by_zero'
export class DecimalError extends Error {
  readonly code: DecimalErrorCode
  constructor(code: DecimalErrorCode, message?: string) { super(message ?? code); this.code = code }
}

const TEN = 10n
const pow10 = (n: number): bigint => TEN ** BigInt(n)
const digitsOf = (c: bigint): number => (c === 0n ? 1 : c.toString().length)

/** Round `coeff` (non-negative) to keep `keep` leading digits out of its `len`, half-even. Returns the new coeff and whether a carry grew it. */
function roundHalfEvenDrop(coeff: bigint, drop: number): bigint {
  if (drop <= 0) return coeff
  const divisor = pow10(drop)
  const q = coeff / divisor
  const r = coeff % divisor
  const twice = r * 2n
  if (twice > divisor) return q + 1n
  if (twice < divisor) return q
  return q % 2n === 1n ? q + 1n : q
}

export class Decimal {
  readonly sign: 0 | 1
  readonly coeff: bigint
  readonly exp: number
  private constructor(sign: 0 | 1, coeff: bigint, exp: number) { this.sign = sign; this.coeff = coeff; this.exp = exp }

  /** Exact construction (no rounding), like `Decimal("...")`. */
  static parse(input: string): Decimal {
    const text = input.trim().replaceAll('_', '')
    const m = /^([-+])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([-+]?\d+))?$/.exec(text)
    if (!m) throw new DecimalError('invalid', `invalid literal for Decimal: ${JSON.stringify(input)}`)
    const intPart = m[2] ?? ''
    const frac = m[3] ?? m[4] ?? ''
    const exp = Number(m[5] ?? '0') - frac.length
    if (!Number.isSafeInteger(exp)) throw new DecimalError('invalid', 'exponent out of range')
    const coeff = BigInt((intPart + frac) || '0')
    return new Decimal(m[1] === '-' ? 1 : 0, coeff, exp)
  }
  static fromInt(n: number): Decimal {
    if (!Number.isSafeInteger(n)) throw new DecimalError('invalid')
    return new Decimal(n < 0 ? 1 : 0, BigInt(Math.abs(n)), 0)
  }
  static zero(): Decimal { return new Decimal(0, 0n, 0) }

  isZero(): boolean { return this.coeff === 0n }
  /** Python truthiness: a zero Decimal is falsy. */
  get truthy(): boolean { return this.coeff !== 0n }
  isNegative(): boolean { return this.sign === 1 }
  adjusted(): number { return this.exp + digitsOf(this.coeff) - 1 }

  /** `Decimal.__str__` (to-scientific-string). */
  toString(): string {
    const intDigits = this.coeff.toString()
    const leftDigits = this.exp + intDigits.length
    let dotPlace: number
    if (this.exp <= 0 && leftDigits > -6) dotPlace = leftDigits
    else dotPlace = 1
    let intPart: string, fracPart: string
    if (dotPlace <= 0) { intPart = '0'; fracPart = '.' + '0'.repeat(-dotPlace) + intDigits }
    else if (dotPlace >= intDigits.length) { intPart = intDigits + '0'.repeat(dotPlace - intDigits.length); fracPart = '' }
    else { intPart = intDigits.slice(0, dotPlace); fracPart = '.' + intDigits.slice(dotPlace) }
    const e = leftDigits - dotPlace
    const expText = e === 0 ? '' : `E${e >= 0 ? '+' : '-'}${Math.abs(e)}`
    return (this.sign ? '-' : '') + intPart + fracPart + expText
  }

  /** `_fix`: round to PREC digits and enforce Emax/Etiny under the default context. */
  private fix(): Decimal {
    if (this.coeff === 0n) return new Decimal(this.sign, 0n, Math.min(Math.max(this.exp, ETINY), EMAX))
    const digits = digitsOf(this.coeff)
    let expMin = digits + this.exp - PREC
    if (expMin > ETOP) throw new DecimalError('overflow')
    if (expMin < ETINY) expMin = ETINY
    if (this.exp >= expMin) return this
    let keep = digits + this.exp - expMin
    let coeff: bigint
    if (keep < 0) { coeff = 0n; keep = 0 } else coeff = roundHalfEvenDrop(this.coeff, digits - keep)
    if (digitsOf(coeff) > PREC) { coeff /= TEN; expMin += 1 }
    if (expMin > ETOP) throw new DecimalError('overflow')
    return new Decimal(this.sign, coeff, expMin)
  }

  add(other: Decimal): Decimal {
    const exp = Math.min(this.exp, other.exp)
    if (this.coeff === 0n && other.coeff === 0n)
      return new Decimal(this.sign && other.sign ? 1 : 0, 0n, exp).fix()
    if (this.coeff === 0n) return other.rescaleTo(Math.max(exp, other.exp - PREC - 1)).fix()
    if (other.coeff === 0n) return this.rescaleTo(Math.max(exp, this.exp - PREC - 1)).fix()
    // _normalize(op1, op2, prec)
    let a = { s: this.sign, i: this.coeff, e: this.exp }
    let b = { s: other.sign, i: other.coeff, e: other.exp }
    const [tmp, oth] = a.e < b.e ? [b, a] : [a, b]
    const tmpLen = digitsOf(tmp.i), othLen = digitsOf(oth.i)
    const e2 = tmp.e + Math.min(-1, tmpLen - PREC - 2)
    if (othLen + oth.e - 1 < e2) { oth.i = 1n; oth.e = e2 }
    tmp.i *= pow10(tmp.e - oth.e)
    tmp.e = oth.e
    const total = (a.s ? -a.i : a.i) + (b.s ? -b.i : b.i)
    const sign: 0 | 1 = total < 0n ? 1 : 0
    const result = new Decimal(total === 0n ? 0 : sign, total < 0n ? -total : total, a.e)
    return result.fix()
  }
  neg(): Decimal { return new Decimal(this.sign ? 0 : 1, this.coeff, this.exp) }
  sub(other: Decimal): Decimal {
    // a - b == a + (-b) except the sign of an exact zero, which only matters for ROUND_FLOOR.
    return this.add(other.neg())
  }
  mul(other: Decimal): Decimal {
    const sign: 0 | 1 = this.sign === other.sign ? 0 : 1
    if (this.coeff === 0n || other.coeff === 0n) return new Decimal(sign, 0n, this.exp + other.exp).fix()
    return new Decimal(sign, this.coeff * other.coeff, this.exp + other.exp).fix()
  }
  div(other: Decimal): Decimal {
    const sign: 0 | 1 = this.sign === other.sign ? 0 : 1
    // CPython: 0/0 raises InvalidOperation (DivisionUndefined is a subclass of it), x/0 raises DivisionByZero.
    if (other.coeff === 0n) throw new DecimalError(this.coeff === 0n ? 'invalid' : 'division_by_zero')
    const idealExp = this.exp - other.exp
    if (this.coeff === 0n) return new Decimal(sign, 0n, Math.min(Math.max(idealExp, ETINY), EMAX))
    const shift = digitsOf(other.coeff) - digitsOf(this.coeff) + PREC + 1
    let exp = idealExp - shift
    let coeff: bigint, remainder: bigint
    if (shift >= 0) { const n = this.coeff * pow10(shift); coeff = n / other.coeff; remainder = n % other.coeff }
    else { const d = other.coeff * pow10(-shift); coeff = this.coeff / d; remainder = this.coeff % d }
    if (remainder !== 0n) { if (coeff % 5n === 0n) coeff += 1n }
    else while (exp < idealExp && coeff % TEN === 0n) { coeff /= TEN; exp += 1 }
    return new Decimal(sign, coeff, exp).fix()
  }
  /** `abs(x)` — rounds to context precision, like Python's `Decimal.__abs__`. */
  abs(): Decimal { return new Decimal(0, this.coeff, this.exp).fix() }

  /** Exact numeric comparison (ignores representation): -1, 0, 1. */
  cmp(other: Decimal): -1 | 0 | 1 {
    if (this.coeff === 0n && other.coeff === 0n) return 0
    if (this.coeff === 0n) return other.sign ? 1 : -1
    if (other.coeff === 0n) return this.sign ? -1 : 1
    if (this.sign !== other.sign) return this.sign ? -1 : 1
    const flip = this.sign ? -1 : 1
    const adjA = this.adjusted(), adjB = other.adjusted()
    if (adjA !== adjB) return (adjA > adjB ? flip : -flip) as -1 | 1
    const e = Math.min(this.exp, other.exp)
    const a = this.coeff * pow10(this.exp - e), b = other.coeff * pow10(other.exp - e)
    return a === b ? 0 : ((a > b ? flip : -flip) as -1 | 1)
  }
  lt(o: Decimal): boolean { return this.cmp(o) < 0 }
  le(o: Decimal): boolean { return this.cmp(o) <= 0 }
  gt(o: Decimal): boolean { return this.cmp(o) > 0 }
  ge(o: Decimal): boolean { return this.cmp(o) >= 0 }
  eq(o: Decimal): boolean { return this.cmp(o) === 0 }

  /** `_rescale(exp, ROUND_HALF_EVEN)` */
  private rescaleTo(exp: number): Decimal {
    if (this.coeff === 0n) return new Decimal(this.sign, 0n, exp)
    if (this.exp >= exp) return new Decimal(this.sign, this.coeff * pow10(this.exp - exp), exp)
    const digits = digitsOf(this.coeff) + this.exp - exp
    if (digits < 0) return new Decimal(this.sign, 0n, exp)
    return new Decimal(this.sign, roundHalfEvenDrop(this.coeff, digitsOf(this.coeff) - digits), exp)
  }
  /** `quantize(Decimal(10) ** exp)` under the default context. */
  quantize(exp: number): Decimal {
    if (this.coeff === 0n) return new Decimal(this.sign, 0n, exp).fix()
    if (this.adjusted() > EMAX) throw new DecimalError('invalid')
    if (this.adjusted() - exp + 1 > PREC) throw new DecimalError('invalid')
    const ans = this.rescaleTo(exp)
    if (ans.adjusted() > EMAX || digitsOf(ans.coeff) > PREC) throw new DecimalError('invalid')
    return ans
  }
}

/** Python's `max(a, b)`: returns `b` only if it is strictly greater (ties keep the first object). */
export const pyMax = (a: Decimal, b: Decimal): Decimal => (b.gt(a) ? b : a)
/** Python's `min(a, b)`: returns `b` only if it is strictly smaller. */
export const pyMin = (a: Decimal, b: Decimal): Decimal => (b.lt(a) ? b : a)
export const ZERO = Decimal.zero()
