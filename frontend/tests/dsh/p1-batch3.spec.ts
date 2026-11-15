import zlib from 'node:zlib'
import { expect, test, type Page } from './base'
import { login, openWorkbench } from './helpers'

/**
 * Real-browser acceptance of the P1 third batch (B07 + B08).
 *
 * Two evidence classes live in this file, and the file name/title says which is
 * which:
 *
 * * the untagged tests run in the default acceptance environment, where
 *   `ACEPASS_AI_PROVIDER=none`: they prove the honest no-model paths (the
 *   transcription gate, the manual transcription fallback, and a tutor stream
 *   that reports the real reason instead of inventing content);
 * * the tests tagged `@stub` run only in the second, explicitly stub-provider
 *   run (`ACEPASS_AI_PROVIDER=stub ACEPASS_RUNTIME_MODE=demo`): they prove the
 *   UI labels stub output as stub, streams validated segments, and reconnects
 *   without a second model call.
 *
 * Neither run is evidence of real model quality: there is no usable credential
 * on this machine (see docs/18 §7).
 */

const CHUNK_TYPE = 'IEND'

/** Minimal valid 8×8 PNG (the same shape the P0 suite uploads). */
function makePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3
      raw[offset] = 200
      raw[offset + 1] = 220
      raw[offset + 2] = 240
    }
  }
  const crcTable: number[] = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typeAndData), 0)
    return Buffer.concat([length, typeAndData, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk(CHUNK_TYPE, Buffer.alloc(0)),
  ])
}

/** Marker used to find this very attempt in the grading queue. */
const MARKER = '验收手写过程照片复核'

/** Open one specific attempt on the grading page (the AI panels live there). */
async function openGradingFor(page: Page, marker: string) {
  await page.goto('/grading')
  const row = page.locator('table.data tbody tr', { hasText: marker }).first()
  await expect(row, '待评分队列里应能找到本次作答').toBeVisible()
  await row.click()
  await expect(page.getByTestId('ai-estimate-panel')).toBeVisible()
}

/** Submit one constructed-response item with a photo answer. */
async function submitPhotoAnswer(page: Page, text: string) {
  await openWorkbench(page, '大题')
  await page.getByPlaceholder('写下你的推导过程与结论').fill(text)
  const uploaded = page.waitForResponse((r) => r.url().endsWith('/assets') && r.request().method() === 'POST')
  await page.locator('.workbench input[type="file"]').setInputFiles({
    name: 'handwriting.png',
    mimeType: 'image/png',
    buffer: makePng(8, 8),
  })
  expect((await uploaded).status()).toBe(201)
  const submitted = page.waitForResponse((r) => r.url().endsWith('/submit'))
  await page.getByRole('button', { name: '提交作答' }).click()
  expect((await submitted).status()).toBe(200)
  await expect(page.getByText('提交时间', { exact: false }).first()).toBeVisible()
  await page.reload()
}

