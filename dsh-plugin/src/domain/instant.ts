/**
 * UTC instants with microsecond precision, matching Python's `datetime` + `timedelta`.
 *
 * The Python scheduler stores `due_at = reviewed_at + timedelta(days=<float>)`. JS `Date` only has
 * millisecond precision, so parity with the Django implementation needs its own representation.
 * An instant is a BigInt count of microseconds since the Unix epoch.
 */
export type Instant = bigint

const US_PER_DAY = 86_400_000_000

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/

/** Parse an ISO-8601 string. A missing zone is read as UTC (same rule as the Python scheduler). */
export function parseInstant(text: string): Instant {
  const m = ISO.exec(text)
  if (!m) throw new Error(`invalid instant: ${text}`)
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  const frac = BigInt((m[7] ?? '').padEnd(6, '0') || '0')
  let us = BigInt(ms) * 1000n + frac
  const zone = m[8]
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1n : 1n
    const offsetMin = BigInt(+zone.slice(1, 3) * 60 + +zone.slice(4, 6))
    us -= sign * offsetMin * 60_000_000n
  }
  return us
}

export function fromDate(date: Date): Instant {
  return BigInt(date.getTime()) * 1000n
}

/** Format like Python's `datetime.isoformat()` for UTC, rewritten with a `Z` suffix. */
export function formatInstant(instant: Instant): string {
  const secs = instant >= 0n ? instant / 1_000_000n : -((-instant + 999_999n) / 1_000_000n)
  const micro = Number(instant - secs * 1_000_000n)
  const base = new Date(Number(secs) * 1000).toISOString().slice(0, 19)
  return micro === 0 ? `${base}Z` : `${base}.${String(micro).padStart(6, '0')}Z`
}

/**
 * Format exactly like Python's `datetime.isoformat()` on an aware UTC datetime:
 * `+00:00` suffix, and no fractional part at all when microseconds are zero.
 */
export function formatPythonIso(instant: Instant): string {
  const micro = instant % 1_000_000n
  const secs = (instant - micro) / 1_000_000n
  const base = new Date(Number(secs) * 1000).toISOString().slice(0, 19)
  const frac = micro === 0n ? '' : `.${String(micro).padStart(6, '0')}`
  return `${base}${frac}+00:00`
}

/** `(a - b).total_seconds()` as Python computes it: integer microseconds / 10**6. */
export function secondsBetween(a: Instant, b: Instant): number {
  return Number(a - b) / 1_000_000
}

/** Round half to even, as CPython's `timedelta` does for the sub-microsecond remainder. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

/** Microseconds of `timedelta(days=<float>)`, reproducing CPython's accumulation order exactly. */
export function daysToMicroseconds(days: number): bigint {
  const intPart = Math.trunc(days)
  let fracPart = days - intPart
  let total = BigInt(intPart) * BigInt(US_PER_DAY)
  let leftover = 0
  if (fracPart !== 0) {
    const scaled = fracPart * US_PER_DAY
    const whole = Math.trunc(scaled)
    total += BigInt(whole)
    leftover += scaled - whole
  }
  total += BigInt(roundHalfEven(leftover))
  return total
}

export function addDays(instant: Instant, days: number): Instant {
  return instant + daysToMicroseconds(days)
}
