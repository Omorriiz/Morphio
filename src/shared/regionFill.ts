/**
 * Заливка областью по цвету (инструмент «Заливка» в редакторе маски). Один и тот же код считает область
 * в окне (по уменьшенной копии, для подсветки и мгновенной реакции) и в основном процессе (по полному размеру
 * при сохранении), поэтому результат на экране и в файле совпадает.
 *
 * Расстояние между цветами считается в Lab (ΔE76): оно ближе к зрению, чем RGB. Края области получают
 * частичную силу по мягкому порогу, поэтому после удаления нет ступенек.
 */

export interface FillParams {
  /** Точка клика в пикселях изображения */
  x: number
  y: number
  /** Допуск, ΔE (1–100): насколько похожий цвет считать тем же */
  tolerance: number
  /** true — только область, связанная с точкой клика (4 соседа); false — по всей картинке */
  contiguous: boolean
  /** Опорный цвет; не задан — цвет пикселя под точкой клика */
  color?: [number, number, number]
  /** Мягкость краёв, 0–1: доля допуска, на которой сила плавно падает до нуля */
  feather: number
}

export interface FillResult {
  /** Сила удаления для каждого пикселя, 0–255 (255 — убрать полностью) */
  coverage: Uint8Array
  /** Опорный цвет, по которому считали */
  color: [number, number, number]
  /** Сколько пикселей затронуто (сила больше нуля) */
  count: number
}

// sRGB → линейный: таблица на 256 значений
const LIN = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

const XN = 0.95047
const ZN = 1.08883
const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)

/** sRGB (0–255) → Lab. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = LIN[r]
  const lg = LIN[g]
  const lb = LIN[b]
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / XN
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / ZN
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** Сила по расстоянию: 1 внутри (1 − мягкость) · допуска, плавно до 0 на допуске. */
function strength(d: number, tol: number, feather: number): number {
  if (d >= tol) return 0
  const inner = tol * (1 - Math.min(1, Math.max(0, feather)))
  if (d <= inner) return 1
  const t = (tol - d) / (tol - inner)
  return t * t * (3 - 2 * t)
}

/**
 * Считает область заливки. `rgb` — пиксели подряд по три байта (R, G, B), `width × height`.
 * Возвращает силу удаления по каждому пикселю; при клике за пределами картинки область пустая.
 */
export function computeFill(rgb: ArrayLike<number>, width: number, height: number, p: FillParams): FillResult {
  const n = width * height
  const coverage = new Uint8Array(n)
  const sx = Math.min(width - 1, Math.max(0, Math.floor(p.x)))
  const sy = Math.min(height - 1, Math.max(0, Math.floor(p.y)))
  const si = (sy * width + sx) * 3
  const color: [number, number, number] = p.color ?? [rgb[si], rgb[si + 1], rgb[si + 2]]
  if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return { coverage, color, count: 0 }
  const tol = Math.max(0.5, p.tolerance)
  const [rl, ra, rb] = rgbToLab(color[0], color[1], color[2])

  // Lab считаем по требованию и кэшируем по цвету (в картинках много повторов)
  const cache = new Map<number, number>()
  const power = (i: number): number => {
    const r = rgb[i * 3]
    const g = rgb[i * 3 + 1]
    const b = rgb[i * 3 + 2]
    const key = (r << 16) | (g << 8) | b
    let s = cache.get(key)
    if (s === undefined) {
      const [l, a, bb] = rgbToLab(r, g, b)
      s = strength(Math.hypot(l - rl, a - ra, bb - rb), tol, p.feather)
      if (cache.size < 400_000) cache.set(key, s)
    }
    return s
  }

  let count = 0
  if (!p.contiguous) {
    for (let i = 0; i < n; i++) {
      const s = power(i)
      if (s > 0) {
        coverage[i] = Math.round(s * 255)
        count++
      }
    }
    return { coverage, color, count }
  }

  // смежные: заливка строками (scanline), без рекурсии
  const seed = sy * width + sx
  if (power(seed) <= 0) return { coverage, color, count: 0 }
  const seen = new Uint8Array(n)
  const stack = new Int32Array(Math.min(n, 1 << 22) + 8)
  let top = 0
  stack[top++] = seed
  while (top > 0) {
    const start = stack[--top]
    if (seen[start]) continue
    const y = Math.floor(start / width)
    let x0 = start - y * width
    // влево
    while (x0 > 0 && !seen[y * width + x0 - 1] && power(y * width + x0 - 1) > 0) x0--
    let x = x0
    let upOpen = false
    let downOpen = false
    while (x < width) {
      const i = y * width + x
      if (seen[i]) break
      const s = power(i)
      if (s <= 0) break
      seen[i] = 1
      coverage[i] = Math.round(s * 255)
      count++
      if (y > 0) {
        const u = i - width
        const ok = !seen[u] && power(u) > 0
        if (ok && !upOpen && top < stack.length) stack[top++] = u
        upOpen = ok
      }
      if (y < height - 1) {
        const d = i + width
        const ok = !seen[d] && power(d) > 0
        if (ok && !downOpen && top < stack.length) stack[top++] = d
        downOpen = ok
      }
      x++
    }
  }
  return { coverage, color, count }
}

/**
 * Применяет заливку к маске: новая прозрачность — минимум из текущей и «255 − сила».
 * Уже прозрачное снова видимым не становится. Возвращает, изменилось ли что-то.
 */
export function applyFillToMask(mask: Uint8Array | Uint8ClampedArray, coverage: Uint8Array): boolean {
  let changed = false
  for (let i = 0; i < coverage.length; i++) {
    const c = coverage[i]
    if (c === 0) continue
    const v = 255 - c
    if (v < mask[i]) {
      mask[i] = v
      changed = true
    }
  }
  return changed
}

/**
 * Очищает цвета на краю области от примеси фона: пиксель — смесь «предмет + фон», где доля предмета
 * равна (255 − сила) / 255. Так после удаления не остаётся ореола цвета фона.
 */
export function cleanEdgeColors(rgb: Uint8Array | Uint8ClampedArray, coverage: Uint8Array, bg: [number, number, number]): void {
  for (let i = 0; i < coverage.length; i++) {
    const c = coverage[i]
    if (c === 0 || c === 255) continue
    const a = (255 - c) / 255
    for (let k = 0; k < 3; k++) {
      const v = (rgb[i * 3 + k] - (1 - a) * bg[k]) / a
      rgb[i * 3 + k] = Math.max(0, Math.min(255, Math.round(v)))
    }
  }
}
