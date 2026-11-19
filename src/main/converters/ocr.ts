import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import type { FileItem, UniversalOptions } from '@shared/types'
import { freePath } from '../files'
import { openImage } from '../imageInput'
import { modulePath } from '../modules'
import { tm } from '../tm'
import type { JobResult } from '../queue'
import { forEachPdfPage } from './pdf'

/**
 * Распознавание текста (OCR) на Tesseract.js: WASM, работает офлайн. Языковые файлы докачиваются как модули
 * (русский и английский, «tessdata_fast»). Выход: обычный текст или PDF с невидимым текстовым слоем (ищется и копируется).
 */

export const OCR_LANGS: Record<string, { module: string; label: string }> = {
  rus: { module: 'tess-rus', label: 'русский' },
  eng: { module: 'tess-eng', label: 'английский' }
}

const req = createRequire(import.meta.url ?? __filename)
const unpacked = (p: string): string => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

/** Разбирает «rus+eng» в список языков; неизвестные коды отвергаются. */
export function parseLangs(text: string | undefined): string[] {
  const list = (text ?? 'rus+eng')
    .split(/[+,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  const known = list.map((l) => ({ rus: 'rus', ru: 'rus', eng: 'eng', en: 'eng' })[l] ?? l)
  const bad = known.find((l) => !OCR_LANGS[l])
  if (bad) throw new Error(tm('Язык «{l}» не поддерживается. Доступны: rus, eng', { l: bad }))
  return [...new Set(known)]
}

/** Какие модули нужны для языков и каких не хватает. */
export function missingLangModules(langs: string[]): string[] {
  return langs.map((l) => OCR_LANGS[l].module).filter((m) => !modulePath(m))
}

let active: { terminate: () => Promise<unknown> } | null = null
let stopped = false
/** Кнопка «Остановить». */
export function cancelOcr(): void {
  stopped = true
  void active?.terminate()
}

type Worker = {
  recognize: (img: Buffer, opts?: object, out?: object) => Promise<{ data: { text: string; confidence: number; pdf?: number[] | Uint8Array } }>
  terminate: () => Promise<unknown>
}

async function startWorker(langs: string[]): Promise<{ worker: Worker; dir: string }> {
  const missing = missingLangModules(langs)
  if (missing.length > 0) throw new Error(tm('Нужны языки для распознавания. Скачайте модули в приложении: {list}', { list: missing.join(', ') }))
  // tesseract.js ищет все языки в одной папке: собираем её из установленных модулей
  const dir = join(tmpdir(), `morphio-tess-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  for (const l of langs) await fs.copyFile(modulePath(OCR_LANGS[l].module)!, join(dir, `${l}.traineddata`))
  const { createWorker } = (await import('tesseract.js')) as unknown as {
    createWorker: (langs: string[], oem: number, options: Record<string, unknown>) => Promise<Worker>
  }
  const root = unpacked(dirname(req.resolve('tesseract.js/package.json')))
  const core = unpacked(dirname(req.resolve('tesseract.js-core/package.json')))
  const worker = await createWorker(langs, 1, {
    langPath: dir,
    gzip: false,
    cacheMethod: 'none',
    workerPath: join(root, 'src', 'worker-script', 'node', 'index.js'),
    corePath: core,
    workerBlobURL: false,
    logger: () => {}
  })
  active = worker
  return { worker, dir }
}

/** Подготовка картинки: поворот по EXIF, серый, контраст, увеличение мелкого текста. */
export async function prepareForOcr(input: Buffer | string): Promise<Buffer> {
  const img = typeof input === 'string' ? (await openImage(input)).rotate() : sharp(input)
  const meta = await img.clone().metadata()
  let p = img.flatten({ background: '#ffffff' }).grayscale().normalise()
  const w = meta.width ?? 0
  if (w > 0 && w < 1000) p = p.resize({ width: Math.min(3000, w * 2), kernel: 'lanczos3' })
  return p.withMetadata({ density: 300 }).png().toBuffer()
}

/** Если первая попытка дала меньше такой уверенности, пробуем повернуть страницу. */
export const ORIENT_BELOW = 60
/** Поворот принимается, только если уверенность выросла хотя бы на столько. */
export const ORIENT_GAIN = 15

/**
 * Выбирает поворот страницы (0, 90, 180, 270): быстро распознаёт уменьшенную копию в каждом положении
 * и берёт то, где уверенность заметно выше. Нужен для сканов, лежащих боком или вверх ногами.
 */
export async function pickRotation(worker: Pick<Worker, 'recognize'>, prepared: Buffer, current: number): Promise<{ deg: number; confidence: number }> {
  let best = { deg: 0, confidence: current }
  for (const deg of [90, 180, 270]) {
    const probe = await sharp(prepared).rotate(deg).resize({ width: 1000, withoutEnlargement: true }).png().toBuffer()
    const r = await worker.recognize(probe)
    if (r.data.confidence > best.confidence) best = { deg, confidence: r.data.confidence }
  }
  return best.confidence >= current + ORIENT_GAIN ? best : { deg: 0, confidence: current }
}

const mergePdfs = async (parts: (number[] | Uint8Array)[]): Promise<Uint8Array> => {
  const out = await PDFDocument.create()
  for (const bytes of parts) {
    const src = await PDFDocument.load(bytes as Uint8Array)
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((pg) => out.addPage(pg))
  }
  return out.save()
}

/**
 * Распознаёт картинку или PDF-скан. mode: 'txt' — текстовый файл, 'pdf' — PDF с текстовым слоем.
 */
export async function ocrFile(
  item: FileItem,
  mode: 'txt' | 'pdf',
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  // Язык не задан (быстрое окно, следящие папки): берём те языки, что установлены
  let langs = parseLangs(options.lang)
  if (!options.lang) {
    const have = langs.filter((l) => modulePath(OCR_LANGS[l].module))
    if (have.length > 0) langs = have
  }
  stopped = false
  const { worker, dir } = await startWorker(langs)
  const dest = options.outputDir ?? dirname(item.path)
  await fs.mkdir(dest, { recursive: true })
  const stem = basename(item.path, extname(item.path))
  const texts: string[] = []
  const pdfs: (number[] | Uint8Array)[] = []
  let confidence = 0
  let pages = 0
  let turned = 0
  try {
    const one = async (png: Buffer): Promise<void> => {
      let prepared = await prepareForOcr(png)
      let r = await worker.recognize(prepared, {}, mode === 'pdf' ? { pdf: true } : {})
      if (r.data.confidence < ORIENT_BELOW) {
        const pick = await pickRotation(worker, prepared, r.data.confidence)
        if (pick.deg !== 0) {
          prepared = await sharp(prepared).rotate(pick.deg).png().toBuffer()
          r = await worker.recognize(prepared, {}, mode === 'pdf' ? { pdf: true } : {})
          turned++
        }
      }
      texts.push(r.data.text.trim())
      if (r.data.pdf) pdfs.push(r.data.pdf)
      confidence += r.data.confidence
      pages++
    }
    if ((item.kind ?? '') === 'pdf' || extname(item.path).toLowerCase() === '.pdf') {
      await forEachPdfPage(item.path, options.password, 3, async (png, n, total) => {
        if (stopped) throw new Error(tm('Остановлено'))
        await one(png)
        update({ percent: (n / total) * 100 })
      })
    } else {
      update({ percent: 5 })
      await one(await (await openImage(item.path)).rotate().png().toBuffer())
    }
    const all = texts.join('\n\n')
    if (all.replace(/\s/g, '') === '') throw new Error(tm('Текст на картинке не найден'))
    let out: string
    if (mode === 'pdf') {
      out = await freePath(dest, `${stem}-ocr`, 'pdf')
      await fs.writeFile(out, await mergePdfs(pdfs))
    } else {
      out = await freePath(dest, stem, 'txt')
      await fs.writeFile(out, all + '\n', 'utf8')
    }
    update({ percent: 100 })
    return {
      outputPath: out,
      outputSize: (await fs.stat(out)).size,
      info: [tm('распознано, уверенность {pct}%', { pct: Math.round(confidence / Math.max(1, pages)) }), turned > 0 ? tm('повёрнуто страниц: {n}', { n: turned }) : ''].filter(Boolean).join(' · ')
    }
  } finally {
    active = null
    await worker.terminate().catch(() => {})
    await fs.rm(dir, { recursive: true, force: true })
  }
}
