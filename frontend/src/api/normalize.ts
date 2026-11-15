// Coercion helpers shared by the domain modules.
//
// These three used to live inside `client.ts` next to the AI transcription
// normalizers, which made `questions.ts`, `exposure.ts` and `variants.ts` import
// from `ai-assist.ts` just to parse a JSON field. They are not AI-specific, so
// they live here and every domain imports them directly.

export function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => String(value)).filter((value) => value.length > 0)
}

export function asNumberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function decimalOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  return String(raw)
}
