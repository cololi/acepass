/**
 * Build the browser-acceptance fixture against one AcePass data root.
 *
 * Port of `backend/apps/accounts/management/commands/bootstrap_acceptance.py::build` onto the
 * plugin's own service layer. The intent of the fixture is unchanged and deliberately **not** the
 * demo fixture: a brand-new account receives real structure built the way the product builds it —
 * projects, subjects, a published exam spec, a published syllabus with knowledge points, and one
 * published question per scorable type with a checked answer (plus a rubric for the constructed
 * response), all labelled as an acceptance fixture rather than as a real past paper.
 *
 * Two consequences of "the same service layer the HTTP routes use":
 *
 *  1. this module never inserts, updates or deletes a row itself. Every write is
 *     `src/services/*`, so a fixture shape the product refuses cannot be seeded at all — the
 *     failure appears here, at seed time, instead of as a green browser run over impossible data;
 *  2. the questions, specs and papers are visible to every list endpoint exactly like user data,
 *     because they *are* user data (origin_type=user_authored, is_demo=false).
 *
 * The delayed-verification chain (`_seed_delayed_verification`) is driven through the **real**
 * services, exactly like Django's command: a reviewed A/B/C pairing, then a graded A attempt creates
 * B, a graded B attempt creates C, and only C's deadline is moved into the past so the browser can
 * start it. The anchor itself is computed by the production rule, which is what the browser test
 * asserts about; no task row is written by hand.
 *
 * One consequence is worth stating: a single chain exists per fixture, so only the first browser
 * project to run the "start the delayed verification" case consumes it (the same is true of the
 * Django baseline, which seeds once for both viewport projects).
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fromDate, formatPythonIso, type Instant } from '../src/domain/instant.ts'
import { findRows, updateRow } from '../src/store/repository.ts'
import { openStore } from '../src/store/db.ts'
import { ensureOwner, ensureSettings, patchStudySettings } from '../src/services/accounts.ts'
import {
  addPaperItem,
  archiveProject,
  confirmPaperRevision,
  createPaperRevisionForImport,
  createProject,
  createSpecVersion,
  createSubject,
  createSyllabusVersion,
  listProjects,
  listSubjects,
  publishSpecVersion,
  publishSyllabusVersion,
  recordPaperCoverage,
  registerPaper,
  updateProject,
} from '../src/services/exams.ts'
import { createNode } from '../src/services/knowledge.ts'
import { replaceKnowledgeMappings } from '../src/services/mappings.ts'
import {
  createVerificationPairing,
  onAttemptGraded,
  resolvePairingTargets,
} from '../src/services/pairing.ts'
import { submitAttempt } from '../src/services/practice.ts'
import { drain } from '../src/jobs/worker.ts'
import { createSession, finishSession, presentItem } from '../src/services/sessions.ts'
import {
  createAnswerKeyVersion,
  createQuestion,
  createQuestionVersionDraft,
  publishQuestionVersion,
  upsertRubricVersion,
} from '../src/services/questions.ts'

/** Django's `FIXTURE_PREFIX`: every authored label carries it so a human can tell fixtures apart. */
export const FIXTURE_PREFIX = '验收'
/** Django's `FIXTURE_NOTE`: the check basis of every checked answer, and the audit note. */
export const FIXTURE_NOTE = '浏览器验收夹具：结构为真实录入路径，题目为自编验收题，不是历年真题。'

export const PROJECT_A = '验收项目A·基础能力'
export const PROJECT_B = '验收项目B·专业实务'
export const PROJECT_C = '验收项目C·延迟验证'
/** The two subjects that live in project A, then the one in project B — Django's `SUBJECT_NAMES`. */
export const SUBJECT_NAMES = ['验收科目一·数量关系', '验收科目二·判断推理', '验收科目三·专业实务'] as const
/** Project C's own subject: the delayed chain used to share a project and measured test ordering. */
export const SUBJECT_C = '验收延迟科目·数量关系'
/** The P1-03 cycle-analysis subject: five complete cycles, one incomplete, one demo paper. */
export const SUBJECT_CYCLES = '验收历年科目·周期统计'
export const CYCLE_YEARS = ['2019', '2020', '2021', '2022', '2023'] as const
export const CYCLE_INCOMPLETE_YEAR = '2024'
export const CYCLE_TOPIC = '验收周期考点'
export const CYCLE_SECOND_TOPIC = '验收周期考点二'
/** `Decimal("10")`: every counted cycle item is worth this much. */
export const CYCLE_SCORE = '10.00'
/** The three fixture projects, in the order Django archives then rebuilds them. */
export const FIXTURE_PROJECT_NAMES = [PROJECT_A, PROJECT_B, PROJECT_C] as const

