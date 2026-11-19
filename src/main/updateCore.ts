import type { UpdateState } from '@shared/types'

/**
 * Автообновление: чистая часть (без Electron), чтобы её можно было проверить тестами с поддельным движком.
 * Правила: проверка только если включена в настройках или нажата кнопка; скачивание и установка только по согласию.
 */

export const CHECK_INTERVAL_MS = 24 * 3600 * 1000

/** Нужна ли плановая проверка (при запуске и раз в сутки). */
export function shouldAutoCheck(enabled: boolean, lastCheck: number, now: number): boolean {
  if (!enabled) return false
  return !Number.isFinite(lastCheck) || lastCheck <= 0 || now - lastCheck >= CHECK_INTERVAL_MS || lastCheck > now
}

/** Сравнение версий вида 1.2.3 (с суффиксом -beta и т. п. до дефиса). */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string): number[] => v.split('-')[0].split('.').map((x) => Number.parseInt(x, 10) || 0)
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

/** Описание версии: без тегов, не длиннее 2000 символов. */
export function cleanNotes(notes: unknown): string {
  let text = ''
  if (typeof notes === 'string') text = notes
  else if (Array.isArray(notes)) text = notes.map((n) => (n && typeof n === 'object' && 'note' in n ? String((n as { note: unknown }).note ?? '') : '')).join('\n')
  const plain = text.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim()
  return plain.length > 2000 ? `${plain.slice(0, 2000)}…` : plain
}

/** Минимум, который нужен от electron-updater. */
export interface UpdateEngine {
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  on(event: 'update-available', cb: (info: { version: string; releaseNotes?: unknown }) => void): unknown
  on(event: 'update-not-available', cb: () => void): unknown
  on(event: 'download-progress', cb: (p: { percent: number }) => void): unknown
  on(event: 'update-downloaded', cb: () => void): unknown
  on(event: 'error', cb: (e: Error) => void): unknown
}

export interface UpdateDeps {
  engine: UpdateEngine
  currentVersion: string
  /** Установленная версия (не портативная и не режим разработки): иначе обновляться нечем */
  supported: boolean
  onState: (s: UpdateState) => void
  onLastCheck: (when: number) => void
  onError: (e: unknown) => void
  now?: () => number
}

/** Управляет состоянием обновления: «ничего не делается без согласия». */
export class UpdateController {
  state: UpdateState = { status: 'idle' }
  private busy = false

  constructor(private d: UpdateDeps) {
    if (!d.supported) this.set({ status: 'unsupported' })
    else this.wire()
  }

  private set(s: UpdateState): void {
    this.state = s
    this.d.onState(s)
  }

  private wire(): void {
    const e = this.d.engine
    e.on('update-available', (info) => {
      if (!isNewer(info.version, this.d.currentVersion)) return this.set({ status: 'none' })
      this.set({ status: 'available', version: info.version, notes: cleanNotes(info.releaseNotes) })
    })
    e.on('update-not-available', () => this.set({ status: 'none' }))
    e.on('download-progress', (p) => this.set({ ...this.state, status: 'downloading', percent: Math.round(p.percent) }))
    e.on('update-downloaded', () => this.set({ ...this.state, status: 'ready', percent: 100 }))
    e.on('error', (err) => {
      this.d.onError(err)
      this.set({ status: 'error', error: err.message })
    })
  }

  /** Проверка по кнопке или по расписанию. Возвращает false, если проверка не началась. */
  async check(): Promise<boolean> {
    if (!this.d.supported || this.busy || ['downloading', 'ready'].includes(this.state.status)) return false
    this.busy = true
    this.set({ status: 'checking' })
    try {
      this.d.onLastCheck((this.d.now ?? Date.now)())
      await this.d.engine.checkForUpdates()
      if (this.state.status === 'checking') this.set({ status: 'none' })
    } catch (err) {
      this.d.onError(err)
      this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.busy = false
    }
    return true
  }

  /** Скачивание: только после явного согласия и только если есть что скачивать. */
  async download(): Promise<void> {
    if (this.state.status !== 'available') return
    this.set({ ...this.state, status: 'downloading', percent: 0 })
    try {
      await this.d.engine.downloadUpdate()
    } catch (err) {
      this.d.onError(err)
      this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Установка: только когда файл скачан. */
  install(): boolean {
    if (this.state.status !== 'ready') return false
    this.d.engine.quitAndInstall()
    return true
  }

  /** «Позже»: прячет предложение до следующей проверки. */
  dismiss(): void {
    if (this.state.status === 'available' || this.state.status === 'error') this.set({ status: 'idle' })
  }
}
