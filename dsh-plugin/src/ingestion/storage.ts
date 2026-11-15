/**
 * Private object storage — port of `backend/apps/ingestion/storage.py`.
 *
 * Every object is addressed by a key the server generates: the user never contributes a path
 * segment, so a leaked key cannot be walked into a directory listing and the original filename
 * never reaches the filesystem (it stays in `Asset.original_filename[:255]` for display only).
 *
 * The write is `write to <key>.part` then `rename`, which is what makes a half-written file
 * impossible to observe under the final key: a process killed mid-upload leaves a `.part` orphan,
 * never a truncated object. The SHA-256 and the size are computed **over the bytes that were
 * written**, so `Asset.checksum` always describes the stored object rather than the upload.
 *
 * Layout decision (06 §5.1): the root is `<dataRoot>/private-media` — a new target layout. The
 * Django root (`ACEPASS_PRIVATE_MEDIA_ROOT`, default `<repo>/var/private-media`) is not reused, but
 * the `object_key` values carried over by the archive import keep working because only the root
 * differs.
 */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export class StorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageError'
  }
}

export interface StoredObject {
  key: string
  size: number
  checksum: string
}

/**
 * Python `str.isalnum()` is Unicode-aware (`"题".isalnum()` is `True`), so the namespace filter is
 * spelled with Unicode property escapes instead of `[A-Za-z0-9]`. In practice the namespace is
 * built from two UUIDs plus a literal word, so this only matters if a future caller passes a label.
 */
const ALNUM = /[\p{L}\p{N}]/u

/**
 * `build_key(namespace, suffix)`.
 *
 * `{namespace}/{token[:2]}/{token}.{suffix}` with a 16-byte token rendered as 32 lowercase hex
 * characters. The two-character directory level keeps any single directory from growing without
 * bound, which matters for a private store that holds every page of every paper.
 */
export function buildKey(namespace: string, suffix: string): string {
  const safeNamespace = [...namespace]
    .filter((character) => ALNUM.test(character) || character === '/' || character === '-' || character === '_')
    .join('')
    .replace(/^\/+|\/+$/g, '')
  const safeSuffix = [...suffix.toLowerCase()]
    .filter((character) => ALNUM.test(character))
    .join('')
    .slice(0, 12)
  const token = randomBytes(16).toString('hex')
  return `${safeNamespace}/${token.slice(0, 2)}/${token}${safeSuffix === '' ? '' : `.${safeSuffix}`}`
}

export class LocalPrivateStorage {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true })
  }

  /**
   * Resolve a key under the root, refusing anything that could leave it.
   *
   * Django's check is a bare `str(path).startswith(str(root))`, which would also accept a sibling
   * directory whose name shares the prefix (`/data/media` vs `/data/media-evil`). `..` is already
   * refused above, so this is defence in depth rather than a live exploit — it is registered as an
   * intentional (stricter) difference in `04-parity-findings.md §K`.
   */
  private resolveKey(key: string): string {
    if (key === '' || key.startsWith('/')) throw new StorageError('invalid object key')
    if (key.split(/[/\\]/).includes('..')) throw new StorageError('invalid object key')
    const path = resolve(this.root, key)
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new StorageError('object key escapes storage root')
    }
    return path
  }

  /** `save()`: stream the bytes to `<key>.part`, hashing as we go, then rename into place. */
  save(keyHint: string, content: Uint8Array): StoredObject {
    const path = this.resolveKey(keyHint)
    mkdirSync(dirname(path), { recursive: true })
    const tmpPath = `${path}.part`
    const digest = createHash('sha256')
    const handle = openSync(tmpPath, 'w')
    try {
      writeSync(handle, content)
      digest.update(content)
    } finally {
      closeSync(handle)
    }
    renameSync(tmpPath, path)
    return { key: keyHint, size: content.byteLength, checksum: digest.digest('hex') }
  }

  open(key: string): Buffer {
    const path = this.resolveKey(key)
    if (!existsSync(path) || !statSync(path).isFile()) throw new StorageError(key)
    return readFileSync(path)
  }

  exists(key: string): boolean {
    try {
      const path = this.resolveKey(key)
      return existsSync(path) && statSync(path).isFile()
    } catch {
      return false
    }
  }

  size(key: string): number {
    const path = this.resolveKey(key)
    if (!existsSync(path) || !statSync(path).isFile()) throw new StorageError(key)
    return statSync(path).size
  }

  delete(key: string): void {
    const path = this.resolveKey(key)
    if (existsSync(path) && statSync(path).isFile()) rmSync(path)
  }

  absolutePath(key: string): string | null {
    const path = this.resolveKey(key)
    return existsSync(path) && statSync(path).isFile() ? path : null
  }
}

/** `<dataRoot>/private-media` — the target layout from 06 §5.1. */
export function mediaRootFor(dataRoot: string): string {
  return join(dataRoot, 'private-media')
}

let cached: LocalPrivateStorage | null = null

/**
 * The process-wide storage handle.
 *
 * `ACEPASS_PRIVATE_MEDIA_ROOT` wins, then an explicit `configureStorage()` (tests, and the plugin
 * entry point once it knows the workspace), then `<cwd>/.acepass/private-media`.
 */
export function getStorage(): LocalPrivateStorage {
  if (cached !== null) return cached
  const root = process.env.ACEPASS_PRIVATE_MEDIA_ROOT ?? join(process.cwd(), '.acepass', 'private-media')
  cached = new LocalPrivateStorage(root)
  return cached
}

export function configureStorage(root: string): LocalPrivateStorage {
  cached = new LocalPrivateStorage(root)
  return cached
}

export function resetStorageCache(): void {
  cached = null
}
