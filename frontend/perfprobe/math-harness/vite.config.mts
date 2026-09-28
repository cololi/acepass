import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Probe-only config: builds/serves perfprobe/math-harness, which imports the
// real src/components/Content.tsx. It deliberately mirrors the app's production
// build settings so the probe measures the shipped code path. It never touches
// frontend/dist or frontend/index.html.
const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  preview: { host: '127.0.0.1', port: 5199, strictPort: true },
  build: { outDir: '../dist-math-harness', emptyOutDir: true, sourcemap: false },
})
