import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import type { FileItem, UniversalOptions } from '@shared/types'
import { dirSize, freeDir, freePath } from '../files'
import { openImage } from '../imageInput'
import { tm } from '../tm'
import type { JobResult } from '../queue'

/**
 * Инструменты для PDF без внешних программ: pdf-lib собирает, склеивает и делит документы,
 * pdfjs-dist читает текст и рисует страницы (на нативном холсте @napi-rs/canvas).
 */

const MAX_PAGES = 3000
/** 2 = 144 точки на дюйм: страница A4 получается около 1190×1684 px. */
const RENDER_SCALE = 2
const MAX_PDF_BYTES = 500 * 1024 * 1024

const req = createRequire(import.meta.url ?? __filename)

/** Внутри собранного приложения файлы лежат не в asar-архиве, а рядом. */
const unpacked = (p: string): string => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

function pdfjsDir(): string {
  return unpacked(dirname(req.resolve('pdfjs-dist/package.json')))
}

/**
 * Нативный холст берём тем же путём, каким его находит сам pdfjs (из папки pdfjs-dist): в собранном приложении
 * иначе получились бы две копии модуля, и страницы не рисовались бы.
 */
function canvasModule(): typeof import('@napi-rs/canvas') {
  return createRequire(join(pdfjsDir(), 'package.json'))('@napi-rs/canvas')
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsPromise: Promise<PdfJs> | undefined

function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import(/* @vite-ignore */ pathToFileURL(join(pdfjsDir(), 'legacy', 'build', 'pdf.mjs')).href) as Promise<PdfJs>
  return pdfjsPromise
}

async function readPdf(path: string): Promise<Uint8Array> {
  const stat = await fs.stat(path)
  if (stat.size > MAX_PDF_BYTES) throw new Error(tm('PDF слишком большой (больше 500 МБ)'))
  return new Uint8Array(await fs.readFile(path))
}

type Doc = import('pdfjs-dist/types/src/display/api').PDFDocumentProxy

async function openDoc(path: string, password?: string): Promise<{ doc: Doc; close: () => Promise<void> }> {
  const pdfjs = await loadPdfjs()
  const dir = pdfjsDir().replace(/\\/g, '/')
  const task = pdfjs.getDocument({
    data: await readPdf(path),
    standardFontDataUrl: `${dir}/standard_fonts/`,
    cMapUrl: `${dir}/cmaps/`,
    cMapPacked: true,
    useSystemFonts: false,
    password: password || undefined,
    verbosity: 0
  })
  try {
    const doc = await task.promise
    if (doc.numPages > MAX_PAGES) throw new Error(tm('В PDF слишком много страниц ({n})', { n: doc.numPages }))
    return { doc, close: () => task.destroy() }
  } catch (e) {
    const name = (e as { name?: string }).name
    if (name === 'PasswordException') {
      throw new Error(password ? tm('Неверный пароль PDF') : tm('PDF защищён паролем: введите пароль в настройках'))
    }
    if (name === 'InvalidPDFException') throw new Error(tm('Файл повреждён или это не PDF'))
    throw e
  }
}

const pad = (n: number, total: number): string => String(n).padStart(Math.max(3, String(total).length), '0')
const stem = (path: string): string => basename(path, extname(path))

// ---------- PDF → текст ----------

export async function pdfToText(
  item: FileItem,
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const { doc, close } = await openDoc(item.path, options.password)
  try {
    const pages: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      let text = ''
      for (const it of content.items) {
        if (!('str' in it)) continue
        text += it.str
        text += it.hasEOL ? '\n' : ''
      }
      pages.push(text.replace(/[ \t]+\n/g, '\n').trim())
      page.cleanup()
      update({ percent: (n / doc.numPages) * 100 })
    }
    const all = pages.join('\n\n')
    if (all.replace(/\s/g, '') === '') {
      throw new Error(tm('В этом PDF нет текста: похоже, это скан. Распознавать буквы с картинки приложение пока не умеет'))
    }
    const out = await freePath(options.outputDir ?? dirname(item.path), stem(item.path), 'txt')
    await fs.mkdir(dirname(out), { recursive: true })
    await fs.writeFile(out, all + '\n', 'utf8')
    return { outputPath: out, outputSize: (await fs.stat(out)).size, info: tm('страниц: {n}', { n: doc.numPages }) }
  } finally {
    await close()
  }
}

// ---------- PDF → картинки ----------