export interface AcceptanceSeedSummary {
  /** The single workspace identity the fixture belongs to (always `owner@acepass.local`). */
  email: string
  project_a: string
  project_b: string
  project_c: string
  /** Subjects of the three active fixture projects (A:2, B:2, C:1) — never the archived generations. */
  subjects: number
  /** Published question versions Django's `build()` counts: 7 per subject × 4 subjects. */
  published_versions: number
  /** Published versions per question type, so "the five types are covered" is machine-checkable. */
  published_versions_by_type: Record<string, number>
  /** Study tasks the A→B→C chain produced (Django: 2 — the B and its delayed C). */
  delayed_verification_tasks: number
  cycle_subject_id: string
  cycle_subject_name: string
  complete_cycles: string[]
  incomplete_cycle: string
  cycle_scored_items: number
  /** Fixture blocks this port could not build. Empty: every block is built through a real service. */
  skipped: string[]
  /** Absolute data root the fixture was built in. */
  data_root: string
  /** Projects retired by this run, so a second run over the same root is auditable. */
  archived_projects: { id: string; name: string; retired_name: string }[]
  /** `formatPythonIso` of the seeding instant: the fixture is deterministic only relative to it. */
  seeded_at: string
  /**
   * The fixture's own outbox, drained with the *seeding* clock.
   *
   * B10: the runtime worker is live in the acceptance server, so leaving the fixture's events
   * pending would let wall-clock time stamp the first rebuild after boot. Draining here keeps
   * `computed_at`/`as_of` at `seeded_at` and makes the fixture state independent of when the server
   * starts. `failed` must be 0: a fixture event nobody consumes is a fixture bug, not browser flake.
   */
  outbox: { handled: number; failed: number; skipped: number }
}

export interface AcceptanceSeedOptions {
  /** Directory holding `acepass.sqlite` (the plugin's `dataRoot`), created when missing. */
  dataRoot: string
  /** Injectable clock; defaults to now. */
  now?: Instant
}

/** Rules Django stores on the spec, including the two policy fields the grader reads. */
interface QuestionTypeRule {
  default_max_score: string
  wrong_score?: string
  blank_score?: string
  policy?: string
  partial_score?: string | null
  mismatch_policy?: string
}

type Rules = Record<string, QuestionTypeRule>

/**
 * `_published_spec`: a published exam spec with one rule per scorable type.
 *
 * The first subject uses partial credit for multiple choice and the rest exact match, exactly as
 * Django does — the two policies have to be observable from a single fixture.
 */
function publishedSpec(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  subject: Record<string, unknown>,
  partialCredit: boolean,
  now: Instant,
): Record<string, unknown> {
  const rules: Rules = {
    single_choice: { default_max_score: '2.00', wrong_score: '0.00', blank_score: '0.00' },
    multiple_choice: {
      default_max_score: '4.00',
      wrong_score: '0.00',
      blank_score: '0.00',
      policy: partialCredit ? 'partial_credit' : 'exact_match',
      partial_score: partialCredit ? '2.00' : null,
    },
    true_false: { default_max_score: '2.00', wrong_score: '0.00', blank_score: '0.00' },
    fill_blank: { default_max_score: '3.00', mismatch_policy: 'review' },
    constructed_response: { default_max_score: '10.00' },
  }
  const spec = createSpecVersion(
    db,
    userId,
    projectId,
    {
      subject_id: String(subject.id),
      name: `${FIXTURE_PREFIX}规范 v1`,
      total_score: subject.total_score as string,
      pass_score: subject.pass_score as string,
      question_type_rules: rules as unknown as Record<string, unknown>,
      time_rules: { single_choice_seconds: 60, constructed_response_seconds: 600 },
      score_floor_at_zero: false,
      rule_source_note: FIXTURE_NOTE,
      is_demo: false,
    },
    now,
  )
  return publishSpecVersion(db, userId, projectId, String(spec.id), now)
}

/** `_published_syllabus`: a provisional user outline, published (that is what freezes its nodes). */
function publishedSyllabus(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  subjectId: string,
  now: Instant,
): Record<string, unknown> {
  const syllabus = createSyllabusVersion(
    db,
    userId,
    projectId,
    {
      subject_id: subjectId,
      name: `${FIXTURE_PREFIX}大纲`,
      version_label: '验收',
      is_user_provisional: true,
    },
    now,
  )
  return publishSyllabusVersion(db, userId, projectId, String(syllabus.id), now)
}

/** `_nodes`: the knowledge points the questions map onto, in syllabus order. */
function createNodes(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  syllabus: Record<string, unknown>,
  names: readonly string[],
  now: Instant,
): Record<string, Record<string, unknown>> {
  const created: Record<string, Record<string, unknown>> = {}
  names.forEach((name, index) => {
    created[name] = createNode(
      db,
      userId,
      projectId,
      {
        syllabus_version_id: String(syllabus.id),
        canonical_name: name,
        kind: 'point',
        display_order: index,
      },
      now,
    )
  })
  return created
}

