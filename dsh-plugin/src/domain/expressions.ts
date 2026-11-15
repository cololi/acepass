/**
 * Restricted math-expression engine for formula blanks (acceptance C07) — port of
 * `backend/domain/grading/expressions.py`.
 *
 * SAFETY CONTRACT (R-INV, docs/05 §3): this file is the only place a learner-written formula may
 * receive a numeric meaning. It is a hand-written tokenizer + recursive-descent parser + tree walker:
 * no `eval`, no `new Function`, no `vm`, no dynamic `import`, no property access on input, no I/O.
 * `tests/expressions.test.ts` enforces that statically on this very file.
 *
 * Verdicts are three-valued; `unknown` means "a human must look" and is never wrong/correct.
 *
 * Known, deliberate divergence from the Python source: non-ASCII decimal digits (e.g. Arabic-Indic)
 * are rejected as illegal characters, where Python's `\d` + `float()` would accept them. Rejecting
 * routes the answer to human review, which is the safe direction. Everything else is bit-identical
 * on the golden vectors (tests/golden/expressions.json).
 */
import { pyFloatRepr, pyFormatG, pyIsSpace, pyStrRepr } from './pyfmt.ts'

export const MAX_INPUT_LENGTH = 200
export const MAX_TOKENS = 160
export const MAX_AST_NODES = 128
export const MAX_DEPTH = 12
export const MAX_EVAL_STEPS = 4000
export const MAX_EXPONENT_MAGNITUDE = 64
export const MAX_ABS_RESULT = 1e30
export const MAX_VARIABLES = 2
export const MAX_SAMPLES = 24
export const DEFAULT_TIME_BUDGET_SECONDS = 0.05
export const MAX_TIME_BUDGET_SECONDS = 2.0
export const DEFAULT_TOLERANCE = 1e-9
export const SAMPLE_SEED = 20260214
const TIME_CHECK_INTERVAL = 32

const FUNCTIONS = ['sqrt', 'abs', 'sin', 'cos', 'tan', 'log', 'ln', 'exp'] as const
type FnName = (typeof FUNCTIONS)[number]
const isFunction = (name: string): name is FnName => (FUNCTIONS as readonly string[]).includes(name)
const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E }
const PARTIAL_FUNCTIONS: ReadonlySet<string> = new Set(['sqrt', 'log', 'ln'])

export const OUTCOME_EQUIVALENT = 'equivalent'
export const OUTCOME_NOT_EQUIVALENT = 'not_equivalent'
export const OUTCOME_UNKNOWN = 'unknown'
export type Outcome = typeof OUTCOME_EQUIVALENT | typeof OUTCOME_NOT_EQUIVALENT | typeof OUTCOME_UNKNOWN
export type ErrorType = 'syntax' | 'limit' | 'domain' | 'timeout'

export class ExpressionError extends Error { readonly code: string = 'expression' }
export class ExpressionSyntaxError extends ExpressionError { override readonly code: ErrorType = 'syntax' }
export class ExpressionLimitError extends ExpressionError { override readonly code: ErrorType = 'limit' }
export class ExpressionDomainError extends ExpressionError { override readonly code: ErrorType = 'domain' }
export class ExpressionTimeout extends ExpressionError { override readonly code: ErrorType = 'timeout' }

export interface ExpressionVerdict {
  outcome: Outcome
  reason: string
  errorType: string | null
  samplesChecked: number
  sample: Record<string, number> | null
}
/** Wire shape identical to Python's `ExpressionVerdict.as_dict()`. */
export function verdictToDict(v: ExpressionVerdict): Record<string, unknown> {
  return { outcome: v.outcome, reason: v.reason, error_type: v.errorType, samples_checked: v.samplesChecked, sample: v.sample && Object.keys(v.sample).length > 0 ? { ...v.sample } : null } // `{}` is falsy in Python
}

// ------------------------------------------------------------------ tokens
interface Token { kind: 'num' | 'name' | 'op' | 'lparen' | 'rparen'; text: string; value?: number }
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
const isNameStart = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z_]$/.test(c)
const isNameChar = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9_]$/.test(c)

