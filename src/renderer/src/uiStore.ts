import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

/**
 * Запоминание значений экранов (формат, качество, папки, свои цепочки) в `settings.json`.
 * Значения лежат в общем объекте `ui`; окно показывается после загрузки, поэтому первое чтение уже готово.
 */

let cache: Record<string, unknown> = {}
let timer: number | undefined

export function initUiStore(ui: Record<string, unknown> | undefined): void {
  cache = { ...(ui ?? {}) }
}

function schedule(): void {
  window.clearTimeout(timer)
  // запись не чаще, чем раз в полсекунды: ползунки меняются часто
  timer = window.setTimeout(() => {
    void window.api.patchSettings({ ui: cache }).catch(() => {})
  }, 500)
}

export function readUi<T>(key: string, fallback: T): T {
  const v = cache[key]
  if (v === undefined) return fallback
  // тип сохранённого должен совпасть с типом значения по умолчанию, иначе берём значение по умолчанию
  if (fallback !== undefined && fallback !== null && typeof v !== typeof fallback) return fallback
  if (Array.isArray(fallback) !== Array.isArray(v)) return fallback
  return v as T
}

export function writeUi(key: string, value: unknown): void {
  if (value === undefined) delete cache[key]
  else cache[key] = value
  schedule()
}

/** Как useState, но значение переживает перезапуск. Ключ вида «convert.quality». */
export function usePersistentState<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readUi(key, fallback))
  const set: Dispatch<SetStateAction<T>> = useCallback(
    (next) => {
      setValue((cur) => {
        const v = typeof next === 'function' ? (next as (c: T) => T)(cur) : next
        writeUi(key, v)
        return v
      })
    },
    [key]
  )
  return [value, set]
}
