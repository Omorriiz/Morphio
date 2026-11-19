import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { path7za } from '7zip-bin'
import type { ModuleInfo, ModuleProgress } from '@shared/types'
import { tm } from './tm'

/**
 * Модули по требованию: тяжёлые программы и нейросети в установщик не входят.
 * Пользователь сам нажимает «Скачать», каждый файл проверяется по контрольной сумме SHA-256 и кладётся
 * в папку данных приложения. Без согласия ничего не скачивается.
 *
 * Свои файлы (модели) лежат в релизе репозитория проекта: так адреса и суммы под нашим контролем,
 * и ссылка не сломается, если автор модели переименует файл у себя.
 */

export interface ModuleFile {
  /** Имя файла в релизе (или в адресе) */
  name: string
  /** Полный адрес; не задан — берётся из релиза проекта: `<MODELS_BASE>/<name>` */
  url?: string
  sha256: string
  /** Размер, байты */
  size: number
  /** Под каким именем сохранить (нейросеть ищет рядом файл с этим именем) */
  saveAs?: string
  /** Это ZIP: распаковать в папку модуля */
  unzip?: boolean
}

export interface ModuleManifest {
  id: string
  /** Программы и модели показываются отдельными группами */
  group: 'tool' | 'model'
  name: string
  version: string
  description: string
  license: string
  /** Откуда скачивается (показывается пользователю) */
  source: string
  files: ModuleFile[]
  /** Главный файл внутри папки модуля: по нему определяем, что модуль установлен, и берём путь к нему */
  main: string
}

/** Релиз репозитория, где лежат копии моделей (адрес можно заменить для тестов и зеркал). */
export const MODELS_BASE = 'https://github.com/Omorriiz/Morphio/releases/download/models-v1'
const modelsBase = (): string => (process.env['MORPHIO_MODELS_URL'] ?? MODELS_BASE).replace(/\/+$/, '')

