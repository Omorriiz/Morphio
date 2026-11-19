import type { GifLayer } from '@shared/types'

/**
 * Слои GIF-студии рисуются здесь, в окне: через canvas доступны все шрифты Windows и кириллица.
 * В основной процесс уходит готовая картинка слоя (PNG), размер которой считается для кадра шириной 1000 px.
 */

export const REF_WIDTH = 1000

export interface TextStyle {
  text: string
  font: string
  size: number
  bold: boolean
  italic: boolean
  color: string
  /** Толщина обводки, px (для кадра шириной 1000) */
  outline: number
  outlineColor: string
  shadow: boolean
}

export const FONTS = ['Impact', 'Arial Black', 'Segoe UI', 'Verdana', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Comic Sans MS', 'Courier New']

export const DEFAULT_TEXT: TextStyle = {
  text: 'Текст',
  font: 'Impact',
  size: 96,
  bold: false,
  italic: false,
  color: '#ffffff',
  outline: 6,
  outlineColor: '#000000',
  shadow: false
}

export const EMOJIS = [
  '😀', '😂', '🤣', '😍', '😎', '🥳', '😭', '😡', '🤔', '🙄', '😱', '😴',
  '👍', '👎', '👏', '🙌', '🙏', '💪', '👀', '🔥', '✨', '💥', '💯', '⭐',
  '❤️', '💔', '💙', '💚', '🎉', '🎁', '🏆', '🚀', '🌈', '☀️', '🌙', '⚡',
  '🐱', '🐶', '🦄', '🐸', '🍕', '🍔', '☕', '🍺', '💣', '💀', '👻', '🤖'
]

export interface Rendered {
  png: string
  width: number
  height: number
}

/** Рисует текст со всеми настройками в прозрачный PNG. */
export async function renderText(s: TextStyle): Promise<Rendered> {
  const spec = `${s.italic ? 'italic ' : ''}${s.bold ? '700' : '400'} ${s.size}px "${s.font}"`
  try {
    await document.fonts.load(spec, s.text || ' ')
  } catch {
    /* шрифт не нашёлся: браузер подставит запасной */
  }
  const lines = (s.text || ' ').split('\n')
  const c = document.createElement('canvas')
  const g = c.getContext('2d')!
  g.font = spec
  const lineH = Math.round(s.size * 1.18)
  const textW = Math.max(...lines.map((l) => g.measureText(l).width), 1)
  const pad = Math.ceil(s.outline + (s.shadow ? s.size * 0.12 + 4 : 0) + 4)
  c.width = Math.ceil(textW + pad * 2)
  c.height = lineH * lines.length + pad * 2
  g.font = spec
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineJoin = 'round'
  g.miterLimit = 2
  lines.forEach((line, i) => {
    const x = c.width / 2
    const y = pad + lineH * i + lineH / 2
    if (s.shadow) {
      g.save()
      g.shadowColor = 'rgba(0,0,0,0.65)'
      g.shadowBlur = s.size * 0.08
      g.shadowOffsetX = s.size * 0.04
      g.shadowOffsetY = s.size * 0.04
      g.fillStyle = s.outline > 0 ? s.outlineColor : s.color
      g.fillText(line, x, y)
      g.restore()
    }
    if (s.outline > 0) {
      g.lineWidth = s.outline * 2
      g.strokeStyle = s.outlineColor
      g.strokeText(line, x, y)
    }
    g.fillStyle = s.color
    g.fillText(line, x, y)
  })
  return { png: c.toDataURL('image/png'), width: c.width, height: c.height }
}

/** Рисует эмодзи в прозрачный PNG (системный шрифт эмодзи Windows). */
export function renderEmoji(emoji: string): Rendered {
  const size = 256
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')!
  g.font = `${Math.round(size * 0.78)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(emoji, size / 2, size / 2 + size * 0.04)
  return { png: c.toDataURL('image/png'), width: size, height: size }
}

const newId = (): string => crypto.randomUUID()

export async function newTextLayer(style: TextStyle = DEFAULT_TEXT): Promise<GifLayer> {
  const r = await renderText(style)
  return {
    id: newId(),
    kind: 'text',
    png: r.png,
    x: 0.5,
    y: 0.85,
    w: Math.min(0.9, r.width / REF_WIDTH),
    rotation: 0,
    edit: { ...style, renderW: r.width }
  }
}

export function newStickerLayer(r: Rendered, label: string, width = 0.22): GifLayer {
  return { id: newId(), kind: 'sticker', png: r.png, x: 0.5, y: 0.5, w: width, rotation: 0, edit: { label } }
}

/** Высота слоя в долях высоты кадра по его картинке (нужна для рамки выделения). */
export const layerAspect = (png: HTMLImageElement | null): number => (png && png.naturalWidth > 0 ? png.naturalHeight / png.naturalWidth : 1)

/** Перерисовывает текстовый слой с новыми настройками. keepScale — сохранить размер, заданный мышью. */
export async function restyleText(layer: GifLayer, style: TextStyle, keepScale = true): Promise<Partial<GifLayer>> {
  const r = await renderText(style)
  const oldRender = (layer.edit?.['renderW'] as number | undefined) ?? r.width
  const scale = keepScale ? (layer.w * REF_WIDTH) / oldRender : 1
  return { png: r.png, w: Math.min(3, (r.width * scale) / REF_WIDTH), edit: { ...style, renderW: r.width } }
}

/** После изменения размера мышью текст перерисовывается с подходящим кеглем, чтобы остаться чётким. */
export async function commitTextScale(layer: GifLayer): Promise<Partial<GifLayer> | null> {
  const edit = layer.edit as (Partial<TextStyle> & { renderW?: number }) | undefined
  if (layer.kind !== 'text' || !edit?.renderW) return null
  const ratio = (layer.w * REF_WIDTH) / edit.renderW
  if (Math.abs(ratio - 1) < 0.03) return null
  const style = { ...DEFAULT_TEXT, ...edit, size: Math.min(400, Math.max(12, Math.round((edit.size ?? DEFAULT_TEXT.size) * ratio))) } as TextStyle
  return restyleText(layer, style, false)
}