function tokenize(source: unknown): Token[] {
  if (typeof source !== 'string') throw new ExpressionSyntaxError('表达式必须是字符串')
  const chars = Array.from(source) // code points, as Python's str
  if (chars.length > MAX_INPUT_LENGTH) throw new ExpressionLimitError(`表达式长度超过上限（MAX_INPUT_LENGTH=${MAX_INPUT_LENGTH}）`)
  const tokens: Token[] = []
  let pos = 0
  while (pos < chars.length) {
    const ch = chars[pos]
    if (pyIsSpace(ch)) { pos++; continue }
    const start = pos
    let kind: Token['kind'] | null = null
    if (isDigit(ch) || (ch === '.' && isDigit(chars[pos + 1]))) {
      // (?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?
      if (ch === '.') { pos++; while (isDigit(chars[pos])) pos++ }
      else { while (isDigit(chars[pos])) pos++; if (chars[pos] === '.') pos++; while (isDigit(chars[pos])) pos++ }
      if (chars[pos] === 'e' || chars[pos] === 'E') {
        let q = pos + 1
        if (chars[q] === '+' || chars[q] === '-') q++
        if (isDigit(chars[q])) { while (isDigit(chars[q])) q++; pos = q }
      }
      kind = 'num'
    } else if (isNameStart(ch)) {
      while (isNameChar(chars[pos])) pos++
      kind = 'name'
    } else if ('+-*/^'.includes(ch)) { pos++; kind = 'op' }
    else if (ch === '(') { pos++; kind = 'lparen' }
    else if (ch === ')') { pos++; kind = 'rparen' }
    if (kind === null)
      throw new ExpressionSyntaxError(`非法字符 ${pyStrRepr(ch)}（位置 ${start}）：表达式只允许数字、运算符、括号和白名单符号`)
    const text = chars.slice(start, pos).join('')
    if (kind === 'num') {
      const value = Number(text)
      if (!Number.isFinite(value)) throw new ExpressionLimitError(`数值超出允许范围：${pyStrRepr(text)}`)
      tokens.push({ kind, text, value })
    } else tokens.push({ kind, text })
    if (tokens.length > MAX_TOKENS) throw new ExpressionLimitError(`表达式 token 数超过上限（MAX_TOKENS=${MAX_TOKENS}）`)
  }
  if (tokens.length === 0) throw new ExpressionSyntaxError('表达式为空')
  return tokens
}

// --------------------------------------------------------------------- AST
type Node =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'neg'; left: Node }
  | { kind: 'call'; name: string; left: Node }
  | { kind: 'bin'; op: string; left: Node; right: Node }

class Parser {
  position = 0
  nodes = 0
  depth = 0
  private readonly tokens: Token[]
  private readonly variables: Set<string> | null
  constructor(tokens: Token[], variables: Set<string> | null) { this.tokens = tokens; this.variables = variables }

