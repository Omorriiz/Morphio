import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { mergeToPdf, pdfToImages, pdfToText, splitPdf } from '../../src/main/converters/pdf'
import { getTargets, kindOfExt, MERGE_TARGET } from '../../src/main/registry'
import { defaultUniversalOptions } from '../../src/shared/types'
import { cleanupAfterAll, exists, fileItem, makeImage, tmpDir } from '../helpers'

cleanupAfterAll()

const noop = (): void => {}
const opts = (outputDir?: string) => defaultUniversalOptions('pdf:txt', outputDir)

async function makePdf(path: string, pages: string[]): Promise<string> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const text of pages) {
    const page = doc.addPage([400, 300])
    page.drawText(text, { x: 40, y: 150, size: 24, font })
  }
  await fs.writeFile(path, await doc.save())
  return path
}

describe('PDF', () => {
  it('kindOfExt: pdf и документы', () => {
    expect(kindOfExt('pdf')).toBe('pdf')
    expect(kindOfExt('docx')).toBe('document')
    expect(kindOfExt('epub')).toBe('document')
  })

  it('PDF → текст: все страницы, порядок сохранён', async () => {
    const dir = await tmpDir('pdf')
    const src = await makePdf(join(dir, 'a.pdf'), ['Hello first page', 'Second page here'])
    const r = await pdfToText(await fileItem(src), opts(), noop)
    const text = await fs.readFile(r.outputPath, 'utf8')
    expect(text).toContain('Hello first page')
    expect(text.indexOf('Hello')).toBeLessThan(text.indexOf('Second'))
    expect(r.info).toContain('2')
  })

  it('PDF без текста даёт понятную ошибку', async () => {
    const dir = await tmpDir('pdf')
    const doc = await PDFDocument.create()
    doc.addPage([200, 200])
    const src = join(dir, 'blank.pdf')
    await fs.writeFile(src, await doc.save())
    await expect(pdfToText(await fileItem(src), opts(), noop)).rejects.toThrow()
  })

  it('PDF → PNG: по файлу на страницу в новой папке', async () => {
    const dir = await tmpDir('pdf')
    const src = await makePdf(join(dir, 'книга.pdf'), ['One', 'Two', 'Three'])
    const r = await pdfToImages(await fileItem(src), 'png', opts(), noop)
    const files = (await fs.readdir(r.outputPath)).sort()
    expect(files).toEqual(['книга-001.png', 'книга-002.png', 'книга-003.png'])
    const meta = await sharp(join(r.outputPath, files[0])).metadata()
    expect(meta.width).toBe(800)
    expect(meta.height).toBe(600)
  })

  it('PDF → JPG', async () => {
    const dir = await tmpDir('pdf')
    const src = await makePdf(join(dir, 'a.pdf'), ['x'])
    const r = await pdfToImages(await fileItem(src), 'jpg', opts(), noop)
    expect((await sharp(join(r.outputPath, 'a-001.jpg')).metadata()).format).toBe('jpeg')
  })

  it('разделение на страницы', async () => {
    const dir = await tmpDir('pdf')
    const src = await makePdf(join(dir, 'a.pdf'), ['A', 'B', 'C'])
    const r = await splitPdf(await fileItem(src), opts(), noop)
    const files = await fs.readdir(r.outputPath)
    expect(files).toHaveLength(3)
    const one = await PDFDocument.load(await fs.readFile(join(r.outputPath, files.sort()[1])))
    expect(one.getPageCount()).toBe(1)
  })

  it('склейка PDF и картинок в одном документе', async () => {
    const dir = await tmpDir('pdf')
    const a = await makePdf(join(dir, 'a.pdf'), ['A', 'B'])
    const png = await makeImage(join(dir, 'pic.png'), 300, 200)
    const jpg = await makeImage(join(dir, 'pic.jpg'), 200, 300)
    const r = await mergeToPdf([await fileItem(a), await fileItem(png), await fileItem(jpg)], opts(), noop)
    const doc = await PDFDocument.load(await fs.readFile(r.outputPath))
    expect(doc.getPageCount()).toBe(4)
    expect(r.outputPath.endsWith('a-merged.pdf')).toBe(true)
    expect(await exists(a)).toBe(true) // оригиналы не тронуты
  })

  it('картинка → PDF одной страницей', async () => {
    const dir = await tmpDir('pdf')
    const png = await makeImage(join(dir, 'pic.png'), 1600, 800)
    const r = await mergeToPdf([await fileItem(png)], opts(), noop)
    const doc = await PDFDocument.load(await fs.readFile(r.outputPath))
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getPage(0).getWidth()).toBeCloseTo(842, 0)
  })

  it('повреждённый PDF: понятная ошибка, а не падение', async () => {
    const dir = await tmpDir('pdf')
    const bad = join(dir, 'bad.pdf')
    await fs.writeFile(bad, 'это не pdf')
    await expect(splitPdf(await fileItem(bad), opts(), noop)).rejects.toThrow()
    await expect(pdfToText(await fileItem(bad), opts(), noop)).rejects.toThrow()
  })

  it('варианты в реестре: PDF, картинки, склейка', async () => {
    const dir = await tmpDir('pdf')
    const a = await fileItem(await makePdf(join(dir, 'a.pdf'), ['A']))
    const b = await fileItem(await makeImage(join(dir, 'b.png'), 50, 50))
    const ids = (items: typeof a[]): string[] => getTargets(items).map((t) => t.id)
    expect(ids([a])).toEqual(expect.arrayContaining(['pdf:txt', 'pdf:png', 'pdf:jpg', 'pdf:split']))
    expect(ids([a])).not.toContain(MERGE_TARGET)
    expect(ids([b])).toContain('pdf:each')
    expect(ids([a, b])).toContain(MERGE_TARGET)
    expect(ids([b, b])).toContain(MERGE_TARGET)
  })
})
