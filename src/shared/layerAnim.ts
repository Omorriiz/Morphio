/**
 * Анимация слоёв (текст и стикеры) в GIF-студии. Считается по номеру кадра, поэтому окно и сборка
 * показывают одно и то же. «Ход» p идёт от 0 на первом кадре показа до 1 на последнем.
 */

export const LAYER_ANIMS = ['none', 'fadein', 'fadeout', 'fade', 'blink', 'slideup', 'marquee'] as const
export type LayerAnim = (typeof LAYER_ANIMS)[number]

export const LAYER_ANIM_LABELS: Record<LayerAnim, string> = {
  none: 'Без анимации',
  fadein: 'Появление',
  fadeout: 'Исчезновение',
  fade: 'Появление и исчезновение',
  blink: 'Мигание',
  slideup: 'Выезд снизу',
  marquee: 'Бегущая строка'
}

export interface LayerFrameState {
  visible: boolean
  /** Множитель непрозрачности, 0–1 */
  opacity: number
  /** Сдвиг вниз в долях высоты кадра (выезд снизу) */
  dy: number
  /** Бегущая строка: положение от 0 (за правым краем) до 1 (за левым краем); для остальных — null */
  run: number | null
}

const EDGE = 0.25

/** Состояние слоя на кадре `index` при показе с кадра `from` по кадр `to`. */
export function layerState(anim: LayerAnim | undefined, index: number, from: number, to: number): LayerFrameState {
  const base: LayerFrameState = { visible: true, opacity: 1, dy: 0, run: null }
  if (!anim || anim === 'none') return base
  const span = Math.max(1, to - from)
  const p = Math.min(1, Math.max(0, (index - from) / span))
  const total = to - from + 1
  switch (anim) {
    case 'fadein':
      return { ...base, opacity: Math.min(1, p / EDGE) }
    case 'fadeout':
      return { ...base, opacity: Math.min(1, (1 - p) / EDGE) }
    case 'fade':
      return { ...base, opacity: Math.min(1, p / EDGE, (1 - p) / EDGE) }
    case 'blink': {
      const period = Math.max(1, Math.round(total / 8))
      return { ...base, visible: Math.floor((index - from) / period) % 2 === 0 }
    }
    case 'slideup': {
      const e = Math.min(1, p / EDGE)
      const ease = 1 - (1 - e) * (1 - e)
      return { ...base, opacity: Math.min(1, p / 0.1 + 0.2), dy: (1 - ease) * 0.25 }
    }
    case 'marquee':
      return { ...base, run: p }
  }
}
