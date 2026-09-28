import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vendor chunks are split out of the entry bundle so a deploy that only changes
 * app code does not invalidate React / router / query in every browser cache,
 * and so no single first-screen chunk lands near the 500 kB warning line.
 * Route pages and KaTeX are not listed here: they are reachable only through
 * `import()`, so Rollup already emits them as on-demand chunks.
 */
function vendorChunk(id: string): string | undefined {
  const moduleId = id.replace(/\\/g, '/')
  if (!moduleId.includes('node_modules')) return undefined
  if (moduleId.includes('/node_modules/katex/')) return 'vendor-katex'
  if (
    moduleId.includes('/node_modules/react/') ||
    moduleId.includes('/node_modules/react-dom/') ||
    moduleId.includes('/node_modules/scheduler/') ||
    moduleId.includes('/node_modules/react-router/') ||
    moduleId.includes('/node_modules/react-router-dom/')
  ) {
    return 'vendor-react'
  }
  if (moduleId.includes('/node_modules/@tanstack/')) return 'vendor-query'
  return undefined
}

/**
 * Vitest reads the `test` key out of this file. It cannot be typed through
 * vitest's own `declare module 'vite'` augmentation, because vitest 2 ships its
 * own nested copy of Vite and the augmentation therefore lands on that copy
 * instead of the `vite` imported here. Only the keys actually used are spelled
 * out, so the rest of the config keeps full Vite typing.
 */
interface VitestTestOptions {
  include: string[]
  environment: 'node'
}

// Same-origin in production: the reverse proxy serves the built SPA and routes
// /api to Django, so session cookies and CSRF work without CORS. In development
// the Vite server proxies /api to the Django dev server.
const config = {
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:8000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
  // Without an explicit scope, `vitest run` walks into tests/acceptance and
  // tests/e2e and tries to execute the Playwright specs, which fail to collect
  // (`test.describe() called outside a Playwright run`) and take `npm run test`
  // down with them. Unit tests live next to the code they cover, under src/.
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  } satisfies VitestTestOptions,
}

export default defineConfig(config as UserConfig & { test: VitestTestOptions })
