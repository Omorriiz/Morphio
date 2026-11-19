import { beforeAll, describe, expect, it } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import { missingLangModules, ocrFile, parseLangs, prepareForOcr } from '../../src/main/converters/ocr'
import { mergeToPdf, pdfToText } from '../../src/main/converters/pdf'
import { run } from '../../src/main/ffmpeg'
import { configureModules } from '../../src/main/modules'
import { getTargets } from '../../src/main/registry'
import { defaultUniversalOptions } from '../../src/shared/types'
import { cleanupAfterAll, fileItem, installFromRelease, releaseHas, tmpDir } from '../helpers'

cleanupAfterAll()

const noop = (): void => {}
const FONT = 'C:/Windows/Fonts/arial.ttf'
const can = releaseHas('rus.traineddata', 'eng.traineddata') && existsSync(FONT)
const opts = (dir: string, lang?: string): ReturnType<typeof defaultUniversalOptions> => ({ ...defaultUniversalOptions('ocr:txt', dir), lang })

/** Картинка с текстом: FFmpeg рисует строки шрифтом Windows (там есть кириллица). */
async function textImage(path: string, lines: string[], size = 48): Promise<string> {
  const filters = lines
    .map((l, i) => `drawtext=fontfile='${FONT.replace(':', '\\:')}':text='${l}':fontsize=${size}:fontcolor=black:x=40:y=${30 + i * (size + 24)}`)
    .join(',')
  const r = await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=white:s=900x${60 + lines.length * (size + 24)}`, '-vf', filters, '-frames:v', '1', path])
  if (r.code !== 0) throw new Error(r.stderr)
  return path
}

describe('языки', () => {
  it('«rus+eng», короткие коды, повторы; неизвестный язык — понятная ошибка', () => {
    expect(parseLangs(undefined)).toEqual(['rus', 'eng'])
    expect(parseLangs('ru+en')).toEqual(['rus', 'eng'])
    expect(parseLangs('eng')).toEqual(['eng'])
    expect(parseLangs('rus, rus')).toEqual(['rus'])
    expect(() => parseLangs('klingon')).toThrow(/klingon/)
  })

  it('без модулей: список недостающих и понятная ошибка при запуске', async () => {
    configureModules([])
    expect(missingLangModules(['rus', 'eng'])).toEqual(['tess-rus', 'tess-eng'])
    const dir = await tmpDir('ocr')
    await fs.writeFile(join(dir, 'a.png'), 'x')
    await expect(ocrFile(await fileItem(join(dir, 'a.png')), 'txt', opts(dir), noop)).rejects.toThrow(/модул|tess-/i)
  })

  it('варианты в реестре: для картинок и PDF, нужные модули помечены', async () => {
    configureModules([])
    const dir = await tmpDir('ocr')
    await fs.writeFile(join(dir, 'a.png'), 'x')
    const t = getTargets([await fileItem(join(dir, 'a.png'))]).filter((x) => x.id.startsWith('ocr:'))
    expect(t.map((x) => x.id)).toEqual(['ocr:txt', 'ocr:pdftext'])
    expect(t.every((x) => x.group === 'ai' && x.missing)).toBe(true)
  })
})

describe.skipIf(!can)('Tesseract (настоящие языки)', () => {
  beforeAll(async () => {
    expect(await installFromRelease(['tess-rus', 'tess-eng'])).toBe(true)
  })

  it('английский текст → TXT', async () => {
    const dir = await tmpDir('ocr')
    const img = await textImage(join(dir, 'en.png'), ['Hello Morphio world', 'Invoice number 12345'])
    const r = await ocrFile(await fileItem(img), 'txt', opts(dir, 'eng'), noop)
    const text = await fs.readFile(r.outputPath, 'utf8')
    expect(text).toMatch(/Hello/i)
    expect(text).toMatch(/Morphio/i)
    expect(text).toMatch(/12345/)
    expect(r.info).toContain('%')
  }, 120_000)

  it('русский текст и смесь языков', async () => {
    const dir = await tmpDir('ocr')
    const img = await textImage(join(dir, 'ru.png'), ['Привет мир', 'Счёт номер 2024 Morphio'])
    const r = await ocrFile(await fileItem(img), 'txt', opts(dir), noop) // rus+eng по умолчанию
    const text = await fs.readFile(r.outputPath, 'utf8')
    expect(text.toLowerCase()).toContain('привет')
    expect(text).toMatch(/Morphio/i)
    expect(text).toMatch(/2024/)
  }, 120_000)

  it('мелкий текст: картинка увеличивается перед распознаванием', async () => {
    const dir = await tmpDir('ocr')
    const img = await textImage(join(dir, 'small.png'), ['Small print text here'], 18)
    const prepared = await prepareForOcr(img)
    const meta = await (await import('sharp')).default(prepared).metadata()
    expect(meta.width).toBeGreaterThanOrEqual(1800)
    const r = await ocrFile(await fileItem(img), 'txt', opts(dir, 'eng'), noop)
    expect((await fs.readFile(r.outputPath, 'utf8')).toLowerCase()).toContain('small print')
  }, 120_000)

  it('PDF с текстовым слоем: текст можно извлечь обычным чтением PDF', async () => {
    const dir = await tmpDir('ocr')
    const img = await textImage(join(dir, 'doc.png'), ['Searchable document', 'Order 7788'])
    const r = await ocrFile(await fileItem(img), 'pdf', opts(dir, 'eng'), noop)
    expect(r.outputPath.endsWith('-ocr.pdf')).toBe(true)
    const bytes = await fs.readFile(r.outputPath)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    const back = await pdfToText(await fileItem(r.outputPath), defaultUniversalOptions('pdf:txt', dir), noop)
    const text = await fs.readFile(back.outputPath, 'utf8')
    expect(text).toMatch(/Searchable/i)
    expect(text).toMatch(/Order/i)
    expect(text).toMatch(/\d{3}/) // цифры тоже попали в текстовый слой
  }, 120_000)

  it('скан в PDF: страницы рисуются и распознаются, текст идёт по порядку', async () => {
    const dir = await tmpDir('ocr')
    const a = await textImage(join(dir, 'p1.png'), ['First page alpha'])
    const b = await textImage(join(dir, 'p2.png'), ['Second page beta'])
    const scan = await mergeToPdf([await fileItem(a), await fileItem(b)], defaultUniversalOptions('pdf:merge', dir), noop)
    expect(scan.outputPath.endsWith('.pdf')).toBe(true)
    const r = await ocrFile(await fileItem(scan.outputPath), 'txt', opts(dir, 'eng'), noop)
    const text = await fs.readFile(r.outputPath, 'utf8')
    expect(text.toLowerCase().indexOf('first page')).toBeGreaterThanOrEqual(0)
    expect(text.toLowerCase().indexOf('second page')).toBeGreaterThan(text.toLowerCase().indexOf('first page'))
  }, 180_000)

  it('страница боком и вверх ногами: поворот находится сам, текст читается', async () => {
    const dir = await tmpDir('ocr')
    const img = await textImage(join(dir, 'up.png'), ['Rotated page sample', 'Invoice number 55555'])
    const sharp = (await import('sharp')).default
    for (const deg of [90, 180, 270]) {
      const turned = join(dir, `turn-${deg}.png`)
      await sharp(img).rotate(deg).toFile(turned)
      const r = await ocrFile(await fileItem(turned), 'txt', opts(dir, 'eng'), noop)
      const text = (await fs.readFile(r.outputPath, 'utf8')).toLowerCase()
      expect(text, `поворот ${deg}`).toContain('rotated page')
      expect(text).toContain('55555')
      expect(r.info).toContain('повёрнуто')
    }
    // ровная страница не поворачивается
    const flat = await ocrFile(await fileItem(img), 'txt', opts(dir, 'eng'), noop)
    expect(flat.info).not.toContain('повёрнуто')
  }, 240_000)

  it('пустая картинка: понятная ошибка вместо пустого файла', async () => {
    const dir = await tmpDir('ocr')
    const blank = join(dir, 'blank.png')
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=400x300', '-frames:v', '1', blank])
    await expect(ocrFile(await fileItem(blank), 'txt', opts(dir, 'eng'), noop)).rejects.toThrow()
  }, 120_000)
})
