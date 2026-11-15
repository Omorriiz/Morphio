// Только интерфейс в обычном браузере (без Electron): `npm run ui`, затем http://localhost:5173.
// API подставляет заглушка src/renderer/src/devMock.ts. Удобно для проверки вёрстки и переводов.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  server: { port: 5173, strictPort: true }
})
