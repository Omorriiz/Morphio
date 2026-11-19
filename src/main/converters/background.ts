import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import type { BgRemoveOptions, FileItem } from '@shared/types'
import { detectSolidBackground, hex, removeSolidBackground } from './solidBackground'
import { openImage, type SharpImage } from '../imageInput'
import { freePath } from '../files'
import { tm } from '../tm'

const SIZE = 1024
const MEAN = [0.485, 0.456, 0.406]

let sessionPromise: Promise<ort.InferenceSession> | null = null
let provider = 'cpu'

/** Создаём сессию один раз: пробуем видеокарту (DirectML), при проблемах — процессор. */
function getSession(modelPath: string): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const s = await ort.InferenceSession.create(modelPath, {
          executionProviders: ['dml'],
          enableMemPattern: false,
          executionMode: 'sequential'
        })
        provider = 'dml'
        return s
      } catch {
        provider = 'cpu'
        return ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
      }
    })()
    sessionPromise.catch(() => (sessionPromise = null))
  }
  return sessionPromise
}

export function backgroundProvider(): string {
  return provider
}

/** Возвращает маску 0..255 того же размера, что и исходное изображение. */
export async function predictMask(
  modelPath: string,
  rgb: Buffer,
  width: number,
  height: number
): Promise<Buffer> {
  const session = await getSession(modelPath)

  // Подготовка входа: 1024×1024, нормализация как в rembg для ISNet.
  const small = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(SIZE, SIZE, { fit: 'fill' })
    .raw()
    .toBuffer()

  let max = 1e-6
  for (let i = 0; i < small.length; i++) if (small[i] > max) max = small[i]

  const plane = SIZE * SIZE
  const input = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    input[i] = small[i * 3] / max - MEAN[0]
    input[plane + i] = small[i * 3 + 1] / max - MEAN[1]
    input[2 * plane + i] = small[i * 3 + 2] / max - MEAN[2]
  }

  const inputName = session.inputNames[0]
  const outputs = await session.run({
    [inputName]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE])
  })
  const out = outputs[session.outputNames[0]].data as Float32Array

  // Нормализуем результат к 0..1 (min-max), как в rembg.
  let mi = Infinity
  let ma = -Infinity
  for (let i = 0; i < plane; i++) {
    if (out[i] < mi) mi = out[i]
    if (out[i] > ma) ma = out[i]
  }
  const range = ma - mi || 1
  const mask = Buffer.alloc(plane)
  for (let i = 0; i < plane; i++) mask[i] = Math.round(((out[i] - mi) / range) * 255)

  // Растягиваем маску обратно до размера исходника.
  const { data, info } = await sharp(mask, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })

  // sharp может вернуть несколько одинаковых каналов — оставляем ровно один.
  if (info.channels === 1) return data
  const single = Buffer.alloc(width * height)
  for (let i = 0; i < single.length; i++) single[i] = data[i * info.channels]
  return single
}

export interface Cutout {
  width: number
  height: number
  /** Цвета (RGB), при необходимости очищенные от каймы фона */
  colors: Buffer
  /** Альфа-маска 0..255 */
  mask: Buffer
  /** Как был найден фон (для заметки в интерфейсе) */
  note: string
}

export type CutoutOptions = Pick<
  BgRemoveOptions,
  'method' | 'tolerance' | 'everywhere' | 'translucent' | 'bgColor'
>