  private peek(): Token | undefined { return this.tokens[this.position] }
  private next(): Token { return this.tokens[this.position++] }
  private mk<N extends Node>(node: N): N {
    if (++this.nodes > MAX_AST_NODES) throw new ExpressionLimitError(`表达式 AST 节点数超过上限（MAX_AST_NODES=${MAX_AST_NODES}）`)
    return node
  }
  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new ExpressionLimitError(`表达式嵌套深度超过上限（MAX_DEPTH=${MAX_DEPTH}）`)
  }
  private leave(): void { this.depth-- }

  parse(): Node {
    const node = this.expression()
    const leftover = this.peek()
    if (leftover) throw new ExpressionSyntaxError(`表达式存在多余内容 ${pyStrRepr(leftover.text)}（位置 ${this.position}）`)
    return node
  }
  private expression(): Node {
    let node = this.term()
    for (;;) {
      const t = this.peek()
      if (!t || t.kind !== 'op' || (t.text !== '+' && t.text !== '-')) return node
      this.next()
      node = this.mk({ kind: 'bin', op: t.text, left: node, right: this.term() })
    }
  }
  private term(): Node {
    let node = this.unary()
    for (;;) {
      const t = this.peek()
      if (t && t.kind === 'op' && (t.text === '*' || t.text === '/')) {
        this.next()
        node = this.mk({ kind: 'bin', op: t.text, left: node, right: this.unary() })
      } else if (t && (t.kind === 'name' || t.kind === 'lparen')) {
        node = this.mk({ kind: 'bin', op: '*', left: node, right: this.unary() }) // implicit multiplication
      } else return node
    }
  }
  private unary(): Node {
    this.enter()
    try {
      const t = this.peek()
      if (t && t.kind === 'op' && (t.text === '+' || t.text === '-')) {
        this.next()
        const operand = this.unary()
        return t.text === '+' ? operand : this.mk({ kind: 'neg', left: operand })
      }
      return this.power()
    } finally { this.leave() }
  }
  private power(): Node {
    const base = this.primary()
    const t = this.peek()
    if (t && t.kind === 'op' && t.text === '^') {
      this.next()
      return this.mk({ kind: 'bin', op: '^', left: base, right: this.unary() }) // right-assoc, signed exponent
    }
    return base
  }
  private primary(): Node {
    const t = this.peek()
    if (!t) throw new ExpressionSyntaxError('表达式意外结束')
    if (t.kind === 'num') { this.next(); return this.mk({ kind: 'num', value: t.value! }) }
    if (t.kind === 'lparen') {
      this.next(); this.enter()
      let inner: Node
      try { inner = this.expression() } finally { this.leave() }
      this.expectRparen()
      return inner
    }
    if (t.kind === 'name') {
      this.next()
      const name = t.text.toLowerCase()
      const following = this.peek()
      if (following && following.kind === 'lparen') {
        if (!isFunction(name)) throw new ExpressionSyntaxError(`未知函数 ${pyStrRepr(t.text)}：只允许 ${[...FUNCTIONS].sort().join(', ')}`)
        this.next(); this.enter()
        let argument: Node
        try { argument = this.expression() } finally { this.leave() }
        this.expectRparen()
        return this.mk({ kind: 'call', name, left: argument })
      }
      if (isFunction(name)) throw new ExpressionSyntaxError(`函数 ${pyStrRepr(t.text)} 缺少括号参数`)
      if (Object.hasOwn(CONSTANTS, name)) return this.mk({ kind: 'num', value: CONSTANTS[name] })
      if (this.variables !== null && !this.variables.has(name)) throw new ExpressionSyntaxError(`未知符号 ${pyStrRepr(t.text)}：不在允许的变量白名单中`)
      return this.mk({ kind: 'var', name })
    }
    throw new ExpressionSyntaxError(`意外的符号 ${pyStrRepr(t.text)}（位置 ${this.position}）`)
  }
  private expectRparen(): void {
    const t = this.peek()
    if (!t || t.kind !== 'rparen') throw new ExpressionSyntaxError('括号不匹配')
    this.next()
  }
}
const parse = (source: unknown, variables: Set<string> | null): Node => new Parser(tokenize(source), variables).parse()

// -------------------------------------------------------------- evaluation
function budgetOf(seconds: unknown): number {
  if (seconds === undefined || seconds === null) return DEFAULT_TIME_BUDGET_SECONDS
  const value = Number(seconds)
  if (Number.isNaN(value) && typeof seconds !== 'number') return DEFAULT_TIME_BUDGET_SECONDS
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(value, MAX_TIME_BUDGET_SECONDS)
}
const nowSeconds = (): number => performance.now() / 1000

class Evaluator {
  steps = 0
  private readonly budget: number
  private readonly deadline: number
  private variables: Record<string, number>
  constructor(budget: number, deadline: number, variables: Record<string, number> = {}) {
    this.budget = budget; this.deadline = deadline; this.variables = variables
  }

