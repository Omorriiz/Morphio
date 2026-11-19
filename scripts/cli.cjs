// Запуск командной строки из исходников: npm run cli -- convert photo.heic --to jpg
// (сначала нужна сборка: npm run build). Работает так же, как morphio.cmd у готового приложения.
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const electron = require('electron')
const root = join(__dirname, '..')
const r = spawnSync(electron, [join(root, 'out', 'main', 'cli.js'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(r.status ?? 1)
