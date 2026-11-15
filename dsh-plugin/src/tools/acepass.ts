import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LlmPort } from '../llm/port.ts'
import { ACTIONS, runAction, type Json } from '../actions/run.ts'

export { ACTIONS }

export function createAcePassTool(deps: { llm: () => LlmPort }) {
  return defineTool({
    name: 'acepass',
    description:
      'AcePass exam-practice workbench. Actions: capabilities (what AI features are available right now, honestly), ' +
      'fsrs_schedule (pure FSRS-4.5 memory-card scheduling; never writes scores or mastery). ' +
      'ai_explain (render the explain prompt, call the model, validate the answer; returns what *would* be stored, ' +
      'never writes a score, mastery state, plan or statistic). ' +
      'Pass action arguments as a JSON object string in payload_json.',
    parameters: {
      action: { type: 'string', required: true, enum: [...ACTIONS], description: 'Action name' },
      payload_json: { type: 'string', description: 'JSON object of action arguments; omit for read actions' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { action: string; payload_json?: string }, exec: { signal?: AbortSignal }) {
      let payload: Json = {}
      if (args.payload_json) {
        try { payload = JSON.parse(args.payload_json) as Json } catch { return { ok: false, error: { code: 'bad_payload', message: 'payload_json is not valid JSON' } } }
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
          return { ok: false, error: { code: 'bad_payload', message: 'payload_json must be a JSON object' } }
      }
      return runAction(args.action, payload, deps, exec.signal)
    },
  })
}
