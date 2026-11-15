import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import sharp from 'sharp'
import { comparePair, measure, psnr, ssim, verdictOf } from '../../src/main/compare'
import type { Gray } from '../../src/main/compare'
import { run } from '../../src/main/ffmpeg'
import { cleanupAfterAll, makeImage, tmpDir } from '../helpers'

cleanupAfterAll()

const gray = (w: number, h: number, fn: (x: number, y: number) => number): Gray => {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fn(x, y)
  return { width: w, height: h, data }
}

describe('метрики PSNR и SSIM', () => {
  const a = gray(64, 64, (x, y) => (x * 4 + y * 2) % 256)

  it('одинаковые картинки: PSNR 99, SSIM 1', () => {
    expect(psnr(a, a)).toBe(99)
    expect(ssim(a, a)).toBeCloseTo(1, 5)
  })

  it('небольшой шум снижает оценки, сильный снижает их ещё больше', () => {
    const light = gray(64, 64, (x, y) => Math.min(255, a.data[y * 64 + x] + ((x + y) % 3)))
    const heavy = gray(64, 64, (x, y) => (a.data[y * 64 + x] + ((x * 37 + y * 91) % 120)) % 256)
    expect(psnr(a, light)).toBeGreaterThan(psnr(a, heavy))
    expect(ssim(a, light)).toBeGreaterThan(ssim(a, heavy))
    expect(ssim(a, heavy)).toBeLessThan(0.9)
  })

  it('оценка словами', () => {
    expect(verdictOf(0.999, 50)).toBe('invisible')
    expect(verdictOf(0.96, 36)).toBe('small')
    expect(verdictOf(0.9, 30)).toBe('noticeable')
    expect(verdictOf(0.5, 15)).toBe('big')
  })
})

describe('comparePair', () => {
  it('картинки: два кадра одного размера и подпись о качестве', async () => {
    const dir = await tmpDir('cmp')
    const src = await makeImage(join(dir, 'a.png'), 800, 500)
    const out = join(dir, 'a.jpg')
    await sharp(src).jpeg({ quality: 20 }).toFile(out)
    const r = await comparePair(src, out)
    expect(r.originalWidth).toBe(800)
    expect(r.width).toBe(800)
    expect(r.before.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(r.after.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(r.sizeBefore).toBeGreaterThan(0)
    expect(r.sizeAfter).toBeGreaterThan(0)
    expect(r.ssim).toBeGreaterThan(0.8)
    expect(r.duration).toBeUndefined()
  })

  it('результат другого размера приводится к размеру оригинала', async () => {
    const dir = await tmpDir('cmp')
    const src = await makeImage(join(dir, 'a.png'), 400, 300)
    const out = join(dir, 'small.webp')
    await sharp(src).resize(200).webp().toFile(out)
    const r = await comparePair(src, out)
    const after = Buffer.from(r.after.split(',')[1], 'base64')
    const meta = await sharp(after).metadata()
    expect(meta.width).toBe(400)
    expect(meta.height).toBe(300)
    expect(r.ssim).toBeGreaterThan(0.5)
  })

  it('большая картинка уменьшается для показа до 1600 px', async () => {
    const dir = await tmpDir('cmp')
    const src = join(dir, 'big.png')
    await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#4488cc' } }).png().toFile(src)
    const r = await comparePair(src, src)
    expect(r.originalWidth).toBe(3000)
    expect(r.width).toBe(1600)
    expect(r.verdict).toBe('invisible')
  })

  it('видео: кадр в выбранный момент, указана длительность', async () => {
    const dir = await tmpDir('cmp')
    const a = join(dir, 'a.mp4')
    const b = join(dir, 'b.mp4')
    const base = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']
    expect((await run([...base, a])).code).toBe(0)
    expect((await run([...base, '-crf', '45', b])).code).toBe(0)
    const r = await comparePair(a, b, 1.5)
    expect(r.duration).toBeGreaterThan(2.5)
    expect(r.width).toBe(320)
    expect(r.ssim).toBeGreaterThan(0.5)
    const first = await comparePair(a, b, 0)
    expect(first.before).not.toBe(r.before) // другой момент — другой кадр
  })

  it('measure сравнивает буферы разного размера', async () => {
    const x = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).png().toBuffer()
    const y = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } }).png().toBuffer()
    const m = await measure(x, y)
    expect(m.ssim).toBeGreaterThan(0.99)
  })
})
