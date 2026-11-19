/**
 * Журнал ошибок: чистая часть (без Electron), которую можно проверить тестами.
 * Приватность: из текста вырезается имя пользователя Windows, содержимое файлов в журнал не попадает.
 */

export const LOG_KEEP_DAYS = 7
export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const LOG_PREFIX = 'morphio-'

/** Подменяет путь к профилю и имя пользователя: `C:\Users\Иван\Видео` → `%USERPROFILE%\Видео`. */
export function redact(text: string, home?: string, user?: string): string {
  let out = text
  const variants = new Set<string>()
  if (home) {
    variants.add(home)
    variants.add(home.replace(/\\/g, '/'))
    variants.add(home.replace(/\\/g, '\\\\'))
  }
  for (const v of [...variants].sort((a, b) => b.length - a.length)) {
    out = out.split(v).join('%USERPROFILE%')
  }
  // любые другие «C:\Users\имя» (например, чужой профиль в сообщении системы)
  out = out.replace(/([A-Za-z]:)([\\/]{1,2})Users\2[^\\/\s"'<>|:*?]+/gi, '$1$2Users$2<user>')
  if (user && user.length >= 3) {
    out = out.split(user).join('<user>')
  }
  return out
}

/** `morphio-2026-11-19.log` */
export function logFileName(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${LOG_PREFIX}${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.log`
}

export function parseLogDate(name: string): Date | undefined {
  const m = /^morphio-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined
}

/** Какие файлы журнала удалить: старше недели, а затем самые старые, пока общий размер больше предела. */
export function logsToDelete(files: { name: string; size: number }[], now: Date): string[] {
  const dated = files
    .map((f) => ({ ...f, date: parseLogDate(f.name) }))
    .filter((f): f is { name: string; size: number; date: Date } => !!f.date)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
  const limit = now.getTime() - LOG_KEEP_DAYS * 86_400_000
  const doomed = new Set(dated.filter((f) => f.date.getTime() < limit).map((f) => f.name))
  let total = dated.filter((f) => !doomed.has(f.name)).reduce((s, f) => s + f.size, 0)
  for (const f of dated) {
    if (total <= LOG_MAX_BYTES) break
    if (doomed.has(f.name)) continue
    doomed.add(f.name)
    total -= f.size
  }
  return [...doomed]
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

export function formatLine(level: LogLevel, source: string, message: string, now = new Date()): string {
  const clean = message.replace(/\r/g, '').trimEnd()
  const [first, ...rest] = clean.split('\n')
  const head = `${now.toISOString()} ${level} [${source}] ${first}`
  return rest.length ? `${head}\n${rest.map((l) => `    ${l}`).join('\n')}\n` : `${head}\n`
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`
  try {
    return typeof e === 'string' ? e : JSON.stringify(e)
  } catch {
    return String(e)
  }
}

export interface ReportInfo {
  version: string
  windows: string
  electron: string
  gpu: string
  note?: string
  logTail: string
}

/** Текст обращения о проблеме. */
export function reportBody(r: ReportInfo, withLog = true): string {
  const lines = [
    '**What happened / Что произошло**',
    r.note?.trim() || '<!-- describe what you did and what you expected / опишите, что делали и что ожидали -->',
    '',
    '**Environment / Окружение**',
    `- Morphio: ${r.version}`,
    `- Windows: ${r.windows}`,
    `- Electron: ${r.electron}`,
    `- GPU: ${r.gpu || '—'}`
  ]
  if (withLog) lines.push('', '**Log (last lines) / Журнал (последние строки)**', '```', r.logTail.trim() || '(empty)', '```')
  return lines.join('\n')
}

/**
 * Адрес нового Issue. Если текст с журналом не помещается в адрес (около 6000 символов после кодирования),
 * в адресе остаются только окружение и подсказка, а полный текст нужно вставить из буфера обмена.
 */
export function buildIssueUrl(repo: string, r: ReportInfo, max = 6000): { url: string; copied: boolean; full: string } {
  const full = reportBody(r, true)
  const title = 'Problem report'
  const make = (body: string): string => `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  const url = make(full)
  if (url.length <= max) return { url, copied: false, full }
  const short = reportBody({ ...r, logTail: '' }, false) + '\n\n_The full report is in the clipboard: paste it here. / Полный отчёт в буфере обмена: вставьте его сюда._'
  return { url: make(short), copied: true, full }
}
