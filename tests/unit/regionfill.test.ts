import { describe, expect, it } from 'vitest'
import { applyFillToMask, cleanEdgeColors, computeFill, rgbToLab } from '../../src/shared/regionFill'
import { applyEdits } from '../../src/main/maskEdit'
import type { FillOp } from '../../src/shared/types'

/** Картинка из функции цвета. */
function image(w: number, h: number, at: (x: number, y: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y)
      out.set([r, g, b], (y * w + x) * 3)
    }
  }
  return out
}

const PINK: [number, number, number] = [255, 105, 180]
const BLUE: [number, number, number] = [30, 60, 200]
const base = { tolerance: 15, contiguous: true, feather: 0 }

describe('цвет Lab', () => {
  it('белый, чёрный и расстояния', () => {
    const [l] = rgbToLab(255, 255, 255)
    expect(l).toBeCloseTo(100, 0)
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 0)
    const d = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    expect(d(rgbToLab(...PINK), rgbToLab(255, 110, 180))).toBeLessThan(3)
    expect(d(rgbToLab(...PINK), rgbToLab(...BLUE))).toBeGreaterThan(50)
  })
})

describe('заливка: область', () => {
  // розовый фон 40×30 с синим квадратом посередине
  const W = 40
  const H = 30
  const inside = (x: number, y: number): boolean => x >= 15 && x < 25 && y >= 10 && y < 20
  const img = image(W, H, (x, y) => (inside(x, y) ? BLUE : PINK))

  it('смежные: фон убран весь, предмет цел', () => {
    const r = computeFill(img, W, H, { ...base, x: 1, y: 1 })
    expect(r.coverage[0]).toBe(255)
    expect(r.coverage[12 * W + 20]).toBe(0)
    expect(r.count).toBe(W * H - 100)
    expect(r.color).toEqual(PINK)
  })

  it('смежные не перепрыгивают через предмет: отдельный остров того же цвета остаётся', () => {
    // розовая «стена» делит картинку, справа за ней синий фон с розовым островом
    const wall = image(W, H, (x) => (x === 20 ? BLUE : x < 20 ? PINK : PINK))
    const left = computeFill(wall, W, H, { ...base, x: 2, y: 2 })
    expect(left.coverage[2 * W + 30]).toBe(0) // справа от стены не тронуто
    expect(left.coverage[2 * W + 5]).toBe(255)
    const everywhere = computeFill(wall, W, H, { ...base, x: 2, y: 2, contiguous: false })
    expect(everywhere.coverage[2 * W + 30]).toBe(255)
  })

  it('«везде» убирает цвет и в дырках внутри предмета', () => {
    const holed = image(W, H, (x, y) => (inside(x, y) ? (x === 20 && y === 15 ? PINK : BLUE) : PINK))
    const one = computeFill(holed, W, H, { ...base, x: 1, y: 1 })
    expect(one.coverage[15 * W + 20]).toBe(0)
    const all = computeFill(holed, W, H, { ...base, x: 1, y: 1, contiguous: false })
    expect(all.coverage[15 * W + 20]).toBe(255)
  })

  it('допуск: слабое различие цвета захватывается только при большом допуске', () => {
    const grad = image(W, H, (x) => [200 + x, 120, 120])
    const small = computeFill(grad, W, H, { ...base, x: 0, y: 0, tolerance: 3 })
    const big = computeFill(grad, W, H, { ...base, x: 0, y: 0, tolerance: 40 })
    expect(small.count).toBeLessThan(big.count)
    expect(big.count).toBe(W * H)
  })

  it('цвет пипетки: клик по предмету убирает цвет фона', () => {
    const r = computeFill(img, W, H, { ...base, x: 20, y: 15, color: PINK })
    expect(r.coverage[15 * W + 20]).toBe(0) // под курсором синий: розовая область не связана с точкой
    const all = computeFill(img, W, H, { ...base, x: 20, y: 15, color: PINK, contiguous: false })
    expect(all.coverage[0]).toBe(255)
    expect(all.coverage[15 * W + 20]).toBe(0)
  })

  it('клик за картинкой и пустая область ничего не делают', () => {
    expect(computeFill(img, W, H, { ...base, x: -5, y: 3 }).count).toBe(0)
    expect(computeFill(img, W, H, { ...base, x: 99, y: 3 }).count).toBe(0)
    // цвет пипетки далёк от пикселя под курсором (смежные)
    expect(computeFill(img, W, H, { ...base, x: 20, y: 15, color: [0, 255, 0] }).count).toBe(0)
  })
})