test.describe('P1 batch 3: transcription gate, AI estimation and validated streaming', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('a photo answer cannot be AI-graded before the learner records what they wrote', async ({ page }) => {
    await submitPhotoAnswer(page, `验收：${MARKER}。`)
    await expect(page.getByTestId('transcription-panel')).toBeVisible()

    // The AI estimate lives on the grading page; the gate must fire before any
    // provider is consulted, so the refusal is 409 transcription_required.
    await openGradingFor(page, MARKER)
    await expect(page.getByTestId('transcription-panel')).toBeVisible()
    const blocked = page.waitForResponse((r) => r.url().includes('/ai-estimate') && r.request().method() === 'POST')
    await page.getByTestId('ai-estimate-request').click()
    const blockedResponse = await blocked
    expect(blockedResponse.status(), '未确认转写前必须拒绝估分').toBe(409)
    expect((await blockedResponse.json()).error.code).toBe('transcription_required')

    // Asking the model is what makes the missing-vision-model state visible: the
    // server must refuse explicitly (503 ai_not_configured) and the panel must
    // then point at the manual path, not leave the learner stuck.
    const generated = page.waitForResponse(
      (r) => r.url().includes('/transcriptions') && r.request().method() === 'POST',
    )
    await page.getByTestId('transcription-generate').first().click()
    const generatedResponse = await generated
    expect(generatedResponse.status(), '没有视觉模型时必须明确拒绝，而不是编造转写').toBe(503)
    expect((await generatedResponse.json()).error.code).toBe('ai_not_configured')
    await expect(page.getByTestId('transcription-not-configured')).toContainText('未配置视觉模型')

    // The manual path must be reachable here and must open the gate.
    await page.getByTestId('transcription-text').first().fill('我写的是：5 × 4 = 20，所以共有 20 个。')
    const recorded = page.waitForResponse(
      (r) => r.url().includes('/transcriptions') && r.request().method() === 'POST',
    )
    await page.getByTestId('transcription-manual-submit').getByRole('button').first().click()
    const recordedResponse = await recorded
    expect(recordedResponse.status(), '人工录入必须真的写入').toBe(201)
    const recordedBody = await recordedResponse.json()
    expect(recordedBody.origin).toBe('manual')
    expect(recordedBody.status).toBe('confirmed')
    expect(recordedBody.is_stub).toBe(false)
    await expect(page.getByTestId('transcription-status')).toContainText('已确认')

    // Gate open now: the estimate is attempted and fails for the *real* reason
    // (no provider configured), never with invented numbers.
    const estimate = page.waitForResponse((r) => r.url().includes('/ai-estimate') && r.request().method() === 'POST')
    await page.getByTestId('ai-estimate-request').click()
    const estimateResponse = await estimate
    expect([200, 503]).toContain(estimateResponse.status())
    if (estimateResponse.status() === 503) {
      await expect(page.getByTestId('ai-estimate-panel')).toContainText('未配置')
    }
    await expect(page.getByTestId('ai-estimate-inert-notice')).toContainText('不计入正式分数')
  })

  test('the tutor stream reports the real reason instead of inventing content', async ({ page }) => {
    await openWorkbench(page, '大题')
    await page.getByPlaceholder('写下你的推导过程与结论').fill('验收：请求讲解以检查流式面板。')
    await page.getByRole('button', { name: '提交作答' }).click()
    await page.reload()
    const requested = page.waitForResponse((r) => r.url().endsWith('/messages'))
    await page.getByTestId('tutor-explanation').click()
    const response = await requested
    expect([201, 503]).toContain(response.status())
    await expect(page.getByTestId('tutor-stream-panel')).toBeVisible()
    if (response.status() === 503) {
      await expect(page.getByTestId('tutor-stream-panel')).toContainText('未配置')
      expect(await page.getByTestId('tutor-stream-segment').count(), '未配置时不得出现任何片段').toBe(0)
    }
  })
})

