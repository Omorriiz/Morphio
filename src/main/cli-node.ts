import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveLanguage } from '@shared/i18n'
import { runCli } from './cli'
import { configureModules } from './modules'
import { configureModelDirs, findBgModel } from './models'
import { sanitizeSettings } from './settingsCore'
import { mainLanguage, setMainLanguage } from './tm'

/**
 * Лёгкая командная строка: запускается как Node (`ELECTRON_RUN_AS_NODE=1 Morphio.exe cli.js ...`), без окон
 * и без Chromium, поэтому стартует за доли секунды и честно пишет в консоль и в каналы (stdout чистый).
 * Здесь нельзя подключать модуль 'electron': в режиме Node его нет.
 */

const argv = process.argv.slice(2)

function arg(name: string): string | undefined {
  const a = argv.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : undefined
}

const appRoot = join(__dirname, '..', '..')
const exeDir = dirname(process.execPath)
const dataDir = arg('user-data-dir') ?? process.env['MORPHIO_DATA_DIR'] ?? join(process.env['APPDATA'] ?? join(process.env['USERPROFILE'] ?? '.', 'AppData', 'Roaming'), 'Morphio')
// параметр --user-data-dir нужен только для проверок и не относится к командам
const args = argv.filter((x) => !x.startsWith('--user-data-dir='))

function version(): string {
  try {
    return (JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version: string }).version
  } catch {
    return '0'
  }
}

function setup(): void {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale
  let language = resolveLanguage('system', locale)
  if (!args.includes('--no-settings')) {
    try {
      const raw = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>
      language = resolveLanguage(sanitizeSettings(raw).language, locale)
    } catch {
      /* нет файла настроек: язык системы */
    }
  }
  setMainLanguage(language)
  configureModules([join(dataDir, 'modules'), join(exeDir, 'modules'), join(appRoot, 'modules')])
  configureModelDirs([join(dataDir, 'models'), join(exeDir, 'models'), join(appRoot, 'models')])
}

/** Печать документа в PDF нужна Chromium: запускаем приложение в режиме `--cli`, результат забираем из файла. */
function delegate(cmdArgs: string[]): Promise<number> {
  return new Promise((resolve) => {
    const outFile = join(tmpdir(), `morphio-cli-${randomBytes(4).toString('hex')}.txt`)
    const env: NodeJS.ProcessEnv = { ...process.env, MORPHIO_CLI_OUT: outFile }
    delete env['ELECTRON_RUN_AS_NODE']
    // из исходников приложение нужно запускать с путём к проекту, из установленной копии путь не нужен
    const entry = __dirname.includes('app.asar') ? [] : [appRoot]
    const child = spawn(process.execPath, [...entry, `--user-data-dir=${dataDir}`, '--cli', ...cmdArgs], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(d))
    const finish = (code: number): void => {
      try {
        process.stdout.write(readFileSync(outFile, 'utf8'))
      } catch {
        /* результатов нет */
      }
      rmSync(outFile, { force: true })
      resolve(code)
    }
    child.on('error', (e) => {
      process.stderr.write(`${e.message}\n`)
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

async function main(): Promise<void> {
  setup()
  const code = await runCli(args, {
    version: version(),
    info: {
      electron: process.versions.electron ?? '',
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      language: mainLanguage()
    },
    dataDir,
    io: {
      out: (t) => void process.stdout.write(t + '\n'),
      err: (t) => void process.stderr.write(t + '\n')
    },
    bgModel: findBgModel,
    electron: false,
    args,
    delegate
  })
  await Promise.all([process.stdout, process.stderr].map((s) => new Promise<void>((r) => s.write('', () => r()))))
  process.exit(code)
}

void main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(1)
})