export async function pdfToImages(
  item: FileItem,
  format: 'png' | 'jpg',
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const { createCanvas } = canvasModule()
  const { doc, close } = await openDoc(item.path, options.password)
  const parent = options.outputDir ?? dirname(item.path)
  await fs.mkdir(parent, { recursive: true })
  const dest = await freeDir(parent, `${stem(item.path)}-pages`)
  await fs.mkdir(dest, { recursive: true })
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const viewport = page.getViewport({ scale: RENDER_SCALE })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({
        canvasContext: ctx as never,
        canvas: canvas as never,
        viewport
      }).promise
      const png = canvas.toBuffer('image/png')
      const file = join(dest, `${stem(item.path)}-${pad(n, doc.numPages)}.${format}`)
      if (format === 'png') await fs.writeFile(file, png)
      else await sharp(png).jpeg({ quality: options.quality, mozjpeg: true }).toFile(file)
      page.cleanup()
      update({ percent: (n / doc.numPages) * 100 })
    }
    return { outputPath: dest, outputSize: await dirSize(dest), info: tm('страниц: {n}', { n: doc.numPages }) }
  } catch (e) {
    await fs.rm(dest, { recursive: true, force: true })
    throw e
  } finally {
    await close()
  }
}

// ---------- разделить на страницы ----------

async function loadLib(path: string, password?: string): Promise<PDFDocument> {
  const bytes = await readPdf(path)
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: false })
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (/encrypted/i.test(msg)) {
      throw new Error(
        password
          ? tm('Из PDF с паролем страницы вынуть нельзя: сначала снимите защиту')
          : tm('PDF защищён паролем: снимите защиту и повторите')
      )
    }
    throw new Error(tm('Файл повреждён или это не PDF'))
  }
}

export async function splitPdf(
  item: FileItem,
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const src = await loadLib(item.path, options.password)
  const total = src.getPageCount()
  if (total > MAX_PAGES) throw new Error(tm('В PDF слишком много страниц ({n})', { n: total }))
  const parent = options.outputDir ?? dirname(item.path)
  await fs.mkdir(parent, { recursive: true })
  const dest = await freeDir(parent, `${stem(item.path)}-pages`)
  await fs.mkdir(dest, { recursive: true })
  try {
    for (let i = 0; i < total; i++) {
      const doc = await PDFDocument.create()
      const [page] = await doc.copyPages(src, [i])
      doc.addPage(page)
      await fs.writeFile(join(dest, `${stem(item.path)}-${pad(i + 1, total)}.pdf`), await doc.save())
      update({ percent: ((i + 1) / total) * 100 })
    }
    return { outputPath: dest, outputSize: await dirSize(dest), info: tm('страниц: {n}', { n: total }) }
  } catch (e) {
    await fs.rm(dest, { recursive: true, force: true })
    throw e
  }
}

// ---------- склеить и собрать из картинок ----------

/** Длинная сторона страницы для картинок, в пунктах (около A4). */
const PAGE_LONG_SIDE = 842

async function addImagePage(doc: PDFDocument, path: string): Promise<void> {
  const img = (await openImage(path)).rotate()
  const meta = await img.clone().metadata()
  const hasAlpha = !!meta.hasAlpha
  const buf = hasAlpha ? await img.png().toBuffer() : await img.jpeg({ quality: 92 }).toBuffer()
  const embedded = hasAlpha ? await doc.embedPng(buf) : await doc.embedJpg(buf)
  const k = Math.min(1, PAGE_LONG_SIDE / Math.max(embedded.width, embedded.height))
  const w = embedded.width * k
  const h = embedded.height * k
  const page = doc.addPage([w, h])
  page.drawImage(embedded, { x: 0, y: 0, width: w, height: h })
}

/** Собирает один PDF из PDF-файлов и картинок в указанном порядке. */
export async function mergeToPdf(
  items: FileItem[],
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  if (items.length === 0) throw new Error(tm('Нет файлов'))
  const out = await PDFDocument.create()
  let i = 0
  for (const it of items) {
    if (it.ext.toLowerCase() === 'pdf') {
      const src = await loadLib(it.path, options.password)
      const pages = await out.copyPages(src, src.getPageIndices())
      pages.forEach((p) => out.addPage(p))
    } else {
      await addImagePage(out, it.path)
    }
    update({ percent: (++i / items.length) * 100 })
  }
  const first = items[0]
  const base = items.length === 1 ? stem(first.path) : `${stem(first.path)}-merged`
  const file = await freePath(options.outputDir ?? dirname(first.path), base, 'pdf')
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, await out.save())
  return {
    outputPath: file,
    outputSize: (await fs.stat(file)).size,
    info: tm('страниц: {n}', { n: out.getPageCount() })
  }
}