export const MODULES: ModuleManifest[] = [
  {
    id: 'pandoc',
    group: 'tool',
    name: 'Pandoc',
    version: '3.14',
    description: 'Документы и книги: DOCX, ODT, RTF, HTML, Markdown, EPUB, FB2 и PDF',
    license: 'GPL-2.0-or-later',
    source: 'github.com/jgm/pandoc',
    files: [
      {
        name: 'pandoc-3.14-windows-x86_64.zip',
        url: 'https://github.com/jgm/pandoc/releases/download/3.14/pandoc-3.14-windows-x86_64.zip',
        sha256: '0144b96e8c7b023fd382ec5ef5bdc475e873f1019d6fa72502492df2c9a94a3b',
        size: 43_614_099,
        unzip: true
      }
    ],
    main: 'pandoc-3.14/pandoc.exe'
  },
  {
    id: 'bg-isnet',
    group: 'model',
    name: 'Удаление фона (ISNet)',
    version: '1',
    description: 'Нейросеть для удаления фона у фото и кадров анимации',
    license: 'Apache-2.0',
    source: 'github.com/xuebinqin/DIS',
    files: [{ name: 'isnet-general-use.onnx', sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a', size: 178_648_008 }],
    main: 'isnet-general-use.onnx'
  },
  {
    id: 'upscale',
    group: 'model',
    name: 'Увеличение фото (Real-ESRGAN)',
    version: 'x4v3',
    description: 'Нейросеть увеличивает фото в 2 или 4 раза и убирает шум; лёгкая модель general-x4v3',
    license: 'BSD-3-Clause',
    source: 'github.com/xinntao/Real-ESRGAN',
    files: [
      { name: 'realesrgan-x4v3.onnx', saveAs: 'model.onnx', sha256: '2d1810f8b75c6a899487decf933697241eafbe6327d7b723674ba6df73a08fda', size: 42_443 },
      { name: 'realesrgan-x4v3.data', saveAs: 'model.data', sha256: '512d0ec9940c2e9d85d27f2952f12a0b77b7841dc22df4ce9f3ea458bc98f37f', size: 4_836_096 }
    ],
    main: 'model.onnx'
  },
  {
    id: 'tess-rus',
    group: 'model',
    name: 'Распознавание текста: русский',
    version: 'fast',
    description: 'Язык для распознавания текста на картинках и в сканах PDF (Tesseract)',
    license: 'Apache-2.0',
    source: 'github.com/tesseract-ocr/tessdata_fast',
    files: [{ name: 'rus.traineddata', sha256: 'e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225', size: 3_861_738 }],
    main: 'rus.traineddata'
  },
  {
    id: 'tess-eng',
    group: 'model',
    name: 'Распознавание текста: английский',
    version: 'fast',
    description: 'Язык для распознавания текста на картинках и в сканах PDF (Tesseract)',
    license: 'Apache-2.0',
    source: 'github.com/tesseract-ocr/tessdata_fast',
    files: [{ name: 'eng.traineddata', sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2', size: 4_113_088 }],
    main: 'eng.traineddata'
  },
  {
    id: 'whisper',
    group: 'tool',
    name: 'Речь в текст (программа whisper.cpp)',
    version: 'b5130',
    description: 'Программа, которая превращает речь в субтитры; работает на процессоре',
    license: 'MIT',
    source: 'github.com/ggml-org/whisper.cpp',
    files: [{ name: 'whisper-bin-x64.zip', sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c', size: 8_573_270, unzip: true }],
    main: 'Release/whisper-cli.exe'
  },
  {
    id: 'whisper-tiny',
    group: 'model',
    name: 'Речь в текст: быстрая (tiny)',
    version: 'ggml',
    description: 'Самая лёгкая модель: быстро, но с ошибками в сложной речи',
    license: 'MIT',
    source: 'huggingface.co/ggerganov/whisper.cpp',
    files: [{ name: 'ggml-tiny.bin', sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', size: 77_691_713 }],
    main: 'ggml-tiny.bin'
  },
  {
    id: 'whisper-base',
    group: 'model',
    name: 'Речь в текст: обычная (base)',
    version: 'ggml',
    description: 'Хороший баланс скорости и точности для чистой речи',
    license: 'MIT',
    source: 'huggingface.co/ggerganov/whisper.cpp',
    files: [{ name: 'ggml-base.bin', sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', size: 147_951_465 }],
    main: 'ggml-base.bin'
  },
  {
    id: 'whisper-small',
    group: 'model',
    name: 'Речь в текст: точная (small)',
    version: 'ggml',
    description: 'Заметно точнее для русского языка, но медленнее',
    license: 'MIT',
    source: 'huggingface.co/ggerganov/whisper.cpp',
    files: [{ name: 'ggml-small.bin', sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', size: 487_601_967 }],
    main: 'ggml-small.bin'
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

const moduleDirIn = (root: string, m: ModuleManifest): string => join(root, m.id, m.version)
const totalSize = (m: ModuleManifest): number => m.files.reduce((s, f) => s + f.size, 0)

/** Внутри собранного приложения 7za лежит не в asar-архиве. */
const sevenZip = (): string => path7za.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

/** Папка установленного модуля. */
export function moduleDir(id: string): string | undefined {
  const m = manifestOf(id)
  for (const root of searchDirs) {
    const dir = moduleDirIn(root, m)
    if (existsSync(join(dir, m.main)) && existsSync(join(dir, '.ok'))) return dir
  }
  return undefined
}

/** Путь к главному файлу модуля (программе или модели), если он установлен. */
export function modulePath(id: string): string | undefined {
  const dir = moduleDir(id)
  return dir ? join(dir, manifestOf(id).main) : undefined
}

export const moduleReady = (id: string): boolean => !!moduleDir(id)

export function moduleList(): ModuleInfo[] {
  return MODULES.map((m) => ({
    id: m.id,
    group: m.group,
    name: m.name,
    version: m.version,
    description: m.description,
    license: m.license,
    source: m.source,
    sizeMB: Math.round((totalSize(m) / 1024 / 1024) * 10) / 10,
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
  await fs.mkdir(dirname(dest), { recursive: true })
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
  const dir = moduleDirIn(installRoot, m)
  const total = totalSize(m)
  const downloads = join(installRoot, m.id, '.downloads')
  try {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })
    report({ id, phase: 'download', received: 0, total })
    let done = 0
    for (const f of m.files) {
      const url = f.url ?? `${modelsBase()}/${f.name}`
      const target = f.unzip ? join(downloads, f.name) : join(dir, f.saveAs ?? f.name)
      await downloadVerified(url, target, f, (received) => report({ id, phase: 'download', received: done + received, total }), doFetch)
      done += f.size
      if (f.unzip) {
        report({ id, phase: 'extract', received: done, total })
        await extractZip(target, dir)
      }
    }
    if (!existsSync(join(dir, m.main))) throw new Error(tm('В скачанном архиве нет нужной программы'))
    await fs.writeFile(join(dir, '.ok'), m.files.map((f) => f.sha256).join('\n'))
    report({ id, phase: 'done', received: total, total })
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true })
    report({ id, phase: 'error', received: 0, total: 0, error: e instanceof Error ? e.message : String(e) })
  } finally {
    await fs.rm(downloads, { recursive: true, force: true })
    busy.delete(id)
  }
}

/** Удаляет установленный модуль из папки данных. */
export async function removeModule(id: string): Promise<void> {
  const m = manifestOf(id)
  await fs.rm(join(installRoot, m.id), { recursive: true, force: true })
}
