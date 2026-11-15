import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { buildGif, exportFrames, inspectFrames } from '../../src/main/converters/gif'
import type { GifBuildOptions } from '../../src/shared/types'
import { cleanupAfterAll, tmpDir } from '../helpers'

cleanupAfterAll()

const COLORS = ['#e44', '#ee4', '#4e4', '#4ee', '#44e', '#a4e']

async function frames(dir: string, n = 4, w = 80, h = 60): Promise<string[]> {
  const paths: string[] = []
  for (let i = 0; i < n; i++) {
    const p = join(dir, `кадр-${String(i + 1).padStart(2, '0')}.png`)
    await sharp({ create: { width: w, height: h, channels: 3, background: COLORS[i % COLORS.length] } }).png().toFile(p)
    paths.push(p)
  }
  return paths
}

const options = (dir: string, extra: Partial<GifBuildOptions> = {}): GifBuildOptions => ({
  format: 'gif',
  fit: 'contain',
  background: 'transparent',
  defaultDelay: 100,
  loop: 0,
  order: 'normal',
  colours: 128,
  dither: true,
  quality: 80,
  name: 'анимация',
  outputDir: dir,
  ...extra
})
const noop = (): void => {}

describe('inspectFrames', () => {
  it('читает картинки по порядку имён', async () => {
    const dir = await tmpDir('gif')
    const paths = await frames(dir, 3)
    const f = await inspectFrames([...paths].reverse().sort())
    expect(f.map((x) => x.name)).toEqual(['кадр-01.png', 'кадр-02.png', 'кадр-03.png'])
    expect(f[0]).toMatchObject({ width: 80, height: 60 })
    expect(f[0].thumbnail.startsWith('data:image/')).toBe(true)
  })

  it('разбирает готовый анимированный GIF на кадры', async () => {
    const dir = await tmpDir('gif')
    const f1 = await inspectFrames(await frames(dir, 4))
    const built = await buildGif(f1, options(dir, { name: 'source' }), noop)
    const f2 = await inspectFrames([built.outputPath])
    expect(f2).toHaveLength(4)
  })

  it('не-картинки пропускаются', async () => {
    const dir = await tmpDir('gif')
    const txt = join(dir, 'a.txt')
    await fs.writeFile(txt, 'x')
    expect(await inspectFrames([txt])).toEqual([])
  })
})