  run(node: Node, variables?: Record<string, number>): number {
    if (variables !== undefined) this.variables = variables
    this.checkDeadline()
    return this.evalNode(node)
  }
  private checkDeadline(): void {
    if (nowSeconds() >= this.deadline)
      throw new ExpressionTimeout(`表达式判分超时（时间预算 ${(this.budget * 1000).toFixed(1)} ms，MAX_TIME_BUDGET_SECONDS=${pyFloatRepr(MAX_TIME_BUDGET_SECONDS)}）`)
  }
  private tick(): void {
    if (++this.steps > MAX_EVAL_STEPS) throw new ExpressionLimitError(`表达式求值步数超过上限（MAX_EVAL_STEPS=${MAX_EVAL_STEPS}）`)
    if (this.steps % TIME_CHECK_INTERVAL === 0) this.checkDeadline()
  }
  private finite(value: number): number {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_RESULT)
      throw new ExpressionLimitError(`数值超出允许范围（MAX_ABS_RESULT=${pyFormatG(MAX_ABS_RESULT)}）`)
    return value
  }
  private evalNode(node: Node): number {
    this.tick()
    switch (node.kind) {
      case 'num': return this.finite(node.value)
      case 'var': {
        const raw = Object.hasOwn(this.variables, node.name) ? this.variables[node.name] : undefined
        if (typeof raw !== 'number' || Number.isNaN(raw)) throw new ExpressionDomainError(`变量 ${pyStrRepr(node.name)} 没有赋值`)
        return this.finite(raw)
      }
      case 'neg': return this.finite(-this.evalNode(node.left))
      case 'call': return this.call(node.name as FnName, this.evalNode(node.left))
      case 'bin': {
        const left = this.evalNode(node.left)
        const right = this.evalNode(node.right)
        switch (node.op) {
          case '+': return this.finite(left + right)
          case '-': return this.finite(left - right)
          case '*': return this.finite(left * right)
          case '/':
            if (right === 0) throw new ExpressionDomainError('除数为零')
            return this.finite(left / right)
          default: return this.pow(left, right) // '^'
        }
      }
    }
  }
  private call(name: FnName, x: number): number {
    const undefinedAt = (): never => { throw new ExpressionDomainError(`${name}(${pyFormatG(x)}) 在实数域无定义`) }
    let result: number
    switch (name) {
      case 'sqrt': if (x < 0) undefinedAt(); result = Math.sqrt(x); break
      case 'abs': result = Math.abs(x); break
      case 'sin': result = Math.sin(x); break
      case 'cos': result = Math.cos(x); break
      case 'tan': result = Math.tan(x); break
      case 'log': if (x <= 0) undefinedAt(); result = Math.log10(x); break
      case 'ln': if (x <= 0) undefinedAt(); result = Math.log(x); break
      case 'exp': result = Math.exp(x); break
    }
    if (result === Infinity) throw new ExpressionLimitError(`${name} 的结果超出允许范围（MAX_ABS_RESULT=${pyFormatG(MAX_ABS_RESULT)}）`)
    return this.finite(result)
  }
  private pow(left: number, right: number): number {
    if (Math.abs(right) > MAX_EXPONENT_MAGNITUDE)
      throw new ExpressionLimitError(`指数绝对值超过上限（MAX_EXPONENT_MAGNITUDE=${MAX_EXPONENT_MAGNITUDE}）`)
    const result = Math.pow(left, right)
    // CPython's math.pow: NaN or 0**negative -> ValueError, finite->inf -> OverflowError.
    if (Number.isNaN(result) || (left === 0 && right < 0)) throw new ExpressionDomainError('幂运算在实数域无定义（0 的负数次幂或负数的非整数次幂）')
    if (!Number.isFinite(result)) throw new ExpressionLimitError(`幂运算结果超出允许范围（MAX_ABS_RESULT=${pyFormatG(MAX_ABS_RESULT)}）`)
    return this.finite(result)
  }
}

export function toFloat(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value)
  throw new TypeError(`cannot convert ${typeof value} to float`)
}

/** Evaluate `expr` with a strict whitelist of names. Throws a typed {@link ExpressionError}. */
export function evaluate(expr: string, variables?: Record<string, unknown> | null, options: { timeBudget?: number } = {}): number {
  const bindings: Record<string, number> = Object.create(null)
  for (const [key, value] of Object.entries(variables ?? {})) {
    let number: number
    try { number = toFloat(value) } catch { throw new ExpressionDomainError(`变量 ${pyStrRepr(key)} 的值不是实数`) }
    if (!Number.isFinite(number)) throw new ExpressionDomainError(`变量 ${pyStrRepr(key)} 的值不是有限实数`)
    bindings[key.toLowerCase()] = number
  }
  const node = parse(expr, new Set(Object.keys(bindings)))
  const budget = budgetOf(options.timeBudget ?? DEFAULT_TIME_BUDGET_SECONDS)
  return new Evaluator(budget, nowSeconds() + budget, bindings).run(node)
}

