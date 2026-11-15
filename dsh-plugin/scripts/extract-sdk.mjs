import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
const asar = process.env.DSH_APP_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const out = '.cache/dsh-sdk'
if (existsSync(`${out}/dsh/node_modules`)) { console.log(`already extracted: ${out}`); process.exit(0) }
mkdirSync(out, { recursive: true })
execFileSync('npx', ['--yes', '@electron/asar', 'extract', asar, out], { stdio: 'inherit' })
