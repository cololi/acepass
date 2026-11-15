/**
 * Build the browser half.
 *
 * DSH serves a client plugin as one self-registering script: the shell's module
 * loader calls `factory(require)` and the returned `module.exports` must expose
 * `apply` and `inject`. esbuild writes the CommonJS body; this script wraps it in
 * that loader call, because the host package publishes no bundler of its own.
 */
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  // React is part of the shell's frozen module table; a second copy would break hooks.
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
  sourcemap: false,
})

const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({id:"@acepass/dsh-plugin",factory:function(require){var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`
const { writeFileSync, mkdirSync } = await import('node:fs')
mkdirSync('lib', { recursive: true })
writeFileSync('lib/client.js', wrapped)
console.log(`lib/client.js ${wrapped.length} bytes`)