// ------------------------------------------------------ normalisation
function isTotal(node: Node): boolean {
  switch (node.kind) {
    case 'num': case 'var': return true
    case 'neg': return isTotal(node.left)
    case 'call': return !PARTIAL_FUNCTIONS.has(node.name) && isTotal(node.left)
    case 'bin':
      if (node.op === '^') {
        const e = node.right
        if (e.kind !== 'num' || e.value < 0 || !Number.isInteger(e.value)) return false
      }
      return isTotal(node.left) && isTotal(node.right)
  }
}

function foldBinary(op: string, left: number, right: number): number | null {
  let value: number
  if (op === '+') value = left + right
  else if (op === '-') value = left - right
  else if (op === '*') value = left * right
  else if (op === '^') {
    if (Math.abs(right) > MAX_EXPONENT_MAGNITUDE) return null
    value = Math.pow(left, right)
  } else return null
  if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_RESULT) return null
  return value
}

const num = (value: number): Node => ({ kind: 'num', value })
const isNum = (n: Node, v: number): boolean => n.kind === 'num' && n.value === v

function fold(node: Node): Node {
  if (node.kind === 'num' || node.kind === 'var') return node
  if (node.kind === 'neg') {
    const operand = fold(node.left)
    if (operand.kind === 'num') return num(-operand.value)
    if (operand.kind === 'neg') return operand.left
    return { kind: 'neg', left: operand }
  }
  if (node.kind === 'call') return { kind: 'call', name: node.name, left: fold(node.left) }
  const left = fold(node.left)
  const right = fold(node.right)
  const op = node.op
  if (op === '/') return fold({ kind: 'bin', op: '*', left, right: { kind: 'bin', op: '^', left: right, right: num(-1) } })
  if (op === '^') {
    if (isNum(right, 1)) return left
    if (isNum(right, 0) && isTotal(left)) return num(1)
  }
  if (left.kind === 'num' && right.kind === 'num') {
    const folded = foldBinary(op, left.value, right.value)
    if (folded !== null) return num(folded)
  }
  if (op === '+') {
    if (isNum(left, 0)) return right
    if (isNum(right, 0)) return left
  } else if (op === '-') {
    if (isNum(right, 0)) return left
  } else if (op === '*') {
    if (isNum(left, 1)) return right
    if (isNum(right, 1)) return left
    if (isNum(left, 0) && isTotal(right)) return num(0)
    if (isNum(right, 0) && isTotal(left)) return num(0)
  }
  return { kind: 'bin', op, left, right }
}

function collectVariables(node: Node, names: Map<string, string>): Map<string, string> {
  if (node.kind === 'var') { if (!names.has(node.name)) names.set(node.name, `v${names.size}`) }
  else if (node.kind === 'neg' || node.kind === 'call') collectVariables(node.left, names)
  else if (node.kind === 'bin') { collectVariables(node.left, names); collectVariables(node.right, names) }
  return names
}

const numberText = (v: number): string => pyFloatRepr(v)
// Code-unit order == code-point order for the ASCII terms built here, so default sort matches Python's.
const sorted = (xs: string[]): string[] => [...xs].sort()

