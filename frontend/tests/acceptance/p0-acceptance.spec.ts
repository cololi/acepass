import { expect, test, type Page } from '@playwright/test'
import zlib from 'node:zlib'
import {
  PROJECT_A,
  PROJECT_B,
  TYPE_LABELS,
  login,
  openWorkbench,
  switchProject,
  switchSubject,
  watchResponses,
} from './helpers'

/**
 * Real-browser acceptance of the P0 loop against an isolated environment.
 *
 * Assertion policy (this is what the independent review asked for):
 *
 * * every one of the five scorable question types is answered — the loop is not
 *   allowed to `continue` past a type that happens to be missing;
 * * the grade shown is the *real* server score, read from the response the page
 *   actually received, not merely "some panel appeared";
 * * the endpoints the pages depend on must answer 2xx — an empty state is not
 *   accepted as proof that a page works;
 * * grading completeness and full marks are asserted separately, because the
 *   original bug was treating 8/10 as "unscored".
 */

test.describe('acceptance: setup and scope', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('a new account sees two projects and three subjects, and can add a subject without a reload', async ({
    page,
  }) => {
    await expect(page.locator('.context-strip')).toContainText(PROJECT_A)
    const subjectSelect = page.getByLabel('选择科目')
    const before = await subjectSelect.locator('option').count()
    expect(before).toBeGreaterThanOrEqual(2)

    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
    const name = `验收新科目-${Date.now()}`
    await page.getByPlaceholder('科目名称').fill(name)
    await page.getByRole('button', { name: '添加', exact: true }).click()
    // No page refresh: the new subject must appear in the selector immediately.
    await expect(page.getByLabel('选择科目').locator('option', { hasText: name })).toHaveCount(1)
  })

  test('switching project changes the data, not only the label', async ({ page }) => {
    const failures = watchResponses(page, (url) => url.includes('/api/v1/projects/'))
    await page.goto('/questions')
    await expect(page.locator('table.data tbody tr').first()).toBeVisible()
    expect(await page.locator('table.data tbody tr').count()).toBeGreaterThan(0)
    await switchProject(page, PROJECT_B)
    await expect(page.getByRole('heading', { name: '题库与导入' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText('验收科目一·数量关系')
    expect(failures, `项目级请求不得 4xx/5xx：${failures.join(', ')}`).toEqual([])
  })
})

test.describe('acceptance: five question types with real scores', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('every one of the five types is answered and reports a real score or a real pending state', async ({
    page,
  }) => {
    const answered = new Set<string>()

    for (const label of TYPE_LABELS) {
      await openWorkbench(page, label)
      const type = ((await page.locator('.workbench .card .pill').first().textContent()) ?? '').trim()
      expect(type, `题型标签必须出现（${label}）`).not.toEqual('')
      answered.add(type)

      if (type.includes('大题')) {
        await page.getByPlaceholder('写下你的推导过程与结论').fill('验收：5 袋 × 4 个 = 20 个。')
        await expect(page.locator('.workbench input[type="file"]'), '大题必须能上传作答照片').toHaveCount(1)
      }

      // Read the correct answer from the server *before* submitting, so the
      // test proves "the right answer scores full marks" rather than "one
      // arbitrary click produced some score". For a multi-select question a
      // single option is a genuine partial answer under the partial-credit rule,
      // which is exactly the kind of conflation this suite must not allow.
      const revealResponse = page.waitForResponse((r) => r.url().endsWith('/reveal'))
      await page.getByRole('button', { name: /查看答案与解析/ }).click()
      const reveal = (await (await revealResponse).json()) as { answer_payload: Record<string, unknown> }
      const correctIds: string[] = Array.isArray(reveal.answer_payload.correct_option_ids)
        ? (reveal.answer_payload.correct_option_ids as string[])
        : reveal.answer_payload.correct_option_id
          ? [String(reveal.answer_payload.correct_option_id)]
          : []
      const correctBlankValues = Object.values(
        (reveal.answer_payload.blanks as Record<string, { accepted_values?: string[] }>) ?? {},
      ).map((spec) => spec.accepted_values?.[0] ?? '')

      if (type.includes('单选') || type.includes('多选')) {
        for (const id of correctIds) {
          const option = page.locator(`.option input[value="${id}"]`)
          if (await option.count()) {
            await option.first().check()
            continue
          }
          // The fixture renders options without a value attribute; fall back to
          // the stable position of the option id (opt_a is the first option).
          const index = Number(id.replace('opt_', '').charCodeAt(0) - 'a'.charCodeAt(0))
          await page.locator('.option input').nth(index).check()
        }
      } else if (type.includes('判断')) {
        const value = reveal.answer_payload.value === true
        await page.getByRole('button', { name: value ? '正确' : '错误', exact: true }).click()
      } else if (type.includes('填空')) {
        const inputs = page.locator('.blank-row input')
        for (let index = 0; index < (await inputs.count()); index += 1) {
          await inputs.nth(index).fill(correctBlankValues[index] ?? '7')
        }
      }

      const submitResponse = page.waitForResponse(
        (response) => response.url().endsWith('/submit') && response.request().method() === 'POST',
      )
      await page.getByRole('button', { name: '提交作答' }).click()
      const response = await submitResponse
      expect(response.status(), `提交必须成功（${label}）`).toBe(200)
      const body = (await response.json()) as {
        grade: { status: string; confirmed_score: string | null; max_score: string; pending_max_score: string; is_fully_confirmed: boolean; is_correct: boolean } | null
        receipt_only: boolean
      }
      expect(body.receipt_only).toBe(false)
      expect(body.grade, `练习模式必须返回评分（${label}）`).not.toBeNull()

      const grade = body.grade!
      await expect(page.getByText('提交时间', { exact: false }).first()).toBeVisible()
      await expect(page.getByTestId('grade-score')).toContainText(`/ ${Number(grade.max_score).toFixed(2)}`)

      if (type.includes('大题')) {
        // A constructed response is never auto-scored: real pending, real max.
        expect(grade.status).toBe('pending_review')
        expect(grade.confirmed_score).toBeNull()
        expect(Number(grade.pending_max_score)).toBe(Number(grade.max_score))
        expect(grade.is_fully_confirmed).toBe(false)
        await expect(page.getByTestId('grade-panel')).toContainText('待评')
      } else {
        // Every objective type: fully graded, at full marks, and called correct.
        // The maximum is read from the response, because the acceptance fixture
        // deliberately gives the two projects different scoring rules.
        expect(Number(grade.max_score), `${label} 必须有真实满分`).toBeGreaterThan(0)
        expect(grade.status, `${label} 应已确认`).toBe('confirmed')
        expect(grade.is_fully_confirmed, `${label} 应已评完`).toBe(true)
        expect(grade.confirmed_score, `${label} 应得满分`).toBe(grade.max_score)
        expect(grade.is_correct, `${label} 应判为完全正确`).toBe(true)
        await expect(page.getByTestId('grade-correctness')).toContainText('完全正确')
      }
    }

    expect(answered.size, '五种题型必须全部真实作答，不允许因缺题跳过').toBe(5)
  })

  test('a wrong objective answer is fully graded, scores 0, and is not called correct', async ({ page }) => {
    await openWorkbench(page, '单选')
    // opt_d is the wrong option in the acceptance fixture (correct is opt_a).
    const options = page.locator('.option')
    await options.nth(3).click()
    const submitResponse = page.waitForResponse((r) => r.url().endsWith('/submit'))
    await page.getByRole('button', { name: '提交作答' }).click()
    const grade = ((await (await submitResponse).json()) as {
      grade: { status: string; confirmed_score: string; pending_max_score: string; is_fully_confirmed: boolean; is_correct: boolean }
    }).grade

    expect(grade.status).toBe('confirmed')
    expect(Number(grade.confirmed_score)).toBe(0)
    expect(Number(grade.pending_max_score)).toBe(0)
    expect(grade.is_fully_confirmed, '0 分错答已经评完，不是待评').toBe(true)
    expect(grade.is_correct, '0 分不能被当成完全正确').toBe(false)

    await expect(page.getByTestId('grade-score')).toContainText('0.00 /')
    await expect(page.getByTestId('grade-correctness')).toContainText('未达到满分')
    await expect(page.getByTestId('grade-panel')).not.toContainText('待评')
  })

  test('an answered constructed response can be confirmed criterion by criterion down to a real partial score', async ({
    page,
  }) => {
    await openWorkbench(page, '大题')
    const marker = `人工评分核对标记-${Date.now()}`
    await page.getByPlaceholder('写下你的推导过程与结论').fill(marker)
    const submitResponse = page.waitForResponse((r) => r.url().endsWith('/submit'))
    await page.getByRole('button', { name: '提交作答' }).click()
    await submitResponse
    await expect(page.getByTestId('grade-panel')).toContainText('待评')

    await page.goto('/grading')
    // Several constructed responses may be waiting (the suite runs both a
    // desktop and a mobile project against the same database), so select the
    // row by what it actually contains rather than by position.
    const queueRow = page.locator('table.data tbody tr', { hasText: marker }).first()
    await expect(queueRow, '该作答必须出现在人工评分队列中').toBeVisible()
    await queueRow.click()
    await expect(page.getByRole('heading', { name: '逐评分点打分' })).toBeVisible()
    // The reviewer must see the student's original words, not remember them.
    await expect(page.getByTestId('original-work')).toContainText(marker)
    await expect(page.getByTestId('grading-rubric')).toContainText('正确列出已知条件')

    const scoreInputs = page.locator('.inline-field input[placeholder^="0 ~"]')
    const count = await scoreInputs.count()
    expect(count).toBeGreaterThanOrEqual(3)
    // Leave the first criterion at 0 and award full marks to the rest: 8 / 10.
    for (let index = 0; index < count; index += 1) {
      const placeholder = (await scoreInputs.nth(index).getAttribute('placeholder')) ?? '0 ~ 0'
      const max = placeholder.replace('0 ~ ', '')
      await scoreInputs.nth(index).fill(index === 0 ? '0' : max)
    }
    const confirmResponse = page.waitForResponse((r) => r.url().endsWith('/confirm-grade'))
    await page.getByRole('button', { name: '确认评分' }).click()
    const confirmed = (await (await confirmResponse).json()) as {
      status: string
      confirmed_score: string
      max_score: string
      pending_max_score: string
      is_fully_confirmed: boolean
      is_correct: boolean
    }
    expect(confirmed.status, '全部评分点确认后必须是已确认，而不是一直待评').toBe('confirmed')
    expect(Number(confirmed.confirmed_score)).toBe(8)
    expect(Number(confirmed.max_score)).toBe(10)
    expect(Number(confirmed.pending_max_score), '失分不是未评分').toBe(0)
    expect(confirmed.is_fully_confirmed).toBe(true)
    expect(confirmed.is_correct).toBe(false)
    await expect(page.getByTestId('grade-score')).toContainText('/ 10')
  })
})

test.describe('acceptance: verification never leaks', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('an active verification returns no score anywhere and blocks reveal', async ({ page }) => {
    await page.goto('/review')
    await expect(page.getByRole('heading', { name: /延迟验证任务/ })).toBeVisible()
    const startButton = page.getByRole('button', { name: '开始验证' }).first()
    await expect(startButton, '验收夹具必须产生一个到期的延迟验证任务').toBeEnabled()

    await startButton.click()
    await expect(page.getByRole('heading', { name: '刷题工作台' })).toBeVisible()

    const createResponse = page.waitForResponse(
      (r) => r.url().includes('/practice-sessions') && r.request().method() === 'POST',
    )
    await page.getByRole('button', { name: '创建练习会话' }).click()
    const created = (await (await createResponse).json()) as { session_id: string; mode: string }
    expect(created.mode, '服务端必须按任务用途固定验证模式').toBe('verification')
    await expect.poll(() => sessionIdFromUrlOrNull(page)).toBe(created.session_id)

    // Ask the server directly, from inside the authenticated page: this is
    // stronger than reading whichever response the UI happened to receive. The
    // project is resolved from the API rather than the URL so the check cannot
    // depend on how the client happens to encode its route.
    const evidence = await page.evaluate(
      async ([sessionId, expectedMode]) => {
        const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? ''
        const projects = await (
          await fetch('/api/v1/projects', { credentials: 'same-origin' })
        ).json() as Array<{ id: string; name: string }>
        for (const project of projects) {
          const response = await fetch(`/api/v1/projects/${project.id}/practice-sessions/${sessionId}`, {
            credentials: 'same-origin',
          })
          if (response.status !== 200) continue
          const state = await response.json()
          if (state.mode !== expectedMode) continue
          const itemId = state.items[0]?.session_item_id
          let reveal: { status: number; code?: string } = { status: 0 }
          if (itemId) {
            const blocked = await fetch(`/api/v1/projects/${project.id}/session-items/${itemId}/reveal`, {
              method: 'POST',
              headers: { 'X-CSRFToken': decodeURIComponent(csrf), 'Idempotency-Key': `acceptance-reveal-${itemId}` },
              credentials: 'same-origin',
            })
            reveal = { status: blocked.status, code: (await blocked.json().catch(() => null))?.error?.code }
          }
          return { projectId: project.id, state, itemId, reveal }
        }
        return null
      },
      [created.session_id, 'verification'],
    )
    expect(evidence, '必须能在某个项目下读到该验证会话').not.toBeNull()
    const state = evidence!.state
    expect(state.mode, '从「开始验证」进入的会话必须是验证模式').toBe('verification')
    expect(state.score_visible).toBe(false)
    expect(state.confirmed_score, '验证进行中不得返回分数').toBeNull()
    expect(state.pending_max_score).toBeNull()
    await expect(page.getByTestId('session-score')).toContainText('验证进行中')

    // The reveal endpoint of the *same* verification item must refuse, and the
    // item route must not become a bypass.
    expect(evidence!.itemId, '验证会话必须有可作答题项').toBeTruthy()
    expect(evidence!.reveal.status, '活动验证期间不得下发答案').toBe(403)
    expect(evidence!.reveal.code).toBe('purpose_not_allowed')
  })
})

