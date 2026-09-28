import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  ApiError,
  apiRequest,
  createExamClock,
  createMockExamSession,
  deadlineLabel,
  describeApiError,
  examDeadlineRefusalOf,
  expressionReviewNotices,
  fetchPublishedQuestions,
  fetchSealedContent,
  finishPracticeSession,
  formatRemaining,
  newIdempotencyKey,
  type AttemptDetail,
  type AttemptState,
  type ExamClock,
  type ExamDeadlineRefusal,
  type GradeOut,
  type PresentationOut,
  type QuestionListItem,
  type RevealOut,
  type SessionItemState,
  type SessionOut,
  type TutorJobOut,
  type UploadedAsset,
} from '../../api/client'
import { describeError, useScope, useToast } from '../../app/context'
import { Blocks } from '../../components/Content'
import { DiagnosisPanel, TranscriptionPanel, TutorStreamPanel } from './AiAssistPanels'

type AnswerState = Record<string, unknown>

const DRAFT_PREFIX = 'acepass.draft.'
const MAX_ATTACHMENTS = 6

/**
 * Versioned draft envelope (B06).
 *
 * The first version stored the answer state alone, so an uploaded photo was
 * never part of the draft: `setAttachments([])` on load plus a text-only payload
 * meant a refresh silently dropped it. The envelope keeps both halves in one
 * server-side record, and the revision check still protects concurrent tabs.
 */
type DraftEnvelope = { draft_version: 2; answer: AnswerState; asset_ids: string[] }

function readDraft(raw: unknown): { answer: AnswerState | null; assetIds: string[] } {
  if (!raw || typeof raw !== 'object') return { answer: null, assetIds: [] }
  const value = raw as Record<string, unknown>
  if (value.draft_version === 2 && value.answer && typeof value.answer === 'object') {
    const assetIds = Array.isArray(value.asset_ids) ? value.asset_ids.map(String) : []
    return { answer: value.answer as AnswerState, assetIds }
  }
  // A draft written before the envelope existed is still an answer state; read it
  // rather than discarding the learner's work.
  return { answer: Object.keys(value).length > 0 ? (value as AnswerState) : null, assetIds: [] }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** A draft stores attachment ids; the editor only needs the id to render. */
function restoredAttachments(ids: string[]): UploadedAsset[] {
  return ids.map((id) => ({
    id,
    role: 'user_attachment',
    content_type: '',
    size_bytes: 0,
    original_filename: '',
  }))
}

const QUESTION_TYPE_LABELS: Record<string, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  true_false: '判断题',
  fill_blank: '填空题',
  constructed_response: '大题',
}

const DEFAULT_EXAM_QUESTION_COUNT = 10
/** The server's own bounds for an explicit mock-exam length. */
const EXAM_MIN_MINUTES = 5
const EXAM_MAX_MINUTES = 600

/** A score that is an exact decimal on the wire, rendered without float noise. */
function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return String(Number(value.toFixed(4)))
}

/**
 * One item's outcome after a mock exam ended.
 *
 * `is_correct` is the only reading of "完全正确"; a fully graded but imperfect
 * answer is not a wrong answer, and a half-confirmed one keeps its pending
 * marks instead of being shown as lost.
 */
function itemOutcomeLabel(item: SessionItemState): string {
  if (!item.attempt) return '未作答'
  const grade = item.attempt.grade
  if (!grade) return item.attempt.receipt_only ? '已提交（服务器尚未返回判分）' : '判分处理中'
  if (grade.is_correct) return '完全正确'
  if (grade.is_fully_confirmed) return '已评完，未满分'
  return `待人工确认（待评 ${grade.pending_max_score} 分，不当作 0 分）`
}

function emptyAnswer(questionType: string, presentation: PresentationOut | null): AnswerState {
  switch (questionType) {
    case 'single_choice':
    case 'multiple_choice':
      return { type: questionType, selected_option_ids: [] as string[] }
    case 'true_false':
      return { type: questionType, value: null }
    case 'fill_blank':
      return {
        type: questionType,
        blanks: Object.fromEntries((presentation?.stem.blank_ids ?? []).map((id) => [id, ''])),
      }
    default:
      return { type: questionType, text: '' }
  }
}

