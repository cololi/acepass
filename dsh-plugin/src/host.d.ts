/**
 * Minimal ambient declarations for the DSH host packages this plugin imports.
 *
 * The SDK inside the installed DeepSeek Harness app ships no .d.ts files, so these cover only the
 * surface we call. Source of truth: the READMEs under node_modules/@deepseek-ai/<pkg> in app.asar
 * (see docs/dsh-migration/03). Widen deliberately, and re-verify with `npm run smoke`.
 */
declare module '@deepseek-ai/cordis' {
  export interface Context {
    get(name: string): unknown
    readonly root: Context
    inject(deps: string[], callback: (ctx: Context & Record<string, any>) => void): void
    effect<T>(fn: () => T, label?: string): void
    on(event: string, listener: (...args: any[]) => unknown): () => void
    plugin(plugin: unknown, config?: unknown): unknown
    tools: any
  }
}
declare module '@deepseek-ai/schemastery' {
  interface Schema<T = unknown> { default(value: unknown): Schema<T>; description(text: string): Schema<T> }
  const Schema: {
    object<T extends Record<string, Schema<any>>>(shape: T): Schema<{ [K in keyof T]: T[K] extends Schema<infer U> ? U : never }>
    string(): Schema<string>
    boolean(): Schema<boolean>
    number(): Schema<number>
  }
  export default Schema
}
declare module '@deepseek-ai/dsh-llm' {
  export class BlockAssembler {
    push(chunk: unknown): void
    readonly finish: unknown
    readonly usage: unknown
    blocks(): unknown[]
  }
  export function createUserMessage(init: { content: unknown[] }): unknown
}
declare module '@deepseek-ai/dsh-tools' {
  export interface ToolDefinition<A = any> {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: { schema: unknown; render: (args: A, value: any) => unknown[] }
    execute(args: A, exec: { signal?: AbortSignal }): unknown | Promise<unknown>
  }
  export function defineTool<A>(definition: ToolDefinition<A>): ToolDefinition<A>
}
