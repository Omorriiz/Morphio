import sharp from 'sharp'
import type { GifCrop, GifFrame, GifLayer } from '@shared/types'
import { layerState } from '@shared/layerAnim'
import type { LayerAnim } from '@shared/layerAnim'

/** Помощники GIF-студии: обрезка рамкой, наложение текста и стикеров, сглаживание маски, «матовые» края. */

/** Слой, подготовленный под размер холста: пиксели RGBA и положение левого верхнего угла (может быть за краем). */
export interface PreparedLayer {
  id: string
  data: Buffer
  width: number
  height: number
  left: number
  top: number
  opacity: number
  from: number
  to: number
  anim?: LayerAnim
}

const dataUrlToBuffer = (url: string): Buffer => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')

/** Рамка обрезки в пикселях кадра; слишком маленькая или кривая рамка заменяется целым кадром. */
export function cropRect(crop: GifCrop | undefined, w: number, h: number): { left: number; top: number; width: number; height: number } {
  if (!crop) return { left: 0, top: 0, width: w, height: h }
  const left = Math.min(w - 1, Math.max(0, Math.round(crop.x * w)))
  const top = Math.min(h - 1, Math.max(0, Math.round(crop.y * h)))
  const width = Math.min(w - left, Math.max(1, Math.round(crop.w * w)))
  const height = Math.min(h - top, Math.max(1, Math.round(crop.h * h)))
  if (width < 4 || height < 4) return { left: 0, top: 0, width: w, height: h }
  return { left, top, width, height }
}

/** Размер кадра после обрезки. */
export const croppedSize = (f: Pick<GifFrame, 'width' | 'height'>, crop?: GifCrop): { width: number; height: number } => {
  const r = cropRect(crop, f.width, f.height)
  return { width: r.width, height: r.height }
}

/**
 * Готовит слои под холст `canvasW × canvasH`: размер по доле ширины, поворот, положение по центру.
 * `indexOf` переводит id кадра в его номер в списке (для диапазонов «с кадра … по кадр …»).
 */
export async function prepareLayers(layers: GifLayer[] | undefined, canvasW: number, canvasH: number, frameCount: number): Promise<PreparedLayer[]> {
  const out: PreparedLayer[] = []
  for (const l of layers ?? []) {
    if (!l.png || !(l.w > 0)) continue
    const targetW = Math.max(2, Math.round(l.w * canvasW))
    let img = sharp(dataUrlToBuffer(l.png)).ensureAlpha().resize({ width: targetW })
    if (l.rotation % 360 !== 0) img = img.rotate(l.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
    out.push({
      id: l.id,
      data,
      width: info.width,
      height: info.height,
      left: Math.round(l.x * canvasW - info.width / 2),
      top: Math.round(l.y * canvasH - info.height / 2),
      opacity: Math.min(1, Math.max(0, l.opacity ?? 1)),
      from: Math.max(0, l.from ?? 0),
      to: Math.min(frameCount - 1, l.to ?? frameCount - 1),
      anim: l.anim
    })
  }
  return out
}

/**
 * Слои, видимые на кадре с таким номером, уже с анимацией: прозрачность, сдвиг и бегущая строка
 * пересчитаны для этого кадра (холст canvasW × canvasH нужен для сдвигов).
 */
export function activeLayers(layers: PreparedLayer[], index: number, canvasW = 0, canvasH = 0): PreparedLayer[] {
  const out: PreparedLayer[] = []
  for (const l of layers) {
    if (index < l.from || index > l.to) continue
    if (!l.anim || l.anim === 'none') {
      out.push(l)
      continue
    }
    const s = layerState(l.anim, index, l.from, l.to)
    if (!s.visible || s.opacity <= 0) continue
    out.push({
      ...l,
      opacity: l.opacity * s.opacity,
      top: l.top + Math.round(s.dy * canvasH),
      left: s.run === null ? l.left : Math.round(canvasW + (-l.width - canvasW) * s.run)
    })
  }
  return out
}

/** Накладывает слои на кадр RGBA (обычное смешивание «поверх»). Возвращает новый буфер. */
export function overlayLayers(base: Buffer, w: number, h: number, layers: PreparedLayer[]): Buffer {
  if (layers.length === 0) return base
  const out = Buffer.from(base)
  for (const l of layers) {
    for (let ly = 0; ly < l.height; ly++) {
      const y = l.top + ly
      if (y < 0 || y >= h) continue
      for (let lx = 0; lx < l.width; lx++) {
        const x = l.left + lx
        if (x < 0 || x >= w) continue
        const si = (ly * l.width + lx) * 4
        const sa = (l.data[si + 3] / 255) * l.opacity
        if (sa <= 0) continue
        const di = (y * w + x) * 4
        const da = out[di + 3] / 255
        const oa = sa + da * (1 - sa)
        if (oa <= 0) continue
        for (let c = 0; c < 3; c++) {
          out[di + c] = Math.round((l.data[si + c] * sa + out[di + c] * da * (1 - sa)) / oa)
        }
        out[di + 3] = Math.round(oa * 255)
      }
    }
  }
  return out
}

/**
 * Сглаживает маски по времени: каждая маска усредняется с соседними (веса 1-2-1 для радиуса 1).
 * Покадровая нейросеть даёт мерцающие края, после сглаживания кадры соседствуют плавно.
 */
export function smoothMasks(masks: Buffer[], radius = 1): Buffer[] {
  if (masks.length < 2 || radius < 1) return masks
  return masks.map((m, i) => {
    const out = Buffer.alloc(m.length)
    let total = 0
    const picks: { buf: Buffer; weight: number }[] = []
    for (let d = -radius; d <= radius; d++) {
      const j = i + d
      if (j < 0 || j >= masks.length) continue
      const weight = radius + 1 - Math.abs(d)
      picks.push({ buf: masks[j], weight })
      total += weight
    }
    for (let p = 0; p < m.length; p++) {
      let s = 0
      for (const pk of picks) s += pk.buf[p] * pk.weight
      out[p] = Math.round(s / total)
    }
    return out
  })
}

/**
 * «Матовые» края для GIF: прозрачность в GIF только «есть или нет», поэтому полупрозрачные пиксели
 * смешиваются с цветом будущего фона и режутся по половине прозрачности. Так нет светлой каймы.
 */
export function matteEdges(rgba: Buffer, matte: { r: number; g: number; b: number }): Buffer {
  const out = Buffer.from(rgba)
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3] / 255
    if (a >= 1) continue
    if (a <= 0) {
      out[i + 3] = 0
      continue
    }
    out[i] = Math.round(out[i] * a + matte.r * (1 - a))
    out[i + 1] = Math.round(out[i + 1] * a + matte.g * (1 - a))
    out[i + 2] = Math.round(out[i + 2] * a + matte.b * (1 - a))
    out[i + 3] = a >= 0.5 ? 255 : 0
  }
  return out
}
