import { useEffect, useRef, useState } from 'react'

/**
 * Перетаскивание файлов в окно. Возвращает, идёт ли сейчас перетаскивание файлов
 * (внутренние перетаскивания элементов интерфейса игнорируются).
 */
export function useDropZone(active: boolean, onPaths: (paths: string[]) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const handler = useRef(onPaths)
  handler.current = onPaths

  useEffect(() => {
    if (!active) return
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types?.includes('Files')
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setDragging(true)
    }
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (--depth.current <= 0) {
        depth.current = 0
        setDragging(false)
      }
    }
    const onOver = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => window.api.getPathForFile(f))
        .filter(Boolean)
      if (paths.length) handler.current(paths)
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
  }, [active])

  return dragging
}