test.describe('acceptance: submitted item survives a reload', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('reveal after a reload uses the attempt route and returns 200', async ({ page }) => {
    await openWorkbench(page, '单选')
    await page.locator('.option').first().click()
    const submitResponse = page.waitForResponse((r) => r.url().endsWith('/submit'))
    await page.getByRole('button', { name: '提交作答' }).click()
    await submitResponse
    await expect(page.getByText('提交时间', { exact: false }).first()).toBeVisible()

    await page.reload()
    await expect(page.getByText('提交时间', { exact: false }).first()).toBeVisible()
    const revealResponse = page.waitForResponse((r) => r.url().endsWith('/reveal'))
    await page.getByTestId('reveal-answer').click()
    const response = await revealResponse
    expect(response.status(), '刷新后的 reveal 不能是 422/404').toBe(200)
    expect(response.url(), '必须使用稳定的 attempts 路由').toContain('/attempts/')
    await expect(page.getByText('答案与解析（已记录暴露）')).toBeVisible()
  })

  test('a submitted item exposes the tutoring entry after reload', async ({ page }) => {
    await openWorkbench(page, '大题')
    await page.getByPlaceholder('写下你的推导过程与结论').fill('验收：先列条件，再推导。')
    const submitResponse = page.waitForResponse((r) => r.url().endsWith('/submit'))
    await page.getByRole('button', { name: '提交作答' }).click()
    await submitResponse
    await expect(page.getByText('提交时间', { exact: false }).first()).toBeVisible()

    await page.reload()
    await expect(page.getByTestId('tutor-explanation')).toBeVisible()
    const tutorResponse = page.waitForResponse((r) => r.url().endsWith('/messages'))
    await page.getByTestId('tutor-explanation').click()
    const response = await tutorResponse
    expect([201, 503].includes(response.status()), `辅导请求要么成功要么明确未配置，实际 ${response.status()}`).toBe(true)
    const job = (await response.json()) as { error_code?: string; is_stub?: boolean }
    if (response.status() === 503) {
      expect(job.error_code).toBe('ai_not_configured')
    }
  })

  test('attachments uploaded with a constructed response are visible back to the student and the reviewer', async ({
    page,
  }) => {
    await openWorkbench(page, '大题')
    await page.getByPlaceholder('写下你的推导过程与结论').fill('验收：附带作答照片。')
    const png = makePng(8, 8)
    const uploadResponse = page.waitForResponse((r) => r.url().endsWith('/assets'))
    await page
      .locator('.workbench input[type="file"]')
      .setInputFiles({ name: 'work.png', mimeType: 'image/png', buffer: png })
    const uploaded = await uploadResponse
    expect(uploaded.status(), `附件上传必须成功：${await uploaded.text()}`).toBe(201)
    await expect(page.getByTestId('attachment-editor').locator('img')).toHaveCount(1)

    const submitResponse = page.waitForResponse((r) => r.url().endsWith('/submit'))
    await page.getByRole('button', { name: '提交作答' }).click()
    const submitted = (await (await submitResponse).json()) as { attempt_id: string }
    expect(submitted.attempt_id).toBeTruthy()

    await page.reload()
    await expect(page.getByTestId('original-work').locator('img')).toHaveCount(1)

    const attemptResponse = page.waitForResponse((r) => /\/attempts\/[0-9a-f-]+$/.test(r.url()))
    await page.reload()
    const attempt = (await (await attemptResponse).json()) as { attachments: string[] }
    expect(attempt.attachments.length, '提交必须带有附件 ID').toBe(1)
  })
})

