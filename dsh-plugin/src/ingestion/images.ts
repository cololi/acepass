/**
 * Image validation and metadata stripping — port of `validate_image` / `strip_metadata`
 * (`backend/apps/ingestion/services/core.py:32`).
 *
 * The port keeps the **order of checks** because the messages are part of the API: a GIF uploaded as
 * `image/png` is "格式与声明不一致" (it *is* an image, just the wrong kind), while random bytes are
 * "内容无法解析". Both are 400, but a client that shows the message to a learner needs the right one.
 *
 * Format identification is done on the magic bytes rather than by asking the decoder, mirroring what
 * Pillow's `Image.open` does before it reads any pixels. That matters for the formats libvips cannot
 * decode at all (BMP here): Pillow identifies the file, so Django reports "格式与声明不一致" with
 * `detected: "bmp"`, and a decoder-first port would wrongly report "无法解析".
 *
 * Two limits come from settings and are the same numbers:
 * - `IMAGE_MAX_BYTES` (10 MiB) is checked on the **uploaded** bytes, before decoding;
 * - `IMAGE_MAX_PIXELS` (25 000 000) is checked after the format is known.
 *
 * Known, narrow difference (04 §K): Pillow's `verify()` runs *before* the pixel limit, so a file that
 * is both corrupt and larger than 25 M pixels is "无法解析" in Django and "像素超过上限" here. The
 * alternative — decoding 30 M pixels just to reject them — costs 120 MB per request, so the limit is
 * checked first on purpose.
 */
import { DependencyUnavailable, InvalidInput } from '../services/errors.ts'
import { loadSharp, type SharpFactory } from './sharp.ts'

/** `settings.ALLOWED_IMAGE_MIME_TYPES`. */
export const ALLOWED_IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']
/** `settings.IMAGE_MAX_BYTES`. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** `settings.IMAGE_MAX_PIXELS`. */
export const IMAGE_MAX_PIXELS = 25_000_000

const ALLOWED_FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp'])

const MESSAGE_UNREADABLE = '图片内容无法解析，文件可能损坏或不是真实图片'
const MESSAGE_PIXELS = '图片像素超过上限，请先裁剪或压缩'

export interface ImageFacts {
  width: number
  height: number
  /** The detected container format, as Pillow reports it lower-cased (`jpeg`/`png`/`webp`/…). */
  detected: string
}

export interface StoredImage {
  bytes: Uint8Array
  /** `false` means the re-encode failed and the original bytes were kept (Django's fallback). */
  reencoded: boolean
  format: string
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.length) return false
  return prefix.every((value, index) => bytes[offset + index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let index = 0; index < length; index += 1) {
    const value = bytes[offset + index]
    if (value === undefined) return out
    out += String.fromCharCode(value)
  }
  return out
}

/**
 * Identify the container from its magic bytes.
 *
 * Returns `null` when no known signature matches — which is exactly the `UnidentifiedImageError`
 * branch in Pillow. The names are the lower-cased Pillow format names, because they are echoed in
 * the error `details.detected`.
 */
export function sniffImageFormat(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (ascii(bytes, 0, 4) === 'GIF8') return 'gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp'
  if (ascii(bytes, 0, 2) === 'BM') return 'bmp'
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff'
  return null
}

/**
 * Resolve the codec, or say so plainly.
 *
 * This runs *outside* the decode `try` blocks on purpose: a missing module must not be reported as
 * a corrupt upload (see `DependencyUnavailable`).
 */
function requireSharp(): SharpFactory {
  try {
    return loadSharp()
  } catch (error) {
    throw new DependencyUnavailable('图片处理依赖不可用（sharp 未能加载），无法校验或转存图片', {
      details: { cause: String((error as Error).message) },
    })
  }
}

function pipelineFor(bytes: Uint8Array) {
  return requireSharp()(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { limitInputPixels: false })
}

/**
 * `validate_image`: real decoding, not a MIME sniff.
 *
 * Returns the dimensions and the detected format. Every failure is `InvalidInput` (400) with the
 * Python message; `details` is only present where Django sets it.
 */
export async function validateImage(options: { bytes: Uint8Array; contentType: string }): Promise<ImageFacts> {
  const { bytes, contentType } = options
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(contentType)) {
    throw new InvalidInput('仅支持 JPEG/PNG/WebP 图片', { details: { content_type: contentType } })
  }
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new InvalidInput(`图片超过大小上限 ${Math.floor(IMAGE_MAX_BYTES / (1024 * 1024))} MiB`)
  }
  const detected = sniffImageFormat(bytes)
  if (detected === null) throw new InvalidInput(MESSAGE_UNREADABLE)
  if (!ALLOWED_FORMATS.has(detected)) {
    throw new InvalidInput('图片格式与声明不一致', { details: { detected } })
  }

  requireSharp()
  let width = 0
  let height = 0
  try {
    const metadata = await pipelineFor(bytes).metadata()
    width = Number(metadata.width ?? 0)
    height = Number(metadata.height ?? 0)
  } catch {
    throw new InvalidInput(MESSAGE_UNREADABLE)
  }
  if (width <= 0 || height <= 0) throw new InvalidInput(MESSAGE_UNREADABLE)
  if (width * height > IMAGE_MAX_PIXELS) throw new InvalidInput(MESSAGE_PIXELS)

  // A header can be intact while the pixel data is truncated (a download cut off at 90%). Only a
  // full decode proves the file is usable, which is what Pillow's `verify()` + reopen establishes.
  try {
    await pipelineFor(bytes).raw().toBuffer()
  } catch {
    throw new InvalidInput(MESSAGE_UNREADABLE)
  }
  return { width, height, detected }
}

/**
 * `strip_metadata`: re-encode the pixels into a fresh image so EXIF/GPS/ICC/XMP cannot travel with
 * the stored object.
 *
 * Semantics preserved from Pillow:
 * - dimensions and colour mode are kept (`Image.new(mode, size)` + `putdata`), except that a JPEG
 *   whose mode is neither `RGB` nor `L` (CMYK/YCbCr) is converted to `RGB`;
 * - the container format is kept (`JPEG`/`PNG`/`WEBP`);
 * - **no EXIF rotation is applied**: the pixels stay in the orientation they were stored in, and the
 *   orientation tag is dropped with the rest of the metadata;
 * - a re-encode failure keeps the original bytes. Django documents "record it" in a comment but
 *   writes nothing, so neither does this port — the `reencoded: false` return value is the only
 *   signal, and it is asserted in the image property tests rather than written to the database.
 */
export async function stripMetadata(bytes: Uint8Array): Promise<StoredImage> {
  const format = sniffImageFormat(bytes) ?? 'png'
  requireSharp()
  try {
    // No `withMetadata()` call: sharp strips EXIF/XMP/IPTC/ICC by default, and `withMetadata()`
    // would *keep* them. The absence of the call is the behaviour, so it is spelled out here.
    let pipeline = pipelineFor(bytes)
    if (format === 'jpeg') {
      const metadata = await pipelineFor(bytes).metadata()
      if ((metadata.space ?? '') === 'cmyk') pipeline = pipeline.toColourspace('srgb')
      const output = await pipeline.jpeg().toBuffer()
      return { bytes: new Uint8Array(output), reencoded: true, format }
    }
    if (format === 'webp') {
      const output = await pipeline.webp().toBuffer()
      return { bytes: new Uint8Array(output), reencoded: true, format }
    }
    const output = await pipeline.png().toBuffer()
    return { bytes: new Uint8Array(output), reencoded: true, format }
  } catch {
    return { bytes, reencoded: false, format }
  }
}
