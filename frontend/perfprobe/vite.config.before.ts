import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Same-origin in production: the reverse proxy serves the built SPA and routes
// /api to Django, so session cookies and CSRF work without CORS. In development
// the Vite server proxies /api to the Django dev server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:8000', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
})
