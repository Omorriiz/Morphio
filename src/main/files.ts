import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** Подбирает свободное имя, чтобы никогда не перезаписывать существующие файлы. */
export async function freePath(dir: string, base: string, ext: string): Promise<string> {
  let candidate = join(dir, `${base}.${ext}`)
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