interface Blueprint {
  label: string
  questionType: string
  content: Record<string, unknown>
  answerPayload: Record<string, unknown>
  rubricCriteria?: unknown[]
  rubricTotal?: string
  explanation?: unknown[]
}

/** One published question of every scorable type, with a checked answer — Django's `_seed_subject`. */
const BLUEPRINT_SOURCE: Omit<Blueprint, 'label'>[] = [
  {
    questionType: 'single_choice',
    content: {
      blocks: [{ kind: 'text', text: '验收单选：下列哪一项等于 3 + 4 × 2？' }],
      options: [
        { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '11' }] },
        { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '14' }] },
        { id: 'opt_c', label: 'C', blocks: [{ kind: 'text', text: '9' }] },
        { id: 'opt_d', label: 'D', blocks: [{ kind: 'text', text: '12' }] },
      ],
    },
    answerPayload: { kind: 'single_choice', correct_option_id: 'opt_a' },
    explanation: [{ kind: 'text', text: '先乘后加：4 × 2 = 8，再加 3 得 11。' }],
  },
  // Two more singles, so the A/B/C pairing is built from *three different* stable questions on the
  // same subject: one question cannot play two roles in a pairing (the service refuses it).
  {
    questionType: 'single_choice',
    content: {
      blocks: [{ kind: 'text', text: '验收单选：12 的一半是多少？' }],
      options: [
        { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '6' }] },
        { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '24' }] },
        { id: 'opt_c', label: 'C', blocks: [{ kind: 'text', text: '4' }] },
        { id: 'opt_d', label: 'D', blocks: [{ kind: 'text', text: '8' }] },
      ],
    },
    answerPayload: { kind: 'single_choice', correct_option_id: 'opt_a' },
    explanation: [{ kind: 'text', text: '12 ÷ 2 = 6。' }],
  },
  {
    questionType: 'single_choice',
    content: {
      blocks: [{ kind: 'text', text: '验收单选：一个正方形边长 3，周长是多少？' }],
      options: [
        { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '6' }] },
        { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '12' }] },
        { id: 'opt_c', label: 'C', blocks: [{ kind: 'text', text: '9' }] },
        { id: 'opt_d', label: 'D', blocks: [{ kind: 'text', text: '18' }] },
      ],
    },
    answerPayload: { kind: 'single_choice', correct_option_id: 'opt_b' },
    explanation: [{ kind: 'text', text: '正方形周长 = 4 × 3 = 12。' }],
  },
  {
    questionType: 'multiple_choice',
    content: {
      blocks: [{ kind: 'text', text: '验收多选：下列哪些数是偶数？' }],
      options: [
        { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '2' }] },
        { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '3' }] },
        { id: 'opt_c', label: 'C', blocks: [{ kind: 'text', text: '4' }] },
        { id: 'opt_d', label: 'D', blocks: [{ kind: 'text', text: '5' }] },
      ],
    },
    answerPayload: { kind: 'multiple_choice', correct_option_ids: ['opt_a', 'opt_c'] },
    explanation: [{ kind: 'text', text: '2 与 4 能被 2 整除。' }],
  },
  {
    questionType: 'true_false',
    content: { blocks: [{ kind: 'text', text: '验收判断：三角形内角和为 180 度。' }] },
    answerPayload: { kind: 'true_false', value: true },
    explanation: [{ kind: 'text', text: '欧氏平面几何中三角形内角和为 180 度。' }],
  },
  {
    questionType: 'fill_blank',
    content: {
      blocks: [{ kind: 'text', text: '验收填空：3 + 4 = ____，10 ÷ 2 = ____。' }],
      blanks: [
        { blank_id: 'b1', label: '第 1 空' },
        { blank_id: 'b2', label: '第 2 空' },
      ],
    },
    answerPayload: {
      kind: 'fill_blank',
      blanks: {
        b1: {
          accepted_values: ['7'],
          max_score: '1.50',
          normalization: { strip_whitespace: true, fullwidth_to_halfwidth: true },
          mismatch_policy: 'wrong',
        },
        b2: {
          accepted_values: ['5'],
          max_score: '1.50',
          normalization: { strip_whitespace: true, fullwidth_to_halfwidth: true },
          mismatch_policy: 'wrong',
        },
      },
    },
    explanation: [{ kind: 'text', text: '3 + 4 = 7；10 ÷ 2 = 5。' }],
  },
  {
    questionType: 'constructed_response',
    content: {
      blocks: [
        {
          kind: 'text',
          text: '验收大题：一箱有 5 袋，每袋 4 个，共多少个？请写出完整推导过程并给出结论。',
        },
      ],
    },
    answerPayload: { kind: 'constructed_response', rubric_required: true },
    rubricCriteria: [
      { criterion_id: 'c1', text: '正确列出已知条件', max_score: '2.00', required: true },
      { criterion_id: 'c2', text: '推导过程正确', max_score: '3.00', required: true },
      { criterion_id: 'c3', text: '结论正确且单位完整', max_score: '5.00', required: true },
    ],
    rubricTotal: '10.00',
    explanation: [{ kind: 'text', text: '5 × 4 = 20 个。' }],
  },
]