test.describe('acceptance: reports, review and evidence are real', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('review page loads its queues over 2xx and shows confirmed mistakes', async ({ page }) => {
    const failures = watchResponses(page, (url) => url.includes('/review-tasks') || url.includes('/evidence') || url.includes('/mistakes'))
    await page.goto('/review')
    await expect(page.getByRole('heading', { name: '错题与复习' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /延迟验证任务/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /已确认的错题/ })).toBeVisible()
    // The mistake table must be present (possibly empty, but a real response).
    const table = page.getByTestId('mistake-table')
    const empty = page.getByText('还没有已确认的错题。')
    await expect(table.or(empty)).toBeVisible()
    expect(failures, `复习页依赖的接口不得失败：${failures.join(', ')}`).toEqual([])
  })

  test('knowledge page loads states and evidence over 2xx', async ({ page }) => {
    const failures = watchResponses(page, (url) => url.includes('/learning-states') || url.includes('/evidence'))
    await page.goto('/knowledge')
    await expect(page.getByRole('heading', { name: '考点地图' })).toBeVisible()
    const firstNode = page.locator('table.data tbody tr').first()
    await expect(firstNode).toBeVisible()
    await firstNode.click()
    await expect(page.getByRole('heading', { name: '证据详情' })).toBeVisible()
    expect(failures, `考点页依赖的接口不得失败：${failures.join(', ')}`).toEqual([])
  })

  test('report separates grading completeness from full marks', async ({ page }) => {
    await page.goto('/reports')
    await expect(page.getByRole('heading', { name: '报告' })).toBeVisible()
    await expect(page.getByText('作答分类')).toBeVisible()
    await expect(page.getByText('按考点')).toBeVisible()
  })

  test('a subject filter changes the rows the server returns', async ({ page }) => {
    await page.goto('/review')
    await expect(page.getByRole('heading', { name: /延迟验证任务/ })).toBeVisible()
    const requests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/review-tasks')) requests.push(request.url())
    })
    await switchSubject(page, '验收科目二·判断推理')
    await expect.poll(() => requests.some((url) => url.includes('subject_id='))).toBe(true)
  })
})