function parseHex(value: string | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((value ?? '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Находит объект на изображении: возвращает цвета и маску прозрачности. */
export async function computeCutout(
  item: { path: string },
  options: CutoutOptions,
  modelPath?: string
): Promise<Cutout> {
  const { data: rgb, info } = await (await openImage(item.path))
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })

  const detected =
    options.method === 'ai' ? null : detectSolidBackground(rgb, info.width, info.height)
  // Цвет фона, выбранный пипеткой, важнее автоопределения.
  const picked = parseHex(options.bgColor)
  const solid =
    detected && picked ? { ...detected, color: picked, uniformity: 1 } : detected
  const useSolid =
    options.method === 'solid' || (options.method === 'auto' && !!solid && solid.uniformity >= 0.98)

  if (useSolid && solid) {
    // Если цвет задан вручную, шум рамки ничего не говорит о нём — берём разумный допуск.
    const tol = options.tolerance > 0 ? options.tolerance : picked ? 30 : solid.tolerance
    const res = removeSolidBackground(
      rgb,
      info.width,
      info.height,
      solid.color,
      tol,
      options.everywhere,
      options.translucent
    )
    return {
      width: info.width,
      height: info.height,
      colors: res.rgb,
      mask: res.alpha,
      note: tm('Однотонный фон {color}', { color: hex(solid.color) })
    }
  }

  if (!modelPath) {
    throw new Error(
      tm('Фон не однотонный, а модель нейросети не скачана. Скачайте её на вкладке «Удалить фон».')
    )
  }
  const mask = await predictMask(modelPath, rgb, info.width, info.height)
  return { width: info.width, height: info.height, colors: rgb, mask, note: tm('Нейросеть') }
}

/**
 * Собирает итоговую картинку: прозрачный фон или заливка цветом.
 * opaque — принудительно без прозрачности (для JPG).
 */
export function composeCutout(
  cutout: Cutout,
  fill: { mode: 'transparent' | 'color'; color: string },
  opaque = false
): SharpImage {
  const { width, height, colors, mask } = cutout
  const n = width * height
  const solid = fill.mode === 'color' || opaque
  const bg = parseHex(fill.mode === 'color' ? fill.color : '#ffffff') ?? [255, 255, 255]

  if (solid) {
    const out = Buffer.alloc(n * 3)
    for (let i = 0; i < n; i++) {
      const a = mask[i] / 255
      out[i * 3] = Math.round(colors[i * 3] * a + bg[0] * (1 - a))
      out[i * 3 + 1] = Math.round(colors[i * 3 + 1] * a + bg[1] * (1 - a))
      out[i * 3 + 2] = Math.round(colors[i * 3 + 2] * a + bg[2] * (1 - a))
    }
    return sharp(out, { raw: { width, height, channels: 3 } })
  }

  const out = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    out[i * 4] = colors[i * 3]
    out[i * 4 + 1] = colors[i * 3 + 1]
    out[i * 4 + 2] = colors[i * 3 + 2]
    out[i * 4 + 3] = mask[i]
  }
  return sharp(out, { raw: { width, height, channels: 4 } })
}

/** Сохраняет результат удаления фона и делает превью (на шахматном фоне оно прозрачное). */
export async function writeCutout(
  item: FileItem,
  cutout: Cutout,
  options: Pick<BgRemoveOptions, 'background' | 'color' | 'format' | 'outputDir'>,
  overwritePath?: string
): Promise<{ outputPath: string; outputSize: number; preview: string; info: string }> {
  let image = composeCutout(
    cutout,
    { mode: options.background, color: options.color },
    options.format === 'jpg'
  )
  switch (options.format) {
    case 'png':
      image = image.png({ compressionLevel: 9 })
      break
    case 'webp':
      image = image.webp({ quality: 92, alphaQuality: 100 })
      break
    case 'jpg':
      image = image.jpeg({ quality: 93, mozjpeg: true })
      break
  }

  let outputPath = overwritePath
  if (!outputPath) {
    const dir = options.outputDir ?? dirname(item.path)
    await fs.mkdir(dir, { recursive: true })
    const base = basename(item.path, extname(item.path))
    outputPath = await freePath(dir, options.outputDir ? base : `${base}-no-bg`, options.format)
  }
  await image.toFile(outputPath)

  const { size } = await fs.stat(outputPath)
  const previewBuf = await sharp(outputPath)
    .resize(160, 160, { fit: 'cover' })
    .webp({ quality: 80, alphaQuality: 100 })
    .toBuffer()

  return {
    outputPath,
    outputSize: size,
    preview: `data:image/webp;base64,${previewBuf.toString('base64')}`,
    info: cutout.note
  }
}

export async function removeBackground(
  item: FileItem,
  options: BgRemoveOptions,
  modelPath: string | undefined
): Promise<{ outputPath: string; outputSize: number; preview: string; info: string }> {
  const cutout = await computeCutout(item, options, modelPath)
  return writeCutout(item, cutout, options)
}
