/**
 * Удаление однотонного фона (спрайт-листы, иконки, картинки на «зелёном/розовом экране»).
 * Работает без нейросети и состоит из нескольких шагов:
 *  1. По рамке картинки находим цвет фона.
 *  2. «Чистый» фон ищем по лучу яркости (тени и блики фона тоже считаются фоном),
 *     области связаны в компоненты; внутренние дыры убираем, если они «чисто фоновые».
 *  3. На границе объектов (локальные перепады = high-pass) раскладываем смесь
 *     «объект + фон» на цвет и прозрачность по ближайшим «чистым» пикселям объекта.
 *  4. Полупрозрачные участки (паутина, дымка, свечение) раскладываем по составляющей
 *     цвета фона («spill»), чтобы остался только сам предмет без розовой пелены.
 */

export interface SolidDetection {
  /** Цвет фона [r, g, b] */
  color: [number, number, number]
  /** Доля пикселей по периметру, совпавших с цветом фона (0..1) */
  uniformity: number
  /** Автоматически подобранный допуск (евклидово расстояние в RGB) */
  tolerance: number
}

type RGB = [number, number, number]

const dist = (r: number, g: number, b: number, c: RGB): number => {
  const dr = r - c[0]
  const dg = g - c[1]
  const db = b - c[2]
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

/** Оттенок (0..360) и насыщенность (0..1). */
function hueSat(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return [0, 0]
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, d / max]
}

/** Ищет доминирующий цвет по рамке изображения (2 пикселя от края). */
export function detectSolidBackground(rgb: Buffer, w: number, h: number): SolidDetection {
  const ring: number[] = []
  const depth = Math.min(2, Math.floor(Math.min(w, h) / 2))
  for (let d = 0; d < depth; d++) {
    for (let x = 0; x < w; x++) {
      ring.push((d * w + x) * 3, ((h - 1 - d) * w + x) * 3)
    }
    for (let y = depth; y < h - depth; y++) {
      ring.push((y * w + d) * 3, (y * w + (w - 1 - d)) * 3)
    }
  }

  // Мода по 5-битным корзинам, затем уточняем средним цветом внутри корзины.
  const keyOf = (i: number): number =>
    ((rgb[i] >> 3) << 10) | ((rgb[i + 1] >> 3) << 5) | (rgb[i + 2] >> 3)
  const bins = new Map<number, number>()
  for (const i of ring) bins.set(keyOf(i), (bins.get(keyOf(i)) ?? 0) + 1)
  let bestKey = 0
  let bestCount = -1
  for (const [k, c] of bins) {
    if (c > bestCount) {
      bestCount = c
      bestKey = k
    }
  }
  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  for (const i of ring) {
    if (keyOf(i) === bestKey) {
      sr += rgb[i]
      sg += rgb[i + 1]
      sb += rgb[i + 2]
      n++
    }
  }
  const color: RGB = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)]

  // Однородность и уровень шума (JPEG/WebP-артефакты) по рамке.
  const dists = ring.map((i) => dist(rgb[i], rgb[i + 1], rgb[i + 2], color))
  const near = dists.filter((d) => d <= 40)
  const uniformity = dists.filter((d) => d <= 24).length / ring.length
  near.sort((a, b) => a - b)
  const p95 = near.length ? near[Math.floor(near.length * 0.95)] : 10
  const tolerance = Math.min(80, Math.max(18, p95 * 1.6 + 6))

  return { color, uniformity, tolerance }
}

/**
 * Строит альфа-канал и очищенные цвета.
 * @param everywhere  true — убирать цвет фона везде (в т.ч. «дыры» внутри объектов),
 *                    false — только то, что соединено с краем изображения.
 * @param translucent true — раскладывать полупрозрачные участки (паутина, дымка, свечение).
 */
