import { describe, expect, it } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { buildGif, inspectFrames } from '../../src/main/converters/gif'
import { cropRect, matteEdges, overlayLayers, prepareLayers, smoothMasks } from '../../src/main/converters/gifLayers'
import type { PreparedLayer } from '../../src/main/converters/gifLayers'
import { run } from '../../src/main/ffmpeg'
import type { GifBuildOptions, GifLayer } from '../../src/shared/types'
import { cleanupAfterAll, tmpDir } from '../helpers'

cleanupAfterAll()

const noop = (): void => {}
const MODEL = join(process.cwd(), 'models', 'isnet-general-use.onnx')

const options = (dir: string, extra: Partial<GifBuildOptions> = {}): GifBuildOptions => ({
  format: 'webp',
  fit: 'contain',
  background: 'transparent',
  defaultDelay: 100,
  loop: 0,
  order: 'normal',
  colours: 256,
  dither: false,
  quality: 100,
  name: 'студия',
  outputDir: dir,
  ...extra
})

/** Однотонные кадры нужного цвета. */
async function flat(dir: string, colors: string[], w = 200, h = 100): Promise<string[]> {
  const out: string[] = []
  for (const [i, c] of colors.entries()) {
    const p = join(dir, `ф-${i + 1}.png`)
    await sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toFile(p)
    out.push(p)
  }
  return out
}

/** Слой: цветной прямоугольник нужного размера. */
async function rect(color: string, w: number, h: number, alpha = 1): Promise<string> {
  const png = await sharp({ create: { width: w, height: h, channels: 4, background: color } })
    .ensureAlpha(alpha)
    .png()
    .toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

const layer = async (extra: Partial<GifLayer> = {}): Promise<GifLayer> => ({
  id: 'l1',
  kind: 'text',
  png: await rect('#ff0000', 100, 40),
  x: 0.5,
  y: 0.5,
  w: 0.5,
  rotation: 0,
  ...extra
})

/** WebP с потерями меняет цвет на единицу: сравниваем с допуском. */
const near = (got: number[], want: number[], tol = 6): void => {
  want.forEach((w, i) => expect(Math.abs(got[i] - w)).toBeLessThanOrEqual(tol))
}

/** Пиксель страницы анимации. */
async function pixel(file: string, page: number, x: number, y: number): Promise<[number, number, number, number]> {
  const { data, info } = await sharp(file, { page }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * 4
  return [data[i], data[i + 1], data[i + 2], data[i + 3]]
}

describe('чистые помощники', () => {
  it('рамка обрезки: доли → пиксели, кривая рамка = целый кадр', () => {
    expect(cropRect(undefined, 400, 300)).toEqual({ left: 0, top: 0, width: 400, height: 300 })
    expect(cropRect({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, 400, 300)).toEqual({ left: 100, top: 150, width: 200, height: 150 })
    expect(cropRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 400, 300)).toEqual({ left: 360, top: 270, width: 40, height: 30 })
    expect(cropRect({ x: 0, y: 0, w: 0.001, h: 0.001 }, 400, 300)).toEqual({ left: 0, top: 0, width: 400, height: 300 })
  })

  it('сглаживание масок по времени: соседние кадры сближаются, крайние тоже обрабатываются', () => {
    const masks = [Buffer.from([0, 0]), Buffer.from([255, 255]), Buffer.from([0, 0])]
    const s = smoothMasks(masks, 1)
    expect(s[1][0]).toBe(128) // (0 + 2·255 + 0) / 4
    expect(s[0][0]).toBe(85) // (2·0 + 255) / 3
    expect(smoothMasks([masks[0]], 1)).toEqual([masks[0]])
    expect(smoothMasks(masks, 0)).toBe(masks)
  })

  it('матовые края: полупрозрачные пиксели смешиваются с цветом фона и становятся «есть/нет»', () => {
    const px = Buffer.from([255, 0, 0, 200, 255, 0, 0, 60, 255, 0, 0, 255, 9, 9, 9, 0])
    const m = matteEdges(px, { r: 255, g: 255, b: 255 })
    expect([...m.subarray(0, 4)]).toEqual([255, 55, 55, 255]) // 78% непрозрачности → плотный, подмешано белое
    expect(m[7]).toBe(0) // 24% → исчезает
    expect([...m.subarray(8, 12)]).toEqual([255, 0, 0, 255]) // плотный не меняется
    expect(m[15]).toBe(0)
  })

  it('наложение «поверх»: непрозрачный слой, полупрозрачный и выход за край кадра', () => {
    const base = Buffer.alloc(4 * 4 * 4, 255) // белый 4×4
    const solid: PreparedLayer = { id: 'a', data: Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]), width: 2, height: 2, left: 1, top: 1, opacity: 1, from: 0, to: 9 }
    const out = overlayLayers(base, 4, 4, [solid])
    expect(out[(1 * 4 + 1) * 4]).toBe(0)
    expect(out[0]).toBe(255)
    expect(base[(1 * 4 + 1) * 4]).toBe(255) // исходный кадр не изменён
    const half = overlayLayers(base, 4, 4, [{ ...solid, opacity: 0.5 }])
    expect(half[(1 * 4 + 1) * 4]).toBe(128)
    const outside = overlayLayers(base, 4, 4, [{ ...solid, left: 3, top: -1 }]) // частично за краем
    expect(outside[(0 * 4 + 3) * 4]).toBe(0)
    expect(overlayLayers(base, 4, 4, [])).toBe(base)
  })

  it('подготовка слоёв: размер по доле ширины, поворот, положение по центру', async () => {
    const [l] = await prepareLayers([await layer({ w: 0.5, x: 0.5, y: 0.5 })], 200, 100, 3)
    expect(l.width).toBe(100)
    expect(l.height).toBe(40)
    expect([l.left, l.top]).toEqual([50, 30])
    const [r] = await prepareLayers([await layer({ rotation: 90 })], 200, 100, 3)
    expect([r.width, r.height]).toEqual([40, 100])
    expect(await prepareLayers([{ ...(await layer()), png: '' }], 200, 100, 3)).toEqual([])
    const [range] = await prepareLayers([await layer({ from: 1, to: 99 })], 200, 100, 3)
    expect([range.from, range.to]).toEqual([1, 2])
  })
})

