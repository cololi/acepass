/**
 * Load the BUILT plugin into a real Cordis context with DSH's real `dsh-system-prompt` + `dsh-tools`
 * services, then execute the tool through the registry. Proves: plugin shape is valid, the tool
 * registers against the real schema validator, and an `acepass` call runs end to end.
 *
 *   DSH_SDK_ROOT=<dir containing node_modules/@deepseek-ai> node scripts/load-smoke.mjs
 * Extract the SDK first with `npm run sdk:extract` (reads the installed DeepSeek Harness app.asar).
 */
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(process.env.DSH_SDK_ROOT ?? '.cache/dsh-sdk/dsh')
if (!existsSync(join(root, 'node_modules/@deepseek-ai/cordis'))) {
  console.error(`DSH SDK not found at ${root}. Run: npm run sdk:extract`); process.exit(2)
}
const req = createRequire(join(root, 'package.json'))
const load = (spec) => import(pathToFileURL(req.resolve(spec)).href)
const { Context } = await load('@deepseek-ai/cordis')
const systemPrompt = await load('@deepseek-ai/dsh-system-prompt')
const tools = await load('@deepseek-ai/dsh-tools')

const root_ = new Context()
await root_.plugin(systemPrompt.default ?? systemPrompt)
await root_.plugin(tools.default ?? tools.ToolsService)

// The plugin imports host packages by bare specifier; resolve them against the SDK root.
// Mirror a real install: the package sits in the profile's node_modules next to the host packages.
const installed = join(root, 'node_modules/@acepass/dsh-plugin')
rmSync(installed, { recursive: true, force: true }); mkdirSync(installed, { recursive: true })
cpSync('lib', join(installed, 'lib'), { recursive: true })
cpSync('package.json', join(installed, 'package.json'))
cpSync('cordis.patch.yml', join(installed, 'cordis.patch.yml'))
cpSync('locale', join(installed, 'locale'), { recursive: true })
const plugin = await import(pathToFileURL(join(installed, 'lib/index.js')).href)
assert.equal(plugin.name, 'acepass')
await root_.plugin(plugin, { dataRoot: '', provider: '', model: '' })

const def = root_.tools.get('acepass', undefined)
assert.ok(def, 'acepass tool is registered')
const out = (await def.execute({ action: 'capabilities' }, {}))
assert.equal(out.ok, true)
assert.equal(out.capabilities.explain.available, false)
assert.equal(out.capabilities.explain.reason, 'ai_not_configured', 'no model => honest not-configured, no stub')
assert.equal(out.capabilities.embed.reason, 'ai_capability_unsupported')

const fs = await def.execute({ action: 'fsrs_schedule', payload_json: JSON.stringify({ rating: 'good', reviewed_at: '2026-01-01T08:00:00Z' }) }, {})
assert.equal(fs.ok, true); assert.equal(fs.phase_after, 'learning'); assert.equal(fs.state.reps, 1)
const bad = await def.execute({ action: 'fsrs_schedule', payload_json: '{"rating":"good"}' }, {})
assert.equal(bad.error.code, 'reviewed_at_required')
console.log('load-smoke OK: plugin loaded into real Cordis + dsh-tools; tool registered and executed')
await root_.fiber.dispose()
// The copy exists only for this process's module resolution. Leaving it behind would shadow the
// profile's linked package in the next `dsh web` boot (bundle resolution prefers the installation),
// which is exactly how a stale build once served a plugin whose client bundle did not exist.
rmSync(installed, { recursive: true, force: true })
