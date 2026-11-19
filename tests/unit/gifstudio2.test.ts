import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { buildGif, exportFrames, inspectFrames } from '../../src/main/converters/gif'
import { activeLayers, prepareLayers } from '../../src/main/converters/gifLayers'
import { layerState } from '../../src/shared/layerAnim'
import { speedFor } from '../../src/shared/types'
import type { GifBuildOptions, GifLayer } from '../../src/shared/types'
import { cleanupAfterAll, tmpDir } from '../helpers'

cleanupAfterAll()

const noop = (): void => {}

const options = (dir: string, extra: Partial<GifBuildOptions> = {}): GifBuildOptions => ({
  format: 'apng',
  fit: 'contain',
  background: 'transparent',
  defaultDelay: 100,
  loop: 0,
  order: 'normal',
  colours: 256,
  dither: false,
  quality: 100,
  name: 'анимация',
  outputDir: dir,
  ...extra
})

async function flat(dir: string, n: number, w = 200, h = 100): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const p = join(dir, `ф-${i + 1}.png`)
    await sharp({ create: { width: w, height: h, channels: 3, background: { r: 30 + i * 35, g: 64, b: 160 } } }).png().toFile(p)
    out.push(p)
  }
  return out
}

async function rect(color: string, w: number, h: number): Promise<string> {
  const png = await sharp({ create: { width: w, height: h, channels: 4, background: color } }).png().toBuffer()
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

describe('анимация слоёв: состояние по кадрам', () => {
  it('без анимации слой неподвижен', () => {
    expect(layerState(undefined, 3, 0, 9)).toEqual({ visible: true, opacity: 1, dy: 0, run: null })
    expect(layerState('none', 3, 0, 9).opacity).toBe(1)
  })

  it('появление и исчезновение', () => {
    expect(layerState('fadein', 0, 0, 9).opacity).toBe(0)
    expect(layerState('fadein', 9, 0, 9).opacity).toBe(1)
    expect(layerState('fadein', 1, 0, 9).opacity).toBeGreaterThan(0)
    expect(layerState('fadein', 1, 0, 9).opacity).toBeLessThan(1)
    expect(layerState('fadeout', 9, 0, 9).opacity).toBe(0)
    expect(layerState('fade', 0, 0, 9).opacity).toBe(0)
    expect(layerState('fade', 5, 0, 9).opacity).toBe(1)
    expect(layerState('fade', 9, 0, 9).opacity).toBe(0)
  })

  it('мигание чередует показ', () => {
    const v = Array.from({ length: 16 }, (_, i) => layerState('blink', i, 0, 15).visible)
    expect(v.slice(0, 2)).toEqual([true, true])
    expect(v.slice(2, 4)).toEqual([false, false])
    expect(v.filter(Boolean).length).toBe(8)
  })

  it('выезд снизу и бегущая строка', () => {
    expect(layerState('slideup', 0, 0, 9).dy).toBeGreaterThan(0.2)
    expect(layerState('slideup', 9, 0, 9).dy).toBe(0)
    expect(layerState('marquee', 0, 0, 9).run).toBe(0)
    expect(layerState('marquee', 9, 0, 9).run).toBe(1)
    expect(layerState('marquee', 5, 5, 5).run).toBe(0) // слой на одном кадре не делит на ноль
  })
})

describe('анимация слоёв: наложение', () => {
  it('прозрачность и сдвиг пересчитываются на каждый кадр, невидимые кадры пропускаются', async () => {
    const layers = await prepareLayers([await layer({ anim: 'fade' })], 200, 100, 10)
    expect(activeLayers(layers, 0, 200, 100)).toHaveLength(0) // на первом кадре ещё прозрачен
    const mid = activeLayers(layers, 5, 200, 100)
    expect(mid[0].opacity).toBe(1)
    expect(activeLayers(layers, 1, 200, 100)[0].opacity).toBeLessThan(1)
    const up = await prepareLayers([await layer({ anim: 'slideup' })], 200, 100, 10)
    expect(activeLayers(up, 0, 200, 100)[0].top).toBeGreaterThan(up[0].top)
    expect(activeLayers(up, 9, 200, 100)[0].top).toBe(up[0].top)
    const run = await prepareLayers([await layer({ anim: 'marquee' })], 200, 100, 10)
    expect(activeLayers(run, 0, 200, 100)[0].left).toBe(200)
    expect(activeLayers(run, 9, 200, 100)[0].left).toBe(-100)
  })

  it('в готовой анимации бегущая строка действительно едет', async () => {
    const dir = await tmpDir('anim')
    const frames = await inspectFrames(await flat(dir, 6))
    const r = await buildGif(frames, options(dir, { format: 'webp', layers: [await layer({ w: 0.25, anim: 'marquee', png: await rect('#ff0000', 80, 80) })] }), noop)
    const redColumns: number[] = []
    for (let page = 0; page < 6; page++) {
      const { data, info } = await sharp(r.outputPath, { page }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let min = info.width
      for (let x = 0; x < info.width; x++) {
        const i = ((info.height / 2) * info.width + x) * 4
        if (data[i] > 200 && data[i + 1] < 60) {
          min = x
          break
        }
      }
      redColumns.push(min)
    }
    // слой появляется справа и едет влево: красный левее на каждом следующем кадре
    expect(redColumns[0]).toBeGreaterThanOrEqual(redColumns[1])
    expect(redColumns[1]).toBeGreaterThan(redColumns[3])
  })
})

describe('скорость части кадров', () => {
  it('диапазоны: первый подходящий, нулевая и отрицательная скорость игнорируются', () => {
    const r = [
      { from: 1, to: 3, factor: 2 },
      { from: 3, to: 5, factor: 0.5 },
      { from: 6, to: 7, factor: 0 }
    ]
    expect(speedFor(r, 0)).toBe(1)
    expect(speedFor(r, 2)).toBe(2)
    expect(speedFor(r, 3)).toBe(2)
    expect(speedFor(r, 4)).toBe(0.5)
    expect(speedFor(r, 6)).toBe(1)
    expect(speedFor(undefined, 1)).toBe(1)
  })

  it('задержки в готовой анимации меняются только у выбранных кадров', async () => {
    const dir = await tmpDir('speed')
    const frames = await inspectFrames(await flat(dir, 6))
    const r = await buildGif(
      frames,
      options(dir, { format: 'gif', speedRanges: [{ from: 1, to: 2, factor: 2 }, { from: 4, to: 4, factor: 0.5 }] }),
      noop
    )
    const meta = await sharp(r.outputPath, { pages: -1 }).metadata()
    expect(meta.delay).toEqual([100, 50, 50, 100, 200, 100])
  })
})

describe('кадры в PNG со слоями', () => {
  it('рамка и слои попадают в файлы, размер единый', async () => {
    const dir = await tmpDir('pngs')
    const frames = await inspectFrames(await flat(dir, 3, 200, 100))
    const out = await exportFrames(frames, join(dir, 'out'), noop, {
      crop: { x: 0, y: 0, w: 0.5, h: 1 },
      layers: [await layer({ w: 0.8, png: await rect('#ff0000', 100, 100) })]
    })
    expect(out.count).toBe(3)
    const files = (await fs.readdir(out.dir)).sort()
    const meta = await sharp(join(out.dir, files[0])).metadata()
    expect([meta.width, meta.height]).toEqual([100, 100])
    const { data } = await sharp(join(out.dir, files[0])).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const mid = (50 * 100 + 50) * 3
    expect([data[mid], data[mid + 1], data[mid + 2]]).toEqual([255, 0, 0]) // красный слой по центру
    expect(data[0]).toBe(30) // у края видно фон кадра
  })

  it('без рамки и слоёв кадры сохраняются как раньше', async () => {
    const dir = await tmpDir('pngs2')
    const frames = await inspectFrames(await flat(dir, 2, 200, 100))
    const out = await exportFrames(frames, join(dir, 'out'), noop)
    const files = await fs.readdir(out.dir)
    expect((await sharp(join(out.dir, files[0])).metadata()).width).toBe(200)
  })
})
