import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { convertImage, makeThumbnail } from '../../src/main/converters/image'
import { IMAGE_FORMATS } from '../../src/shared/types'
import type { ConvertOptions, ImageFormat } from '../../src/shared/types'
import { cleanupAfterAll, fileItem, makeImage, tmpDir } from '../helpers'

cleanupAfterAll()

const opts = (format: ImageFormat, extra: Partial<ConvertOptions> = {}): ConvertOptions => ({ format, quality: 80, ...extra })

describe('convertImage', () => {
  it.each(IMAGE_FORMATS.map((f) => f.id))('PNG → %s: файл читается и имеет нужный формат', async (format) => {
    const dir = await tmpDir('img')
    const src = await makeImage(join(dir, 'a.png'), 160, 100)
    const r = await convertImage(await fileItem(src), opts(format, { outputDir: join(dir, 'out') }))
    const meta = await sharp(r.outputPath).metadata()
    const expected = { jpg: 'jpeg', png: 'png', webp: 'webp', avif: 'heif', tiff: 'tiff', gif: 'gif' }[format]
    expect(meta.format).toBe(expected)
    expect(meta.width).toBe(160)
    expect(meta.height).toBe(100)
    expect(r.outputSize).toBeGreaterThan(0)
  })

  it('рядом с оригиналом добавляется «-converted», оригинал не трогается', async () => {
    const dir = await tmpDir('img')
    const src = await makeImage(join(dir, 'фото.png'), 60, 40)
    const before = await fs.readFile(src)
    const r = await convertImage(await fileItem(src), opts('webp'))
    expect(r.outputPath).toBe(join(dir, 'фото-converted.webp'))
    expect(await fs.readFile(src)).toEqual(before)
  })

  it('не перезаписывает существующие файлы', async () => {
    const dir = await tmpDir('img')
    const src = await makeImage(join(dir, 'a.png'), 60, 40)
    const a = await convertImage(await fileItem(src), opts('webp'))
    const b = await convertImage(await fileItem(src), opts('webp'))
    expect(a.outputPath).not.toBe(b.outputPath)
  })

  it('уменьшает по длинной стороне и не увеличивает маленькие', async () => {
    const dir = await tmpDir('img')
    const big = await makeImage(join(dir, 'big.png'), 800, 400)
    const small = await makeImage(join(dir, 'small.png'), 100, 50)
    const a = await convertImage(await fileItem(big), opts('png', { maxSize: 200, outputDir: join(dir, 'o') }))
    const b = await convertImage(await fileItem(small), opts('png', { maxSize: 200, outputDir: join(dir, 'o') }))
    expect(await sharp(a.outputPath).metadata()).toMatchObject({ width: 200, height: 100 })
    expect(await sharp(b.outputPath).metadata()).toMatchObject({ width: 100, height: 50 })
  })

  it('качество влияет на размер JPG', async () => {
    const dir = await tmpDir('img')
    const src = join(dir, 'noise.png')
    await sharp({ create: { width: 300, height: 300, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toFile(src)
    const item = await fileItem(src)
    const low = await convertImage(item, opts('jpg', { quality: 20, outputDir: join(dir, 'l') }))
    const high = await convertImage(item, opts('jpg', { quality: 95, outputDir: join(dir, 'h') }))
    expect(low.outputSize).toBeLessThan(high.outputSize)
  })

  it('JPG: прозрачность заменяется белым', async () => {
    const dir = await tmpDir('img')
    const src = join(dir, 't.png')
    await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(src)
    const r = await convertImage(await fileItem(src), opts('jpg', { outputDir: join(dir, 'o') }))
    const { data } = await sharp(r.outputPath).raw().toBuffer({ resolveWithObject: true })
    expect([...data.subarray(0, 3)].every((v) => v > 240)).toBe(true)
  })

  it('PNG: прозрачность сохраняется', async () => {
    const dir = await tmpDir('img')
    const src = join(dir, 't.png')
    await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toFile(src)
    const r = await convertImage(await fileItem(src), opts('webp', { outputDir: join(dir, 'o') }))
    const meta = await sharp(r.outputPath).metadata()
    expect(meta.hasAlpha).toBe(true)
  })

  it('по умолчанию скрытые данные (EXIF) удаляются, по просьбе сохраняются', async () => {
    const dir = await tmpDir('img')
    const src = join(dir, 'exif.jpg')
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#888' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'Секретный автор', Make: 'MorphioCam' } })
      .toFile(src)
    const item = await fileItem(src)
    const stripped = await convertImage(item, opts('jpg', { outputDir: join(dir, 's') }))
    const kept = await convertImage(item, opts('jpg', { outputDir: join(dir, 'k'), keepMetadata: true }))
    expect((await sharp(stripped.outputPath).metadata()).exif).toBeUndefined()
    const keptExif = (await sharp(kept.outputPath).metadata()).exif
    expect(keptExif?.toString('latin1')).toContain('MorphioCam')
  })

  it('учитывает ориентацию EXIF (поворачивает кадр)', async () => {
    const dir = await tmpDir('img')
    const src = join(dir, 'rot.jpg')
    await sharp({ create: { width: 100, height: 50, channels: 3, background: '#f00' } }).jpeg().withMetadata({ orientation: 6 }).toFile(src)
    const r = await convertImage(await fileItem(src), opts('png', { outputDir: join(dir, 'o') }))
    expect(await sharp(r.outputPath).metadata()).toMatchObject({ width: 50, height: 100 })
  })

  it('битый файл — ошибка, без обломков', async () => {
    const dir = await tmpDir('img')
    const src = join(dir, 'broken.png')
    await fs.writeFile(src, 'не картинка')
    const out = join(dir, 'o')
    await expect(convertImage(await fileItem(src), opts('webp', { outputDir: out }))).rejects.toThrow()
  })
})

describe('makeThumbnail', () => {
  it('превью и размеры', async () => {
    const dir = await tmpDir('thumb')
    const src = await makeImage(join(dir, 'a.jpg'), 400, 300)
    const t = await makeThumbnail(src)
    expect(t).toMatchObject({ width: 400, height: 300 })
    expect(t.thumbnail?.startsWith('data:image/webp;base64,')).toBe(true)
  })

  it('битый файл — пустой результат, без исключения', async () => {
    const dir = await tmpDir('thumb')
    const src = join(dir, 'broken.png')
    await fs.writeFile(src, 'x')
    expect(await makeThumbnail(src)).toEqual({})
  })
})