/** The label suffix Django gives each blueprint: 单选-1/2/3, 多选-1, 判断-1, 填空-1, 大题-1. */
const LABEL_SUFFIXES = ['单选-1', '单选-2', '单选-3', '多选-1', '判断-1', '填空-1', '大题-1']

/**
 * `_publish_one`: create identity → draft version → checked answer → rubric → mapping → publish.
 *
 * The order is the product's order (an answer cannot be attached to a published version, and a
 * mapping cannot precede the version), which is why this is a single helper rather than six calls
 * at every call site.
 */
function publishOne(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: {
    subjectId: string
    spec: Record<string, unknown>
    nodeId: string
    blueprint: Blueprint
    now: Instant
    mappings?: { node_id: string; is_primary: boolean; score_weight: string }[]
  },
): Record<string, unknown> {
  const { blueprint, spec, now } = options
  const rules = (spec.question_type_rules ?? {}) as Rules
  const timeRules = (spec.time_rules ?? {}) as Record<string, unknown>
  const practiceMaxScore = rules[blueprint.questionType]?.default_max_score ?? null

  const question = createQuestion(
    db,
    userId,
    {
      subjectId: options.subjectId,
      originType: 'user_authored',
      displayLabel: blueprint.label,
      isDemo: false,
    },
    now,
  )
  const version = createQuestionVersionDraft(
    db,
    userId,
    projectId,
    String(question.id),
    {
      questionType: blueprint.questionType,
      content: blueprint.content,
      practiceMaxScore,
      estimatedSeconds: (timeRules[`${blueprint.questionType}_seconds`] as number | null) ?? null,
      revisionReason: '验收夹具初始版本',
    },
    now,
  )
  const answer = createAnswerKeyVersion(
    db,
    userId,
    projectId,
    String(version.id),
    {
      answerPayload: blueprint.answerPayload,
      sourceType: 'user',
      verificationStatus: 'checked',
      checkBasis: FIXTURE_NOTE,
      explanationBlocks: blueprint.explanation ?? [],
    },
    now,
  )
  if (blueprint.rubricCriteria !== undefined) {
    upsertRubricVersion(
      db,
      userId,
      projectId,
      String(answer.id),
      {
        criteria: blueprint.rubricCriteria,
        totalScore: blueprint.rubricTotal ?? '10.00',
        usageNote: FIXTURE_NOTE,
      },
      now,
    )
  }
  replaceKnowledgeMappings(
    db,
    projectId,
    String(version.id),
    // One primary mapping is the Django default; the cycle fixture overwrites it afterwards with
    // the split weights, because a paper item's weight is what cycle analysis counts.
    options.mappings ?? [{ node_id: options.nodeId, is_primary: true, score_weight: '1' }],
    { actorId: userId, now },
  )
  return publishQuestionVersion(db, userId, projectId, String(version.id), { now })
}

/** `_seed_subject`: seven published versions (three singles + one of each other scorable type). */
function seedSubject(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: {
    subject: Record<string, unknown>
    spec: Record<string, unknown>
    nodes: Record<string, Record<string, unknown>>
    labelPrefix: string
    now: Instant
  },
): Record<string, unknown>[] {
  const { subject, spec, nodes, labelPrefix, now } = options
  const nodeList = Object.values(nodes)
  const versions: Record<string, unknown>[] = []
  BLUEPRINT_SOURCE.forEach((source, index) => {
    versions.push(
      publishOne(db, userId, projectId, {
        subjectId: String(subject.id),
        spec,
        nodeId: String(nodeList[index % nodeList.length].id),
        blueprint: { ...source, label: `${labelPrefix}-${LABEL_SUFFIXES[index]}` },
        now,
      }),
    )
  })
  return versions
}

/**
 * `_seed_cycle_analysis_subject`: the P1-03 fixture.
 *
 * Five cycles are complete (confirmed revision + manually confirmed coverage), which is the horizon
 * the report uses. `2024` stays incomplete on purpose so the UI has a real "why is this cycle not
 * counted" row, and a demo paper carries a scored item so the exclusion rule is observable rather
 * than assumed. Only the real service paths are used: `registerPaper` /
 * `createPaperRevisionForImport` / `addPaperItem` / `recordPaperCoverage` / `confirmPaperRevision`.
 */
