// Isolated Vite server for the acceptance suite: its own port and its own API
// target, so it can never talk to the development API on 8000.
import base from '../../vite.config.ts'

const apiPort = process.env.ACEPASS_BROWSER_API_PORT ?? '8011'
const webPort = Number(process.env.ACEPASS_BROWSER_WEB_PORT ?? '5181')

export default {
  ...base,
  server: {
    ...base.server,
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
      '/health': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
}