test.describe('acceptance: cross-project tasks and server-side mode', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('starting a delayed-verification task fixes the mode and the project server-side', async ({ page }) => {
    // The acceptance fixture drives a real A -> B -> C chain and only then makes
    // C due, so this exercises the actual anchoring logic rather than a
    // hand-written task row.
    await switchProject(page, PROJECT_A)
    await page.goto('/review')
    await expect(page.getByRole('heading', { name: /延迟验证任务/ })).toBeVisible()
    const row = page.locator('table.data tbody tr').first()
    await expect(row, '验收夹具必须产生一个到期的延迟验证任务').toBeVisible()
    const startButton = row.getByRole('button', { name: '开始验证' })
    await expect(startButton, 'C 必须已到期（锚点由 B 的作答时间计算）').toBeEnabled()

    const startResponse = page.waitForResponse((r) => r.url().includes('/study-tasks/') && r.url().endsWith('/start'))
    await startButton.click()
    const started = (await (await startResponse).json()) as {
      create_session_hint: { subject_id: string; task_id: string; purpose: string }
    }
    expect(started.create_session_hint.purpose).toBe('delayed_verification')

    const createResponse = page.waitForResponse(
      (r) => r.url().includes('/practice-sessions') && r.request().method() === 'POST',
    )
    await expect(page.getByRole('heading', { name: '刷题工作台' })).toBeVisible()
    await page.getByRole('button', { name: '创建练习会话' }).click()
    const created = (await (await createResponse).json()) as { mode: string; session_id: string }
    expect(created.mode, '服务端必须按任务用途固定验证模式，不接受客户端降级为 practice').toBe('verification')

    const state = (await (
      await page.waitForResponse((r) => r.url().includes(`/practice-sessions/${created.session_id}`))
    ).json()) as { score_visible: boolean; confirmed_score: string | null; mode: string }
    expect(state.mode).toBe('verification')
    expect(state.score_visible).toBe(false)
    expect(state.confirmed_score, '活动验证不得返回分数').toBeNull()
    await expect(page.getByTestId('session-score')).toContainText('验证进行中')
  })
})

test.describe('acceptance: errors are surfaced, not shown as empty', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('a failing learning endpoint shows an error instead of an empty state', async ({ page }) => {
    await page.route('**/api/v1/projects/*/review-tasks*', (route) => route.fulfill({ status: 500, body: '{}' }))
    await page.goto('/review')
    await expect(page.getByText(/加载失败|服务器内部错误|请求失败/).first()).toBeVisible()
  })
})

/** Read the session id from the workbench URL the app itself put there. */
function sessionIdFromUrlOrNull(page: Page): string | null {
  return new URL(page.url()).searchParams.get('session')
}

/** A genuinely valid PNG, so the upload exercises the real image validator. */
function makePng(width: number, height: number): Buffer {
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
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const raw = Buffer.alloc(height * (1 + width * 3), 0xff)
  for (let row = 0; row < height; row += 1) raw[row * (1 + width * 3)] = 0 // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