function seedCycleAnalysisSubject(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  now: Instant,
): { subject: Record<string, unknown>; countedItems: number } {
  const subject = createSubject(
    db,
    userId,
    projectId,
    { name: SUBJECT_CYCLES, total_score: '100', pass_score: '60' },
    now,
  )
  const spec = publishedSpec(db, userId, projectId, subject, false, now)
  const syllabus = publishedSyllabus(db, userId, projectId, String(subject.id), now)
  const nodes = createNodes(db, userId, projectId, syllabus, [CYCLE_TOPIC, CYCLE_SECOND_TOPIC], now)
  const node = nodes[CYCLE_TOPIC]

  let countedItems = 0
  for (const year of CYCLE_YEARS) {
    const registered = registerPaper(
      db,
      userId,
      projectId,
      {
        subject_id: String(subject.id),
        cycle_key: year,
        paper_code: '卷一',
        source_kind: 'official_past',
        title: `${year} 验收周期材料`,
      },
      now,
    )
    const paper = registered.paper
    const revision = createPaperRevisionForImport(
      db,
      paper,
      {
        expectedSessionCount: 1,
        coveredSessionCount: 1,
        note: FIXTURE_NOTE,
        actorId: userId,
        projectId,
      },
      now,
    )
    // Two scoring units per cycle: one maps to a single point, the other splits its weight across
    // two points, so the report shows both whole and fractional shares (and proves weights are
    // counted once).
    const weightSets: string[][] = [['1'], ['0.6', '0.4']]
    weightSets.forEach((weights, index) => {
      const version = publishOne(db, userId, projectId, {
        subjectId: String(subject.id),
        spec,
        nodeId: String(node.id),
        blueprint: {
          label: `${year}-${index + 1}`,
          questionType: 'single_choice',
          content: {
            blocks: [{ kind: 'text', text: `${year} 年第 ${index + 1} 题（验收夹具）` }],
            options: [
              { id: 'opt_a', label: 'A', blocks: [{ kind: 'text', text: '甲' }] },
              { id: 'opt_b', label: 'B', blocks: [{ kind: 'text', text: '乙' }] },
            ],
          },
          answerPayload: { kind: 'single_choice', correct_option_id: 'opt_a' },
        },
        now,
        mappings: weights.map((weight, position) => ({
          node_id: String((position === 0 ? nodes[CYCLE_TOPIC] : nodes[CYCLE_SECOND_TOPIC]).id),
          is_primary: true,
          score_weight: weight,
        })),
      })
      addPaperItem(
        db,
        userId,
        projectId,
        String(revision.id),
        { positionKey: String(index + 1), questionVersionId: String(version.id), maxScore: CYCLE_SCORE },
        now,
      )
      countedItems += 1
    })
    recordPaperCoverage(
      db,
      userId,
      projectId,
      String(revision.id),
      { expected_session_count: 1, covered_session_count: 1, confirm: true, note: FIXTURE_NOTE },
      now,
    )
    // A revision with no scored item cannot be confirmed, so this runs after `addPaperItem`.
    confirmPaperRevision(db, userId, projectId, String(revision.id), now)
  }

  // One incomplete cycle: the revision exists but is neither confirmed nor coverage-complete, so
  // the analysis must report why it is excluded.
  const incomplete = registerPaper(
    db,
    userId,
    projectId,
    {
      subject_id: String(subject.id),
      cycle_key: CYCLE_INCOMPLETE_YEAR,
      paper_code: '卷一',
      source_kind: 'official_past',
      title: `${CYCLE_INCOMPLETE_YEAR} 验收周期材料（未完成校对）`,
    },
    now,
  )
  createPaperRevisionForImport(
    db,
    incomplete.paper,
    { note: `${FIXTURE_NOTE}（未完成）`, actorId: userId, projectId },
    now,
  )

  // A demo paper with a scored item: it must never enter the numbers.
  const demo = registerPaper(
    db,
    userId,
    projectId,
    {
      subject_id: String(subject.id),
      cycle_key: '2025',
      paper_code: '演示卷',
      source_kind: 'demo',
      title: '演示试卷（不计入统计）',
    },
    now,
  )
  const demoRevision = createPaperRevisionForImport(
    db,
    demo.paper,
    { expectedSessionCount: 1, coveredSessionCount: 1, note: '演示数据', actorId: userId, projectId },
    now,
  )
  const demoVersion = publishOne(db, userId, projectId, {
    subjectId: String(subject.id),
    spec,
    nodeId: String(node.id),
    blueprint: {
      label: '演示-1',
      questionType: 'true_false',
      content: { blocks: [{ kind: 'text', text: '演示试卷题目（不计入统计）' }] },
      answerPayload: { kind: 'true_false', value: true },
    },
    now,
  })
  addPaperItem(
    db,
    userId,
    projectId,
    String(demoRevision.id),
    { positionKey: '1', questionVersionId: String(demoVersion.id), maxScore: '99.00' },
    now,
  )

  return { subject, countedItems }
}


