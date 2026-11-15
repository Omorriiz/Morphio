import { defineConfig } from '@playwright/test'

// Сквозные тесты настоящего окна Electron: `npm run e2e` (сначала собирает приложение).
// Каждый тест запускает свою копию с отдельной папкой данных, поэтому работающему Morphio они не мешают.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { trace: 'off' }
})
