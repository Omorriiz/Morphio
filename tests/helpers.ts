import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll } from 'vitest'
import sharp from 'sharp'
import type { FileItem } from '../src/shared/types'
import { kindOfExt } from '../src/main/registry'

const created: string[] = []

/** Временная папка, которая удаляется после тестов файла. */
export async function tmpDir(label = 'case'): Promise<string> {
  const dir = join(tmpdir(), `morphio-test-${label}-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  created.push(dir)
  return dir
}

export function cleanupAfterAll(): void {
  afterAll(async () => {
    await Promise.all(created.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
  })
}

export const exists = (p: string): Promise<boolean> =>
  fs.stat(p).then(
    () => true,
    () => false
  )

/** Описание файла для движков без обращения к диску за превью. */
export async function fileItem(path: string, extra: Partial<FileItem> = {}): Promise<FileItem> {
  const stat = await fs.stat(path)
  const name = path.split(/[\\/]/).pop() ?? path
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return {
    id: randomUUID(),
    path,
    name,
    ext,
    size: stat.isDirectory() ? 0 : stat.size,
    kind: kindOfExt(ext, stat.isDirectory()),
    ...extra
  }
}

/** Картинка-градиент с кругом: понятный образец для проверок. */
export async function makeImage(
  path: string,
  width = 320,
  height = 200,
  colors: [string, string] = ['#ff7ab6', '#7364f0']
): Promise<string> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#g)"/><circle cx="${width / 2}" cy="${height / 2}" r="${height / 4}" fill="#fff"/></svg>`
  )
  const ext = path.split('.').pop()!.toLowerCase()
  let img = sharp(svg)
  if (ext === 'jpg' || ext === 'jpeg') img = img.jpeg({ quality: 90 })
  else if (ext === 'webp') img = img.webp()
  else img = img.png()
  await img.toFile(path)
  return path
}
