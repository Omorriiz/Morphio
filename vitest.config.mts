import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Модульные тесты основного процесса и общего кода: `npm test`.
// Сквозные тесты окна Electron лежат в tests/e2e и запускаются отдельно: `npm run e2e`.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Тесты пишут файлы во временные папки и запускают внешние программы: параллельно их не гоняем
    fileParallelism: false
  }
})