describe('buildGif: обрезка, слои, фон', () => {
  it('обрезка рамкой меняет размер холста у всех кадров', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await flat(dir, ['#e44', '#4e4'], 400, 300))
    const r = await buildGif(fr, options(dir, { crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }), noop)
    expect([r.width, r.height]).toEqual([200, 150])
    const meta = await sharp(r.outputPath, { pages: -1 }).metadata()
    expect([meta.width, meta.pageHeight, meta.pages]).toEqual([200, 150, 2])
  })

  it('текст/стикер ложится в центр кадра; без слоя там фон кадра', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await flat(dir, ['#ffffff']))
    const r = await buildGif(fr, options(dir, { layers: [await layer()] }), noop)
    near(await pixel(r.outputPath, 0, 100, 50), [255, 0, 0])
    near(await pixel(r.outputPath, 0, 5, 5), [255, 255, 255])
  })

  it('диапазон кадров: слой виден только на выбранных', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await flat(dir, ['#ffffff', '#ffffff', '#ffffff']))
    const r = await buildGif(fr, options(dir, { layers: [await layer({ from: 1, to: 1 })] }), noop)
    near(await pixel(r.outputPath, 0, 100, 50), [255, 255, 255])
    near(await pixel(r.outputPath, 1, 100, 50), [255, 0, 0])
    near(await pixel(r.outputPath, 2, 100, 50), [255, 255, 255])
  })

  it('диапазон слоя считается по исходным кадрам, а не по порядку проигрывания (туда-обратно)', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await flat(dir, ['#ffffff', '#eeeeee', '#dddddd']))
    const r = await buildGif(fr, options(dir, { order: 'pingpong', layers: [await layer({ from: 2, to: 2 })] }), noop)
    // проигрывание: 0 1 2 1 → слой только на третьей странице
    expect((await sharp(r.outputPath, { pages: -1 }).metadata()).pages).toBe(4)
    near(await pixel(r.outputPath, 2, 100, 50), [255, 0, 0])
    expect((await pixel(r.outputPath, 3, 100, 50))[1]).toBeGreaterThan(200)
  })

  it('поворот слоя на 90°: узкий прямоугольник становится высоким', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await flat(dir, ['#ffffff'], 200, 200))
    const wide = await rect('#0000ff', 100, 20)
    const r = await buildGif(fr, options(dir, { layers: [await layer({ png: wide, w: 0.5, rotation: 90 })] }), noop)
    near(await pixel(r.outputPath, 0, 100, 60), [0, 0, 255]) // выше центра синий
    near(await pixel(r.outputPath, 0, 140, 100), [255, 255, 255]) // справа от центра пусто
  })

  it('непрозрачность слоя: 50% чёрного на белом даёт серый', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await flat(dir, ['#ffffff']))
    const r = await buildGif(fr, options(dir, { layers: [await layer({ png: await rect('#000000', 100, 40), opacity: 0.5 })] }), noop)
    const [red] = await pixel(r.outputPath, 0, 100, 50)
    expect(red).toBeGreaterThan(110)
    expect(red).toBeLessThan(145)
  })

  it('слой вместе с обрезкой: координаты считаются от обрезанного кадра', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await flat(dir, ['#ffffff'], 400, 200))
    const r = await buildGif(fr, options(dir, { crop: { x: 0, y: 0, w: 0.5, h: 1 }, layers: [await layer({ x: 0.1, y: 0.1, w: 0.1 })] }), noop)
    expect(r.width).toBe(200)
    near(await pixel(r.outputPath, 0, 20, 20), [255, 0, 0]) // слой в левом верхнем углу обрезанного кадра
  })

  // красный квадрат на зелёном экране, квадрат двигается
  async function greenScreen(dir: string, n = 3): Promise<string[]> {
    const out: string[] = []
    for (let i = 0; i < n; i++) {
      const p = join(dir, `зелёный-${i}.png`)
      const sq = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#cc1133' } }).png().toBuffer()
      await sharp({ create: { width: 200, height: 120, channels: 3, background: '#00ff00' } })
        .composite([{ input: sq, left: 40 + i * 10, top: 30 }])
        .png()
        .toFile(p)
      out.push(p)
    }
    return out
  }

  it('удаление однотонного фона у всех кадров: фон прозрачный, предмет цел, на всех кадрах одинаково', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await greenScreen(dir))
    const r = await buildGif(fr, options(dir, { removeBg: { method: 'solid', matte: '#ffffff', smooth: true } }), noop)
    for (let i = 0; i < 3; i++) {
      expect((await pixel(r.outputPath, i, 2, 2))[3]).toBe(0)
      expect((await pixel(r.outputPath, i, 70 + i * 10, 60))[3]).toBe(255)
    }
    near(await pixel(r.outputPath, 0, 70, 60), [204, 17, 51])
  })

  it('«авто» выбирает однотонный фон; цвет берётся с первого кадра и не плавает', async () => {
    const dir = await tmpDir('studio')
    const paths = await greenScreen(dir)
    // на последнем кадре фон чуть светлее: цвет с первого кадра с допуском всё равно его убирает
    const last = paths[2]
    const sq = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#cc1133' } }).png().toBuffer()
    await sharp({ create: { width: 200, height: 120, channels: 3, background: '#10f010' } }).composite([{ input: sq, left: 60, top: 30 }]).png().toFile(last)
    const fr = await inspectFrames(paths)
    const r = await buildGif(fr, options(dir, { removeBg: { method: 'auto', matte: '#ffffff', smooth: true } }), noop)
    expect((await pixel(r.outputPath, 2, 2, 2))[3]).toBe(0)
  })

  it('GIF с удалённым фоном: прозрачность строго «есть/нет», без светлой каймы', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await greenScreen(dir, 2))
    const r = await buildGif(fr, options(dir, { format: 'gif', removeBg: { method: 'solid', matte: '#ffffff', smooth: false } }), noop)
    const { data } = await sharp(r.outputPath, { page: 0 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const alphas = new Set<number>()
    for (let i = 3; i < data.length; i += 4) alphas.add(data[i])
    expect([...alphas].sort()).toEqual([0, 255])
  })

  it('без модели нейросети метод «нейросеть» даёт понятную ошибку', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await greenScreen(dir, 1))
    await expect(buildGif(fr, options(dir, { removeBg: { method: 'ai', matte: '#ffffff', smooth: true } }), noop)).rejects.toThrow()
  })

  it.skipIf(!existsSync(MODEL))('нейросеть: прозрачная анимация со сглаживанием по времени', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await greenScreen(dir, 3))
    const r = await buildGif(fr, options(dir, { removeBg: { method: 'ai', matte: '#ffffff', smooth: true } }), noop, { modelPath: MODEL })
    expect((await sharp(r.outputPath, { pages: -1 }).metadata()).pages).toBe(3)
    // угол кадра прозрачный
    expect((await pixel(r.outputPath, 1, 2, 2))[3]).toBeLessThan(60)
  })

  it('APNG: три кадра с разной задержкой, прозрачность сохраняется', async () => {
    const dir = await tmpDir('studio')
    const fr = (await inspectFrames(await greenScreen(dir, 3))).map((f, i) => ({ ...f, delay: 100 * (i + 1) }))
    const r = await buildGif(fr, options(dir, { format: 'apng', removeBg: { method: 'solid', matte: '#ffffff', smooth: false } }), noop)
    expect(r.outputPath.endsWith('.apng')).toBe(true)
    const bytes = await fs.readFile(r.outputPath)
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const idx = bytes.indexOf('acTL')
    expect(idx).toBeGreaterThan(0)
    expect(bytes.readUInt32BE(idx + 4)).toBe(3) // число кадров
    // длительности: 0,1 + 0,2 + 0,3 = 0,6 с
    const probe = await run(['-hide_banner', '-i', r.outputPath])
    expect(probe.stderr).toMatch(/Video: apng/)
    expect(r.previewUrl?.startsWith('data:image/png;base64,')).toBe(true)
    // альфа на первом кадре: угол прозрачный
    expect((await pixel(r.outputPath, 0, 2, 2))[3]).toBe(0)
  })

  it('порядок кадров и слои не мешают лимиту размера', async () => {
    const dir = await tmpDir('studio')
    const fr = await inspectFrames(await flat(dir, ['#e44', '#4e4', '#44e'], 300, 200))
    const r = await buildGif(fr, options(dir, { format: 'gif', targetKB: 20, layers: [await layer()] }), noop)
    expect(r.outputSize).toBeLessThanOrEqual(20 * 1024)
  })
})
