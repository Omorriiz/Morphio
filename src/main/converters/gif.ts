import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { orderFrames } from '@shared/types'
import type { GifBuildOptions, GifFrame, GifProgress, GifResult } from '@shared/types'
import { openImage } from '../imageInput'
import { freePath } from '../files'
import { tm } from '../tm'

export const MAX_FRAMES = 400
/** Если все кадры анимации в сыром виде весят больше — читаем их по одному. */
const BULK_LIMIT = 600 * 1024 * 1024

type Report = (p: GifProgress) => void

async function makeThumbs(
  raw: Buffer,
  w: number,
  h: number
): Promise<{ thumbnail: string; preview: string }> {
  const src = (): ReturnType<typeof sharp> => sharp(raw, { raw: { width: w, height: h, channels: 4 } })
  const [t, p] = await Promise.all([
    src().resize(160, 160, { fit: 'cover' }).webp({ quality: 70, alphaQuality: 80 }).toBuffer(),
    src()
      .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, alphaQuality: 90 })
      .toBuffer()
  ])
  return {
    thumbnail: `data:image/webp;base64,${t.toString('base64')}`,
    preview: `data:image/webp;base64,${p.toString('base64')}`
  }
}

/**
 * Читает файлы и превращает их в кадры. Обычная картинка — один кадр,
 * GIF/WebP-анимация раскладывается на отдельные кадры с их задержками.
 */
export async function inspectFrames(
  paths: string[],
  onProgress?: (done: number, total: number) => void
): Promise<GifFrame[]> {
  const frames: GifFrame[] = []

  for (const [fileIndex, path] of paths.entries()) {
    onProgress?.(fileIndex, paths.length)
    if (frames.length >= MAX_FRAMES) break
    const name = basename(path)
    try {
      const meta = await sharp(path, { pages: -1 }).metadata()
      const pages = meta.pages ?? 1

      if (pages > 1 && meta.pageHeight) {
        const w = meta.width!
        const h = meta.pageHeight
        const take = Math.min(pages, MAX_FRAMES - frames.length)
        const bulk = pages * w * h * 4 <= BULK_LIMIT
        let all: Buffer | null = null
        if (bulk) {
          all = await sharp(path, { pages: -1 }).ensureAlpha().raw().toBuffer()
        }
        for (let i = 0; i < take; i++) {
          const raw = all
            ? all.subarray(i * w * h * 4, (i + 1) * w * h * 4)
            : await sharp(path, { page: i }).ensureAlpha().raw().toBuffer()
          const thumbs = await makeThumbs(Buffer.from(raw), w, h)
          frames.push({
            id: randomUUID(),
            path,
            page: i,
            name: `${name} #${i + 1}`,
            delay: meta.delay?.[i],
            width: w,
            height: h,
            ...thumbs
          })
        }
        continue
      }

      // Обычная картинка (с учётом поворота по EXIF).
      const image = (await openImage(path)).rotate()
      const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const thumbs = await makeThumbs(data, info.width, info.height)
      frames.push({
        id: randomUUID(),
        path,
        name,
        width: info.width,
        height: info.height,
        ...thumbs
      })
    } catch {
      /* файл не картинка — пропускаем */
    }
  }
  return frames
}

function parseColor(value: string): { r: number; g: number; b: number; alpha: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim())
  if (!m) return { r: 0, g: 0, b: 0, alpha: 0 }
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 }
}

/** Загружает кадр в исходном виде (RGBA). */
async function loadFrame(frame: GifFrame): Promise<ReturnType<typeof sharp>> {
  if (frame.page !== undefined) return sharp(frame.path, { page: frame.page })
  return (await openImage(frame.path)).rotate()
}

interface Attempt {
  scale: number
  colours: number
  quality: number
  label: string
}

function planAttempts(options: GifBuildOptions): Attempt[] {
  const base: Attempt = {
    scale: 1,
    colours: options.colours,
    quality: options.quality,
    label: tm('без изменений')
  }
  if (!options.targetKB) return [base]

  const list: Attempt[] = [base]
  if (options.format === 'gif') {
    const c = options.colours
    const steps: [number, number][] = [
      [1, Math.min(c, 128)],
      [0.85, Math.min(c, 128)],
      [0.7, Math.min(c, 96)],
      [0.7, Math.min(c, 64)],
      [0.55, Math.min(c, 64)],
      [0.45, Math.min(c, 48)],
      [0.35, Math.min(c, 32)],
      [0.25, Math.min(c, 32)]
    ]
    for (const [scale, colours] of steps) {
      list.push({ scale, colours, quality: options.quality, label: tm('{pct}% размера, {colours} цветов', { pct: Math.round(scale * 100), colours }) })
    }
  } else {
    const steps: [number, number][] = [
      [1, Math.min(options.quality, 70)],
      [0.85, 60],
      [0.7, 55],
      [0.55, 45],
      [0.45, 35],
      [0.35, 30]
    ]
    for (const [scale, quality] of steps) {
      list.push({ scale, colours: options.colours, quality, label: tm('{pct}% размера, качество {quality}', { pct: Math.round(scale * 100), quality }) })
    }
  }
  return list
}

