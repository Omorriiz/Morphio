import type { BrushStroke, EditOp } from '@shared/types'
import { applyFillToMask, cleanEdgeColors, computeFill } from '@shared/regionFill'

/**
 * Применяет мазки кисти к маске прозрачности (0..255) прямо в буфере.
 * erase — «стереть» (сделать прозрачным), restore — «вернуть» (сделать видимым).
 * Края кисти мягкие: полная сила в центре и плавный спад к границе.
 */
export function applyStrokes(mask: Buffer, width: number, height: number, strokes: BrushStroke[]): void {
  for (const stroke of strokes) {
    const r = Math.max(1, stroke.radius)
    const step = Math.max(1, r * 0.25)
    const pts = stroke.points
    if (pts.length < 2) continue

    const stamp = (cx: number, cy: number): void => {
      const x0 = Math.max(0, Math.floor(cx - r))
      const x1 = Math.min(width - 1, Math.ceil(cx + r))
      const y0 = Math.max(0, Math.floor(cy - r))
      const y1 = Math.min(height - 1, Math.ceil(cy + r))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, y - cy)
          if (d > r) continue
          // Сила: 1 в центре (до 60% радиуса), дальше плавно к 0.
          const t = d <= r * 0.6 ? 1 : 1 - (d - r * 0.6) / (r * 0.4)
          const s = t * t * (3 - 2 * t)
          const i = y * width + x
          mask[i] =
            stroke.mode === 'erase'
              ? Math.round(mask[i] * (1 - s))
              : Math.round(mask[i] + (255 - mask[i]) * s)
        }
      }
    }

    // Одиночный клик — один штамп; иначе штампуем вдоль ломаной с шагом.
    if (pts.length === 2) stamp(pts[0], pts[1])
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i]
      const ay = pts[i + 1]
      const bx = pts[i + 2]
      const by = pts[i + 3]
      const len = Math.hypot(bx - ax, by - ay)
      const count = Math.max(1, Math.ceil(len / step))
      for (let k = 0; k <= count; k++) {
        const t = k / count
        stamp(ax + (bx - ax) * t, ay + (by - ay) * t)
      }
    }
  }
}

/**
 * Применяет всю историю правок по порядку: мазки меняют маску, заливки меняют маску и очищают цвета на краю.
 * `colors` — RGB по три байта (его меняют на месте, передавайте копию), `mask` — 0..255.
 */
export function applyEdits(colors: Buffer, mask: Buffer, width: number, height: number, ops: EditOp[]): void {
  for (const op of ops) {
    if ('type' in op && op.type === 'fill') {
      // сила считается по цветам до очистки краёв: так же, как в окне
      const r = computeFill(colors, width, height, op)
      if (applyFillToMask(mask, r.coverage)) cleanEdgeColors(colors, r.coverage, r.color)
    } else {
      applyStrokes(mask, width, height, [op as BrushStroke])
    }
  }
}
