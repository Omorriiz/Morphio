import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileItem, JobProgress } from '@shared/types'

/**
 * Общая логика экранов с файлами: список, перетаскивание, прогресс обработки.
 * `active` — экран сейчас виден (иначе он не должен реагировать на drag&drop).
 */
export function useFileJobs(
  active: boolean,
  /** Откуда брать файлы: по умолчанию изображения; видео и звук передают свои функции. */
  source?: {
    inspect: (paths: string[]) => Promise<FileItem[]>
    pick: () => Promise<string[]>
  }
) {
  const [files, setFiles] = useState<FileItem[]>([])
  const [progress, setProgress] = useState<Record<string, JobProgress>>({})
  const [dragging, setDragging] = useState(false)
  const [running, setRunning] = useState(false)
  const dragDepth = useRef(0)
  const sourceRef = useRef(source)
  sourceRef.current = source

  const addPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    const items = await (sourceRef.current?.inspect ?? window.api.inspectFiles)(paths)
    setFiles((prev) => {
      const known = new Set(prev.map((f) => f.path))
      return [...prev, ...items.filter((i) => !known.has(i.path))]
    })
  }, [])

  useEffect(
    () => window.api.onProgress((p) => setProgress((prev) => ({ ...prev, [p.id]: p }))),
    []
  )

  useEffect(() => {
    if (!active) return
    const onEnter = (e: DragEvent): void => {
      e.preventDefault()
      dragDepth.current++
      setDragging(true)
    }
    const onLeave = (e: DragEvent): void => {
      e.preventDefault()
      if (--dragDepth.current <= 0) {
        dragDepth.current = 0
        setDragging(false)
      }
    }
    const onOver = (e: DragEvent): void => e.preventDefault()
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => window.api.getPathForFile(f))
      void addPaths(paths.filter(Boolean))
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [active, addPaths])

  const pick = useCallback(
    async () => addPaths(await (sourceRef.current?.pick ?? window.api.pickFiles)()),
    [addPaths]
  )

  const remove = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
    setProgress((prev) => {
      const { [id]: _removed, ...rest } = prev
      return rest
    })
  }, [])

  const clear = useCallback(() => {
    setFiles([])
    setProgress({})
  }, [])

  const resetResults = useCallback(() => setProgress({}), [])

  /** Обновляет результат одного файла (например, после правки кистью). */
  const patchProgress = useCallback(
    (id: string, patch: Partial<JobProgress>) =>
      setProgress((prev) => ({ ...prev, [id]: { ...prev[id], id, status: 'done', ...patch } })),
    []
  )

  /** Запускает обработку непросчитанных файлов, пока идёт работа — блокирует интерфейс. */
  const run = useCallback(
    async (job: (todo: FileItem[]) => Promise<void>) => {
      const todo = files.filter((f) => progress[f.id]?.status !== 'done')
      if (todo.length === 0) return
      setRunning(true)
      try {
        await job(todo)
      } finally {
        setRunning(false)
      }
    },
    [files, progress]
  )

  const stats = useMemo(() => {
    const done = files.filter((f) => progress[f.id]?.status === 'done')
    const before = done.reduce((s, f) => s + f.size, 0)
    const after = done.reduce((s, f) => s + (progress[f.id]?.outputSize ?? 0), 0)
    return { done: done.length, before, after }
  }, [files, progress])

  const allDone = files.length > 0 && stats.done === files.length

  return {
    files,
    progress,
    dragging,
    running,
    stats,
    allDone,
    pick,
    addPaths,
    remove,
    clear,
    resetResults,
    patchProgress,
    run
  }
}