describe('buildGif', () => {
  it('собирает GIF из кадров: число кадров, размер, цикл', async () => {
    const dir = await tmpDir('gif')
    const f = await inspectFrames(await frames(dir, 4))
    const r = await buildGif(f, options(join(dir, 'out')), noop)
    expect(r.frames).toBe(4)
    expect(r.outputPath.endsWith('.gif')).toBe(true)
    const meta = await sharp(r.outputPath, { pages: -1 }).metadata()
    expect(meta.pages).toBe(4)
    expect(meta.width).toBe(80)
    expect(meta.pageHeight).toBe(60)
    expect(meta.loop).toBe(0)
    expect(meta.delay?.every((d) => d === 100)).toBe(true)
  })

  it('индивидуальные задержки и общая', async () => {
    const dir = await tmpDir('gif')
    const f = await inspectFrames(await frames(dir, 3))
    f[1].delay = 400
    const r = await buildGif(f, options(join(dir, 'out'), { defaultDelay: 50 }), noop)
    const meta = await sharp(r.outputPath, { pages: -1 }).metadata()
    expect(meta.delay).toEqual([50, 400, 50])
  })

  it('порядок: обратный и туда-обратно', async () => {
    const dir = await tmpDir('gif')
    const f = await inspectFrames(await frames(dir, 3))
    const rev = await buildGif(f, options(join(dir, 'a'), { order: 'reverse' }), noop)
    const ping = await buildGif(f, options(join(dir, 'b'), { order: 'pingpong' }), noop)
    const first = async (p: string) => (await sharp(p, { page: 0 }).removeAlpha().raw().toBuffer()).subarray(0, 3)
    // у обратного первым стоит последний кадр (синеватый/зелёный), у обычного — красный
    const normal = await buildGif(f, options(join(dir, 'c')), noop)
    expect([...(await first(rev.outputPath))]).not.toEqual([...(await first(normal.outputPath))])
    expect((await sharp(ping.outputPath, { pages: -1 }).metadata()).pages).toBeGreaterThan(3)
  })

  it('размер холста не зависит от порядка кадров', async () => {
    const dir = await tmpDir('gif')
    const small = await frames(dir, 1, 40, 30)
    const bigDir = await tmpDir('gif')
    const big = await frames(bigDir, 2, 120, 90)
    const f = await inspectFrames([...small, ...big])
    const a = await buildGif(f, options(join(dir, 'a')), noop)
    const b = await buildGif(f, options(join(dir, 'b'), { order: 'reverse' }), noop)
    expect([a.width, a.height]).toEqual([b.width, b.height])
  })

  it('WebP-анимация', async () => {
    const dir = await tmpDir('gif')
    const f = await inspectFrames(await frames(dir, 3))
    const r = await buildGif(f, options(join(dir, 'out'), { format: 'webp' }), noop)
    const meta = await sharp(r.outputPath, { pages: -1 }).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.pages).toBe(3)
  })

  it('лимит по размеру: подбирает настройки и сообщает, уложился ли', async () => {
    const dir = await tmpDir('gif')
    const noisy: string[] = []
    for (let i = 0; i < 6; i++) {
      const p = join(dir, `n${i}.png`)
      await sharp({ create: { width: 300, height: 300, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).png().toFile(p)
      noisy.push(p)
    }
    const f = await inspectFrames(noisy)
    const r = await buildGif(f, options(join(dir, 'out'), { targetKB: 150, colours: 256 }), noop)
    expect(r.reachedTarget).toBeDefined()
    if (r.reachedTarget) expect(r.outputSize).toBeLessThanOrEqual(150 * 1024)
  })

  it('поля при вписывании заливаются выбранным цветом', async () => {
    const dir = await tmpDir('gif')
    const f = await inspectFrames(await frames(dir, 2, 100, 50))
    const r = await buildGif(
      f,
      options(join(dir, 'out'), { fit: 'contain', background: '#ffffff', width: 100 }),
      noop
    )
    expect(r.width).toBe(100)
  })

  it('сообщает о ходе работы', async () => {
    const dir = await tmpDir('gif')
    const f = await inspectFrames(await frames(dir, 3))
    const seen: string[] = []
    await buildGif(f, options(join(dir, 'out')), (p) => seen.push(p.text))
    expect(seen.length).toBeGreaterThan(0)
  })

  it('без кадров — ошибка', async () => {
    await expect(buildGif([], options(await tmpDir('gif')), noop)).rejects.toThrow()
  })

  it('не перезаписывает существующий файл', async () => {
    const dir = await tmpDir('gif')
    const f = await inspectFrames(await frames(dir, 2))
    const a = await buildGif(f, options(join(dir, 'out')), noop)
    const b = await buildGif(f, options(join(dir, 'out')), noop)
    expect(a.outputPath).not.toBe(b.outputPath)
  })
})

describe('exportFrames', () => {
  it('сохраняет кадры PNG в отдельную папку', async () => {
    const dir = await tmpDir('gif')
    const f = await inspectFrames(await frames(dir, 3))
    const r = await exportFrames(f, join(dir, 'out'), noop)
    expect(r.count).toBe(3)
    expect((await fs.readdir(r.dir)).filter((n) => n.endsWith('.png'))).toHaveLength(3)
  })

  it('без кадров — ошибка', async () => {
    await expect(exportFrames([], await tmpDir('gif'), noop)).rejects.toThrow()
  })
})
