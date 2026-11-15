import { useCallback, useEffect, useState } from 'react'
import type { ModuleInfo, ModuleProgress } from '@shared/types'

/** Модули по требованию (Pandoc): список, ход скачивания, установка и удаление. */
export function useModules(): {
  modules: ModuleInfo[]
  progress: Record<string, ModuleProgress>
  /** Растёт при каждой установке или удалении: по нему обновляют списки вариантов */
  version: number
  install: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
} {
  const [modules, setModules] = useState<ModuleInfo[]>([])
  const [progress, setProgress] = useState<Record<string, ModuleProgress>>({})
  const [version, setVersion] = useState(0)

  const refresh = useCallback(async () => {
    setModules(await window.api.modulesList())
    setVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(
    () =>
      window.api.onModuleProgress((p) => {
        setProgress((prev) => ({ ...prev, [p.id]: p }))
        if (p.phase === 'done' || p.phase === 'error') void refresh()
      }),
    [refresh]
  )

  const install = useCallback(async (id: string) => {
    setProgress((prev) => ({ ...prev, [id]: { id, phase: 'download', received: 0, total: 0 } }))
    await window.api.modulesInstall(id)
  }, [])

  const remove = useCallback(
    async (id: string) => {
      await window.api.modulesRemove(id)
      setProgress((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      await refresh()
    },
    [refresh]
  )

  return { modules, progress, version, install, remove }
}
