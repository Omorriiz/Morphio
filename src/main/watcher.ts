import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { FileItem, WatchRule, WatchStatus } from '@shared/types'
import { describeItem, targetsFor } from './registry'
import { tm } from './tm'

/** Куда класть результаты по умолчанию: подпапка внутри следимой папки (её мы не отслеживаем, чтобы не зациклиться). */
export const DEFAULT_OUT = 'Morphio-out'

const PARTIAL = /\.(tmp|part|crdownload|download|partial|temp)$/i

export type WatchRunner = (item: FileItem, rule: WatchRule, outputDir: string) => Promise<{ outputPath: string; outputSize: number }>
export type Notify = (title: string, body: string) => void

interface Live {
  rule: WatchRule
  watcher: FSWatcher
  status: WatchStatus
  /** Файлы, которые мы сами создали: их повторно не обрабатываем */
  produced: Set<string>
}

/**
 * Следящие папки: файл появился → дождались, пока он допишется → обработали правилом → в конце пачки
 * показали уведомление. Старые файлы при добавлении правила не трогаем. Обработка идёт по одному файлу.
 */
export class WatchManager {
  private live = new Map<string, Live>()
  private chain: Promise<void> = Promise.resolve()
  private batch = { files: 0, saved: 0, errors: 0 }
  private batchTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly run: WatchRunner,
    private readonly notify: Notify,
    /** Сколько мс файл должен не меняться, чтобы считаться дописанным */
    private readonly stableMs = 1500,
    /** Пауза до уведомления об итогах пачки */
    private readonly batchMs = 5000
  ) {}

  outDirOf(rule: WatchRule): string {
    return resolve(rule.outputDir ?? join(rule.folder, DEFAULT_OUT))
  }

  /** Приводит работающие слежения в соответствие с правилами. */
  async sync(rules: WatchRule[]): Promise<void> {
    const wanted = new Map(rules.filter((r) => r.enabled).map((r) => [r.id, r]))
    for (const [id, l] of [...this.live]) {
      const next = wanted.get(id)
      const same =
        next && next.folder === l.rule.folder && next.target === l.rule.target &&
        next.quality === l.rule.quality && next.outputDir === l.rule.outputDir
      if (!same) {
        await l.watcher.close()
        this.live.delete(id)
      }
    }
    for (const rule of wanted.values()) {
      if (!this.live.has(rule.id)) await this.start(rule)
    }
  }

  private async start(rule: WatchRule): Promise<void> {
    const status: WatchStatus = { id: rule.id, active: false, processed: 0 }
    const out = this.outDirOf(rule)
    const produced = new Set<string>()
    try {
      const stat = await fs.stat(rule.folder)
      if (!stat.isDirectory()) throw new Error('not a folder')
    } catch {
      status.lastError = tm('Папка недоступна')
      this.live.set(rule.id, { rule, watcher: chokidar.watch([]), status, produced })
      return
    }
    if (out === resolve(rule.folder)) {
      // результат в той же папке снова попал бы под правило и зациклился
      status.lastError = tm('Папка результатов не должна совпадать со следимой папкой')
      this.live.set(rule.id, { rule, watcher: chokidar.watch([]), status, produced })
      return
    }
    const watcher = chokidar.watch(rule.folder, {
      ignoreInitial: true, // файлы, которые уже лежат в папке, не трогаем
      depth: 0, // только сама папка, без вложенных
      ignored: (p: string) => resolve(p) === out || resolve(p).startsWith(out + sep),
      awaitWriteFinish: { stabilityThreshold: this.stableMs, pollInterval: 200 }
    })
    const live: Live = { rule, watcher, status, produced }
    watcher.on('add', (path) => this.enqueue(live, path))
    watcher.on('error', (e) => {
      status.lastError = e instanceof Error ? e.message : String(e)
    })
    watcher.on('ready', () => {
      status.active = true
    })
    this.live.set(rule.id, live)
  }

  private enqueue(live: Live, path: string): void {
    if (PARTIAL.test(path) || live.produced.has(resolve(path))) return
    this.chain = this.chain.then(() => this.process(live, path)).catch(() => undefined)
  }

  private async process(live: Live, path: string): Promise<void> {
    const { rule, status } = live
    const item = await describeItem(path, false)
    if (!item || item.kind === 'folder') return
    // Файл не подходит под правило (например, в папке с картинками появился txt) — пропускаем молча.
    if (!targetsFor(item).some((t) => t.id === rule.target)) return
    const out = this.outDirOf(rule)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this.run(item, rule, out)
        live.produced.add(resolve(r.outputPath))
        status.processed++
        status.lastFile = item.name
        status.lastAt = Date.now()
        status.lastError = undefined
        this.batch.files++
        this.batch.saved += Math.max(0, item.size - r.outputSize)
        this.scheduleNotice()
        return
      } catch (e) {
        if (attempt === 2) {
          status.lastFile = item.name
          status.lastAt = Date.now()
          status.lastError = e instanceof Error ? e.message : String(e)
          this.batch.errors++
          this.scheduleNotice()
        } else {
          await new Promise((r) => setTimeout(r, 3000)) // файл мог быть занят другой программой
        }
      }
    }
  }

  private scheduleNotice(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = setTimeout(() => {
      const { files, saved, errors } = this.batch
      this.batch = { files: 0, saved: 0, errors: 0 }
      this.batchTimer = null
      if (files > 0) {
        this.notify(
          'Morphio',
          saved > 0
            ? tm('Обработано файлов: {n}, сэкономлено {mb} МБ', { n: files, mb: (saved / 1048576).toFixed(1) })
            : tm('Обработано файлов: {n}', { n: files })
        )
      }
      if (errors > 0) this.notify('Morphio', tm('Не удалось обработать файлов: {n}', { n: errors }))
    }, this.batchMs)
  }

  /** Помечает путь как созданный приложением (чтобы не обрабатывать результат повторно). */
  markProduced(ruleId: string, path: string): void {
    this.live.get(ruleId)?.produced.add(resolve(path))
  }

  status(): WatchStatus[] {
    return [...this.live.values()].map((l) => ({ ...l.status }))
  }

  /** Есть ли активные слежения (нужно, чтобы приложение не закрывалось само). */
  get active(): boolean {
    return this.live.size > 0
  }

  async close(): Promise<void> {
    await Promise.all([...this.live.values()].map((l) => l.watcher.close()))
    this.live.clear()
  }
}
