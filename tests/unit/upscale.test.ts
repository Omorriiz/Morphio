import { beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { outputSize, upscaleImage, upscaleRgb } from '../../src/main/converters/upscale'
import { configureModules, modulePath } from '../../src/main/modules'
import { getTargets } from '../../src/main/registry'
import { defaultUniversalOptions } from '../../src/shared/types'
import { cleanupAfterAll, fileItem, installFromRelease, releaseHas, tmpDir } from '../helpers'

cleanupAfterAll()

const has = releaseHas('realesrgan-x4v3.onnx', 'realesrgan-x4v3.data')
const noop = (): void => {}
const opts = (dir: string): ReturnType<typeof defaultUniversalOptions> => defaultUniversalOptions('upscale:x4', dir)

describe('размеры результата', () => {
  it('потолок: слишком большие картинки отвергаются заранее', () => {
    expect(outputSize(100, 80, 4)).toEqual({ width: 400, height: 320 })
    expect(outputSize(3000, 2000, 2)).toEqual({ width: 6000, height: 4000 })
    expect(outputSize(5000, 5000, 4)).toBeNull() // 400 млн точек
    expect(outputSize(5000, 100, 4)).toBeNull() // сторона больше 16384 не бывает… 20000
  })
})

describe('без модуля', () => {
  it('понятная ошибка, а не падение', async () => {
    configureModules([])
    const dir = await tmpDir('up')
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } }).png().toFile(join(dir, 'a.png'))
    await expect(upscaleImage(await fileItem(join(dir, 'a.png')), 4, opts(dir), noop)).rejects.toThrow(/модул/i)
  })

  it('варианты в реестре помечены нужным модулем', async () => {
    configureModules([])
    const dir = await tmpDir('up')
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } }).png().toFile(join(dir, 'a.png'))
    const t = getTargets([await fileItem(join(dir, 'a.png'))]).filter((x) => x.group === 'ai')
    expect(t.map((x) => x.id)).toEqual(expect.arrayContaining(['upscale:x2', 'upscale:x4']))
    expect(t.find((x) => x.id === 'upscale:x4')).toMatchObject({ needs: 'upscale', missing: true })
  })
})

describe.skipIf(!has)('Real-ESRGAN (настоящая модель)', () => {
  beforeAll(async () => {
    expect(await installFromRelease(['upscale'])).toBe(true)
    expect(modulePath('upscale')).toBeTruthy()
  })

  /** Среднее различие двух RGB-картинок одного размера и PSNR. */
  const psnr = (a: Buffer, b: Buffer): number => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2
    const mse = s / a.length
    return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
  }

  it('×4: размер ровно в четыре раза, размеры не кратные плитке тоже', async () => {
    const dir = await tmpDir('up')
    for (const [w, h] of [[130, 77], [64, 64], [20, 9]] as const) {
      const p = join(dir, `${w}x${h}.png`)
      await sharp({ create: { width: w, height: h, channels: 3, background: '#4488cc' } }).png().toFile(p)
      const r = await upscaleImage(await fileItem(p), 4, opts(dir), noop)
      const meta = await sharp(r.outputPath).metadata()
      expect([meta.width, meta.height]).toEqual([w * 4, h * 4])
      expect(r.outputPath).toContain('-x4')
    }
  }, 120_000)

  it('×2 получается из ×4 уменьшением, формат JPG сохраняется', async () => {
    const dir = await tmpDir('up')
    const p = join(dir, 'фото.jpg')
    await sharp({ create: { width: 100, height: 60, channels: 3, background: '#cc8844' } }).jpeg().toFile(p)
    const r = await upscaleImage(await fileItem(p), 2, defaultUniversalOptions('upscale:x2', dir), noop)
    const meta = await sharp(r.outputPath).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 200, 120])
    expect(r.outputPath.endsWith('фото-x2.jpg')).toBe(true)
  }, 120_000)

  it('прозрачность сохраняется: углы прозрачные, середина плотная', async () => {
    const dir = await tmpDir('up')
    const p = join(dir, 'alpha.png')
    const dot = await sharp({ create: { width: 30, height: 30, channels: 4, background: '#ff3344' } }).png().toBuffer()
    await sharp({ create: { width: 80, height: 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: dot, left: 25, top: 15 }])
      .png()
      .toFile(p)
    const r = await upscaleImage(await fileItem(p), 4, opts(dir), noop)
    const { data, info } = await sharp(r.outputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(info.width).toBe(320)
    expect(data[3]).toBe(0)
    expect(data[((120 * info.width) + 160) * 4 + 3]).toBe(255)
  }, 120_000)

  it('нет швов между плитками: плавный градиент остаётся плавным на границах плиток', async () => {
    const w = 260
    const h = 120
    const grad = Buffer.alloc(w * h * 3)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) grad[(y * w + x) * 3 + c] = Math.round((x / (w - 1)) * 200) + 20
    const up = await upscaleRgb(modulePath('upscale')!, grad, w, h, 4)
    const W = w * 4
    // средняя разница соседних столбцов на границах плиток (кратно 416) и в остальных местах
    const col = (x: number): number => {
      let s = 0
      for (let y = 100; y < 400; y += 5) s += up[(y * W + x) * 3]
      return s
    }
    const jump = (x: number): number => Math.abs(col(x) - col(x - 1))
    const boundary: number[] = []
    const inner: number[] = []
    for (let x = 50; x < W - 50; x++) (x % 416 === 0 ? boundary : inner).push(jump(x))
    const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
    expect(mean(boundary)).toBeLessThan(mean(inner) * 3 + 20)
  }, 180_000)

  it('качество: на уменьшенном образце результат не хуже простого растягивания по структуре', async () => {
    const dir = await tmpDir('up')
    // образец: логотип приложения в разрешении 256 px; уменьшаем в 4 раза и сравниваем два пути
    const ref = await sharp(join(process.cwd(), 'src/renderer/src/assets/logo.png')).resize(256, 256, { fit: 'cover' }).flatten({ background: '#fff' }).removeAlpha().png().toBuffer()
    const small = join(dir, 'малый.png')
    await sharp(ref).resize(64, 64, { kernel: 'lanczos3' }).png().toFile(small)
    const r = await upscaleImage(await fileItem(small), 4, opts(dir), noop)
    const ai = await sharp(r.outputPath).removeAlpha().raw().toBuffer()
    const plain = await sharp(small).resize(256, 256, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer()
    const truth = await sharp(ref).removeAlpha().raw().toBuffer()
    const pAi = psnr(ai, truth)
    const pPlain = psnr(plain, truth)
    // нейросеть оптимизирует восприятие, а не PSNR: достаточно, чтобы картинка была близка к образцу
    expect(pAi).toBeGreaterThan(18)
    expect(pAi).toBeGreaterThan(pPlain - 6)
    expect(await fs.stat(r.outputPath)).toBeTruthy()
  }, 180_000)
})
