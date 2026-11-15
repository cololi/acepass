/**
 * Image validation and metadata stripping (O01/O05/O08) — property tests.
 *
 * Pillow and sharp do not produce byte-identical re-encodes, and the spec forbids pretending they
 * do (06 §5.1): JPEG/WebP encoders, compression defaults and palette handling all differ. So this
 * file asserts the properties the contract actually promises, and the *decisions* are pinned
 * separately against the Django golden vectors (`ingestion_b3.json`):
 *
 *   - the five validation refusals, with the exact message and `details`;
 *   - the stored object is decodable, keeps its dimensions and format, and has **no metadata**;
 *   - the pixels survive the re-encode (exactly for PNG/WebP-lossless, within a threshold for JPEG);
 *   - EXIF orientation is **not** applied: a rotated tag is dropped, the pixels stay put;
 *   - a re-encode failure keeps the original bytes rather than losing the upload.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PIXELS,
  sniffImageFormat,
  stripMetadata,
  validateImage,
} from '../src/ingestion/images.ts'
import { loadSharp } from '../src/ingestion/sharp.ts'

// The test builds fixtures with sharp's `create` input and reads metadata blocks, which the narrow
// production interface does not expose; the cast keeps that convenience out of `src/`.
const sharp = loadSharp() as unknown as (input: unknown, options?: Record<string, unknown>) => any

/** A small opaque RGB image, encoded as the requested format. */
async function imageBytes(format: 'png' | 'jpeg' | 'webp', width = 24, height = 16): Promise<Uint8Array> {
  const pipeline = sharp({ create: { width, height, channels: 3, background: { r: 32, g: 96, b: 160 } } })
  const encoded = format === 'jpeg' ? await pipeline.jpeg().toBuffer() : format === 'png' ? await pipeline.png().toBuffer() : await pipeline.webp().toBuffer()
  return new Uint8Array(encoded)
}

/** Decoded RGBA pixels, for equality/error comparisons. */
async function pixels(bytes: Uint8Array): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(Buffer.from(bytes), { limitInputPixels: false })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), width: info.width, height: info.height }
}

