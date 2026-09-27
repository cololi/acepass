import config from '../../../frontend/vite.config.ts'
config.server.port = 5174
config.server.proxy['/api'].target = 'http://127.0.0.1:8001'
config.server.proxy['/health'].target = 'http://127.0.0.1:8001'
export default config
