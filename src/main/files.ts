import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

let overwriteMode = false
const protectedPaths = new Set<string>()
const keyOf = (p: string): string => resolve(p).toLowerCase()

/**
 * Режим «перезаписывать» (флаг --overwrite командной строки): результат с занятым именем заменяет старый файл.
 * Исходные файлы защищены всегда: их путь регистрируется через protectPath и никогда не перезаписывается.
 */
export function setOverwrite(on: boolean): void {
  overwriteMode = on
  if (!on) protectedPaths.clear()
}

export function protectPath(path: string): void {
  protectedPaths.add(keyOf(path))
}

/** Подбирает свободное имя, чтобы никогда не перезаписывать существующие файлы (кроме режима overwrite). */
export async function freePath(dir: string, base: string, ext: string): Promise<string> {
  let candidate = join(dir, `${base}.${ext}`)
  if (overwriteMode && !protectedPaths.has(keyOf(candidate))) {
    await fs.rm(candidate, { force: true })
    return candidate
  }
  let n = 1
  while (await exists(candidate)) {
    candidate = join(dir, `${base} (${n}).${ext}`)
    n++
  }
  return candidate
}

/** Свободное имя для папки: «имя», «имя (1)», «имя (2)». */
export async function freeDir(dir: string, base: string): Promise<string> {
  let candidate = join(dir, base)
  let n = 1
  while (await exists(candidate)) candidate = join(dir, `${base} (${n++})`)
  return candidate
}

/** Размер папки со всем содержимым, байты. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? await dirSize(p) : (await fs.stat(p)).size
  }
  return total
}
