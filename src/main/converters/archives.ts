import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { path7za } from '7zip-bin'
import type { FileItem, UniversalOptions } from '@shared/types'
import { dirSize, exists, freeDir, freePath } from '../files'
import { tm } from '../tm'
import type { JobResult } from '../queue'

/** Защита от «бомб»: слишком много файлов или слишком большой распакованный размер. */
const MAX_ENTRIES = 200_000
const MAX_TOTAL_BYTES = 20 * 1024 ** 3

/** Внутри собранного приложения исполняемый файл лежит не в asar-архиве, а рядом (app.asar.unpacked). */
function sevenZip(): string {
  return path7za.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

const running = new Set<ChildProcess>()
const stopped = new WeakSet<ChildProcess>()

/** Останавливает все запущенные 7-Zip (кнопка «Остановить»). */
export function cancelArchives(): void {
  for (const child of running) {
    stopped.add(child)
    child.kill()
  }
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(args: string[], onPercent?: (p: number) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    running.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      stdout += text
      if (stdout.length > 50_000_000) stdout = stdout.slice(-1_000_000) // список без конца не копим
      if (onPercent) {
        const all = [...text.matchAll(/(\d{1,3})%/g)]
        const last = all[all.length - 1]
        if (last) onPercent(Math.min(99, Number(last[1])))
      }
    })
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (e) => {
      running.delete(child)
      reject(e)
    })
    child.on('close', (code) => {
      running.delete(child)
      if (stopped.has(child)) return reject(new Error(tm('Остановлено')))
      resolve({ code, stdout, stderr })
    })
  })
}

function failure(r: RunResult, password?: string): Error {
  const text = `${r.stderr}\n${r.stdout}`
  if (/wrong password|can not open encrypted|Data Error in encrypted|Cannot open encrypted|Enter password/i.test(text)) {
    return new Error(password ? tm('Неверный пароль') : tm('Архив защищён паролем'))
  }
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^(ERROR|WARNING)/i.test(l) || /Can not|Cannot|is not|Unsupported/i.test(l))
      .pop() ?? tm('код {code}', { code: r.code ?? -1 })
  return new Error(tm('Не удалось обработать архив: {msg}', { msg: line.replace(/^ERROR:\s*/i, '') }))
}

interface Entry {
  path: string
  size: number
}

/** Читает список файлов архива (без распаковки), чтобы проверить его до начала работы. */
async function list(path: string, password?: string): Promise<Entry[]> {
  const args = ['l', '-slt', '-ba', '-sccUTF-8', '-y']
  if (password) args.push(`-p${password}`)
  args.push('--', path)
  const r = await run(args)
  if (r.code !== 0 && r.code !== 1) throw failure(r, password)
  const entries: Entry[] = []
  let cur: Partial<Entry> & { folder?: boolean } = {}
  const flush = (): void => {
    if (cur.path !== undefined && !cur.folder) entries.push({ path: cur.path, size: cur.size ?? 0 })
    cur = {}
  }
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.trim() === '') flush()
    else if (line.startsWith('Path = ')) {
      if (cur.path !== undefined) flush()
      cur.path = line.slice(7)
    } else if (line.startsWith('Size = ')) cur.size = Number(line.slice(7)) || 0
    else if (line.startsWith('Folder = ')) cur.folder = line.slice(9).trim() === '+'
    else if (/^Attributes = D/.test(line)) cur.folder = true // у 7z папки помечены атрибутом D
  }
  flush()
  return entries
}

/** Проверка пути внутри архива: не выходит ли он за папку назначения (zip-slip). */
export function isUnsafeEntry(p: string): boolean {
  if (/^[A-Za-z]:/.test(p) || /^[\\/]/.test(p)) return true
  return p.split(/[\\/]/).some((part) => part === '..')
}

export async function checkArchive(path: string, password?: string): Promise<Entry[]> {
  const entries = await list(path, password)
  if (entries.length > MAX_ENTRIES) throw new Error(tm('В архиве слишком много файлов ({n})', { n: entries.length }))
  const total = entries.reduce((s, e) => s + e.size, 0)
  if (total > MAX_TOTAL_BYTES) throw new Error(tm('Архив слишком большой после распаковки'))
  if (entries.some((e) => isUnsafeEntry(e.path))) throw new Error(tm('Архив содержит небезопасные пути, распаковка отменена'))
  return entries
}

