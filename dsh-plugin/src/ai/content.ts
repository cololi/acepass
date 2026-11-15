/**
 * Port of `apps/common/content.py`'s structural contract.
 *
 * The AI validators call `validate_content()` and quote its problems verbatim (`extract` prefixes the
 * code with `content.`, `propose_variant` keeps code/message/path/severity untouched), so the audit
 * row a human reads is produced by this function. It is duplicated here — rather than imported from
 * the future store layer — because `src/ai/**` must stay dependency-free and pure; the store layer's
 * publish gate and this validator must agree, which the golden vectors from the real Python
 * implementation pin.
 */
import { Decimal, DecimalError } from '../domain/decimal.ts'
import { isPyNumber, pyLen, pyRepr, pyStr, pyStrip, pyTruthy, PY_SPACE_CLASS } from './pyvalue.ts'

export const BLOCK_KINDS = ['text', 'math', 'image', 'table'] as const
export const MAX_BLOCKS = 120
export const MAX_OPTIONS = 26
export const MAX_BLANKS = 20
export const MAX_TEXT_LENGTH = 8000

export const QUESTION_TYPES = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'fill_blank',
  'constructed_response',
  'material',
] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

/** Question types that can carry a score and receive an attempt (`SCORABLE_LEAF_TYPES`). */
export const SCORABLE_LEAF_TYPES: readonly QuestionType[] = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'fill_blank',
  'constructed_response',
]

export interface ContentIssue {
  code: string
  message: string
  path: string
  severity: string
}

const HTML_PATTERN = new RegExp(`<${PY_SPACE_CLASS}*/?${PY_SPACE_CLASS}*[a-zA-Z][^>]*>`)
const SCRIPT_PATTERN = /(javascript:|data:text\/html|<script)/i
const OPTION_ID_PATTERN = /^[A-Za-z0-9_\-]{1,40}$/
const BLANK_ID_PATTERN = /^[A-Za-z0-9_\-]{1,40}$/

/**
 * `re.IGNORECASE` is not `toLowerCase()` for four characters: CPython's docs call out that
 * `[a-z]` also matches `İ`, `ı`, `ſ` and the Kelvin sign `K`. Folding them keeps the script check
 * aligned with Python instead of quietly accepting `<ſcript>` that Python would reject.
 */
function pyIgnoreCase(text: string): string {
  return text.replaceAll('İ', 'i').replaceAll('ı', 'i').replaceAll('ſ', 's').replaceAll('\u212a', 'k').toLowerCase()
}

function scriptMatches(text: string): boolean {
  return SCRIPT_PATTERN.test(text) || /(?:javascript:|data:text\/html|<script)/.test(pyIgnoreCase(text))
}

export function contentIssue(code: string, message: string, path = '', severity = 'blocking'): ContentIssue {
  return { code, message, path, severity }
}

