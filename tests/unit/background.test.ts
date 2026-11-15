import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import sharp from 'sharp'
import { detectSolidBackground, hex, removeSolidBackground } from '../../src/main/converters/solidBackground'
import { composeCutout } from '../../src/main/converters/background'
import { applyStrokes } from '../../src/main/maskEdit'
import { cleanupAfterAll, tmpDir } from '../helpers'

cleanupAfterAll()

const W = 160
const H = 120

type RGB = [number, number, number]

/** Спрайт на однотонном фоне: коричневый прямоугольник с «окном» (дырой), фиолетовый круг и тень под предметом. */
function sprite(bg: RGB): Buffer {
  const rgb = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c: RGB = bg
      if (x >= 30 && x < 130 && y >= 30 && y < 90) c = [154, 106, 58] // предмет
      if (x >= 60 && x < 80 && y >= 45 && y < 70) c = bg // «окно» внутри предмета: виден фон
      const d = Math.hypot(x - 105, y - 55)
      if (d < 14) c = [123, 92, 240] // круг на предмете
      const i = (y * W + x) * 3
      rgb[i] = c[0]
      rgb[i + 1] = c[1]
      rgb[i + 2] = c[2]
    }
  }
  return rgb
}

const alphaAt = (a: Buffer, x: number, y: number): number => a[y * W + x]

describe('detectSolidBackground', () => {
  it('находит цвет фона по рамке', () => {
    const det = detectSolidBackground(sprite([255, 0, 255]), W, H)
    expect(det.color).toEqual([255, 0, 255])
    expect(det.uniformity).toBeGreaterThan(0.95)
    expect(det.tolerance).toBeGreaterThan(0)
  })

  it('на фото без однотонного фона однородность низкая', async () => {
    const noise = await sharp({ create: { width: W, height: H, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 } } }).removeAlpha().raw().toBuffer()
    expect(detectSolidBackground(noise, W, H).uniformity).toBeLessThan(0.5)
  })

  it('hex форматирует цвет', () => {
    expect(hex([255, 0, 255])).toBe('#ff00ff')
    expect(hex([1, 2, 3])).toBe('#010203')
  })
})

describe('removeSolidBackground', () => {
  const bg: RGB = [255, 0, 255]
  const rgb = sprite(bg)
  const det = detectSolidBackground(rgb, W, H)

  it('фон вокруг прозрачный, предмет и круг остаются', () => {
    const { alpha } = removeSolidBackground(rgb, W, H, bg, det.tolerance, true)
    expect(alphaAt(alpha, 2, 2)).toBe(0)
    expect(alphaAt(alpha, W - 3, H - 3)).toBe(0)
    expect(alphaAt(alpha, 50, 40)).toBe(255) // предмет
    expect(alphaAt(alpha, 105, 55)).toBe(255) // круг
  })

  it('«окно» внутри предмета: убирается при «везде», остаётся без него', () => {
    const everywhere = removeSolidBackground(rgb, W, H, bg, det.tolerance, true).alpha
    const edgeOnly = removeSolidBackground(rgb, W, H, bg, det.tolerance, false).alpha
    expect(alphaAt(everywhere, 70, 57)).toBeLessThan(20)
    expect(alphaAt(edgeOnly, 70, 57)).toBeGreaterThan(200)
  })

  it('на границе нет розовой каймы: цвета у края предмета не розовые', () => {
    const { alpha, rgb: out } = removeSolidBackground(rgb, W, H, bg, det.tolerance, true)
    let pinkish = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (alphaAt(alpha, x, y) < 200) continue
        const i = (y * W + x) * 3
        // розовый/пурпурный фон: много красного и синего, мало зелёного
        if (out[i] > 200 && out[i + 2] > 200 && out[i + 1] < 80) pinkish++
      }
    }
    expect(pinkish).toBe(0)
  })

  it('зелёный фон работает так же', () => {
    const green: RGB = [0, 177, 64]
    const g = sprite(green)
    const d = detectSolidBackground(g, W, H)
    expect(d.color).toEqual(green)
    const { alpha } = removeSolidBackground(g, W, H, green, d.tolerance, true)
    expect(alphaAt(alpha, 3, 3)).toBe(0)
    expect(alphaAt(alpha, 50, 40)).toBe(255)
  })

  it('двигаем допуск: большой допуск не съедает предмет', () => {
    const { alpha } = removeSolidBackground(rgb, W, H, bg, 40, true)
    expect(alphaAt(alpha, 50, 40)).toBe(255)
  })
})

describe('composeCutout', () => {
  const cutout = {
    width: 2,
    height: 1,
    colors: Buffer.from([255, 0, 0, 0, 255, 0]),
    mask: Buffer.from([255, 0]),
    note: ''
  }

  it('прозрачный фон: RGBA с альфой из маски', async () => {
    const { data, info } = await composeCutout(cutout, { mode: 'transparent', color: '#fff' }).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)
    expect([...data]).toEqual([255, 0, 0, 255, 0, 255, 0, 0])
  })

  it('заливка цветом: прозрачные места получают цвет', async () => {
    const { data, info } = await composeCutout(cutout, { mode: 'color', color: '#0000ff' }).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(3)
    expect([...data]).toEqual([255, 0, 0, 0, 0, 255])
  })
})

describe('applyStrokes (ручная кисть)', () => {
  it('«стереть» делает прозрачным, «вернуть» делает видимым', () => {
    const w = 40
    const h = 40
    const mask = Buffer.alloc(w * h, 255)
    applyStrokes(mask, w, h, [{ mode: 'erase', radius: 6, points: [20, 20] }])
    expect(mask[20 * w + 20]).toBe(0)
    expect(mask[2 * w + 2]).toBe(255) // далеко от кисти
    applyStrokes(mask, w, h, [{ mode: 'restore', radius: 6, points: [20, 20] }])
    expect(mask[20 * w + 20]).toBe(255)
  })

  it('мазок вдоль линии закрашивает путь целиком', () => {
    const w = 60
    const h = 20
    const mask = Buffer.alloc(w * h, 255)
    applyStrokes(mask, w, h, [{ mode: 'erase', radius: 3, points: [5, 10, 55, 10] }])
    for (let x = 6; x < 55; x += 7) expect(mask[10 * w + x]).toBe(0)
  })
})

describe('sharp умеет склеивать результат (дымовая проверка)', () => {
  it('сохранение PNG с прозрачностью', async () => {
    const dir = await tmpDir('bg')
    const out = join(dir, 'cut.png')
    await composeCutout(
      { width: 4, height: 4, colors: Buffer.alloc(48, 100), mask: Buffer.alloc(16, 128), note: '' },
      { mode: 'transparent', color: '#fff' }
    )
      .png()
      .toFile(out)
    expect((await sharp(out).metadata()).hasAlpha).toBe(true)
  })
})