/** One hour / one minute as microseconds, for the chain's explicit timestamps. */
const HOUR_MICROS = 3_600_000_000n
const MINUTE_MICROS = 60_000_000n

/** Django's `_answer_for`: the checked answer's correct option, in the submission wire shape. */
function answerForVersion(db: DatabaseSync, versionId: string): Record<string, unknown> {
  const answer = findRows(db, 'question_bank_answer_key_version', {
    question_version_id: versionId,
    is_disputed: false,
  })[0]
  if (answer === undefined) {
    throw new Error(`fixture question version ${versionId} has no undisputed answer to submit`)
  }
  const payload = (answer.answer_payload ?? {}) as Record<string, unknown>
  const optionId = payload['correct_option_id']
  if (optionId === null || optionId === undefined) {
    throw new Error(`fixture answer of ${versionId} has no correct_option_id`)
  }
  return { type: 'single_choice', selected_option_ids: [String(optionId)] }
}

/** Deliver, present and submit one question, returning the attempt and the item it answered. */
function answerOneQuestion(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: {
    subjectId: string
    questionId: string
    versionId: string
    presentedAt: Instant
    submittedAt: Instant
    now: Instant
  },
): { attemptId: string; itemId: string } {
  const session = createSession(
    db,
    userId,
    projectId,
    { subject_id: options.subjectId, question_ids: [options.questionId], mode: 'practice' },
    options.now,
  )
  const item = findRows(db, 'practice_session_item', { session_id: String(session.id) })[0]
  if (item === undefined) throw new Error('fixture session was created without its item')
  presentItem(db, userId, String(item.id), options.presentedAt)
  const submitted = submitAttempt(
    db,
    userId,
    String(item.id),
    {
      raw_answer: answerForVersion(db, options.versionId),
      steps: [],
      confidence: '',
    },
    options.submittedAt,
  )
  // The learner is done with this one-question session. Django's command leaves it open (it only
  // ever runs on a fresh database), but this seeder is re-runnable: an open session would block
  // archiving the previous fixture generation (`存在进行中的练习会话`).
  finishSession(db, userId, String(session.id), options.submittedAt)
  return { attemptId: String(submitted.attempt.id), itemId: String(item.id) }
}

/**
 * `_seed_delayed_verification`: drive a real A → B → C chain so the review page has actual work.
 *
 * The chain is produced by the normal service path — grading an A attempt creates B, grading a B
 * attempt creates C — and only C's deadline is then moved into the past so the browser can start it.
 * The anchor is computed by the real rule, which is what the browser test asserts about. Nothing here
 * writes a task row by hand; a hand-written row would make the acceptance case prove nothing.
 *
 * Returns the number of study tasks the pairing produced (Django returns the same count: 2).
 */