/** `uuid.UUID(str(value))` acceptance for the shapes a JSON payload can carry. */
function isValidUuidText(raw: string): boolean {
  let text = raw
  if (text.startsWith('urn:uuid:')) text = text.slice('urn:uuid:'.length)
  if (text.startsWith('{') && text.endsWith('}')) text = text.slice(1, -1)
  return (
    /^[0-9a-fA-F]{32}$/.test(text) ||
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(text)
  )
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  // `PyNumber` is a wrapper object, not a JSON object; Python would see a number here.
  value !== null && typeof value === 'object' && !Array.isArray(value) && !isPyNumber(value) ? (value as Record<string, unknown>) : null

function fieldOf(map: Record<string, unknown>, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(map, key) ? map[key] : fallback
}

function validateBlocks(blocks: unknown, path: string, problems: ContentIssue[]): void {
  if (blocks === null || blocks === undefined) return
  if (!Array.isArray(blocks)) {
    problems.push(contentIssue('blocks_not_list', '题干块必须是数组', path))
    return
  }
  if (blocks.length > MAX_BLOCKS) problems.push(contentIssue('too_many_blocks', `题干块数量超过上限 ${MAX_BLOCKS}`, path))
  blocks.forEach((block, index) => {
    const blockPath = `${path}[${index}]`
    const map = asRecord(block)
    if (map === null) {
      problems.push(contentIssue('block_not_object', '题干块必须是对象', blockPath))
      return
    }
    const kind = fieldOf(map, 'kind')
    if (typeof kind !== 'string' || !(BLOCK_KINDS as readonly string[]).includes(kind)) {
      // The Python message uses `{kind!r}`, i.e. `repr`, so a string kind is quoted.
      problems.push(contentIssue('unknown_block_kind', `不支持的题干块类型：${pyRepr(kind)}`, blockPath))
      return
    }
    if (kind === 'text') {
      const text = fieldOf(map, 'text', '')
      if (typeof text !== 'string') {
        problems.push(contentIssue('text_not_string', '文本块内容必须是字符串', blockPath))
        return
      }
      if (pyLen(text) > MAX_TEXT_LENGTH) problems.push(contentIssue('text_too_long', '文本块过长', blockPath))
      if (HTML_PATTERN.test(text) || scriptMatches(text)) {
        problems.push(contentIssue('raw_html_rejected', '题干不允许包含 HTML 或脚本', blockPath))
      }
    } else if (kind === 'math') {
      const latex = fieldOf(map, 'latex', '')
      if (typeof latex !== 'string' || pyStrip(latex) === '') {
        problems.push(contentIssue('math_empty', '公式块缺少 latex 内容', blockPath))
      } else if (scriptMatches(latex)) {
        problems.push(contentIssue('raw_html_rejected', '公式块包含可疑内容', blockPath))
      }
    } else if (kind === 'image') {
      const assetId = fieldOf(map, 'asset_id')
      const regionId = fieldOf(map, 'region_id')
      if (!pyTruthy(assetId) && !pyTruthy(regionId)) {
        problems.push(contentIssue('image_without_source', '图片块必须引用本项目的资产或来源区域', blockPath))
      }
      for (const [key, value] of [['asset_id', assetId], ['region_id', regionId]] as const) {
        // Python skips only `None` and `""`; `0`/`False` fall through to the UUID parse.
        if (value === null || value === undefined || value === '') continue
        if (!isValidUuidText(pyStr(value))) {
          problems.push(contentIssue(`${key}_invalid`, `${key} 必须是 UUID`, blockPath))
        }
      }
    } else if (kind === 'table') {
      const rows = fieldOf(map, 'rows')
      if (!Array.isArray(rows) || rows.length === 0) {
        problems.push(contentIssue('table_without_rows', '表格块必须包含至少一行', blockPath))
        return
      }
      rows.forEach((row, rowIndex) => {
        if (!Array.isArray(row)) {
          problems.push(contentIssue('table_row_not_list', '表格行必须是数组', `${blockPath}.rows[${rowIndex}]`))
          return
        }
        row.forEach((cell, cellIndex) => {
          if (typeof cell === 'string') return
          const cellMap = asRecord(cell)
          if (cellMap === null || typeof fieldOf(cellMap, 'text', '') !== 'string') {
            problems.push(
              contentIssue('table_cell_invalid', '表格单元格必须是字符串或 {text} 对象', `${blockPath}.rows[${rowIndex}][${cellIndex}]`),
            )
          }
        })
      })
    }
  })
}

function validateOptions(options: unknown, problems: ContentIssue[]): void {
  if (options === null || options === undefined) return
  if (!Array.isArray(options)) {
    problems.push(contentIssue('options_not_list', '选项必须是数组', 'options'))
    return
  }
  if (options.length === 0) {
    problems.push(contentIssue('options_empty', '选择题必须至少有一个选项', 'options'))
    return
  }
  if (options.length > MAX_OPTIONS) problems.push(contentIssue('too_many_options', `选项数量超过上限 ${MAX_OPTIONS}`, 'options'))
  const seen = new Set<string>()
  options.forEach((option, index) => {
    const path = `options[${index}]`
    const map = asRecord(option)
    if (map === null) {
      problems.push(contentIssue('option_not_object', '选项必须是对象', path))
      return
    }
    const optionId = fieldOf(map, 'id')
    if (typeof optionId !== 'string' || !OPTION_ID_PATTERN.test(optionId)) {
      problems.push(contentIssue('option_id_invalid', '选项 ID 必须稳定且仅含字母数字_-', path))
      return
    }
    if (seen.has(optionId)) problems.push(contentIssue('option_id_duplicate', `选项 ID 重复：${optionId}`, path))
    seen.add(optionId)
    validateBlocks(fieldOf(map, 'blocks'), `${path}.blocks`, problems)
    const label = fieldOf(map, 'label', '')
    if (pyTruthy(label) && typeof label !== 'string') {
      problems.push(contentIssue('option_label_invalid', '选项标签必须是字符串', path))
    }
  })
}

function validateBlanks(blanks: unknown, problems: ContentIssue[]): void {
  if (blanks === null || blanks === undefined) return
  if (!Array.isArray(blanks)) {
    problems.push(contentIssue('blanks_not_list', '空位定义必须是数组', 'blanks'))
    return
  }
  if (blanks.length === 0) {
    problems.push(contentIssue('blanks_empty', '填空题必须定义至少一个空位', 'blanks'))
    return
  }
  if (blanks.length > MAX_BLANKS) problems.push(contentIssue('too_many_blanks', `空位数量超过上限 ${MAX_BLANKS}`, 'blanks'))
  const seen = new Set<string>()
  blanks.forEach((blank, index) => {
    const path = `blanks[${index}]`
    const map = asRecord(blank)
    if (map === null) {
      problems.push(contentIssue('blank_not_object', '空位必须是对象', path))
      return
    }
    const blankId = fieldOf(map, 'blank_id')
    if (typeof blankId !== 'string' || !BLANK_ID_PATTERN.test(blankId)) {
      problems.push(contentIssue('blank_id_invalid', '空位 ID 必须稳定且仅含字母数字_-', path))
      return
    }
    if (seen.has(blankId)) problems.push(contentIssue('blank_id_duplicate', `空位 ID 重复：${blankId}`, path))
    seen.add(blankId)
    validateBlocks(fieldOf(map, 'blocks'), `${path}.blocks`, problems)
    const maxScore = fieldOf(map, 'max_score')
    if (maxScore !== null && maxScore !== undefined) {
      try {
        if (Decimal.parse(pyStr(maxScore)).lt(Decimal.zero())) {
          problems.push(contentIssue('blank_score_negative', '空位分值不能为负', path))
        }
      } catch (error) {
        if (!(error instanceof DecimalError)) throw error
        problems.push(contentIssue('blank_score_invalid', '空位分值必须是十进制数', path))
      }
    }
  })
}

/** Return every structural problem for one content payload, in the Python emission order. */
export function validateContent(content: unknown, questionType: string): ContentIssue[] {
  const problems: ContentIssue[] = []
  const map = asRecord(content)
  if (map === null) return [contentIssue('content_not_object', '内容必须是对象', 'content')]
  if (!(QUESTION_TYPES as readonly string[]).includes(questionType)) {
    return [contentIssue('unknown_question_type', `未知题型：${pyRepr(questionType)}`, 'type')]
  }
  const blocks = pyTruthy(fieldOf(map, 'blocks')) ? fieldOf(map, 'blocks') : []
  validateBlocks(blocks, 'blocks', problems)
  if (questionType !== 'material' && !pyTruthy(blocks)) {
    problems.push(contentIssue('stem_empty', '题干不能为空', 'blocks'))
  }
  if (questionType === 'single_choice' || questionType === 'multiple_choice') {
    validateOptions(fieldOf(map, 'options'), problems)
  } else if (questionType === 'fill_blank') {
    validateBlanks(fieldOf(map, 'blanks'), problems)
  }
  return problems
}

/** `option_ids(content)`: raw ids, only for dict options whose id is truthy. */
export function optionIds(content: unknown): unknown[] {
  const map = asRecord(content)
  if (map === null) return []
  const options = fieldOf(map, 'options')
  if (!Array.isArray(options)) return []
  return options.flatMap((option) => {
    const item = asRecord(option)
    if (item === null) return []
    const id = fieldOf(item, 'id')
    return pyTruthy(id) ? [id] : []
  })
}

/** `blank_ids(content)`: raw ids, only for dict blanks whose blank_id is truthy. */
export function blankIds(content: unknown): unknown[] {
  const map = asRecord(content)
  if (map === null) return []
  const blanks = fieldOf(map, 'blanks')
  if (!Array.isArray(blanks)) return []
  return blanks.flatMap((blank) => {
    const item = asRecord(blank)
    if (item === null) return []
    const id = fieldOf(item, 'blank_id')
    return pyTruthy(id) ? [id] : []
  })
}