/** Собирает анимацию из кадров. */
export async function buildGif(
  frames: GifFrame[],
  options: GifBuildOptions,
  report: Report
): Promise<GifResult> {
  if (frames.length === 0) throw new Error(tm('Добавьте хотя бы один кадр'))
  const ordered = orderFrames(frames, options.order)

  // Размер холста: по первому кадру списка (не зависит от выбранного порядка проигрывания).
  const first = frames[0]
  const baseW = Math.max(
    8,
    Math.round(options.width ?? Math.min(first.width, 1200))
  )
  const baseH = Math.max(8, Math.round((baseW * first.height) / first.width))
  const bg = options.background === 'transparent' ? { r: 0, g: 0, b: 0, alpha: 0 } : parseColor(options.background)

  // Каждый уникальный кадр декодируем один раз.
  const cache = new Map<string, Buffer>()
  const unique = [...new Map(ordered.map((f) => [f.id, f])).values()]
  let done = 0
  for (const f of unique) {
    report({ text: tm('Подготавливаю кадры…'), done, total: unique.length })
    const buf = await (await loadFrame(f))
      .resize(baseW, baseH, { fit: options.fit, background: bg })
      .ensureAlpha()
      .raw()
      .toBuffer()
    cache.set(f.id, buf)
    done++
  }

  const delays = ordered.map((f) => {
    const d = f.delay ?? options.defaultDelay
    // Браузеры показывают слишком короткие задержки GIF (<20 мс) как 100 мс.
    return Math.max(options.format === 'gif' ? 20 : 10, Math.round(d))
  })

  const attempts = planAttempts(options)
  let best: { data: Buffer; w: number; h: number; attempt: Attempt } | null = null
  const limit = options.targetKB ? options.targetKB * 1024 : Infinity
  let reached = !options.targetKB

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i]
    report({
      text: options.targetKB ? tm('Подбираю размер (попытка {i} из {n})…', { i: i + 1, n: attempts.length }) : tm('Собираю анимацию…'),
      done: i,
      total: attempts.length
    })
    const w = Math.max(8, Math.round(baseW * a.scale))
    const h = Math.max(8, Math.round(baseH * a.scale))

    const parts: Buffer[] = []
    for (const f of ordered) {
      const src = cache.get(f.id)!
      parts.push(
        a.scale === 1
          ? src
          : await sharp(src, { raw: { width: baseW, height: baseH, channels: 4 } })
              .resize(w, h)
              .raw()
              .toBuffer()
      )
    }
    const stack = Buffer.concat(parts)
    const img = sharp(stack, {
      raw: { width: w, height: h * ordered.length, channels: 4, pageHeight: h }
    })
    const data =
      options.format === 'gif'
        ? await img
            .gif({
              delay: delays,
              loop: options.loop,
              colours: Math.min(256, Math.max(2, a.colours)),
              dither: options.dither ? 1 : 0,
              effort: 7
            })
            .toBuffer()
        : await img
            .webp({
              delay: delays,
              loop: options.loop,
              quality: Math.min(100, Math.max(1, a.quality)),
              alphaQuality: 90,
              effort: 4
            })
            .toBuffer()

    best = { data, w, h, attempt: a }
    if (data.length <= limit) {
      reached = true
      break
    }
  }

  const result = best!
  const dir = options.outputDir ?? dirname(first.path)
  await fs.mkdir(dir, { recursive: true })
  const safeName = (options.name || 'animation').replace(/[\\/:*?"<>|]/g, '_').trim() || 'animation'
  const outputPath = await freePath(dir, safeName, options.format)
  await fs.writeFile(outputPath, result.data)

  const mime = options.format === 'gif' ? 'image/gif' : 'image/webp'
  const a = result.attempt
  const degraded =
    !!options.targetKB &&
    (a.scale !== 1 ||
      (options.format === 'gif' ? a.colours !== options.colours : a.quality !== options.quality))
  return {
    outputPath,
    outputSize: result.data.length,
    width: result.w,
    height: result.h,
    frames: ordered.length,
    note: degraded ? tm('Чтобы уложиться в размер: {label}', { label: result.attempt.label }) : undefined,
    reachedTarget: options.targetKB ? reached : undefined,
    previewUrl:
      result.data.length <= 12 * 1024 * 1024
        ? `data:${mime};base64,${result.data.toString('base64')}`
        : undefined
  }
}

/** Сохраняет кадры как отдельные PNG в полном размере. */
export async function exportFrames(
  frames: GifFrame[],
  outputDir: string,
  report: Report
): Promise<{ dir: string; count: number }> {
  const first = frames[0]
  if (!first) throw new Error(tm('Нет кадров'))
  const base = basename(first.path, extname(first.path)).replace(/[\\/:*?"<>|]/g, '_')
  let dir = join(outputDir, `${base}-frames`)
  let n = 1
  while (true) {
    try {
      await fs.access(dir)
      dir = join(outputDir, `${base}-frames (${n++})`)
    } catch {
      break
    }
  }
  await fs.mkdir(dir, { recursive: true })
  const pad = String(frames.length).length < 3 ? 3 : String(frames.length).length
  for (let i = 0; i < frames.length; i++) {
    report({ text: tm('Сохраняю кадры…'), done: i, total: frames.length })
    await (await loadFrame(frames[i]))
      .png()
      .toFile(join(dir, `${base}-${String(i + 1).padStart(pad, '0')}.png`))
  }
  return { dir, count: frames.length }
}