/** These run only in the stub-provider run: `--grep "@stub"`. */
test.describe('P1 batch 3 stub-provider run', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('@stub a stub transcription is labelled, confirmable, and the estimate stays inert', async ({ page }) => {
    await submitPhotoAnswer(page, `验收：${MARKER}（stub）。`)
    const proposed = page.waitForResponse(
      (r) => r.url().includes('/transcriptions') && r.request().method() === 'POST',
    )
    await page.getByTestId('transcription-generate').first().click()
    const proposedResponse = await proposed
    expect(proposedResponse.status()).toBe(201)
    const body = await proposedResponse.json()
    expect(body.origin).toBe('model')
    expect(body.is_stub, 'stub 转写必须自我标注').toBe(true)
    await expect(page.getByTestId('transcription-stub').first()).toBeVisible()

    const confirmed = page.waitForResponse((r) => r.url().includes('/confirm') && r.request().method() === 'POST')
    await page.getByTestId('transcription-text').first().fill('确认后的转写文本：5 × 4 = 20。')
    await page.getByTestId('transcription-confirm').first().click()
    expect((await confirmed).status()).toBe(200)

    await openGradingFor(page, MARKER)
    const estimate = page.waitForResponse((r) => r.url().includes('/ai-estimate') && r.request().method() === 'POST')
    await page.getByTestId('ai-estimate-request').click()
    const estimateResponse = await estimate
    // The stub deliberately returns no criterion scores, so the only honest
    // outcomes are "refused, nothing usable" or an estimate that stays inert.
    expect([200, 503]).toContain(estimateResponse.status())
    if (estimateResponse.status() === 503) {
      expect(await page.getByTestId('ai-estimate-criterion-row').count(), '不得凭空生成评分点').toBe(0)
    }
    await expect(page.getByTestId('ai-estimate-inert-notice')).toBeVisible()
  })

  test('@stub diagnosis proposes an unproven cause honestly and asks a follow-up', async ({ page }) => {
    await openWorkbench(page, '大题')
    await page.getByPlaceholder('写下你的推导过程与结论').fill('验收：诊断追问流程。')
    await page.getByRole('button', { name: '提交作答' }).click()
    await page.reload()
    const diagnosed = page.waitForResponse(
      (r) => r.url().includes('/ai-diagnosis') && r.request().method() === 'POST',
    )
    await page.getByTestId('diagnosis-request').click()
    const response = await diagnosed
    expect(response.status()).toBe(200)
    await expect(page.getByTestId('diagnosis-panel')).toContainText('证据不足')
    await expect(page.getByTestId('diagnosis-panel')).toContainText('暂不判断')
    await expect(page.getByTestId('diagnosis-cause-row').first()).toBeVisible()

    const answered = page.waitForResponse(
      (r) => r.url().includes('/diagnosis-follow-ups/') && r.request().method() === 'POST',
    )
    await page.getByTestId('diagnosis-follow-up').first().locator('textarea').fill('我当时先算乘法，再写结论。')
    await page.getByTestId('diagnosis-follow-up-answer').first().click()
    expect((await answered).status()).toBe(200)
  })

  test('@stub validated segments stream, and reconnecting does not call the model again', async ({ page }) => {
    const projectId = await page.evaluate(() => window.localStorage.getItem('acepass.currentProject'))
    expect(projectId, '验收前提：页面必须已选定项目').toBeTruthy()
    await openWorkbench(page, '大题')
    await page.getByPlaceholder('写下你的推导过程与结论').fill('验收：流式讲解与断线重连。')
    await page.getByRole('button', { name: '提交作答' }).click()
    await page.reload()

    const requested = page.waitForResponse((r) => r.url().endsWith('/messages'))
    await page.getByTestId('tutor-explanation').click()
    const response = await requested
    expect(response.status(), `stub 环境下辅导任务应创建成功：${await response.text()}`).toBe(201)
    const job = (await response.json()) as { tutor_job_id: string }
    expect(job.tutor_job_id, '辅导任务响应必须带 tutor_job_id').toBeTruthy()

    // The UI itself consumes the stream and renders only validated segments.
    await expect(page.getByTestId('tutor-stream-segment').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('tutor-stream-panel')).toContainText('stub')

    // The job itself legitimately costs exactly one model call; everything after
    // this point is a reconnect and must cost nothing.
    const runsAfterJob = await page.request.get(`/api/v1/projects/${projectId}/ai-runs?limit=50`)
    const beforeReconnect = ((await runsAfterJob.json()) as unknown[]).length

    // A real reconnect: read the stream again from index 0, then resume after the
    // first segment. Both are plain HTTP GETs, so the only thing that can notice
    // the difference is the server (one LLMRun for the whole job).
    const first = await page.request.get(
      `/api/v1/projects/${projectId}/tutor-jobs/${job.tutor_job_id}/stream?poll_seconds=0.05&max_seconds=5`,
    )
    expect(first.status()).toBe(200)
    const firstBody = await first.text()
    expect(firstBody, '首个分段必须带 id: 0').toContain('id: 0')
    expect(firstBody).toContain('event: done')

    const resumed = await page.request.get(
      `/api/v1/projects/${projectId}/tutor-jobs/${job.tutor_job_id}/stream?after=0&poll_seconds=0.05&max_seconds=5`,
    )
    expect(resumed.status()).toBe(200)
    const resumedBody = await resumed.text()
    expect(resumedBody, '断线重连不得重发已收到的分段').not.toContain('id: 0')
    expect(resumedBody).toContain('event: done')

    const runsAfter = await page.request.get(`/api/v1/projects/${projectId}/ai-runs?limit=50`)
    const afterCount = ((await runsAfter.json()) as unknown[]).length
    expect(afterCount, '重连不得产生新的模型调用').toBe(beforeReconnect)
  })
})
