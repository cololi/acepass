/**
 * `Idempotency-Key` handling, shared by every side-effecting route.
 *
 * Port of `backend/apps/common/api.py::idempotency_key`: the header is trimmed with Python's
 * `str.strip()` semantics, a missing/empty key is a **409 `idempotency_conflict`** (not a 400), and
 * a key longer than 200 code points is the same 409. The trimmed key is what the request journal
 * stores, so `" key "` and `"key"` are the same idempotency key — exactly as in Django.
 *
 * The ingestion and B8 route modules implemented this rule inline before the helper existed; new
 * routes should call this instead of re-deriving the status code.
 */
import { pyCodePointLen, pyStrip } from '../domain/ingestion/pystring.ts'
import { IdempotencyConflictError } from '../services/errors.ts'

export function normaliseIdempotencyKey(raw: string | null | undefined): string {
  const key = pyStrip(raw ?? '')
  if (key === '') throw new IdempotencyConflictError('缺少 Idempotency-Key 请求头')
  if (pyCodePointLen(key) > 200) throw new IdempotencyConflictError('Idempotency-Key 过长')
  return key
}

export function requireIdempotencyKey(headers: Headers): string {
  return normaliseIdempotencyKey(headers.get('idempotency-key'))
}
