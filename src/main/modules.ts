import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { path7za } from '7zip-bin'
import type { ModuleInfo, ModuleProgress } from '@shared/types'
import { tm } from './tm'

/**
 * Модули по требованию: тяжёлые программы (Pandoc) в установщик не входят.
 * Пользователь сам нажимает «Скачать», файл проверяется по контрольной сумме SHA-256 и распаковывается
 * в папку данных приложения. Без согласия ничего не скачивается.
 */

export interface ModuleManifest {
  id: string
  name: string
  version: string
  description: string
  license: string
  /** Откуда скачивается (показывается пользователю) */
  source: string
  url: string
  sha256: string
  /** Размер архива, байты */
  size: number
  /** Путь к программе внутри распакованной папки */
  exe: string
}

export const MODULES: ModuleManifest[] = [
  {
    id: 'pandoc',
    name: 'Pandoc',
    version: '3.14',
    description: 'Документы и книги: DOCX, ODT, RTF, HTML, Markdown, EPUB, FB2 и PDF',
    license: 'GPL-2.0-or-later',
    source: 'github.com/jgm/pandoc',
    url: 'https://github.com/jgm/pandoc/releases/download/3.14/pandoc-3.14-windows-x86_64.zip',
    sha256: '0144b96e8c7b023fd382ec5ef5bdc475e873f1019d6fa72502492df2c9a94a3b',
    size: 43_614_099,
    exe: 'pandoc-3.14/pandoc.exe'
  }
]

let searchDirs: string[] = []
let installRoot = ''

/** Папки, где ищем модули: первая — куда устанавливаем. */
export function configureModules(dirs: string[]): void {
  searchDirs = dirs
  installRoot = dirs[0] ?? ''
}

const manifestOf = (id: string): ModuleManifest => {
  const m = MODULES.find((x) => x.id === id)
  if (!m) throw new Error(tm('Неизвестный модуль'))
  return m
}

const moduleDir = (root: string, m: ModuleManifest): string => join(root, m.id, m.version)

/** Внутри собранного приложения 7za лежит не в asar-архиве. */
const sevenZip = (): string => path7za.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

/** Путь к программе модуля, если он установлен. */
export function modulePath(id: string): string | undefined {
  const m = manifestOf(id)
  for (const root of searchDirs) {
    const exe = join(moduleDir(root, m), m.exe)
    if (existsSync(exe) && existsSync(join(moduleDir(root, m), '.ok'))) return exe
  }
  return undefined
}

export const moduleReady = (id: string): boolean => !!modulePath(id)

export function moduleList(): ModuleInfo[] {
  return MODULES.map((m) => ({
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    license: m.license,
    source: m.source,
    sizeMB: Math.round((m.size / 1024 / 1024) * 10) / 10,
    installed: moduleReady(m.id)
  }))
}

type FetchLike = (url: string) => Promise<Response>

/**
 * Скачивает файл во временный `.part`, считает SHA-256 «на лету» и переименовывает, только если сумма совпала.
 * Повреждённый или подменённый файл удаляется.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expect: { sha256: string; size: number },
  report: (received: number, total: number) => void,
  doFetch: FetchLike = (u) => fetch(u, { redirect: 'follow' })
): Promise<void> {
  const temp = `${dest}.part`
  await fs.mkdir(join(dest, '..'), { recursive: true })
  try {
    const res = await doFetch(url)
    if (!res.ok || !res.body) throw new Error(tm('Сервер ответил: {status}', { status: res.status }))
    const total = Number(res.headers.get('content-length')) || expect.size
    const hash = createHash('sha256')
    let received = 0
    let last = 0
    const source = Readable.fromWeb(res.body as never)
    source.on('data', (chunk: Buffer) => {
      hash.update(chunk)
      received += chunk.length
      const now = Date.now()
      if (now - last > 150) {
        last = now
        report(received, total)
      }
    })
    await pipeline(source, createWriteStream(temp))
    if (hash.digest('hex') !== expect.sha256.toLowerCase()) {
      throw new Error(tm('Контрольная сумма не совпала: файл повреждён или подменён, он удалён'))
    }
    await fs.rename(temp, dest)
    report(received, total)
  } catch (e) {
    await fs.rm(temp, { force: true })
    throw e
  }
}

function extractZip(zip: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip(), ['x', zip, `-o${dest}`, '-y', '-bd'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.stdout.resume()
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tm('Не удалось распаковать модуль: {err}', { err: err.trim().slice(0, 200) })))))
  })
}

const busy = new Set<string>()

/** Скачивает и устанавливает модуль. Повторный вызов во время загрузки игнорируется. */
export async function installModule(
  id: string,
  report: (p: ModuleProgress) => void,
  doFetch?: FetchLike,
  override?: Partial<ModuleManifest>
): Promise<void> {
  const m = { ...manifestOf(id), ...override }
  if (busy.has(id)) return
  busy.add(id)
  const dir = moduleDir(installRoot, m)
  const zip = join(installRoot, m.id, `${m.id}-${m.version}.zip`)
  try {
    await fs.rm(dir, { recursive: true, force: true })
    report({ id, phase: 'download', received: 0, total: m.size })
    await downloadVerified(m.url, zip, m, (received, total) => report({ id, phase: 'download', received, total }), doFetch)
    report({ id, phase: 'extract', received: m.size, total: m.size })
    await fs.mkdir(dir, { recursive: true })
    await extractZip(zip, dir)
    if (!existsSync(join(dir, m.exe))) throw new Error(tm('В скачанном архиве нет нужной программы'))
    await fs.writeFile(join(dir, '.ok'), m.sha256)
    report({ id, phase: 'done', received: m.size, total: m.size })
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true })
    report({ id, phase: 'error', received: 0, total: 0, error: e instanceof Error ? e.message : String(e) })
  } finally {
    await fs.rm(zip, { force: true })
    busy.delete(id)
  }
}

/** Удаляет установленный модуль из папки данных. */
export async function removeModule(id: string): Promise<void> {
  const m = manifestOf(id)
  await fs.rm(join(installRoot, m.id), { recursive: true, force: true })
}
