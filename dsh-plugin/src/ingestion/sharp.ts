/**
 * `sharp` is the image codec for the port (`C9`: Pillow → sharp).
 *
 * It is loaded through `createRequire` rather than a static `import` for two reasons:
 *
 * 1. it is a **native** module, so esbuild must not try to bundle it (`scripts/build.mjs` marks it
 *    external) and the bundle must resolve it at run time from the plugin's own install tree;
 * 2. this repository keeps `dsh-plugin/node_modules` as a symlink to `frontend/node_modules`, so the
 *    development install lives in `dsh-plugin/.deps` instead. A packaged plugin resolves the bare
 *    specifier; a checkout resolves the vendored copy. Both runtimes (system Node and the DSH
 *    Electron Node) load the same prebuilt N-API binary — verified in `npm run verify`.
 *
 * When neither resolves, image features fail with an explicit `dependency_unavailable` instead of a
 * silent fallback: a hand-rolled decoder would be an approximation, and pretending the file was
 * validated is worse than saying the capability is missing.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Minimal surface of the sharp factory that this port uses. */
export interface SharpMetadata {
  format?: string
  width?: number
  height?: number
  channels?: number
  hasAlpha?: boolean
  space?: string
  orientation?: number
  /** Present when the input carried an EXIF block; used by the property tests to prove it is gone. */
  exif?: Uint8Array
  /** Present when the input carried an ICC profile. */
  icc?: Uint8Array
}

/**
 * Only the operations the port actually calls. `withMetadata()` (which *keeps* metadata) and
 * `rotate()` (which would apply EXIF orientation) are deliberately absent: neither behaviour is
 * wanted, and an unused method on the interface invites someone to call it.
 */
export interface SharpPipeline {
  metadata(): Promise<SharpMetadata>
  toColourspace(colourspace: string): SharpPipeline
  ensureAlpha(): SharpPipeline
  jpeg(options?: Record<string, unknown>): SharpPipeline
  png(options?: Record<string, unknown>): SharpPipeline
  webp(options?: Record<string, unknown>): SharpPipeline
  raw(options?: Record<string, unknown>): SharpPipeline
  toBuffer(options?: Record<string, unknown>): Promise<Buffer & { info?: { width: number; height: number; channels: number } }>
}

export type SharpFactory = (input: Buffer, options?: Record<string, unknown>) => SharpPipeline

let cached: SharpFactory | null = null

/** Walk up from this module to the package root (works from `src/ingestion/` and from `lib/`). */
function pluginRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, 'package.json'))) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return process.cwd()
}

export function loadSharp(): SharpFactory {
  if (cached !== null) return cached
  const require = createRequire(import.meta.url)
  const candidates = ['sharp', join(pluginRoot(), '.deps', 'node_modules', 'sharp')]
  const failures: string[] = []
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate) as { default?: unknown } | unknown
      const factory =
        typeof loaded === 'function'
          ? loaded
          : (loaded as { default?: unknown })?.default
      if (typeof factory === 'function') {
        cached = factory as SharpFactory
        return cached
      }
      failures.push(`${candidate}: not a function`)
    } catch (error) {
      failures.push(`${candidate}: ${(error as Error).message}`)
    }
  }
  throw new Error(`sharp is not resolvable (${failures.join('; ')})`)
}

/** Test hook: forget the resolved module (used by the dependency-missing test). */
export function resetSharpCache(): void {
  cached = null
}
