import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Два входа: само приложение и лёгкая командная строка (запускается как Node, без окон и Chromium)
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          cli: resolve('src/main/cli-node.ts')
        }
      }
    },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    plugins: [react()],
    // Две страницы: основное окно и быстрое окно по сочетанию клавиш
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          quick: resolve('src/renderer/quick.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