function seedDelayedVerification(
  db: DatabaseSync,
  userId: string,
  projectId: string,
  options: {
    subject: Record<string, unknown>
    nodes: Record<string, Record<string, unknown>>
    versions: Record<string, unknown>[]
    now: Instant
  },
): number {
  const now = options.now
  const subjectId = String(options.subject.id)
  const singles = options.versions.filter((version) => String(version.question_type) === 'single_choice')
  const [baseline, immediate, delayed] = singles
  if (baseline === undefined || immediate === undefined || delayed === undefined) return 0
  const nodeId = String(Object.values(options.nodes)[0].id)

  const targets = resolvePairingTargets(db, userId, projectId, {
    subject_id: subjectId,
    node_id: nodeId,
    baseline_question_id: String(baseline.question_id),
    immediate_question_id: String(immediate.question_id),
    delayed_question_id: String(delayed.question_id),
    delay_hours: 24,
  })
  const pairing = createVerificationPairing(
    db,
    userId,
    projectId,
    targets,
    { delayHours: 24, note: FIXTURE_NOTE },
    now,
  )

  const attemptA = answerOneQuestion(db, userId, projectId, {
    subjectId,
    questionId: String(baseline.question_id),
    versionId: String(baseline.id),
    presentedAt: now - 30n * HOUR_MICROS - 5n * MINUTE_MICROS,
    submittedAt: now - 30n * HOUR_MICROS,
    now,
  })
  // The submission itself already created B (Django's `learning.on_attempt_graded`); the explicit
  // call is the idempotent replay the command performs, and it keeps this fixture correct even if a
  // future submission path stops wiring the trigger.
  onAttemptGraded(db, attemptA.attemptId, now)

  const bTask = findRows(db, 'learning_study_task', {
    pairing_id: pairing.id,
    task_kind: 'paired_immediate',
  })[0]
  if (bTask === undefined || bTask.question_id === null || bTask.question_id === undefined) return 0
  const bVersion = findRows(db, 'question_bank_question_version', {
    question_id: bTask.question_id,
    status: 'published',
  }).sort((left, right) => Number(right.version) - Number(left.version))[0]
  if (bVersion === undefined) return 0

  const attemptB = answerOneQuestion(db, userId, projectId, {
    subjectId,
    questionId: String(bTask.question_id),
    versionId: String(bVersion.id),
    presentedAt: now - 35n * MINUTE_MICROS,
    submittedAt: now - 30n * MINUTE_MICROS,
    now,
  })
  onAttemptGraded(db, attemptB.attemptId, now)

  const cTask = findRows(db, 'learning_study_task', {
    pairing_id: pairing.id,
    task_kind: 'delayed_verification',
    origin_session_item_id: attemptB.itemId,
  })[0]
  if (cTask === undefined) return 0

  // Only the deadline moves: the anchor stays what the production rule computed from B.
  const due = now - MINUTE_MICROS
  updateRow(db, 'learning_study_task', cTask.id, { not_before: due, due_at: due }, { now })
  for (const review of findRows(db, 'learning_review_task', { study_task_id: cTask.id })) {
    updateRow(db, 'learning_review_task', review.id, { not_before: due }, { now })
  }
  return findRows(db, 'learning_study_task', { pairing_id: pairing.id }).length
}

/**
 * Retire the previous generation of the fixture.
 *
 * Django archives any same-name project before rebuilding. That alone cannot work in either
 * implementation, because `uniq_project_name_per_owner` is unconditional and `create_project`
 * refuses a name that exists "even archived" — so re-running Django's command on a used database
 * raises `已存在同名项目`. The seeder therefore *renames* the old generation out of the way first
 * (a plain `update_project`, the same call the rename UI makes), then archives it. The archived rows
 * keep every subject/question/attempt they had; only the name gains a timestamp so the new
 * generation can carry the exact name the acceptance suite asserts on.
 *
 * Returns the archived projects, so the summary can say what this run replaced.
 */
function retirePreviousFixture(
  db: DatabaseSync,
  userId: string,
  dataRoot: string,
  now: Instant,
): { id: string; name: string; retired_name: string }[] {
  const retired: { id: string; name: string; retired_name: string }[] = []
  const projects = listProjects(db, userId, { includeArchived: true })
  const stamp = formatPythonIso(now).replaceAll(/[^0-9TZ]/g, '').slice(0, 15)
  for (const name of FIXTURE_PROJECT_NAMES) {
    const existing = projects.find((project) => String(project.name) === name)
    if (existing === undefined) continue
    if (existing.is_archived) {
      // An archived project still owns the name. Nothing in the service layer can free it, and
      // deleting history is not the seeder's call, so say exactly what happened and stop.
      throw new Error(
        `data root ${dataRoot} already holds an archived fixture project named ${name}; ` +
          'the unique project name cannot be reused. Seed a fresh --data-root instead.',
      )
    }
    const base = `${name}（验收归档 ${stamp}）`
    let retiredName = base
    for (let attempt = 2; ; attempt += 1) {
      const clash = projects.some((project) => String(project.name) === retiredName)
      if (!clash) break
      retiredName = `${base}-${attempt}`
    }
    updateProject(db, userId, String(existing.id), { name: retiredName }, now)
    archiveProject(db, userId, String(existing.id), { reason: '验收夹具重建', now })
    retired.push({ id: String(existing.id), name, retired_name: retiredName })
  }
  return retired
}

/**
 * Build the fixture in an already-open store.
 *
 * Pure with respect to the filesystem: the caller owns the store handle, which is what lets the
 * test drive it without a second process.
 */