export function removeSolidBackground(
  rgb: Buffer,
  w: number,
  h: number,
  bg: RGB,
  tol: number,
  everywhere: boolean,
  translucent = true
): { alpha: Buffer; rgb: Buffer } {
  const n = w * h

  // ---- Подготовка: луч яркости фона ----
  const bb = bg[0] * bg[0] + bg[1] * bg[1] + bg[2] * bg[2] || 1
  const [bgHue, bgSat] = hueSat(bg[0], bg[1], bg[2])
  const saturatedBg = bgSat > 0.5
  const sMin = saturatedBg ? 0.4 : 0.85 // насколько темнее фона может быть его тень
  const tolR = Math.min(tol, 45)

  const res = new Float32Array(n) // расстояние до луча (цвет, нормированный по яркости)
  const scale = new Float32Array(n) // яркость относительно фона
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3]
    const g = rgb[i * 3 + 1]
    const b = rgb[i * 3 + 2]
    const s = (r * bg[0] + g * bg[1] + b * bg[2]) / bb
    scale[i] = s
    res[i] = Math.hypot(r - s * bg[0], g - s * bg[1], b - s * bg[2])
  }

  // Оттенок и насыщенность каждого пикселя (для окон «похож на фон» ниже).
  // dHue — смещение оттенка от фона; окно несимметричное: у розового фона фиолетовые
  // предметы (руны, кристаллы) лежат по одну сторону, а розовые тени и смеси — по другую.
  const dHue = new Float32Array(n)
  const sat = new Float32Array(n)
  const val = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const [hu, sa] = hueSat(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])
    dHue[i] = ((hu - bgHue + 540) % 360) - 180
    sat[i] = sa
    val[i] = Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) / 255
  }
  const HUE_LO = -5
  const HUE_HI = 30

  // ---- Шаг 2: кандидаты в фон и связные области ----
  // strict — точный фон и его тени по лучу яркости;
  // tinted — насыщенные розоватые оттенки фона (тень от предметов, свечение за ними).
  const cand = new Uint8Array(n)
  const strict = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (res[i] <= tolR && scale[i] >= sMin && scale[i] <= 1.15) {
      cand[i] = 1
      strict[i] = 1
    } else if (
      saturatedBg &&
      dHue[i] >= HUE_LO + 1 &&
      dHue[i] <= HUE_HI - 4 &&
      sat[i] >= 0.72 &&
      val[i] >= 0.3
    ) {
      cand[i] = 1
    }
  }

  const isBg = new Uint8Array(n)
  const visited = new Uint8Array(n)
  const stack = new Int32Array(n)
  const members: number[] = []
  for (let start = 0; start < n; start++) {
    if (!cand[start] || visited[start]) continue
    members.length = 0
    let sp = 0
    stack[sp++] = start
    visited[start] = 1
    let touches = false
    let sum = 0
    let strictCount = 0
    while (sp > 0) {
      const i = stack[--sp]
      members.push(i)
      sum += res[i]
      if (strict[i]) strictCount++
      const x = i % w
      const y = (i - x) / w
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true
      if (x > 0 && cand[i - 1] && !visited[i - 1]) (visited[i - 1] = 1), (stack[sp++] = i - 1)
      if (x < w - 1 && cand[i + 1] && !visited[i + 1]) (visited[i + 1] = 1), (stack[sp++] = i + 1)
      if (y > 0 && cand[i - w] && !visited[i - w]) (visited[i - w] = 1), (stack[sp++] = i - w)
      if (y < h - 1 && cand[i + w] && !visited[i + w])
        (visited[i + w] = 1), (stack[sp++] = i + w)
    }
    // Внутренняя дыра считается фоном, только если она «чисто фоновая» и не крошечная.
    // Все члены области — «фоновые» кандидаты (точный цвет, тень или розоватый оттенок),
    // поэтому закрытая область из ≥4 пикселей — это дыра, а не деталь предмета.
    const clean = members.length >= 4 && (strictCount > 0 || sum / members.length <= tolR)
    if (touches || (everywhere && clean)) for (const i of members) isBg[i] = 1
  }

  // ---- Шаг 3: зона границ (≈3 px от фона) — здесь цвет смешан с фоном ----
  const dilate = (src: Uint8Array): Uint8Array => {
    const tmp = new Uint8Array(n)
    const dst = new Uint8Array(n)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        tmp[i] = src[i] || (x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) ? 1 : 0
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        dst[i] = tmp[i] || (y > 0 && tmp[i - w]) || (y < h - 1 && tmp[i + w]) ? 1 : 0
      }
    }
    return dst
  }
  const near = dilate(dilate(dilate(isBg)))
  const isEdge = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (!isBg[i] && near[i]) isEdge[i] = 1

  // ---- Шаг 4: полупрозрачные участки (оттенок как у фона) ----
  // «Spill» = насколько в пикселе выражены каналы, которые у фона сильные, над теми, что слабые.
  const bgMax = Math.max(...bg)
  const high: number[] = []
  const low: number[] = []
  for (let c = 0; c < 3; c++) (bg[c] >= bgMax * 0.75 ? high : low).push(c)
  const spillOf = (r: number, g: number, b: number): number => {
    const v = [r, g, b]
    let hi = Infinity
    for (const c of high) hi = Math.min(hi, v[c])
    let lo = -Infinity
    for (const c of low) lo = Math.max(lo, v[c])
    return hi - lo
  }
  const spillBg = low.length > 0 && high.length > 0 ? spillOf(bg[0], bg[1], bg[2]) : 0
  const canSpill = saturatedBg && spillBg >= 60

  const isVeil = new Uint8Array(n)
  if (translucent && canSpill) {
    for (let i = 0; i < n; i++) {
      if (isBg[i]) continue
      const r = rgb[i * 3]
      const g = rgb[i * 3 + 1]
      const b = rgb[i * 3 + 2]
      // Фиолетовые предметы (оттенок < HUE_LO) не трогаем — это не «пелена» фона.
      if (dHue[i] >= HUE_LO && dHue[i] <= HUE_HI && sat[i] >= 0.3 && spillOf(r, g, b) > 12) {
        isVeil[i] = 1
      }
    }

    // Настоящая «пелена» связана с фоном (через щели в паутине и т.п.). Изолированное
    // свечение внутри предмета (например, руна на обелиске) пеленой не считаем.
    const bridge = dilate(dilate(isVeil)) // склеиваем острова через тонкие нити
    const reach = new Uint8Array(n)
    let sp = 0
    for (let i = 0; i < n; i++) {
      if (isVeil[i] && near[i]) {
        reach[i] = 1
        stack[sp++] = i
      }
    }
    while (sp > 0) {
      const i = stack[--sp]
      const x = i % w
      const y = (i - x) / w
      const tryAdd = (j: number): void => {
        if (bridge[j] && !reach[j]) {
          reach[j] = 1
          stack[sp++] = j
        }
      }
      if (x > 0) tryAdd(i - 1)
      if (x < w - 1) tryAdd(i + 1)
      if (y > 0) tryAdd(i - w)
      if (y < h - 1) tryAdd(i + w)
    }
    for (let i = 0; i < n; i++) if (isVeil[i] && !reach[i]) isVeil[i] = 0
  }

  const alpha = Buffer.alloc(n, 255)
  const out = Buffer.from(rgb)

  /** Раскладывает пиксель по составляющей фона. Возвращает false, если он весь фон. */
  const unmixSpill = (i: number, bgc: RGB): boolean => {
    const pr = rgb[i * 3]
    const pg = rgb[i * 3 + 1]
    const pb = rgb[i * 3 + 2]
    const sb = spillOf(bgc[0], bgc[1], bgc[2])
    const f = Math.min(1, Math.max(0, spillOf(pr, pg, pb) / (sb || 1)))
    const a = 1 - f
    if (a < 0.04) {
      alpha[i] = 0
      return false
    }
    out[i * 3] = clamp((pr - f * bgc[0]) / a)
    out[i * 3 + 1] = clamp((pg - f * bgc[1]) / a)
    out[i * 3 + 2] = clamp((pb - f * bgc[2]) / a)
    alpha[i] = Math.round(a * 255)
    return true
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (isBg[i]) {
        alpha[i] = 0
        continue
      }
      const veil = isVeil[i] === 1
      if (!isEdge[i] && !veil) continue

      const pr = rgb[i * 3]
      const pg = rgb[i * 3 + 1]
      const pb = rgb[i * 3 + 2]

      // Локальный цвет фона (с тенью) рядом с пикселем и «чистый» цвет объекта.
      let br = 0
      let bgn = 0
      let bbl = 0
      let bn = 0
      let fr = 0
      let fg = 0
      let fb = 0
      let fn = 0
      const R = 6
      for (let r = 1; r <= R && fn === 0; r++) {
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
            const j = yy * w + xx
            if (isBg[j]) {
              if (r <= 3) {
                br += rgb[j * 3]
                bgn += rgb[j * 3 + 1]
                bbl += rgb[j * 3 + 2]
                bn++
              }
            } else if (!isEdge[j] && !isVeil[j]) {
              fr += rgb[j * 3]
              fg += rgb[j * 3 + 1]
              fb += rgb[j * 3 + 2]
              fn++
            }
          }
        }
      }
      const bgLoc: RGB = bn > 0 ? [br / bn, bgn / bn, bbl / bn] : bg

      // 4a. Есть «чистый» объект рядом — точная проекция.
      if (fn > 0) {
        fr /= fn
        fg /= fn
        fb /= fn
        const vr = fr - bgLoc[0]
        const vg = fg - bgLoc[1]
        const vb = fb - bgLoc[2]
        const len2 = vr * vr + vg * vg + vb * vb
        let a =
          len2 < 1
            ? 1
            : ((pr - bgLoc[0]) * vr + (pg - bgLoc[1]) * vg + (pb - bgLoc[2]) * vb) / len2
        a = Math.min(1, Math.max(0, a))
        if (a < 0.04) {
          alpha[i] = 0
          continue
        }
        // Для пикселей-«дымки» проекция может быть неточной — берём лучшую по spill.
        if (veil && canSpill) {
          const sp = 1 - Math.min(1, spillOf(pr, pg, pb) / spillBg)
          if (sp < a) {
            unmixSpill(i, bgLoc)
            continue
          }
        }
        if (a >= 0.4) {
          out[i * 3] = clamp((pr - (1 - a) * bgLoc[0]) / a)
          out[i * 3 + 1] = clamp((pg - (1 - a) * bgLoc[1]) / a)
          out[i * 3 + 2] = clamp((pb - (1 - a) * bgLoc[2]) / a)
        } else {
          out[i * 3] = clamp(fr)
          out[i * 3 + 1] = clamp(fg)
          out[i * 3 + 2] = clamp(fb)
        }
        alpha[i] = Math.round(a * 255)
        continue
      }

      // 4b. Тонкие детали без «чистых» соседей — разложение по составляющей фона.
      if (canSpill) {
        unmixSpill(i, bgLoc)
        continue
      }

      // 4c. Нейтральный фон (белый/серый) — по расстоянию до луча.
      const a = Math.min(1, Math.max(0, (res[i] - tolR) / (tolR * 1.5)))
      if (a < 0.04) {
        alpha[i] = 0
        continue
      }
      out[i * 3] = clamp((pr - (1 - a) * bgLoc[0]) / a)
      out[i * 3 + 1] = clamp((pg - (1 - a) * bgLoc[1]) / a)
      out[i * 3 + 2] = clamp((pb - (1 - a) * bgLoc[2]) / a)
      alpha[i] = Math.round(a * 255)
    }
  }

  return { alpha, rgb: out }
}

export function hex(c: [number, number, number]): string {
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
}