function render(node: Node, names: Map<string, string>): string {
  switch (node.kind) {
    case 'num': return numberText(node.value)
    case 'var': return names.get(node.name)!
    case 'neg':
      if (node.left.kind === 'num') return numberText(-node.left.value)
      return sumText(negatedTerms(node.left, names))
    case 'call': return `(${node.name} ${render(node.left, names)})`
    case 'bin':
      if (node.op === '+' || node.op === '-') return sumText(sumTerms(node, names))
      if (node.op === '*') return productText(productTerms(node, names))
      return `(^ ${render(node.left, names)} ${render(node.right, names)})`
  }
}
function sumTerms(node: Node, names: Map<string, string>): string[] {
  if (node.kind === 'neg') return negatedTerms(node.left, names)
  if (node.kind === 'bin' && node.op === '+') return [...sumTerms(node.left, names), ...sumTerms(node.right, names)]
  if (node.kind === 'bin' && node.op === '-') return [...sumTerms(node.left, names), ...negatedTerms(node.right, names)]
  if (node.kind === 'num' && node.value === 0) return []
  return [render(node, names)]
}
function negatedTerms(node: Node, names: Map<string, string>): string[] {
  if (node.kind === 'neg') return sumTerms(node.left, names)
  if (node.kind === 'bin' && node.op === '+') return [...negatedTerms(node.left, names), ...negatedTerms(node.right, names)]
  if (node.kind === 'bin' && node.op === '-') return [...negatedTerms(node.left, names), ...sumTerms(node.right, names)]
  if (node.kind === 'num') { const v = -node.value; return v === 0 ? [] : [numberText(v)] }
  return [`(neg ${render(node, names)})`]
}
function sumText(terms: string[]): string {
  const t = terms.filter(Boolean)
  if (t.length === 0) return numberText(0)
  if (t.length === 1) return t[0]
  return `(+ ${sorted(t).join(' ')})`
}
function productTerms(node: Node, names: Map<string, string>): string[] {
  if (node.kind === 'bin' && node.op === '*') return [...productTerms(node.left, names), ...productTerms(node.right, names)]
  if (node.kind === 'num' && node.value === 1) return []
  return [render(node, names)]
}
function productText(terms: string[]): string {
  const t = terms.filter(Boolean)
  if (t.length === 0) return numberText(1)
  if (t.length === 1) return t[0]
  return `(* ${sorted(t).join(' ')})`
}

export function normalizeExpression(expr: string): string {
  const folded = fold(parse(expr, null))
  return render(folded, collectVariables(folded, new Map()))
}
export function freeVariables(expr: string): string[] {
  return [...collectVariables(fold(parse(expr, null)), new Map()).keys()].sort()
}

// ---------------------------------------------------------------- sampling
export const SAMPLE_POINTS: readonly number[] = [-2, -1.5, -1, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 10]

/** Deterministic LCG; BigInt because 1103515245 * state exceeds 2**53. */
export function seededValues(count: number, seed: number = SAMPLE_SEED): number[] {
  let state = BigInt(seed) & 0x7fffffffn
  const values: number[] = []
  for (let i = 0; i < Math.max(0, count); i++) {
    state = (1103515245n * state + 12345n) & 0x7fffffffn
    values.push(Number((-3 + (Number(state) / 0x7fffffff) * 13).toFixed(6)))
  }
  return values
}
export function sampleValues(): number[] {
  return [...SAMPLE_POINTS, ...seededValues(MAX_SAMPLES - SAMPLE_POINTS.length)].slice(0, MAX_SAMPLES)
}
type Row = Record<string, number>
export function defaultRows(variableCount: number): Row[] {
  if (variableCount <= 0) return [{}]
  const values = sampleValues()
  if (variableCount === 1) return values.map((v) => ({ v0: v }))
  return values.map((_, i) => ({ v0: values[i], v1: values[(i * 5 + 3) % values.length] }))
}
function sampleRows(variableCount: number, samples: unknown): Row[] {
  if (samples === undefined || samples === null) return defaultRows(variableCount)
  if (!Array.isArray(samples)) throw new ExpressionLimitError('采样点必须是数值序列')
  const wanted = Math.max(1, variableCount)
  const rows: Row[] = []
  for (const item of samples) {
    if (rows.length >= MAX_SAMPLES) throw new ExpressionLimitError(`采样点数量超过上限（MAX_SAMPLES=${MAX_SAMPLES}）`)
    let row: Row
    try {
      if (item !== null && typeof item === 'object' && !Array.isArray(item))
        row = Object.fromEntries(Object.entries(item).map(([k, v]) => [String(k), toFloat(v)]))
      else if (Array.isArray(item)) row = Object.fromEntries(item.map((v, i) => [`v${i}`, toFloat(v)]))
      else if (wanted === 1 && typeof item !== 'boolean') row = { v0: toFloat(item) }
      else throw new ExpressionLimitError(`采样点格式无效：${wanted} 个变量需要 (v0, v1) 形式的采样点`)
    } catch (error) {
      if (error instanceof ExpressionError) throw error
      throw new ExpressionLimitError('采样点必须是实数')
    }
    const missing = Array.from({ length: wanted }, (_, i) => `v${i}`).filter((k) => !(k in row))
    if (missing.length) throw new ExpressionLimitError(`采样点缺少变量 ${missing.join(', ')}`)
    rows.push(row)
  }
  return rows
}