export function buildAcceptanceFixtureInStore(
  db: DatabaseSync,
  options: { now: Instant; dataRoot?: string },
): AcceptanceSeedSummary {
  const now = options.now
  const dataRoot = options.dataRoot ?? ''
  const userId = ensureOwner(db, now)
  ensureSettings(db, userId, now)
  // Django's `build()` sets this before anything else; the acceptance cases depend on the budget.
  patchStudySettings(db, userId, { daily_budget_minutes: 90 }, now)

  const archived = retirePreviousFixture(db, userId, dataRoot, now)

  const projectA = createProject(db, userId, { name: PROJECT_A }, now)
  const projectB = createProject(db, userId, { name: PROJECT_B }, now)

  let published = 0
  const byType: Record<string, number> = {}
  SUBJECT_NAMES.forEach((subjectName, index) => {
    const projectId = index < 2 ? String(projectA.id) : String(projectB.id)
    const subject = createSubject(
      db,
      userId,
      projectId,
      { name: subjectName, total_score: '100', pass_score: '60' },
      now,
    )
    const spec = publishedSpec(db, userId, projectId, subject, index === 0, now)
    const syllabus = publishedSyllabus(db, userId, projectId, String(subject.id), now)
    const nodes = createNodes(
      db,
      userId,
      projectId,
      syllabus,
      ['验收考点一', '验收考点二', '验收考点三'],
      now,
    )
    const versions = seedSubject(db, userId, projectId, {
      subject,
      spec,
      nodes,
      labelPrefix: FIXTURE_PREFIX,
      now,
    })
    published += versions.length
    for (const source of BLUEPRINT_SOURCE) {
      byType[source.questionType] = (byType[source.questionType] ?? 0) + 1
    }
  })

  // The delayed-verification chain used to share a project with the other scenarios; Django moved
  // it to its own project precisely because an earlier test revealing an answer on the same point
  // silently un-did the "C is due" setup. The project and its structure are still built here; only
  // the chain is blocked (see the module docstring).
  const projectC = createProject(db, userId, { name: PROJECT_C }, now)
  const subjectC = createSubject(
    db,
    userId,
    String(projectC.id),
    { name: SUBJECT_C, total_score: '100', pass_score: '60' },
    now,
  )
  const specC = publishedSpec(db, userId, String(projectC.id), subjectC, false, now)
  const syllabusC = publishedSyllabus(db, userId, String(projectC.id), String(subjectC.id), now)
  const nodesC = createNodes(
    db,
    userId,
    String(projectC.id),
    syllabusC,
    ['验收延迟考点一', '验收延迟考点二', '验收延迟考点三'],
    now,
  )
  const versionsC = seedSubject(db, userId, String(projectC.id), {
    subject: subjectC,
    spec: specC,
    nodes: nodesC,
    labelPrefix: '验收延迟',
    now,
  })
  published += versionsC.length
  for (const source of BLUEPRINT_SOURCE) {
    byType[source.questionType] = (byType[source.questionType] ?? 0) + 1
  }

  // `_seed_delayed_verification`: a real A → B → C chain, then C's deadline moved into the past.
  const delayedTasks = seedDelayedVerification(db, userId, String(projectC.id), {
    subject: subjectC,
    nodes: nodesC,
    versions: versionsC,
    now,
  })

  const cycle = seedCycleAnalysisSubject(db, userId, String(projectB.id), now)

  // B10: consume the fixture's own events with the fixture clock (see `AcceptanceSeedSummary`).
  // The helper is the production worker's bounded drain, so the fixture exercises the same handlers
  // the acceptance server will run — no second implementation.
  const outbox = drain(db, now, { limit: 500, maxRounds: 500 })
  if (outbox.failed > 0) {
    throw new Error(`fixture left ${outbox.failed} outbox event(s) unconsumed with the seeding clock`)
  }

  const subjects =
    listSubjects(db, userId, String(projectA.id)).length +
    listSubjects(db, userId, String(projectB.id)).length +
    listSubjects(db, userId, String(projectC.id)).length

  return {
    email: 'owner@acepass.local',
    project_a: String(projectA.id),
    project_b: String(projectB.id),
    project_c: String(projectC.id),
    subjects,
    published_versions: published,
    published_versions_by_type: byType,
    delayed_verification_tasks: delayedTasks,
    cycle_subject_id: String(cycle.subject.id),
    cycle_subject_name: String(cycle.subject.name),
    complete_cycles: [...CYCLE_YEARS],
    incomplete_cycle: CYCLE_INCOMPLETE_YEAR,
    cycle_scored_items: cycle.countedItems,
    skipped: [],
    data_root: dataRoot,
    archived_projects: archived,
    seeded_at: formatPythonIso(now),
    outbox,
  }
}

/**
 * Open `<dataRoot>/acepass.sqlite`, build the fixture, close.
 *
 * This is the entry the CLI and the test both use; it is why `--data-root` is the only required
 * argument: the data root *is* the fixture's identity, and seeding a different one cannot collide.
 */
export function seedAcceptanceFixture(options: AcceptanceSeedOptions): AcceptanceSeedSummary {
  const dataRoot = options.dataRoot
  const storePath = join(dataRoot, 'acepass.sqlite')
  mkdirSync(dirname(storePath), { recursive: true })
  const store = openStore({ path: storePath })
  try {
    return buildAcceptanceFixtureInStore(store.db, {
      now: options.now ?? fromDate(new Date()),
      dataRoot,
    })
  } finally {
    store.close()
  }
}
