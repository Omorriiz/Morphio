import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { orderFrames, speedFor } from '@shared/types'
import type { GifBuildOptions, GifCrop, GifFrame, GifLayer, GifProgress, GifResult } from '@shared/types'
import { tmpdir } from 'node:os'
import { openImage } from '../imageInput'
import { freePath } from '../files'
import { tm } from '../tm'
import { predictMask } from './background'
import { detectSolidBackground, removeSolidBackground } from './solidBackground'
import { activeLayers, cropRect, croppedSize, matteEdges, overlayLayers, prepareLayers, smoothMasks } from './gifLayers'

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

/** APNG собирает FFmpeg: sharp умеет читать анимацию, но не писать APNG. Мягкие края прозрачности сохраняются. */
async function encodeApng(buffers: Buffer[], w: number, h: number, delays: number[], loop: number): Promise<Buffer> {
  const { run } = await import('../ffmpeg')
  const dir = join(tmpdir(), `morphio-apng-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  try {
    const lines: string[] = []
    for (let i = 0; i < buffers.length; i++) {
      const name = `f${String(i).padStart(4, '0')}.png`
      await sharp(buffers[i], { raw: { width: w, height: h, channels: 4 } }).png().toFile(join(dir, name))
      lines.push(`file '${name}'`, `duration ${(delays[i] / 1000).toFixed(3)}`)
    }
    // последний кадр в списке нужно повторить, иначе его длительность теряется
    lines.push(`file 'f${String(buffers.length - 1).padStart(4, '0')}.png'`)
    await fs.writeFile(join(dir, 'list.txt'), lines.join('\n'), 'utf8')
    const out = join(dir, 'out.apng')
    const r = await run(
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-t', (delays.reduce((a, b) => a + b, 0) / 1000).toFixed(3), '-plays', String(loop), '-pix_fmt', 'rgba', '-fps_mode', 'vfr', '-f', 'apng', out],
      undefined,
      { cwd: dir }
    )
    if (r.code !== 0) throw new Error(tm('Не удалось собрать APNG: {msg}', { msg: r.stderr.trim().split('\n').pop() ?? '' }))
    return await fs.readFile(out)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const hexToRgb = (value: string): { r: number; g: number; b: number } => {
  const c = parseColor(value)
  return { r: c.r, g: c.g, b: c.b }
}

/** Собирает анимацию из кадров: обрезка, удаление фона, вписывание, текст и стикеры, кодирование. */
export async function buildGif(
  frames: GifFrame[],
  options: GifBuildOptions,
  report: Report,
  ctx: { modelPath?: string } = {}
): Promise<GifResult> {
  if (frames.length === 0) throw new Error(tm('Добавьте хотя бы один кадр'))
  const ordered = orderFrames(frames, options.order)

  // Размер холста: по первому кадру списка после обрезки (не зависит от порядка проигрывания).
  const first = frames[0]
  const firstSize = croppedSize(first, options.crop)
  const baseW = Math.max(8, Math.round(options.width ?? Math.min(firstSize.width, 1200)))
  const baseH = Math.max(8, Math.round((baseW * firstSize.height) / firstSize.width))
  const bg = options.background === 'transparent' ? { r: 0, g: 0, b: 0, alpha: 0 } : parseColor(options.background)
  const transparentBg = { r: 0, g: 0, b: 0, alpha: 0 }

  const cropped = async (f: GifFrame): Promise<ReturnType<typeof sharp>> => {
    const img = await loadFrame(f)
    return options.crop ? img.extract(cropRect(options.crop, f.width, f.height)) : img
  }

  const unique = [...new Map(ordered.map((f) => [f.id, f])).values()]
  const indexOfId = new Map(frames.map((f, i) => [f.id, i]))

  // ---- удаление фона: решаем один раз по первому кадру, чтобы цвет и допуск не «плавали» ----
  const rb = options.removeBg
  let solid: { color: [number, number, number]; tol: number } | null = null
  let useAi = false
  const aiW = Math.min(baseW, 768)
  const aiH = Math.max(8, Math.round((aiW * baseH) / baseW))
  if (rb) {
    const rgbOf = async (f: GifFrame, w: number): Promise<{ rgb: Buffer; w: number; h: number }> => {
      const { data, info } = await (await cropped(f))
        .resize({ width: w })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true })
      return { rgb: data, w: info.width, h: info.height }
    }
    if (rb.method !== 'ai') {
      const f0 = await rgbOf(unique[0], baseW)
      const det = detectSolidBackground(f0.rgb, f0.w, f0.h)
      if (rb.method === 'solid' || det.uniformity >= 0.98) solid = { color: det.color, tol: det.tolerance }
    }
    if (!solid) {
      useAi = true
      if (!ctx.modelPath) {
        throw new Error(tm('Фон не однотонный, а модель нейросети не скачана. Скачайте её на вкладке «Удалить фон».'))
      }
    }
  }

  // ---- кадры без слоёв: обрезка → удаление фона → вписывание ----
  const base = new Map<string, Buffer>()
  const fitted = (img: ReturnType<typeof sharp>): ReturnType<typeof sharp> =>
    img.resize(baseW, baseH, { fit: options.fit, background: bg })

  if (useAi) {
    // Первый проход: маски нейросети для всех кадров (нужны вместе, чтобы сгладить их по времени).
    const masks: Buffer[] = []
    for (const [i, f] of unique.entries()) {
      report({ text: tm('Ищу объект на кадрах…'), done: i, total: unique.length })
      const rgb = await (await cropped(f)).resize(aiW, aiH, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer()
      masks.push(await predictMask(ctx.modelPath!, rgb, aiW, aiH))
    }
    const smooth = rb!.smooth ? smoothMasks(masks, 1) : masks
    for (const [i, f] of unique.entries()) {
      report({ text: tm('Подготавливаю кадры…'), done: i, total: unique.length })
      const color = await fitted(await cropped(f)).ensureAlpha().raw().toBuffer()
      const maskFit = await fitted(sharp(smooth[i], { raw: { width: aiW, height: aiH, channels: 1 } }))
        .removeAlpha()
        .toColourspace('b-w')
        .raw()
        .toBuffer({ resolveWithObject: true })
      const out = Buffer.from(color)
      for (let p = 0; p < baseW * baseH; p++) {
        out[p * 4 + 3] = Math.round((color[p * 4 + 3] * maskFit.data[p * maskFit.info.channels]) / 255)
      }
      base.set(f.id, out)
    }
  } else {
    for (const [i, f] of unique.entries()) {
      report({ text: tm('Подготавливаю кадры…'), done: i, total: unique.length })
      if (solid) {
        const { data, info } = await (await cropped(f))
          .resize({ width: baseW })
          .removeAlpha()
          .toColourspace('srgb')
          .raw()
          .toBuffer({ resolveWithObject: true })
        const res = removeSolidBackground(data, info.width, info.height, solid.color, solid.tol, true, true)
        const rgba = Buffer.alloc(info.width * info.height * 4)
        for (let p = 0; p < info.width * info.height; p++) {
          rgba[p * 4] = res.rgb[p * 3]
          rgba[p * 4 + 1] = res.rgb[p * 3 + 1]
          rgba[p * 4 + 2] = res.rgb[p * 3 + 2]
          rgba[p * 4 + 3] = res.alpha[p]
        }
        base.set(
          f.id,
          await fitted(sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })).ensureAlpha().raw().toBuffer()
        )
      } else {
        base.set(f.id, await fitted(await cropped(f)).ensureAlpha().raw().toBuffer())
      }
    }
  }

  // ---- текст и стикеры ----
  const layers = await prepareLayers(options.layers, baseW, baseH, frames.length)
  const matte =
    options.format === 'gif' && options.background === 'transparent' && (!!rb || layers.length > 0)
      ? hexToRgb(rb?.matte ?? '#ffffff')
      : null
  const composedCache = new Map<string, Buffer>()
  const composed = (f: GifFrame): Buffer => {
    const idx = indexOfId.get(f.id) ?? 0
    const active = activeLayers(layers, idx, baseW, baseH)
    const key = `${f.id}|${active.map((l) => `${l.id}:${l.opacity.toFixed(3)}:${l.left}:${l.top}`).join(',')}`
    let buf = composedCache.get(key)
    if (!buf) {
      buf = overlayLayers(base.get(f.id)!, baseW, baseH, active)
      if (matte) buf = matteEdges(buf, matte)
      composedCache.set(key, buf)
    }
    return buf
  }

  const delays = ordered.map((f) => {
    const d = (f.delay ?? options.defaultDelay) / speedFor(options.speedRanges, indexOfId.get(f.id) ?? 0)
    // Браузеры показывают слишком короткие задержки GIF (<20 мс) как 100 мс.
    return Math.max(options.format === 'gif' ? 20 : 10, Math.round(d))
  })

  const attempts = options.format === 'apng' ? [planAttempts({ ...options, targetKB: undefined })[0]] : planAttempts(options)
  let best: { data: Buffer; w: number; h: number; attempt: Attempt } | null = null
  const limit = options.targetKB && options.format !== 'apng' ? options.targetKB * 1024 : Infinity
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
      const src = composed(f)
      parts.push(
        a.scale === 1
          ? src
          : await sharp(src, { raw: { width: baseW, height: baseH, channels: 4 } })
              .resize(w, h)
              .raw()
              .toBuffer()
      )
    }
    let data: Buffer
    if (options.format === 'apng') {
      data = await encodeApng(parts, w, h, delays, options.loop)
    } else {
      const img = sharp(Buffer.concat(parts), {
        raw: { width: w, height: h * ordered.length, channels: 4, pageHeight: h }
      })
      data =
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
    }

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

  const mime = options.format === 'gif' ? 'image/gif' : options.format === 'webp' ? 'image/webp' : 'image/png'
  const a = result.attempt
  const degraded =
    !!options.targetKB &&
    options.format !== 'apng' &&
    (a.scale !== 1 || (options.format === 'gif' ? a.colours !== options.colours : a.quality !== options.quality))
  return {
    outputPath,
    outputSize: result.data.length,
    width: result.w,
    height: result.h,
    frames: ordered.length,
    note: degraded ? tm('Чтобы уложиться в размер: {label}', { label: result.attempt.label }) : undefined,
    reachedTarget: options.targetKB && options.format !== 'apng' ? reached : undefined,
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
  report: Report,
  extra: { crop?: GifCrop; layers?: GifLayer[] } = {}
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
  const size = croppedSize(first, extra.crop)
  const canvasW = Math.min(size.width, 4096)
  const canvasH = Math.max(1, Math.round((canvasW * size.height) / size.width))
  const prepared = await prepareLayers(extra.layers, canvasW, canvasH, frames.length)
  const pad = String(frames.length).length < 3 ? 3 : String(frames.length).length
  for (let i = 0; i < frames.length; i++) {
    report({ text: tm('Сохраняю кадры…'), done: i, total: frames.length })
    const file = join(dir, `${base}-${String(i + 1).padStart(pad, '0')}.png`)
    if (!extra.crop && !(extra.layers?.length ?? 0)) {
      await (await loadFrame(frames[i])).png().toFile(file)
      continue
    }
    // с рамкой и слоями: все кадры приводятся к размеру первого кадра после обрезки
    const f = frames[i]
    let img = await loadFrame(f)
    if (extra.crop) img = img.extract(cropRect(extra.crop, f.width, f.height))
    const { data, info } = await img
      .resize(canvasW, canvasH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const out = overlayLayers(data, info.width, info.height, activeLayers(prepared, i, info.width, info.height))
    await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(file)
  }
  return { dir, count: frames.length }
}
