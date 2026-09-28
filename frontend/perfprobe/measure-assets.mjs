/**
 * W3 first-screen bundle probe.
 *
 * Measures the *built* artifact (`frontend/dist`) with the same rules every
 * time, so before/after numbers are produced by one command:
 *
 *   node perfprobe/measure-assets.mjs --label before --out perfprobe/baseline.json
 *   node perfprobe/measure-assets.mjs --label after  --out perfprobe/after.json
 *
 * Reported numbers:
 *   - entryJs      : the <script type="module"> chunk referenced by dist/index.html
 *   - entryCss     : the entry stylesheet
 *   - firstLoadJs  : entry chunk plus every chunk reachable through *static*
 *                    imports (what a cold first paint must download)
 *   - deferredJs   : chunks only reachable through dynamic import() (route pages,
 *                    KaTeX) — not fetched for the first screen
 *   - distBytes    : whole dist/ directory (includes KaTeX font files)
 *
 * gzip bytes use zlib default level, which is what `vite build` prints.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(here, '..', 'dist')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function bytes(file) {
  return fs.statSync(file).size
}

function gzipBytes(file) {
  return zlib.gzipSync(fs.readFileSync(file)).length
}

function describe(file) {
  const abs = path.join(dist, file)
  return {
    file,
    bytes: bytes(abs),
    gzipBytes: gzipBytes(abs),
  }
}

function listAssets() {
  const dir = path.join(dist, 'assets')
  return fs
    .readdirSync(dir)
    .map((name) => `assets/${name}`)
    .sort()
}

/** Walk every .js in dist/assets and split its imports into static vs dynamic. */
function importGraph() {
  const assets = listAssets().filter((file) => file.endsWith('.js'))
  const graph = new Map()
  for (const file of assets) {
    const code = fs.readFileSync(path.join(dist, file), 'utf8')
    const staticImports = new Set()
    const dynamicImports = new Set()
    const re = /["']\.\/([A-Za-z0-9_$.\-]+\.js)["']/g
    let match
    while ((match = re.exec(code)) !== null) {
      const before = code.slice(Math.max(0, match.index - 12), match.index)
      if (/import\(\s*$/.test(before)) dynamicImports.add(`assets/${match[1]}`)
      else staticImports.add(`assets/${match[1]}`)
    }
    graph.set(file, { staticImports: [...staticImports], dynamicImports: [...dynamicImports] })
  }
  return graph
}

function sumGzip(files) {
  return files.reduce((total, file) => total + gzipBytes(path.join(dist, file)), 0)
}

function sumBytes(files) {
  return files.reduce((total, file) => total + bytes(path.join(dist, file)), 0)
}

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
const scriptMatch = html.match(/<script[^>]+src="\/?(assets\/[^"]+\.js)"/)
const styleMatch = html.match(/<link[^>]+href="\/?(assets\/[^"]+\.css)"/)
if (!scriptMatch) throw new Error('dist/index.html has no module script: build first')

const entry = scriptMatch[1]
const entryCss = styleMatch ? styleMatch[1] : null

const graph = importGraph()
const firstLoad = new Set()
const deferred = new Set()
const queue = [entry]
while (queue.length) {
  const current = queue.pop()
  if (firstLoad.has(current)) continue
  firstLoad.add(current)
  for (const next of graph.get(current)?.staticImports ?? []) queue.push(next)
}
for (const [file, edges] of graph) {
  if (firstLoad.has(file)) continue
  deferred.add(file)
  for (const next of edges?.dynamicImports ?? []) deferred.add(next)
}

const firstLoadJs = [...firstLoad].sort()
const report = {
  label: arg('label', 'unlabelled'),
  measuredAt: new Date().toISOString(),
  command: 'node perfprobe/measure-assets.mjs',
  entryJson: describe(entry),
  entryCss: entryCss ? describe(entryCss) : null,
  firstLoadJs: { fileCount: firstLoadJs.length, bytes: sumBytes(firstLoadJs), gzipBytes: sumGzip(firstLoadJs) },
  deferredJs: {
    fileCount: deferred.size,
    bytes: sumBytes([...deferred]),
    gzipBytes: sumGzip([...deferred]),
  },
  chunks: [...graph.keys()].sort().map((file) => ({
    ...describe(file),
    role: file === entry ? 'entry' : firstLoad.has(file) ? 'first-load' : 'deferred',
  })),
  assets: listAssets().map((file) => describe(file)),
  distBytes: listAssets().reduce((total, file) => total + bytes(path.join(dist, file)), 0),
}

const outIndex = process.argv.indexOf('--out')
if (outIndex >= 0 && process.argv[outIndex + 1]) {
  fs.writeFileSync(path.resolve(process.argv[outIndex + 1]), `${JSON.stringify(report, null, 2)}\n`)
}
console.log(JSON.stringify({ ...report, assets: `${report.assets.length} files` }, null, 2))
