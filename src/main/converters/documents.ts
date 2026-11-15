import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FileItem, UniversalOptions } from '@shared/types'
import { freePath } from '../files'
import { modulePath } from '../modules'
import { tm } from '../tm'
import type { JobResult } from '../queue'
import { decodeText } from './tables'

/**
 * Документы и книги. Основную работу делает Pandoc (модуль, докачивается по кнопке),
 * PDF получается через HTML и печать встроенным Chromium (LaTeX не нужен).
 * MOBI и AZW3 умеет только Calibre: если он установлен, берём `ebook-convert`.
 */

export interface DocFormat {
  id: string
  label: string
  ext: string
  hint: string
}

/** Что можно получить из документа (и что Pandoc понимает на входе, кроме pdf/mobi/azw3). */
export const DOC_FORMATS: DocFormat[] = [
  { id: 'pdf', label: 'PDF', ext: 'pdf', hint: 'Для печати и отправки' },
  { id: 'docx', label: 'DOCX', ext: 'docx', hint: 'Документ Word' },
  { id: 'odt', label: 'ODT', ext: 'odt', hint: 'Документ LibreOffice' },
  { id: 'rtf', label: 'RTF', ext: 'rtf', hint: 'Простой текстовый документ' },
  { id: 'html', label: 'HTML', ext: 'html', hint: 'Страница для браузера' },
  { id: 'md', label: 'Markdown', ext: 'md', hint: 'Лёгкая разметка текста' },
  { id: 'txt', label: 'TXT', ext: 'txt', hint: 'Простой текст без оформления' },
  { id: 'epub', label: 'EPUB', ext: 'epub', hint: 'Электронная книга' },
  { id: 'fb2', label: 'FB2', ext: 'fb2', hint: 'Книга для читалок' }
]

/** Форматы Calibre: читалки Kindle. */
export const CALIBRE_FORMATS: DocFormat[] = [
  { id: 'mobi', label: 'MOBI', ext: 'mobi', hint: 'Книга для Kindle (нужен Calibre)' },
  { id: 'azw3', label: 'AZW3', ext: 'azw3', hint: 'Книга для Kindle (нужен Calibre)' }
]

/** Расширения, которые Pandoc читает. */
const PANDOC_INPUT: Record<string, string> = {
  docx: 'docx',
  odt: 'odt',
  rtf: 'rtf',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  epub: 'epub',
  fb2: 'fb2'
}

export const CALIBRE_ONLY_INPUT = ['mobi', 'azw3']
/** Что `ebook-convert` принимает из документов и книг. */
const CALIBRE_INPUT = ['epub', 'docx', 'fb2', 'html', 'htm', 'txt', 'md', 'rtf', 'mobi', 'azw3']
/** Что `ebook-convert` умеет на выходе для книг, прочитанных только Calibre. */
const CALIBRE_OUT_FOR_MOBI = ['epub', 'azw3', 'docx', 'fb2', 'txt', 'rtf', 'pdf']

export const normalizeExt = (ext: string): string => {
  const e = ext.toLowerCase()
  if (e === 'htm') return 'html'
  if (e === 'markdown') return 'md'
  return e
}

/** Варианты результата для документа с таким расширением. */
export function docTargetIds(ext: string): { id: string; calibre: boolean }[] {
  const e = normalizeExt(ext)
  if (CALIBRE_ONLY_INPUT.includes(e)) {
    return CALIBRE_OUT_FOR_MOBI.filter((x) => x !== e).map((id) => ({ id, calibre: true }))
  }
  const list = DOC_FORMATS.filter((f) => f.id !== e).map((f) => ({ id: f.id, calibre: false }))
  if (CALIBRE_INPUT.includes(ext.toLowerCase())) {
    for (const f of CALIBRE_FORMATS) list.push({ id: f.id, calibre: true })
  }
  return list
}

// ---------- запуск программ ----------

