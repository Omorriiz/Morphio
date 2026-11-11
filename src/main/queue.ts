import type { FileItem, JobProgress } from '@shared/types'

export interface JobResult {
  outputPath: string
  outputSize: number
  preview?: string
  info?: string
}

/** Обработчик получает файл и функцию для отчёта о ходе работы (проценты). */
export type JobHandler = (
  item: FileItem,
  update: (patch: Partial<JobProgress>) => void
) => Promise<JobResult>

/**
 * Простая очередь задач: файлы обрабатываются по нескольку штук параллельно,
 * можно отменить. Обработчик (что именно делать с файлом) передаётся снаружи,
 * поэтому одна очередь подходит и для конвертации, и для удаления фона, и для видео.
 */
export class JobQueue {
  private cancelled = false

  constructor(private readonly concurrency = 3) {}

  cancel(): void {
    this.cancelled = true
  }

  async run(
    items: FileItem[],
    handler: JobHandler,
    report: (progress: JobProgress) => void
  ): Promise<void> {
    this.cancelled = false
    const pending = [...items]
    items.forEach((item) => report({ id: item.id, status: 'pending' }))

    const worker = async (): Promise<void> => {
      while (pending.length > 0 && !this.cancelled) {
        const item = pending.shift()!
        report({ id: item.id, status: 'working' })
        try {
          const result = await handler(item, (patch) =>
            report({ id: item.id, status: 'working', ...patch })
          )
          report({ id: item.id, status: 'done', ...result })
        } catch (e) {
          report({
            id: item.id,
            status: 'error',
            error: e instanceof Error ? e.message : String(e)
          })
        }
      }
    }

    await Promise.all(Array.from({ length: this.concurrency }, worker))
  }
}