const close = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1)
const unknown = (exc: ExpressionError, samplesChecked = 0, sample: Row | null = null): ExpressionVerdict =>
  ({ outcome: OUTCOME_UNKNOWN, reason: exc.message, errorType: exc.code, samplesChecked, sample })
const timeoutVerdict = (budget: number, samplesChecked = 0): ExpressionVerdict =>
  unknown(new ExpressionTimeout(`表达式判分超时（时间预算 ${(budget * 1000).toFixed(1)} ms，MAX_TIME_BUDGET_SECONDS=${pyFloatRepr(MAX_TIME_BUDGET_SECONDS)}）`), samplesChecked)

export interface CompareOptions { samples?: unknown; tolerance?: number; timeBudget?: number }

/**
 * Same function, different function, or unknown. `equivalent` only when EVERY sample point
 * evaluates and agrees; any syntax error, unknown symbol, limit or timeout is `unknown`
 * (send to a human, never mark wrong). An expired budget can never yield `equivalent`.
 */
export function compareExpressions(left: string, right: string, options: CompareOptions = {}): ExpressionVerdict {
  const budget = budgetOf(options.timeBudget ?? DEFAULT_TIME_BUDGET_SECONDS)
  let tolerance = Math.abs(Number(options.tolerance ?? DEFAULT_TOLERANCE))
  if (Number.isNaN(tolerance)) tolerance = DEFAULT_TOLERANCE
  const deadline = nowSeconds() + budget
  if (nowSeconds() >= deadline) return timeoutVerdict(budget)
  let leftNode: Node, rightNode: Node
  try { leftNode = fold(parse(left, null)); rightNode = fold(parse(right, null)) }
  catch (error) { if (error instanceof ExpressionError) return unknown(error); throw error }

  const leftNames = collectVariables(leftNode, new Map())
  const rightNames = collectVariables(rightNode, new Map())
  if (nowSeconds() >= deadline) return timeoutVerdict(budget)
  if (render(leftNode, leftNames) === render(rightNode, rightNames) && isTotal(leftNode) && isTotal(rightNode))
    return { outcome: OUTCOME_EQUIVALENT, reason: '结构规范化后完全一致', errorType: null, samplesChecked: 0, sample: null }

  const variableCount = Math.max(leftNames.size, rightNames.size)
  if (variableCount > MAX_VARIABLES) return unknown(new ExpressionLimitError(`表达式变量数超过上限（MAX_VARIABLES=${MAX_VARIABLES}）`))
  let rows: Row[]
  try { rows = sampleRows(variableCount, options.samples) }
  catch (error) { if (error instanceof ExpressionError) return unknown(error); throw error }
  if (rows.length === 0) return unknown(new ExpressionLimitError('没有可用的采样点，无法判定等价'))

  let checked = 0
  const evaluator = new Evaluator(budget, deadline)
  for (const row of rows) {
    if (nowSeconds() >= deadline) return timeoutVerdict(budget, checked)
    const lb: Row = {}; for (const [name, canon] of leftNames) lb[name] = row[canon]
    const rb: Row = {}; for (const [name, canon] of rightNames) rb[name] = row[canon]
    let lv: number, rv: number
    try { lv = evaluator.run(leftNode, lb); rv = evaluator.run(rightNode, rb) }
    catch (error) { if (error instanceof ExpressionError) return unknown(error, checked, { ...row }); throw error }
    checked++
    if (!close(lv, rv, tolerance))
      return { outcome: OUTCOME_NOT_EQUIVALENT, reason: '在采样点上取值不同', errorType: null, samplesChecked: checked, sample: { ...row } }
  }
  if (nowSeconds() >= deadline) return timeoutVerdict(budget, checked)
  return { outcome: OUTCOME_EQUIVALENT, reason: '全部采样点取值一致', errorType: null, samplesChecked: checked, sample: null }
}

/** `true` / `false` / `null` (unknown -> human review). */
export function expressionsEquivalent(left: string, right: string, options: CompareOptions = {}): boolean | null {
  const v = compareExpressions(left, right, options)
  return v.outcome === OUTCOME_EQUIVALENT ? true : v.outcome === OUTCOME_NOT_EQUIVALENT ? false : null
}