const running = new Set<ChildProcess>()
const stopped = new WeakSet<ChildProcess>()

export function cancelDocuments(): void {
  for (const c of running) {
    stopped.add(c)
    c.kill()
  }
}

interface Ran {
  code: number | null
  stdout: string
  stderr: string
}

function runProgram(exe: string, args: string[], stdin?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    running.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (e) => {
      running.delete(child)
      reject(e)
    })
    child.on('close', (code) => {
      running.delete(child)
      if (stopped.has(child)) reject(new Error(tm('Остановлено')))
      else resolve({ code, stdout, stderr })
    })
    if (stdin !== undefined) child.stdin.end(stdin, 'utf8')
    else child.stdin.end()
  })
}

/** Calibre: стандартные места установки и PATH. */
export function calibreBinary(): string | undefined {
  const dirs = [
    process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'Calibre2'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Calibre2'),
    process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Programs', 'Calibre2'),
    ...(process.env['PATH'] ?? '').split(';')
  ].filter(Boolean) as string[]
  for (const d of dirs) {
    const p = join(d, 'ebook-convert.exe')
    if (existsSync(p)) return p
  }
  return undefined
}

// ---------- txt → html, чистый текст без разметки ----------

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Обычный текст превращаем в HTML сами: абзацы по пустым строкам, чтобы звёздочки и решётки не считались разметкой. */
export function textToHtml(text: string, title: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>\n')}</p>`)
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>\n${paragraphs.join('\n')}\n</body></html>`
}

// ---------- оформление для PDF ----------

const PDF_CSS = `
html { font-size: 12pt; }
body { font-family: "Segoe UI", Calibri, Arial, sans-serif; line-height: 1.5; color: #111; margin: 0; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 0.5em; page-break-after: avoid; }
h1 { font-size: 1.9em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
p { margin: 0.6em 0; orphans: 3; widows: 3; }
img { max-width: 100%; height: auto; }
pre, code { font-family: Consolas, "Courier New", monospace; font-size: 0.9em; }
pre { background: #f4f4f7; padding: 0.7em 0.9em; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; }
code { background: #f4f4f7; padding: 0 0.25em; border-radius: 4px; }
pre code { background: none; padding: 0; }
blockquote { margin: 0.8em 0; padding: 0.1em 1em; border-left: 4px solid #c9c9d6; color: #444; }
table { border-collapse: collapse; margin: 0.8em 0; max-width: 100%; }
th, td { border: 1px solid #bbb; padding: 0.3em 0.6em; text-align: left; }
th { background: #f0f0f5; }
a { color: #3b4cca; }
header#title-block-header { margin-bottom: 1.5em; }
`

/** Печать HTML в PDF встроенным Chromium: окно скрыто, сеть закрыта, скрипты выключены. */
export async function htmlToPdf(htmlPath: string, outPath: string): Promise<void> {
  const { BrowserWindow, session } = await import('electron')
  const ses = session.fromPartition(`morphio-print-${randomUUID()}`)
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => cb({ cancel: true }))
  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await win.loadFile(htmlPath)
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.8, bottom: 0.9, left: 0.8, right: 0.8 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font-size:9px;color:#777;width:100%;text-align:center;font-family:Segoe UI,Arial"><span class="pageNumber"></span></div>'
    })
    await fs.writeFile(outPath, pdf)
  } finally {
    win.destroy()
  }
}

// ---------- основная функция ----------

function pandocFail(r: Ran): Error {
  const msg = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(0, 3).join(' ')
  return new Error(tm('Pandoc не смог преобразовать файл: {msg}', { msg: msg.slice(0, 240) || String(r.code) }))
}

async function hasTitle(path: string, ext: string): Promise<boolean> {
  if (ext !== 'md' && ext !== 'html') return false
  const head = decodeText(await fs.readFile(path)).slice(0, 4000)
  return ext === 'md' ? /^---\s*\n[\s\S]*?\btitle\s*:/m.test(head) : /<title>\s*\S/i.test(head)
}

/** Преобразует документ или книгу в выбранный формат. */
export async function convertDocument(
  item: FileItem,
  format: string,
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const inExt = normalizeExt(item.ext)
  const outDir = options.outputDir ?? dirname(item.path)
  await fs.mkdir(outDir, { recursive: true })
  const stem = basename(item.path, extname(item.path))
  const out = await freePath(outDir, stem, format)
  update({ percent: 5 })

  // Calibre: книги Kindle в любую сторону
  const viaCalibre = CALIBRE_ONLY_INPUT.includes(inExt) || CALIBRE_FORMATS.some((f) => f.id === format)
  if (viaCalibre) {
    const bin = calibreBinary()
    if (!bin) throw new Error(tm('Для MOBI и AZW3 нужна программа Calibre. Установите её с calibre-ebook.com'))
    const r = await runProgram(bin, [item.path, out])
    if (r.code !== 0 || !existsSync(out)) {
      await fs.rm(out, { force: true })
      throw new Error(tm('Calibre не смог преобразовать файл: {msg}', { msg: (r.stderr || r.stdout).trim().slice(-240) }))
    }
    return { outputPath: out, outputSize: (await fs.stat(out)).size }
  }

  const pandoc = modulePath('pandoc')
  if (!pandoc) throw new Error(tm('Нужен модуль Pandoc. Скачайте его кнопкой в приложении'))

  // Вход: файл, а для обычного текста наш HTML через stdin
  let input: string[] = []
  let stdin: string | undefined
  let reader: string
  if (inExt === 'txt') {
    stdin = textToHtml(decodeText(await fs.readFile(item.path)), stem)
    reader = 'html'
  } else {
    reader = PANDOC_INPUT[inExt] ?? ''
    if (!reader) throw new Error(tm('Этот формат документа не поддерживается'))
    input = [item.path]
  }
  const titled = inExt === 'txt' ? true : await hasTitle(item.path, inExt)
  const base = ['--sandbox', '-f', reader]

  const writers: Record<string, string[]> = {
    docx: ['-t', 'docx'],
    odt: ['-t', 'odt'],
    rtf: ['-t', 'rtf', '-s'],
    html: ['-t', 'html5', '-s', '--metadata', `pagetitle=${stem}`],
    md: ['-t', 'gfm', '--wrap=none'],
    txt: ['-t', 'plain', '--wrap=none'],
    epub: ['-t', 'epub3'],
    fb2: ['-t', 'fb2']
  }

  if (format === 'pdf') {
    const tmpHtml = join(dirname(item.path), `.morphio-${randomUUID().slice(0, 8)}.html`)
    try {
      const r = await runProgram(pandoc, [...base, '-t', 'html5', '-s', '--metadata', `pagetitle=${stem}`, ...input], stdin)
      if (r.code !== 0) throw pandocFail(r)
      update({ percent: 50 })
      const html = r.stdout.replace('</head>', `<style>${PDF_CSS}</style></head>`)
      await fs.writeFile(tmpHtml, html, 'utf8')
      await htmlToPdf(tmpHtml, out)
    } catch (e) {
      await fs.rm(out, { force: true })
      throw e
    } finally {
      await fs.rm(tmpHtml, { force: true })
    }
    return { outputPath: out, outputSize: (await fs.stat(out)).size }
  }

  const w = writers[format]
  if (!w) throw new Error(tm('Для этого файла такой вариант недоступен'))
  const extra = (format === 'epub' || format === 'fb2') && !titled ? ['--metadata', `title=${stem}`] : []
  const args = [...base, ...w, ...extra, '-o', out, ...input]
  const r = await runProgram(pandoc, args, stdin)
  if (r.code !== 0) {
    await fs.rm(out, { force: true })
    throw pandocFail(r)
  }
  update({ percent: 100 })
  return { outputPath: out, outputSize: (await fs.stat(out)).size }
}
