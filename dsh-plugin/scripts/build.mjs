import { build } from 'esbuild'
import { resolve } from 'node:path'
import { rmSync } from 'node:fs'
// Only this build's own outputs: `build-client.mjs` writes `lib/client.js` next to them, and a
// whole-directory wipe would delete it whenever the two scripts run separately.
for (const name of ['index.js', 'index.js.map']) rmSync(new URL(`../lib/${name}`, import.meta.url), { force: true })
await build({
  entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node24',
  // Service-owning host packages are never bundled: DSH owns their single shared instance.
  // `@deepseek-ai/schemastery` is a pure schema library with no service identity, so it is
  // bundled — an out-of-tree plugin installed with `link:` cannot resolve it otherwise.
  external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools'],
  // The SDK tree is the only local copy of the bundled pure library (`.cache/dsh-sdk` is
  // fetched by `npm run sdk:extract`), and the plugin's own node_modules belongs to the frontend.
  nodePaths: [resolve('.cache/dsh-sdk/dsh/node_modules')],
  sourcemap: true,
  logLevel: 'info',
})