/** Распаковывает архив в папку `dest`. Для .tar.gz и подобных распаковывает и внутренний .tar. */
async function extractTo(
  path: string,
  dest: string,
  password: string | undefined,
  onPercent: (p: number) => void
): Promise<number> {
  const entries = await checkArchive(path, password)
  await fs.mkdir(dest, { recursive: true })
  const args = ['x', '-y', '-bsp1', '-bb0', `-o${dest}`]
  if (password) args.push(`-p${password}`)
  args.push('--', path)
  const r = await run(args, onPercent)
  if (r.code !== 0) throw failure(r, password)

  // gz / xz / bz2 хранят один .tar — достаём и его
  const top = await fs.readdir(dest)
  if (top.length === 1 && top[0].toLowerCase().endsWith('.tar')) {
    const inner = join(dest, top[0])
    const nested = await checkArchive(inner)
    const r2 = await run(['x', '-y', '-bb0', `-o${dest}`, '--', inner])
    if (r2.code !== 0) throw failure(r2)
    await fs.rm(inner, { force: true })
    return nested.length
  }
  return entries.length
}

/** Распаковать архив рядом (или в выбранную папку) в подпапку с именем архива. */
export async function unpackArchive(
  item: FileItem,
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const parent = options.outputDir ?? dirname(item.path)
  await fs.mkdir(parent, { recursive: true })
  let base = basename(item.path, extname(item.path))
  if (/\.tar$/i.test(base)) base = base.slice(0, -4)
  const dest = await freeDir(parent, base)
  try {
    const count = await extractTo(item.path, dest, options.password || undefined, (percent) => update({ percent }))
    update({ percent: 100 })
    return { outputPath: dest, outputSize: await dirSize(dest), info: tm('файлов: {n}', { n: count }) }
  } catch (e) {
    await fs.rm(dest, { recursive: true, force: true }) // не оставляем недоделанную папку
    throw e
  }
}

const LEVEL = { fast: '1', normal: '5', max: '9' } as const

type PackKind = 'zip' | '7z' | 'tar' | 'targz'
const PACK_EXT: Record<PackKind, string> = { zip: 'zip', '7z': '7z', tar: 'tar', targz: 'tar.gz' }

async function pack(
  inputs: string[],
  out: string,
  kind: PackKind,
  options: UniversalOptions,
  onPercent: (p: number) => void
): Promise<void> {
  const level = LEVEL[options.archiveLevel]
  const pw = options.password
  const create = async (type: string, target: string, files: string[], extra: string[]): Promise<void> => {
    const args = ['a', `-t${type}`, `-mx=${level}`, '-bsp1', '-bb0', '-y', ...extra, target, '--', ...files]
    const r = await run(args, onPercent)
    if (r.code !== 0) throw failure(r, pw)
  }
  if (kind === 'zip') {
    // 7-Zip не умеет кириллицу в паролях ZIP (кодировка ZIP — только ANSI), поэтому говорим об этом сразу.
    if (pw && /[^\x20-\x7e]/.test(pw)) {
      throw new Error(tm('В пароле ZIP возможны только латинские буквы, цифры и знаки. Для другого пароля выберите 7z'))
    }
    await create('zip', out, inputs, pw ? [`-p${pw}`, '-mem=AES256'] : [])
  } else if (kind === '7z') {
    await create('7z', out, inputs, pw ? [`-p${pw}`, '-mhe=on'] : [])
  } else if (kind === 'tar') {
    await create('tar', out, inputs, [])
  } else {
    const tmp = join(tmpdir(), `morphio-tar-${randomUUID()}`)
    await fs.mkdir(tmp, { recursive: true })
    try {
      const tar = join(tmp, 'data.tar')
      await create('tar', tar, inputs, [])
      await create('gzip', out, [tar], [])
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  }
}

/** Запаковать файл или папку (или превратить архив в архив другого типа). */
export async function packItem(
  item: FileItem,
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const kind = options.target.split(':')[1] as PackKind
  const dir = options.outputDir ?? dirname(item.path)
  await fs.mkdir(dir, { recursive: true })
  const base =
    item.kind === 'folder'
      ? item.name
      : basename(item.path, extname(item.path)).replace(/\.tar$/i, '')
  const out = await freePath(dir, base, PACK_EXT[kind])

  let tmpDir: string | null = null
  try {
    let inputs = [item.path]
    let info = ''
    if (item.kind === 'archive') {
      // архив → архив: распаковываем во временную папку и пакуем содержимое
      tmpDir = join(tmpdir(), `morphio-repack-${randomUUID()}`)
      const count = await extractTo(item.path, tmpDir, options.password || undefined, (p) => update({ percent: p / 2 }))
      inputs = (await fs.readdir(tmpDir)).map((n) => join(tmpDir!, n))
      info = tm('файлов: {n}', { n: count })
    }
    // Пароль относится к исходному архиву; новый архив при смене формата не шифруем.
    const packOptions = item.kind === 'archive' ? { ...options, password: undefined } : options
    await pack(inputs, out, kind, packOptions, (p) => update({ percent: item.kind === 'archive' ? 50 + p / 2 : p }))
    update({ percent: 100 })
    const size = (await fs.stat(out)).size
    return { outputPath: out, outputSize: size, info: info || PACK_EXT[kind].toUpperCase() }
  } catch (e) {
    await fs.rm(out, { force: true }) // не оставляем недоделанный файл
    throw e
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true })
  }
}
