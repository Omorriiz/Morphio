import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app, clipboard, shell } from 'electron'
import type { ProblemReport } from '@shared/types'
import { buildIssueUrl, errorText, formatLine, LOG_MAX_BYTES, logFileName, logsToDelete, redact } from './loggerCore'
import type { LogLevel } from './loggerCore'
import { detectGpu } from './ffmpeg'
import { release } from 'node:os'

/** Журнал в `%APPDATA%\Morphio\logs`: пишет только на диск, в сеть ничего не уходит. */

export const REPO = 'Omorriiz/Morphio'

let dir = ''
let user = ''

export const logsDir = (): string => dir

export function initLogger(): void {
  dir = join(app.getPath('userData'), 'logs')
  try {
    user = userInfo().username
  } catch {
    user = ''
  }
  try {
    mkdirSync(dir, { recursive: true })
    const files = readdirSync(dir).map((name) => ({ name, size: statSync(join(dir, name)).size }))
    for (const name of logsToDelete(files, new Date())) unlinkSync(join(dir, name))
  } catch {
    /* журнал не должен мешать запуску */
  }
  logLine('INFO', 'app', `Morphio ${app.getVersion()} started (Windows ${release()}, Electron ${process.versions.electron})`)
}

function logLine(level: LogLevel, source: string, message: string): void {
  if (!dir) return
  try {
    const file = join(dir, logFileName(new Date()))
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) return // файл дня переполнен: не раздуваем
    appendFileSync(file, formatLine(level, source, redact(message, homedir(), user)), 'utf8')
  } catch {
    /* ошибки записи журнала молчим */
  }
}

export const logInfo = (source: string, message: string): void => logLine('INFO', source, message)
export const logError = (source: string, error: unknown): void => logLine('ERROR', source, errorText(error))

/** Подписка на необработанные ошибки основного процесса и падения окон. */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (e) => logError('main', e))
  process.on('unhandledRejection', (e) => logError('main/promise', e))
  app.on('render-process-gone', (_e, _wc, details) => logLine('ERROR', 'window', `render-process-gone: ${details.reason} (code ${details.exitCode})`))
  app.on('child-process-gone', (_e, details) => logLine('ERROR', 'child', `${details.type}: ${details.reason} (code ${details.exitCode})`))
}

/** Последние строки сегодняшнего журнала. */
export function logTail(maxChars = 4000): string {
  try {
    const file = join(dir, logFileName(new Date()))
    const text = readFileSync(file, 'utf8')
    return text.length > maxChars ? text.slice(-maxChars) : text
  } catch {
    return ''
  }
}

export async function openLogsFolder(): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await shell.openPath(dir)
}

/** Обращение о проблеме: открывает новый Issue; длинный отчёт кладёт в буфер обмена. */
export async function reportProblem(note?: string): Promise<ProblemReport> {
  let gpu = ''
  try {
    const caps = await detectGpu()
    gpu = caps.gpuLabel ?? (caps.gpu ? String(caps.gpu) : '')
  } catch {
    /* видеокарта необязательна */
  }
  const built = buildIssueUrl(REPO, {
    version: app.getVersion(),
    windows: release(),
    electron: process.versions.electron ?? '',
    gpu,
    note,
    logTail: redact(logTail(), homedir(), user)
  })
  if (built.copied) clipboard.writeText(built.full)
  await shell.openExternal(built.url)
  return { url: built.url, copied: built.copied }
}