test('sniffImageFormat reads the container from magic bytes', () => {
  assert.equal(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpeg')
  assert.equal(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png')
  assert.equal(sniffImageFormat(new Uint8Array([...Buffer.from('GIF89a')])), 'gif')
  assert.equal(sniffImageFormat(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')])), 'webp')
  assert.equal(sniffImageFormat(new Uint8Array([...Buffer.from('BM'), 0, 0])), 'bmp')
  assert.equal(sniffImageFormat(new Uint8Array([0x49, 0x49, 0x2a, 0x00])), 'tiff')
  assert.equal(sniffImageFormat(new Uint8Array([...Buffer.from('hello world')])), null)
})

test('validateImage accepts the three allowed formats and reports real dimensions', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const contentType = `image/${format}`
    const facts = await validateImage({ bytes: await imageBytes(format, 24, 16), contentType })
    assert.deepEqual(facts, { width: 24, height: 16, detected: format })
  }
})

test('validateImage refuses a declared type outside the allowlist', async () => {
  const png = await imageBytes('png')
  await assert.rejects(
    () => validateImage({ bytes: png, contentType: 'image/gif' }),
    (error: any) => {
      assert.equal(error.code, 'invalid_input')
      assert.equal(error.message, '仅支持 JPEG/PNG/WebP 图片')
      assert.deepEqual(error.details, { content_type: 'image/gif' })
      return true
    },
  )
})

test('validateImage refuses a real GIF declared as PNG with the detected format', async () => {
  // A one-pixel GIF87a is enough: Pillow identifies the container before it looks at the pixels.
  const gif = new Uint8Array([
    ...Buffer.from('GIF87a'), 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
  ])
  await assert.rejects(
    () => validateImage({ bytes: gif, contentType: 'image/png' }),
    (error: any) => {
      assert.equal(error.code, 'invalid_input')
      assert.equal(error.message, '图片格式与声明不一致')
      assert.deepEqual(error.details, { detected: 'gif' })
      return true
    },
  )
})

test('validateImage refuses bytes that are not an image at all', async () => {
  await assert.rejects(
    () => validateImage({ bytes: new Uint8Array(Buffer.from('not an image')), contentType: 'image/png' }),
    (error: any) => {
      assert.equal(error.message, '图片内容无法解析，文件可能损坏或不是真实图片')
      assert.deepEqual(error.details, {})
      return true
    },
  )
})

test('validateImage refuses a truncated JPEG (intact header, missing pixel data)', async () => {
  const whole = await imageBytes('jpeg', 64, 48)
  const truncated = whole.subarray(0, Math.floor(whole.byteLength * 0.55))
  await assert.rejects(
    () => validateImage({ bytes: truncated, contentType: 'image/jpeg' }),
    (error: any) => {
      assert.equal(error.message, '图片内容无法解析，文件可能损坏或不是真实图片')
      return true
    },
  )
})

test('validateImage refuses an upload above the byte limit before decoding it', async () => {
  const oversized = new Uint8Array(IMAGE_MAX_BYTES + 1)
  oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await assert.rejects(
    () => validateImage({ bytes: oversized, contentType: 'image/png' }),
    (error: any) => {
      assert.equal(error.message, '图片超过大小上限 10 MiB')
      return true
    },
  )
})

test('validateImage refuses more pixels than the limit', async () => {
  // 6000 × 5000 = 30 M pixels: over the 25 M limit while the encoded PNG stays small.
  const big = new Uint8Array(
    await sharp({ create: { width: 6000, height: 5000, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .png()
      .toBuffer(),
  )
  assert.ok(big.byteLength < IMAGE_MAX_BYTES, 'fixture must trip the pixel limit, not the byte limit')
  assert.ok(6000 * 5000 > IMAGE_MAX_PIXELS)
  await assert.rejects(
    () => validateImage({ bytes: big, contentType: 'image/png' }),
    (error: any) => {
      assert.equal(error.message, '图片像素超过上限，请先裁剪或压缩')
      return true
    },
  )
})

test('stripMetadata keeps format and dimensions and drops every metadata block', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const source = await imageBytes(format, 24, 16)
    const stored = await stripMetadata(source)
    assert.equal(stored.reencoded, true, `${format} must re-encode`)
    assert.equal(stored.format, format)
    const metadata = await sharp(Buffer.from(stored.bytes)).metadata()
    assert.equal(metadata.format, format === 'jpeg' ? 'jpeg' : format)
    assert.equal(metadata.width, 24)
    assert.equal(metadata.height, 16)
    assert.equal(metadata.exif, undefined, `${format} must not keep EXIF`)
    assert.equal(metadata.icc, undefined, `${format} must not keep an ICC profile`)
  }
})

test('stripMetadata preserves PNG pixels exactly', async () => {
  const source = await imageBytes('png', 40, 30)
  const stored = await stripMetadata(source)
  assert.deepEqual(await pixels(stored.bytes), await pixels(source))
})

test('stripMetadata keeps a WebP visually intact (the container is lossy, like Pillow)', async () => {
  // Pillow's default WebP save is lossy too, so byte/pixel equality is not a promise here — the
  // contract is "same size, same picture". The threshold is deliberately tight for a flat colour.
  const source = await imageBytes('webp', 40, 30)
  const stored = await stripMetadata(source)
  const before = await pixels(source)
  const after = await pixels(stored.bytes)
  assert.equal(after.width, before.width)
  assert.equal(after.height, before.height)
  let total = 0
  let worst = 0
  for (let index = 0; index < before.data.length; index += 1) {
    const delta = Math.abs(before.data[index] - after.data[index])
    total += delta
    worst = Math.max(worst, delta)
  }
  const mean = total / before.data.length
  assert.ok(mean <= 2, `mean absolute error ${mean} must stay small`)
  assert.ok(worst <= 24, `worst channel error ${worst} must stay small`)
})

test('stripMetadata does not rotate an EXIF-oriented JPEG (the tag is dropped, pixels stay)', async () => {
  const oriented = new Uint8Array(
    await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer(),
  )
  const sourceMetadata = await sharp(Buffer.from(oriented)).metadata()
  assert.equal(sourceMetadata.orientation, 6, 'fixture must carry an orientation tag')
  const stored = await stripMetadata(oriented)
  const metadata = await sharp(Buffer.from(stored.bytes)).metadata()
  assert.equal(metadata.orientation, undefined)
  assert.equal(metadata.width, 60)
  assert.equal(metadata.height, 40)
  assert.equal(metadata.format, 'jpeg')
})

test('stripMetadata keeps a re-encode failure from losing the upload', async () => {
  // A PNG signature with nothing behind it: identified as PNG, refused by the decoder. Django's
  // `except Exception: return content` keeps the original bytes, and so must this port.
  const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const stored = await stripMetadata(broken)
  assert.equal(stored.reencoded, false)
  assert.deepEqual([...stored.bytes], [...broken])
})

test('a missing image codec would be reported as an unavailable dependency, not a corrupt upload', async () => {
  // The wiring is in `images.ts`: `requireSharp()` runs *outside* the decode `try`, so a module that
  // cannot be loaded becomes a 503 `dependency_unavailable` instead of "your file is corrupt".
  // sharp is installed in this workspace, so the end-to-end 503 is not exercised here — what is
  // asserted is the contract the wiring depends on, plus the fact that the codec still loads after a
  // cache reset (i.e. the code path under test is the real one).
  const { DependencyUnavailable } = await import('../src/services/errors.ts')
  const { resetSharpCache } = await import('../src/ingestion/sharp.ts')
  const error = new DependencyUnavailable('图片处理依赖不可用（sharp 未能加载），无法校验或转存图片')
  assert.equal(error.code, 'dependency_unavailable')
  assert.equal(error.statusCode, 503)
  assert.notEqual(error.message, '图片内容无法解析，文件可能损坏或不是真实图片')

  resetSharpCache()
  const png = await imageBytes('png', 8, 8)
  const facts = await validateImage({ bytes: png, contentType: 'image/png' })
  assert.deepEqual(facts, { width: 8, height: 8, detected: 'png' })
})