describe('заливка: края и маска', () => {
  it('мягкость даёт плавный переход вместо ступеньки', () => {
    const W = 64
    const grad = image(W, 4, (x) => [100 + x, 100, 100])
    const hard = computeFill(grad, W, 4, { x: 0, y: 0, tolerance: 20, contiguous: true, feather: 0 })
    const soft = computeFill(grad, W, 4, { x: 0, y: 0, tolerance: 20, contiguous: true, feather: 1 })
    const partial = (c: Uint8Array): number => c.filter((v) => v > 0 && v < 255).length
    expect(partial(hard.coverage)).toBeLessThanOrEqual(2)
    expect(partial(soft.coverage)).toBeGreaterThan(5)
    // сила убывает от центра к краю
    expect(soft.coverage[0]).toBe(255)
    expect(soft.coverage[10]).toBeGreaterThan(soft.coverage[20])
  })

  it('прозрачное не становится видимым, маска берёт минимум', () => {
    const mask = new Uint8Array([255, 255, 40, 0])
    const cov = new Uint8Array([100, 0, 100, 255])
    expect(applyFillToMask(mask, cov)).toBe(true)
    expect([...mask]).toEqual([155, 255, 40, 0]) // 255−100=155; 40 уже меньше; 0 остался 0
    expect(applyFillToMask(mask, new Uint8Array(4))).toBe(false)
  })

  it('очистка цветов на краю: ореол фона убирается', () => {
    // пиксель — смесь 50% синего предмета и 50% розового фона
    const mix: [number, number, number] = [(BLUE[0] + PINK[0]) / 2, (BLUE[1] + PINK[1]) / 2, (BLUE[2] + PINK[2]) / 2]
    const rgb = new Uint8Array([...mix, ...PINK])
    cleanEdgeColors(rgb, new Uint8Array([128, 255]), PINK)
    // остаток по первому пикселю близок к цвету предмета
    expect(Math.abs(rgb[0] - BLUE[0])).toBeLessThan(6)
    expect(Math.abs(rgb[1] - BLUE[1])).toBeLessThan(6)
    expect(Math.abs(rgb[2] - BLUE[2])).toBeLessThan(6)
    expect([...rgb.subarray(3)]).toEqual(PINK) // полностью убранный пиксель не трогаем
  })
})

describe('история правок в основном процессе', () => {
  const W = 40
  const H = 30
  const colors = (): Buffer => Buffer.from(image(W, H, (x, y) => (x >= 15 && x < 25 && y >= 10 && y < 20 ? BLUE : PINK)))
  const fill = (extra: Partial<FillOp> = {}): FillOp => ({ type: 'fill', x: 1, y: 1, tolerance: 15, contiguous: true, feather: 0, ...extra })

  it('заливка и кисть вместе: порядок важен', () => {
    const mask = Buffer.alloc(W * H, 255)
    const c = colors()
    // сначала заливка убирает фон, потом кисть «возвращает» кружок на фоне
    applyEdits(c, mask, W, H, [fill(), { mode: 'restore', radius: 3, points: [3, 3] }])
    expect(mask[15 * W + 20]).toBe(255) // предмет цел
    expect(mask[0]).toBe(0) // дальний фон убран
    expect(mask[3 * W + 3]).toBeGreaterThan(200) // кисть вернула пятно
    // в обратном порядке заливка снова убрала бы пятно
    const mask2 = Buffer.alloc(W * H, 255)
    applyEdits(colors(), mask2, W, H, [{ mode: 'restore', radius: 3, points: [3, 3] }, fill()])
    expect(mask2[3 * W + 3]).toBe(0)
  })

  it('заливка по уже убранной области ничего не меняет и цвета не трогает', () => {
    const mask = Buffer.alloc(W * H, 255)
    const c = colors()
    const before = Buffer.from(c)
    applyEdits(c, mask, W, H, [fill(), fill()])
    expect(Buffer.compare(c, before)).toBe(0)
  })

  it('результат по уменьшенной копии и по полному размеру совпадает (граница области)', () => {
    // полный размер 400×300, копия в 10 раз меньше
    const full = image(400, 300, (x, y) => (x >= 150 && x < 250 && y >= 100 && y < 200 ? BLUE : PINK))
    const small = image(40, 30, (x, y) => (x >= 15 && x < 25 && y >= 10 && y < 20 ? BLUE : PINK))
    const a = computeFill(full, 400, 300, { ...base, x: 10, y: 10 })
    const b = computeFill(small, 40, 30, { ...base, x: 1, y: 1 })
    const ratio = a.count / 120000
    expect(Math.abs(ratio - b.count / 1200)).toBeLessThan(0.01)
  })

  it('скорость: заливка 12 мегапикселей укладывается в разумное время', () => {
    const W2 = 4000
    const H2 = 3000
    const big = image(W2, H2, (x, y) => ((x >> 7) + (y >> 7)) % 2 === 0 ? PINK : [PINK[0], PINK[1] + 3, PINK[2]])
    const t0 = Date.now()
    const r = computeFill(big, W2, H2, { ...base, x: 5, y: 5 })
    const ms = Date.now() - t0
    expect(r.count).toBe(W2 * H2)
    expect(ms).toBeLessThan(5000)
  }, 20_000)
})