export function PracticePage() {
  const { currentProject, projects, currentSubject, subjects, selectProject, selectSubject } = useScope()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [sessionId, setSessionId] = useState<string | null>(params.get('session'))
  const [activeIndex, setActiveIndex] = useState(0)
  const [answer, setAnswer] = useState<AnswerState | null>(null)
  const [attachments, setAttachments] = useState<UploadedAsset[]>([])
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [reveal, setReveal] = useState<RevealOut | null>(null)
  const [tutorJob, setTutorJob] = useState<TutorJobOut | null>(null)
  const [startedAt, setStartedAt] = useState<number>(() => Date.now())
  const draftRevision = useRef<number>(0)
  /* ---------------------------------------------------------- C05 模拟考试 */
  // The subject is chosen on the start card (it may differ from the global
  // context strip); the duration is optional and the count picks from the
  // subject's published questions.
  const [examSubjectId, setExamSubjectId] = useState('')
  const [examMinutes, setExamMinutes] = useState('')
  const [examCount, setExamCount] = useState(DEFAULT_EXAM_QUESTION_COUNT)
  const [examConfirming, setExamConfirming] = useState(false)
  const [examSubmitConfirming, setExamSubmitConfirming] = useState(false)
  const [examValidation, setExamValidation] = useState<string | null>(null)
  // A 409 from a late submission: the server's own sentence plus the deadline.
  const [examRefusal, setExamRefusal] = useState<ExamDeadlineRefusal | null>(null)
  // Re-render for the countdown; the clock itself is server-anchored.
  const [, setClockTick] = useState(0)
  const examReconciledFor = useRef<string | null>(null)
  const examCardRef = useRef<HTMLDivElement | null>(null)

  // A task deep link names its own project and subject. Adopt them so a task
  // from another project is created in the right project instead of silently
  // using whatever happens to be selected globally (R10).
  const urlProjectId = params.get('project')
  const urlSubjectId = params.get('subject')
  useEffect(() => {
    if (!urlProjectId || urlProjectId === currentProject?.id) return
    if (!projects.some((project) => project.id === urlProjectId)) return
    selectProject(urlProjectId)
  }, [urlProjectId, currentProject?.id, projects, selectProject])
  useEffect(() => {
    if (!urlSubjectId || !urlProjectId) return
    if (urlProjectId !== currentProject?.id) return
    if (urlSubjectId === currentSubject?.id) return
    if (!subjects.some((subject) => subject.id === urlSubjectId)) return
    selectSubject(urlSubjectId)
  }, [urlSubjectId, urlProjectId, currentProject?.id, currentSubject?.id, subjects, selectSubject])

  const projectId = currentProject?.id ?? null

  const sessionQuery = useQuery({
    queryKey: ['session', projectId, sessionId],
    queryFn: () => apiRequest<SessionOut>(`/projects/${projectId}/practice-sessions/${sessionId}`),
    // Both ids must be real strings. Firing while `projectId` is still unset
    // produced a request to `/projects/undefined/...`, which the server
    // correctly rejected with 422 — a page-level error the learner never caused.
    enabled: Boolean(projectId && sessionId),
  })

  const session = sessionQuery.data ?? null
  const activeItem = session?.items[activeIndex] ?? null
  const attempt: AttemptState | null = activeItem?.attempt ?? null

  /* ------------------------------------------------- C05 exam clock (server) */
  const isMockExam = session?.mode === 'mock_exam'
  /**
   * The clock is built *once* per server snapshot: the remaining time is
   * `exam_deadline − server_time − monotonic elapsed`, so neither a device clock
   * change nor a page refresh can move it. A reconnect gets a fresh snapshot and
   * therefore the server's current remaining time.
   */
  const examClock: ExamClock | null = useMemo(
    () => (session && session.mode === 'mock_exam' ? createExamClock(session) : null),
    [session],
  )
  useEffect(() => {
    if (!examClock || examClock.deadlineMs === null || examClock.serverTimeMs === null) return
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 500)
    return () => window.clearInterval(timer)
  }, [examClock])
  const remainingMs = examClock ? examClock.remainingMs() : null
  const deadlineReached = remainingMs !== null && remainingMs <= 0
  const examFinished = Boolean(
    isMockExam && session && (session.status !== 'active' || Boolean(session.expired_at)),
  )
  // An expired-but-still-open exam must never look live: `deadlineReached` (the
  // server-anchored clock) and a server refusal both remove every live
  // affordance, and the refetch below lets the server record the finish
  // (finished_at = deadline).
  const examLive = Boolean(
    isMockExam &&
      session &&
      session.status === 'active' &&
      !session.expired_at &&
      !deadlineReached &&
      !examRefusal,
  )
  const examExpired = Boolean(
    isMockExam &&
      session &&
      (examRefusal || session.expired_at || (!examLive && deadlineReached)),
  )
  const examRemainingLabel = formatRemaining(remainingMs, true)
  const examDeadlineText = deadlineLabel(session?.exam_deadline ?? null)

  useEffect(() => {
    if (!isMockExam || !deadlineReached) return
    if (!session || session.status !== 'active') return
    const anchor = `${session.session_id}:${session.exam_deadline ?? ''}`
    if (examReconciledFor.current === anchor) return
    examReconciledFor.current = anchor
    void sessionQuery.refetch()
  }, [deadlineReached, isMockExam, session, sessionQuery])

  const examQuestionQuery = useQuery({
    queryKey: ['published-questions', projectId, examSubjectId],
    queryFn: () => fetchPublishedQuestions(projectId as string, examSubjectId),
    enabled: Boolean(projectId && examSubjectId),
  })
  // Sealing is a server-side policy, and a sealed question cannot enter a
  // practice/exam session at all, so the pool never offers one. When the sealed
  // inventory cannot be read the server still decides: its refusal is surfaced
  // instead of a client-side guess.
  const sealedQuery = useQuery({
    queryKey: ['sealed-content', projectId],
    queryFn: () => fetchSealedContent(projectId as string),
    enabled: Boolean(projectId),
    retry: false,
  })
  const sealedQuestionIds = new Set(
    (sealedQuery.data?.questions ?? []).map((row) => row.question_id),
  )
  /**
   * The pool a mock exam is built from: published, scorable (a material parent is
   * expanded by the server, so it is not a submittable item), carrying a trusted
   * answer (an item without one would make the *whole* creation fail), and not
   * sealed.
   */
  const examQuestionPool: QuestionListItem[] = (examQuestionQuery.data ?? []).filter(
    (question) =>
      question.published_version_id &&
      question.question_type !== 'material' &&
      question.has_trusted_answer &&
      !sealedQuestionIds.has(question.id),
  )
  const examCountOptions = examQuestionPool.length || DEFAULT_EXAM_QUESTION_COUNT
  const examPlannedCount = Math.min(examCount, examQuestionPool.length || examCount)

  useEffect(() => {
    if (examSubjectId || !currentSubject) return
    setExamSubjectId(currentSubject.id)
  }, [examSubjectId, currentSubject])

  useEffect(() => {
    if (examCount < 1) return
    if (examQuestionPool.length && examCount > examQuestionPool.length) {
      setExamCount(examQuestionPool.length)
    }
  }, [examCount, examQuestionPool.length])

  // After a reload the presentation query is disabled because an attempt
  // exists, so every action must key off ids that survive in the session
  // response rather than off the one-shot presentation payload (R09).
  const itemId = activeItem?.session_item_id ?? null
  const attemptId = activeItem?.attempt_id ?? attempt?.attempt_id ?? null

  const presentationQuery = useQuery({
    queryKey: ['presentation', projectId, itemId],
    queryFn: () => apiRequest<PresentationOut>(`/projects/${projectId}/session-items/${itemId}/presentation`),
    enabled: Boolean(projectId && itemId && !attempt),
  })

  const presentation = presentationQuery.data ?? null

  const attemptQuery = useQuery({
    queryKey: ['attempt', projectId, attemptId],
    queryFn: () => apiRequest<AttemptDetail>(`/projects/${projectId}/attempts/${attemptId}`),
    enabled: Boolean(projectId && attemptId),
  })

  /* ------------------------------------------------- draft: local then server */
  useEffect(() => {
    if (!presentation || attempt) return
    const cacheKey = `${DRAFT_PREFIX}${presentation.session_item_id}`
    const cached = window.localStorage.getItem(cacheKey)
    const localDraft = cached ? readDraft(safeParse(cached)) : { answer: null, assetIds: [] }
    const storedDraft = readDraft(presentation.draft)
    const initial =
      localDraft.answer ?? storedDraft.answer ?? emptyAnswer(presentation.stem.question_type, presentation)
    setAnswer(initial)
    // Attachments are restored from the draft that supplied the answer. Text used
    // to come back while the photo silently disappeared; the ids are part of the
    // same record now, so a refresh (or another device) restores the same set.
    setAttachments(restoredAttachments(localDraft.answer ? localDraft.assetIds : storedDraft.assetIds))
    draftRevision.current = presentation.draft_revision
    setStartedAt(Date.now())
    setReveal(null)
    setTutorJob(null)
  }, [presentation, attempt])

  useEffect(() => {
    setReveal(null)
    setTutorJob(null)
  }, [activeIndex, sessionId])

  // A new session starts with no refusal and no pending 交卷 confirmation: the
  // previous exam's server message must not bleed into the next one.
  useEffect(() => {
    setExamRefusal(null)
    setExamSubmitConfirming(false)
  }, [sessionId])

  // The today page links here with `?exam=1`: bring the mock-exam card into view
  // instead of leaving the learner at the top of the practice screen.
  const wantsExamEntry = params.get('exam') === '1'
  useEffect(() => {
    if (!wantsExamEntry || sessionId) return
    examCardRef.current?.scrollIntoView({ block: 'start' })
  }, [wantsExamEntry, sessionId])

  // A deep link (mistake list, review page) names the item directly; honour it
  // once the session has loaded so "查看作答与辅导" lands on the right item.
  const deepLinkItem = params.get('item')
  useEffect(() => {
    if (!deepLinkItem || !session) return
    const index = session.items.findIndex((item) => item.session_item_id === deepLinkItem)
    if (index >= 0 && index !== activeIndex) setActiveIndex(index)
  }, [deepLinkItem, session, activeIndex])

  const syncDraft = useCallback(
    async (value: AnswerState, assets: UploadedAsset[] | string[]) => {
      if (!presentation || !projectId) return
      const cacheKey = `${DRAFT_PREFIX}${presentation.session_item_id}`
      const assetIds = assets.map((item) => (typeof item === 'string' ? item : item.id))
      const envelope: DraftEnvelope = { draft_version: 2, answer: value, asset_ids: assetIds }
      window.localStorage.setItem(cacheKey, JSON.stringify(envelope))
      setDraftStatus('saving')
      try {
        const result = await apiRequest<{ draft_revision: number }>(
          `/projects/${projectId}/session-items/${presentation.session_item_id}/draft`,
          {
            method: 'PUT',
            body: { draft: envelope, draft_revision: draftRevision.current },
          },
        )
        draftRevision.current = result.draft_revision
        setDraftStatus('saved')
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          toast.push('草稿已在其他标签页更新，请刷新后再编辑', 'error')
        }
        setDraftStatus('error')
      }
    },
    [presentation, projectId, toast],
  )

  useEffect(() => {
    if (!answer || attempt) return
    // A photo is content: adding or removing one must be saved by the same
    // debounced path as typing, otherwise the draft on the server is older than
    // what the learner sees.
    const timer = window.setTimeout(() => void syncDraft(answer, attachments), 700)
    return () => window.clearTimeout(timer)
  }, [answer, attachments, attempt, syncDraft])

  /* ------------------------------------------------------------ mutations */
  const createSession = useMutation({
    mutationFn: async () => {
      const subjectId = params.get('subject') ?? currentSubject?.id
      if (!subjectId) throw new Error('请先选择科目')
      const questionIds = params.getAll('q')
      const taskId = params.get('task')
      if (!questionIds.length && !taskId) throw new Error('请从今日任务或题库选择题目')
      return apiRequest<SessionOut>(`/projects/${projectId}/practice-sessions`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('session-create'),
        body: {
          // The server fixes the mode from the task's kind; this is only a hint.
          mode: params.get('mode') ?? 'practice',
          subject_id: subjectId,
          question_ids: questionIds,
          task_id: taskId,
          purpose: params.get('purpose') ?? 'practice',
        },
      })
    },
    onSuccess: (data) => {
      setSessionId(data.session_id)
      setActiveIndex(0)
      setParams((current) => {
        const next = new URLSearchParams(current)
        next.set('session', data.session_id)
        return next
      })
      void queryClient.invalidateQueries({ queryKey: ['today-plan'] })
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const submit = useMutation({
    mutationFn: async (payload: AnswerState) => {
      if (!itemId) throw new Error('题目尚未加载')
      return apiRequest<{ session_item_id: string; attempt_id: string; grade: GradeOut | null; receipt_only: boolean }>(
        `/projects/${projectId}/session-items/${itemId}/submit`,
        {
          method: 'POST',
          idempotencyKey: newIdempotencyKey('item-submit'),
          body: {
            answer: payload,
            steps: buildSteps(payload),
            asset_ids: attachments.map((asset) => asset.id),
            confidence: 'unsure',
            client_active_ms: Date.now() - startedAt,
          },
        },
      )
    },
    onSuccess: async () => {
      if (itemId) window.localStorage.removeItem(`${DRAFT_PREFIX}${itemId}`)
      await queryClient.invalidateQueries({ queryKey: ['session', projectId, sessionId] })
      await queryClient.invalidateQueries({ queryKey: ['presentation'] })
      toast.push(
        isMockExam
          ? '已收到作答（考试结束前不显示分数与正误；交卷后不能再修改）'
          : '已提交（提交后不可修改，如需重做请新建题项）',
        'ok',
      )
    },
    onError: (err) => {
      // A late answer is refused with 409 `exam_deadline_passed`: show the
      // server's own sentence and let the refetch put the exam in its finished
      // state, instead of leaving an overdue run looking active.
      const refusal = examDeadlineRefusalOf(err)
      if (refusal) {
        setExamRefusal(refusal)
        void sessionQuery.refetch()
      }
      toast.push(describeApiError(err), 'error')
    },
  })

  const createMockExam = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('请先选择项目')
      const subjectId = examSubjectId || currentSubject?.id
      if (!subjectId) throw new Error('请先选择科目')
      const trimmed = examMinutes.trim()
      let duration: number | null = null
      if (trimmed) {
        const parsed = Number(trimmed)
        // The 5–600 bound is the server's rule and the server's message is what
        // the learner must see, so only a non-integer is refused here (it cannot
        // be put on the wire as an int at all).
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
          throw new Error(
            `时长必须是整数分钟，或留空由服务器按已发布规范推导（服务器要求 ${EXAM_MIN_MINUTES}–${EXAM_MAX_MINUTES} 分钟）`,
          )
        }
        duration = parsed
      }
      const ids = examQuestionPool.slice(0, Math.max(1, examCount)).map((question) => question.id)
      if (!ids.length) throw new Error('该科目没有可用于模拟考试的已发布题目')
      return createMockExamSession(projectId, {
        subject_id: subjectId,
        question_ids: ids,
        duration_minutes: duration,
      })
    },
    onSuccess: (data) => {
      setExamConfirming(false)
      setExamRefusal(null)
      setExamSubmitConfirming(false)
      examReconciledFor.current = null
      setSessionId(data.session_id)
      setActiveIndex(0)
      setParams((current) => {
        const next = new URLSearchParams(current)
        next.set('session', data.session_id)
        return next
      })
      void queryClient.invalidateQueries({ queryKey: ['today-plan'] })
    },
    onError: (err) => {
      setExamValidation(describeApiError(err))
      toast.push(describeApiError(err), 'error')
    },
  })


  const revealAttempt = useMutation({
    mutationFn: () => {
      // With an attempt the stable attempt route is used, which is what makes
      // reveal work after a reload or a deep link; before submitting there is
      // no attempt yet, so the item route applies.
      const path = attemptId
        ? `/projects/${projectId}/attempts/${attemptId}/reveal`
        : `/projects/${projectId}/session-items/${itemId}/reveal`
      return apiRequest<RevealOut>(path, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('reveal'),
      })
    },
    onSuccess: (data) => {
      setReveal(data)
      toast.push('已下发答案/解析：本次作答将记录为辅助暴露', 'info')
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const askTutor = useMutation({
    mutationFn: async (purpose: 'hint' | 'explanation') => {
      if (!itemId) throw new Error('题目尚未加载')
      const session = await apiRequest<{ tutor_session_id: string }>(`/projects/${projectId}/tutor-sessions`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('tutor-session'),
        body: { session_item_id: itemId, purpose },
      })
      return apiRequest<TutorJobOut>(`/projects/${projectId}/tutor-sessions/${session.tutor_session_id}/messages`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('tutor-message'),
        body: {
          user_question:
            purpose === 'hint'
              ? '请只给提示，不要直接给答案；针对我自己的作答指出关键条件。'
              : '请针对我提交的作答与步骤给出完整讲解、可能卡点与方法边界。',
        },
      })
    },
    onSuccess: (job) => setTutorJob(job),
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!itemId) throw new Error('题目尚未加载')
      const form = new FormData()
      form.append('file', file)
      form.append('role', 'user_attachment')
      return apiRequest<UploadedAsset>(`/projects/${projectId}/assets`, {
        method: 'POST',
        formData: form,
        idempotencyKey: newIdempotencyKey('attachment'),
      })
    },
    onSuccess: (asset) => {
      setAttachments((current) => [...current, asset].slice(0, MAX_ATTACHMENTS))
      toast.push('照片已上传；提交后不可替换或删除', 'ok')
    },
    onError: (err) => toast.push(describeError(err), 'error'),
  })

  const finishSession = useMutation({
    mutationFn: () => {
      if (!projectId || !sessionId) throw new Error('会话尚未创建')
      return finishPracticeSession(projectId, sessionId)
    },
    onSuccess: async (data) => {
      setExamSubmitConfirming(false)
      setExamRefusal(null)
      await queryClient.invalidateQueries({ queryKey: ['session', projectId, sessionId] })
      await queryClient.invalidateQueries({ queryKey: ['today-plan'] })
      toast.push(
        data.mode === 'mock_exam'
          ? '已交卷：本次模拟考试结束，分数与逐题结果已可查看'
          : '会话已结束',
        'ok',
      )
    },
    onError: (err) => toast.push(describeApiError(err), 'error'),
  })

  const selectedOptions = (answer?.selected_option_ids as string[] | undefined) ?? []

  const toggleOption = (optionId: string) => {
    if (!presentation || !answer) return
    if (presentation.stem.question_type === 'single_choice') {
      setAnswer({ ...answer, selected_option_ids: [optionId] })
      return
    }
    const next = selectedOptions.includes(optionId)
      ? selectedOptions.filter((id) => id !== optionId)
      : [...selectedOptions, optionId]
    setAnswer({ ...answer, selected_option_ids: next })
  }

  const subtitle = useMemo(() => {
    if (!session) return '尚未创建会话'
    const done = session.items.filter((item) => item.attempt).length
    return `${session.mode === 'verification' ? '验证模式' : '练习模式'} · 已完成 ${done}/${session.items.length}`
  }, [session])

  if (!currentProject) return <div className="card empty-state">请先选择项目。</div>

  if (!sessionId) {
    return (
      <>
        <div className="page-title">
          <h1>刷题工作台</h1>
          <span className="sub">从今日任务或题库选题后开始；也可以直接开始一道当前科目的练习。</span>
        </div>
        <div className="card">
          <h2>开始一次练习</h2>
          <label className="field">
            <span>科目</span>
            <select value={currentSubject?.id ?? ''} onChange={(event) => selectSubject(event.target.value)}>
              {subjects.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.name}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button className="btn primary" disabled={!currentSubject || createSession.isPending} onClick={() => createSession.mutate()}>
              创建练习会话
            </button>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            会话会在服务端固定题目、答案、评分标准与规则的版本；题干在你领取题项时才下发，避免提前暴露。
          </p>
        </div>

        {/* C05: a timed mock exam. The timer is the server's, the questions come
            from the subject's published pool, and nothing here can move the
            deadline — refreshing or reconnecting cannot extend it either. */}
        <div className="card" data-testid="mock-exam-start-card" ref={examCardRef}>
          <h2>开始一次模拟考试</h2>
          <p className="small muted">
            计时由服务器负责：截止时间在创建时写入一次，刷新页面、断线重连或修改本机时间都不会延长考试。
            考试进行中不显示分数、正误、答案与讲解，也不提供按需辅导；到点后服务器自动交卷。
          </p>
          <label className="field">
            <span>科目</span>
            <select
              data-testid="mock-exam-subject"
              value={examSubjectId}
              onChange={(event) => {
                setExamSubjectId(event.target.value)
                setExamConfirming(false)
                setExamValidation(null)
                selectSubject(event.target.value)
              }}
            >
              <option value="">请选择科目</option>
              {subjects.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>时长（分钟，可留空：由服务器按已发布规范的时限规则推导；填写时为 {EXAM_MIN_MINUTES}–{EXAM_MAX_MINUTES}）</span>
            <input
              data-testid="mock-exam-duration"
              type="number"
              inputMode="numeric"
              min={EXAM_MIN_MINUTES}
              max={EXAM_MAX_MINUTES}
              value={examMinutes}
              placeholder="留空 = 服务器按规范推导"
              onChange={(event) => {
                setExamMinutes(event.target.value)
                setExamValidation(null)
              }}
            />
          </label>
          <label className="field">
            <span>题目数量（从该科目已发布题目中选择）</span>
            <select
              data-testid="mock-exam-question-count"
              value={String(examCount)}
              onChange={(event) => setExamCount(Number(event.target.value))}
              disabled={!examQuestionPool.length}
            >
              {Array.from({ length: examCountOptions }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {count} 题
                </option>
              ))}
            </select>
          </label>
          <p className="small muted">
            {!examSubjectId
              ? '请先选择科目。'
              : examQuestionQuery.isLoading
                ? '正在读取该科目的已发布题目…'
                : examQuestionQuery.isError
                  ? `无法读取题目：${describeError(examQuestionQuery.error)}`
                  : `该科目当前有 ${examQuestionPool.length} 道可用于模拟考试的已发布题目（已核对答案、未封存；共享材料题会展开为子题）。`}
            {sealedQuery.isError
              ? ' 封存清单读取失败：若题目已被封存，服务器会拒绝创建并说明原因。'
              : ''}
          </p>
          <div className="row">
            <button
              className="btn primary"
              data-testid="mock-exam-start"
              disabled={!examSubjectId || !examQuestionPool.length || createMockExam.isPending}
              onClick={() => {
                setExamValidation(null)
                setExamConfirming(true)
              }}
            >
              开始模拟考试
            </button>
            {examConfirming ? (
              <button className="btn ghost" onClick={() => setExamConfirming(false)}>
                取消
              </button>
            ) : null}
          </div>
          {examConfirming ? (
            <div className="notice warn" style={{ marginTop: 10 }}>
              <p style={{ marginTop: 0 }}>
                <strong>交卷后不能再修改。</strong>
                本次将创建 {examPlannedCount} 道题的限时考试，
                {examMinutes.trim()
                  ? `时长 ${examMinutes.trim()} 分钟`
                  : '时长由服务器按已发布规范的时限规则推导'}
                ；考试进行中没有分数、正误、答案与讲解。
              </p>
              <div className="row">
                <button
                  className="btn primary"
                  data-testid="mock-exam-confirm-start"
                  disabled={createMockExam.isPending}
                  onClick={() => createMockExam.mutate()}
                >
                  {createMockExam.isPending ? '正在创建…' : '确认开始（计时从服务器创建时刻开始）'}
                </button>
              </div>
            </div>
          ) : null}
          {examValidation ? (
            <div className="notice danger" style={{ marginTop: 10 }} data-testid="mock-exam-start-error">
              {examValidation}
            </div>
          ) : null}
        </div>
      </>
    )
  }

  return (
    <>
      <div className="page-title">
        <h1>刷题工作台</h1>
        <span className="sub">
          {currentProject.name}
          {currentSubject ? ` · ${currentSubject.name}` : ''} · {subtitle}
        </span>
        <span className="spacer" />
        {session ? (
          <>
            <span
              className={`pill ${session.score_visible ? 'ok' : 'neutral'}`}
              data-testid="session-score"
            >
              {isMockExam
                ? session.score_visible
                  ? `模拟考试已结束 · 已确认 ${session.confirmed_score ?? '—'} 分 · 待评 ${session.pending_max_score ?? '—'} 分`
                  : examLive
                    ? '模拟考试进行中：不显示分数与正误'
                    : '模拟考试已结束：正在读取服务器结果'
                : session.score_visible
                  ? `已确认 ${session.confirmed_score ?? '—'} 分 · 待评 ${session.pending_max_score ?? '—'} 分`
                  : '验证进行中：不显示分数与正误'}
            </span>
            {!isMockExam ? (
              session.status === 'active' ? (
                <button className="btn small" disabled={finishSession.isPending} onClick={() => finishSession.mutate()}>
                  结束会话
                </button>
              ) : (
                <span className="pill neutral">会话已结束</span>
              )
            ) : (
              <span className="pill neutral">{examLive ? '考试进行中' : '考试已结束'}</span>
            )}
          </>
        ) : null}
      </div>

      {isMockExam && session ? (
        <div className="card" data-testid="mock-exam-timer">
          <div className="row between">
            <span className="pill warn">模拟考试 · 计时以服务器为准</span>
            <strong data-testid="mock-exam-remaining">
              {examLive
                ? examRemainingLabel
                  ? `剩余 ${examRemainingLabel}`
                  : '剩余时间：未收到服务器时间，不估算'
                : '考试已结束'}
            </strong>
          </div>
          <p className="small muted" style={{ marginBottom: 6 }}>
            {examDeadlineText ? `服务器截止时间：${examDeadlineText}。` : '服务器尚未提供截止时间。'}
            {examClock?.offsetMs !== null && examClock?.offsetMs !== undefined
              ? `倒计时按服务器的 server_time 锚定，并用单调时钟计时（读取时本机时间与服务器相差约 ${Math.round(
                  examClock.offsetMs / 1000,
                )} 秒）；修改本机时间不会改变剩余时间。`
              : '未收到服务器时间，因此不估算剩余时间；一切以服务器判定为准。'}
          </p>
          {examLive ? (
            <>
              <p className="notice info" data-testid="mock-exam-no-feedback" style={{ marginBottom: 8 }}>
                考试进行中：不显示分数、正误、答案与讲解，也不提供按需辅导。交卷或到达服务器截止时间后才可以查看结果。
              </p>
              <div className="row">
                <button
                  className="btn primary"
                  data-testid="mock-exam-submit"
                  onClick={() => setExamSubmitConfirming(true)}
                >
                  交卷
                </button>
                <span className="small muted">
                  已提交 {session.items.filter((item) => item.attempt).length}/{session.items.length} 题；
                  交卷后不能再修改
                </span>
              </div>
              {examSubmitConfirming ? (
                <div className="notice danger" style={{ marginTop: 10 }}>
                  <p style={{ marginTop: 0 }}>
                    <strong>交卷后不能再修改。</strong>
                    交卷后本次模拟考试立即结束，并显示分数与逐题结果；未提交的题项按未作答处理。
                  </p>
                  <div className="row">
                    <button
                      className="btn primary"
                      data-testid="mock-exam-submit-confirm"
                      disabled={finishSession.isPending}
                      onClick={() => finishSession.mutate()}
                    >
                      {finishSession.isPending ? '正在交卷…' : '确认交卷'}
                    </button>
                    <button
                      className="btn ghost"
                      disabled={finishSession.isPending}
                      onClick={() => setExamSubmitConfirming(false)}
                    >
                      继续作答
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {isMockExam && session && examExpired ? (
        <div className="notice danger" data-testid="mock-exam-expired">
          <p style={{ marginTop: 0 }}>
            <strong>已到服务器截止时间，本次模拟考试不能再提交作答。</strong>
            {session.status === 'active' ? '服务器正在结算本次考试…' : '服务器已自动交卷。'}
          </p>
          {examRefusal ? (
            <p className="small" style={{ marginBottom: 4 }}>
              {examRefusal.message}
            </p>
          ) : null}
          <p className="small" style={{ marginBottom: 0 }}>
            服务器截止时间：{examDeadlineText ?? deadlineLabel(examRefusal?.deadline ?? null) ?? '未提供'}；
            截止时间在创建时写入一次，刷新、重连或修改本机时间都不会延长。
          </p>
        </div>
      ) : null}

      {isMockExam && session && examFinished ? (
        <div className="card" data-testid="mock-exam-result">
          <h2>模拟考试结果</h2>
          <p className="small muted">
            结束时间 {session.finished_at ? new Date(session.finished_at).toLocaleString() : '—'}
            {session.expired_at
              ? '（到达服务器截止时间，由服务器自动交卷）'
              : '（已交卷）'}
          </p>
          {session.score_visible ? (
            <>
              <p className="small">
                已确认 <strong>{session.confirmed_score ?? '—'}</strong> 分 · 满分{' '}
                {formatScore(session.items.reduce((sum, item) => sum + Number(item.max_score || 0), 0))} 分
                {Number(session.pending_max_score ?? 0) > 0
                  ? ` · 待人工确认 ${session.pending_max_score} 分（待评不是 0 分）`
                  : ''}
              </p>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>题号</th>
                      <th>题目</th>
                      <th>结果</th>
                      <th>得分</th>
                    </tr>
                  </thead>
                  <tbody>
                    {session.items.map((item) => (
                      <tr key={item.session_item_id}>
                        <td>{item.ordinal}</td>
                        <td className="small">{item.display_label}</td>
                        <td className="small">{itemOutcomeLabel(item)}</td>
                        <td className="small">
                          {item.attempt?.grade
                            ? `${item.attempt.grade.confirmed_score ?? '—'} / ${item.attempt.grade.max_score}`
                            : '未作答'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="notice warn">
              {session.score_hidden_reason ?? '服务器尚未提供本次考试的分数；此处不显示任何推算分数。'}
            </div>
          )}
        </div>
      ) : null}

      {session && session.items.length > 0 ? (
        <div className="card">
          <div className="item-nav">
            {session.items.map((item, index) => (
              <button
                key={item.session_item_id}
                className={`btn small ${index === activeIndex ? 'current' : ''} ${item.attempt ? 'submitted' : ''}`}
                onClick={() => setActiveIndex(index)}
                title={item.display_label}
              >
                {item.ordinal}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!activeItem ? (
        <div className="card empty-state">该会话没有可作答的题项。</div>
      ) : attempt ? (
        <SubmittedView
          attempt={attempt}
          detail={attemptQuery.data ?? null}
          questionType={activeItem.question_type}
          displayLabel={activeItem.display_label}
          session={session}
          projectId={projectId}
          canReveal={Boolean(activeItem.can_reveal)}
          onReveal={() => revealAttempt.mutate()}
          reveal={reveal}
          revealPending={revealAttempt.isPending}
          onTutor={(purpose) => askTutor.mutate(purpose)}
          tutorPending={askTutor.isPending}
          tutorAllowed={Boolean(activeItem.tutoring_allowed)}
          tutorJob={tutorJob}
          examLive={examLive}
        />
      ) : presentationQuery.isLoading ? (
        <div className="card empty-state">正在领取题项…</div>
      ) : presentationQuery.isError ? (
        <div className="notice danger">{describeError(presentationQuery.error)}</div>
      ) : isMockExam && !examLive ? (
        <div className="card empty-state" data-testid="mock-exam-closed-item">
          本场模拟考试已结束，不能再提交作答。
          {examExpired ? '到达服务器截止时间后，未提交的题项按未作答处理。' : ''}
        </div>
      ) : presentation && answer ? (
        <div className="workbench">
          <div className="card">
            <div className="row between">
              <span className="pill neutral">{QUESTION_TYPE_LABELS[presentation.stem.question_type] ?? presentation.stem.question_type}</span>
              <span className="small muted">
                本题满分 {presentation.max_score} · 第 {presentation.ordinal} 题
              </span>
            </div>
            {presentation.stem.material ? (
              <div className="card" style={{ background: '#f9fafc' }}>
                <h3>共享材料</h3>
                <Blocks blocks={presentation.stem.material.blocks} projectId={projectId ?? undefined} />
              </div>
            ) : null}
            <Blocks blocks={presentation.stem.blocks} projectId={projectId ?? undefined} />

            {presentation.stem.question_type === 'single_choice' || presentation.stem.question_type === 'multiple_choice' ? (
              <div className="option-list">
                {presentation.stem.options.map((option) => {
                  const selected = selectedOptions.includes(option.id)
                  return (
                    <label key={option.id} className={`option ${selected ? 'selected' : ''}`}>
                      <input
                        type={presentation.stem.question_type === 'single_choice' ? 'radio' : 'checkbox'}
                        name="option"
                        checked={selected}
                        onChange={() => toggleOption(option.id)}
                      />
                      <span>
                        <strong>{option.label}.</strong>{' '}
                        <Blocks blocks={option.blocks} projectId={projectId ?? undefined} />
                      </span>
                    </label>
                  )
                })}
              </div>
            ) : null}

            {presentation.stem.question_type === 'true_false' ? (
              <div className="row" style={{ margin: '12px 0' }}>
                <button
                  className={`btn ${answer.value === true ? 'primary' : ''}`}
                  onClick={() => setAnswer({ ...answer, value: true })}
                >
                  正确
                </button>
                <button
                  className={`btn ${answer.value === false ? 'primary' : ''}`}
                  onClick={() => setAnswer({ ...answer, value: false })}
                >
                  错误
                </button>
                <button className="btn ghost" onClick={() => setAnswer({ ...answer, value: null })}>
                  清除（视为未答）
                </button>
              </div>
            ) : null}

            {presentation.stem.question_type === 'fill_blank' ? (
              <div style={{ margin: '12px 0' }}>
                {presentation.stem.blanks.map((blank) => (
                  <div className="blank-row" key={blank.blank_id}>
                    <span className="small muted">{blank.label}</span>
                    <input
                      value={((answer.blanks as Record<string, string>) ?? {})[blank.blank_id] ?? ''}
                      onChange={(event) =>
                        setAnswer({
                          ...answer,
                          blanks: { ...((answer.blanks as Record<string, string>) ?? {}), [blank.blank_id]: event.target.value },
                        })
                      }
                      placeholder="按原文填写，保留负号与单位"
                    />
                  </div>
                ))}
                <p className="tiny muted">
                  系统只做规则中显式允许的归一化（大小写/空白/全半角）；无法判断的会进入人工复核，不会直接判错。
                </p>
              </div>
            ) : null}

            {presentation.stem.question_type === 'constructed_response' ? (
              <div style={{ margin: '12px 0' }}>
                <label className="field">
                  <span>解答过程（可写步骤，提交后不可修改）</span>
                  <textarea
                    value={(answer.text as string) ?? ''}
                    onChange={(event) => setAnswer({ ...answer, text: event.target.value })}
                    placeholder="写下你的推导过程与结论"
                  />
                </label>
                <AttachmentEditor
                  attachments={attachments}
                  busy={uploadAttachment.isPending}
                  onUpload={(file) => uploadAttachment.mutate(file)}
                  onRemove={(id) => setAttachments((current) => current.filter((asset) => asset.id !== id))}
                  projectId={projectId}
                />
                <p className="tiny muted">大题在 P0 逐评分点人工确认，不会自动给分；未确认前保持待评，不记 0 分。</p>
              </div>
            ) : null}

            <div className="row between" style={{ marginTop: 12 }}>
              <span className="small muted">
                草稿：
                {draftStatus === 'saving'
                  ? '正在保存…'
                  : draftStatus === 'saved'
                    ? '已保存'
                    : draftStatus === 'error'
                      ? '保存失败'
                      : '未修改'}
              </span>
              <div className="row">
                {isMockExam ? (
                  // No reveal affordance at all during an exam (and no disabled
                  // button pretending one exists): state why it is unavailable.
                  <span className="small muted">考试进行中不提供答案与解析，交卷或到点后才可以查看。</span>
                ) : (
                  <button className="btn" disabled={revealAttempt.isPending} onClick={() => revealAttempt.mutate()}>
                    查看答案与解析（会记录辅助暴露）
                  </button>
                )}
                <button className="btn primary" disabled={submit.isPending} onClick={() => submit.mutate(answer)}>
                  {isMockExam ? '提交本题（提交后不可修改）' : '提交作答'}
                </button>
              </div>
            </div>

            {reveal ? <RevealPanel reveal={reveal} /> : null}
          </div>

          <div className="card">
            <h2>按需辅导</h2>
            {presentation.tutoring_allowed ? (
              <>
                <p className="small muted">
                  提示与完整讲解由服务端记录暴露；讲解不会写入分数或掌握状态。
                </p>
                <div className="row">
                  <button className="btn" disabled={askTutor.isPending} onClick={() => askTutor.mutate('hint')}>
                    只看提示
                  </button>
                  <button className="btn" disabled={askTutor.isPending} onClick={() => askTutor.mutate('explanation')}>
                    完整讲解
                  </button>
                </div>
              </>
            ) : (
              <div className="notice warn">
                {isMockExam
                  ? '模拟考试进行中不提供按需辅导：考试需要独立完成；交卷或到点后可以查看答案、讲解与结果。'
                  : '当前会话不提供辅导：验证/考试模式下需要独立完成；如需讲解请结束验证后新建练习会话。'}
              </div>
            )}
            {tutorJob ? <TutorStreamPanel projectId={projectId} job={tutorJob} /> : null}
          </div>
        </div>
      ) : (
        <div className="card empty-state">正在准备题目…</div>
      )}
    </>
  )
}

/** Steps are derived from the drafted work so the tutor prompt carries them. */
function buildSteps(answer: AnswerState): Array<{ text: string }> {
  if (answer.type !== 'constructed_response') return []
  const text = String(answer.text ?? '').trim()
  if (!text) return []
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ text: line }))
}

export function AttachmentEditor({
  attachments,
  busy,
  onUpload,
  onRemove,
  projectId,
  readOnly = false,
}: {
  attachments: UploadedAsset[] | string[]
  busy: boolean
  onUpload: (file: File) => void
  onRemove: (id: string) => void
  projectId: string | null
  readOnly?: boolean
}) {
  const ids = attachments.map((item) => (typeof item === 'string' ? item : item.id))
  return (
    <div style={{ margin: '10px 0' }} data-testid="attachment-editor">
      <div className="row between">
        <span className="small muted">
          作答照片（{ids.length}/{MAX_ATTACHMENTS}）：提交后按追加保存，不能替换或删除
        </span>
        {!readOnly ? (
          <label className="btn small" style={{ cursor: 'pointer' }}>
            {busy ? '上传中…' : '添加照片'}
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              disabled={busy || ids.length >= MAX_ATTACHMENTS}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) onUpload(file)
                event.target.value = ''
              }}
            />
          </label>
        ) : null}
      </div>
      {ids.length ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
          {ids.map((id) => (
            <div key={id} style={{ position: 'relative' }}>
              <img
                src={`/api/v1/projects/${projectId}/assets/${id}`}
                alt="作答照片"
                style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8, border: '1px solid #dde' }}
              />
              {!readOnly ? (
                <button
                  className="btn small ghost"
                  style={{ position: 'absolute', top: -8, right: -8 }}
                  onClick={() => onRemove(id)}
                  aria-label="删除照片"
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="tiny muted" style={{ margin: 0 }}>
          还没有照片。大题可以只写文字，也可以传照片；人工评分时会对照原图。
        </p>
      )}
    </div>
  )
}

function SubmittedView({
  attempt,
  detail,
  questionType,
  displayLabel,
  session,
  projectId,
  canReveal,
  onReveal,
  reveal,
  revealPending,
  onTutor,
  tutorPending,
  tutorAllowed,
  tutorJob,
  examLive = false,
}: {
  attempt: AttemptState
  detail: AttemptDetail | null
  questionType: string
  displayLabel: string
  session: SessionOut | null
  projectId: string | null
  canReveal: boolean
  onReveal: () => void
  reveal: RevealOut | null
  revealPending: boolean
  onTutor: (purpose: 'hint' | 'explanation') => void
  tutorPending: boolean
  tutorAllowed: boolean
  tutorJob: TutorJobOut | null
  /** C05: a running mock exam hides every score/feedback surface. */
  examLive?: boolean
}) {
  const wrongOrPartial = Boolean(
    attempt.grade && attempt.grade.is_fully_confirmed && !attempt.grade.is_correct,
  )
  return (
    <>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{displayLabel || '本题'}（已提交）</h2>
          <span className="pill neutral">{QUESTION_TYPE_LABELS[questionType] ?? questionType}</span>
        </div>
        <p className="small muted">
          提交时间 {new Date(attempt.submitted_at).toLocaleString()}，用时 {Math.round(attempt.elapsed_ms / 1000)} 秒。
        </p>
        {attempt.receipt_only ? (
          <div className="notice warn">
            {examLive
              ? '模拟考试进行中：服务器只确认收到作答，不返回分数、正误或评分点；交卷或到达服务器截止时间后即可查看。'
              : '验证进行中：系统只确认收到作答，不返回分数、正误或评分点。结束本次会话后即可查看。'}
          </div>
        ) : attempt.grade ? (
          <GradePanel grade={attempt.grade} projectId={projectId} />
        ) : (
          <div className="notice info">判分处理中。</div>
        )}

        {detail ? (
          <div style={{ marginTop: 10 }}>
            <h3>我的原始作答</h3>
            <OriginalWork detail={detail} projectId={projectId} />
          </div>
        ) : null}

        {/* The photos the learner uploaded are right above this panel: a
            transcription proposal is confirmed where the work is visible. Only a
            constructed response carries handwritten work the gate cares about. */}
        {questionType === 'constructed_response' ? (
          <div style={{ marginTop: 12 }}>
            <TranscriptionPanel
              projectId={projectId}
              attemptId={attempt.attempt_id}
              assetIds={detail?.attachments ?? []}
            />
          </div>
        ) : null}

        <div className="row" style={{ marginTop: 10 }}>
          {canReveal && !examLive ? (
            <button
              className="btn"
              disabled={revealPending}
              onClick={onReveal}
              data-testid="reveal-answer"
            >
              查看答案与解析
            </button>
          ) : null}
          {tutorAllowed && !examLive ? (
            <>
              <button
                className="btn"
                disabled={tutorPending}
                onClick={() => onTutor('hint')}
                data-testid="tutor-hint"
              >
                针对我的作答给提示
              </button>
              <button
                className="btn primary"
                disabled={tutorPending}
                onClick={() => onTutor('explanation')}
                data-testid="tutor-explanation"
              >
                完整讲解
              </button>
            </>
          ) : null}
          {examLive ? (
            <span className="small muted">
              模拟考试进行中：本题已收到，分数、正误、答案与讲解在交卷或到点后才显示。
            </span>
          ) : null}
        </div>
        {wrongOrPartial && !examLive ? (
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            本题已评分但未满分：可以先用「针对我的作答给提示」看卡点，再看完整讲解。讲解不会改写分数。
          </p>
        ) : null}
        {reveal ? <RevealPanel reveal={reveal} /> : null}
      </div>
      {tutorJob ? (
        <div className="card">
          <h2>按需辅导</h2>
          <TutorStreamPanel projectId={projectId} job={tutorJob} />
        </div>
      ) : null}
      {/* Diagnosis is a feedback surface (it names error types off the grade):
          during a live exam it is not offered at all, and the exam bar says so. */}
      {examLive ? null : <DiagnosisPanel projectId={projectId} attemptId={attempt.attempt_id} />}
      {session ? null : null}
    </>
  )
}

/** Render exactly what the student submitted, for every question type. */
export function OriginalWork({ detail, projectId }: { detail: AttemptDetail; projectId: string | null }) {
  const raw = detail.raw_answer ?? {}
  const type = String(raw.type ?? '')
  return (
    <div className="card" style={{ background: '#f9fafc' }} data-testid="original-work">
      {type === 'single_choice' || type === 'multiple_choice' ? (
        <p className="small">
          选择：{JSON.stringify(raw.selected_option_ids ?? raw.selected_option_id ?? [])}
        </p>
      ) : null}
      {type === 'true_false' ? (
        <p className="small">
          判断：{raw.value === null || raw.value === undefined ? '未作答' : raw.value ? '正确' : '错误'}
        </p>
      ) : null}
      {type === 'fill_blank' ? (
        <ul className="small">
          {Object.entries((raw.blanks as Record<string, string>) ?? {}).map(([blankId, value]) => (
            <li key={blankId}>
              {blankId}：<code>{value || '（空）'}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {type === 'constructed_response' ? (
        <pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
          {String(raw.text ?? '') || '（未填写文字）'}
        </pre>
      ) : null}
      {detail.steps?.length ? (
        <>
          <h4>步骤</h4>
          <ol className="small">
            {detail.steps.map((step, index) => (
              <li key={index}>{typeof step === 'string' ? step : String((step as { text?: string }).text ?? JSON.stringify(step))}</li>
            ))}
          </ol>
        </>
      ) : null}
      {detail.attachments?.length ? (
        <>
          <h4>作答照片（{detail.attachments.length}）</h4>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {detail.attachments.map((id) => (
              <a key={id} href={`/api/v1/projects/${projectId}/assets/${id}`} target="_blank" rel="noreferrer">
                <img
                  src={`/api/v1/projects/${projectId}/assets/${id}`}
                  alt="作答照片"
                  style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8, border: '1px solid #dde' }}
                />
              </a>
            ))}
          </div>
        </>
      ) : null}
      {detail.confidence ? <p className="tiny muted">自评把握：{detail.confidence}</p> : null}
    </div>
  )
}

export function GradePanel({
  grade,
  projectId,
  showExpressionReview = true,
}: {
  grade: GradeOut
  projectId: string | null
  /** The grading page already renders the review reasons next to the item. */
  showExpressionReview?: boolean
}) {
  const statusLabel: Record<string, string> = {
    confirmed: '已确认',
    pending_review: '待复核/待评',
    estimated: 'AI 估计（不计入正式分）',
    void: '无效',
  }
  const methodLabel: Record<string, string> = {
    deterministic: '确定性判分',
    self_confirmed: '自评确认',
    reviewer_confirmed: '复核确认',
    ai_estimated: 'AI 估计',
    mixed: '混合来源',
  }
  const pending = Number(grade.pending_max_score ?? 0)
  // C07: an expression blank the restricted engine could not decide is not an
  // unknown shown as "pending": the server names the reason (syntax, limit,
  // domain, timeout, unknown symbol) and the reviewer who will decide it.
  const expressionReviews = showExpressionReview ? expressionReviewNotices(grade) : []
  return (
    <div className="grade-box" data-testid="grade-panel">
      <div className="row between">
        <strong data-testid="grade-method">
          {statusLabel[grade.status] ?? grade.status} · {methodLabel[grade.method] ?? grade.method}
        </strong>
        <span data-testid="grade-score">
          {grade.confirmed_score ?? '—'} / {grade.max_score}
          {pending > 0 ? `（待评 ${grade.pending_max_score} 分）` : ''}
        </span>
      </div>
      {grade.is_fully_confirmed ? (
        <p className="small" data-testid="grade-correctness" style={{ margin: '4px 0' }}>
          {grade.is_correct ? '本题完全正确（满分）' : '本题已评完，但未达到满分（失分不是未评分）'}
        </p>
      ) : null}
      {expressionReviews.length ? (
        <div className="notice warn" data-testid="expression-review-reason" style={{ margin: '6px 0' }}>
          <strong>本空未作判定，已转人工复核：</strong>
          <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {expressionReviews.map((notice) => (
              <li key={notice.partId}>
                {`表达式无法确认（${notice.codeLabel}）：${notice.reason}`}
                {notice.unknownSymbols.length
                  ? `（未登记符号：${notice.unknownSymbols.join('、')}）`
                  : ''}
                {notice.engineMessage && notice.engineMessage !== notice.reason
                  ? `；引擎说明：${notice.engineMessage}`
                  : ''}
              </li>
            ))}
          </ul>
          <p className="tiny" style={{ margin: '4px 0 0' }}>
            未知不等于错误：这里不会显示“正确/错误”，也不会计 0 分；复核确认后才会给出结论。
          </p>
        </div>
      ) : null}
      {grade.parts.map((part) => (
        <div className="grade-part" key={part.part_id}>
          <span className="small">
            {part.part_id}
            {part.detail?.outcome ? ` · ${String(part.detail.outcome)}` : ''}
            {part.detail?.reason ? ` · ${String(part.detail.reason)}` : ''}
          </span>
          <span className="small nowrap">
            {part.status === 'confirmed' ? `${part.score} / ${part.max_score}` : `待评（满分 ${part.max_score}）`}
          </span>
        </div>
      ))}
      {!grade.is_fully_confirmed ? (
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          未完全确认的部分不会当作错题或 0 分，也不计入完整正确率。
          {grade.method === 'self_confirmed' ? ' 自评只产生自评证据，不作为严格独立能力证据。' : ''}
        </p>
      ) : null}
      {projectId ? null : null}
    </div>
  )
}

function RevealPanel({ reveal }: { reveal: RevealOut }) {
  return (
    <div className="card" style={{ background: '#fbfcfe' }}>
      <h3>答案与解析（已记录暴露）</h3>
      {reveal.confidence_note ? <div className="notice warn">{reveal.confidence_note}</div> : null}
      <p className="small">
        答案来源：{reveal.answer_source_type ?? '未知'} · 核对状态：{reveal.answer_verification_status ?? '未知'}
        {reveal.check_basis ? ` · 依据：${reveal.check_basis}` : ''}
      </p>
      <pre className="small" style={{ whiteSpace: 'pre-wrap', background: '#fff', padding: 8, borderRadius: 8 }}>
        {JSON.stringify(reveal.answer_payload, null, 2)}
      </pre>
      {reveal.rubric ? (
        <div>
          <h4>评分标准（逐点确认，P0 不自动给分）</h4>
          <ul className="small">
            {reveal.rubric.criteria.map((criterion, index) => (
              <li key={index}>
                {String(criterion.text ?? '')}（{String(criterion.max_score ?? '')} 分）
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {reveal.explanation_blocks.length ? (
        <>
          <h4>已审核的人工解析</h4>
          <Blocks blocks={reveal.explanation_blocks} />
        </>
      ) : (
        <p className="small muted">本题还没有人工解析。</p>
      )}
    </div>
  )
}

/* 辅导结果由 TutorStreamPanel 渲染：SSE 分段 + 存储分段回退（B08）。 */
