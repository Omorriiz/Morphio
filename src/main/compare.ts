import { promises as fs } from 'node:fs'
import { extname } from 'node:path'
import sharp from 'sharp'
import { VIDEO_EXTENSIONS } from '@shared/types'
import type { CompareResult, CompareVerdict } from '@shared/types'
import { openImage } from './imageInput'
import { run, videoInfo } from './ffmpeg'
import { tm } from './tm'

/** Сравнение «до/после»: две картинки одного размера для слайдера и числа потери качества (PSNR, SSIM). */

const METRIC_SIDE = 512
const SHOW_SIDE = 1600

/** Серое изображение в виде байтов яркости. */
export interface Gray {
  width: number
  height: number
  data: Uint8Array
}

/** Пиковое отношение сигнал/шум в дБ. Одинаковые картинки дают 99. */
export function psnr(a: Gray, b: Gray): number {
  let sum = 0
  const n = a.data.length
  for (let i = 0; i < n; i++) {
    const d = a.data[i] - b.data[i]
    sum += d * d
  }
  const mse = sum / n
  if (mse === 0) return 99
  return Math.min(99, 10 * Math.log10((255 * 255) / mse))
}

/** Структурное сходство (SSIM) по окнам 8×8 с шагом 4; 1 значит «одинаково». */
export function ssim(a: Gray, b: Gray): number {
  const W = 8
  const STEP = 4
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2
  const { width, height } = a
  if (width < W || height < W) return psnr(a, b) >= 99 ? 1 : 0
  let total = 0
  let count = 0
  for (let y = 0; y + W <= height; y += STEP) {
    for (let x = 0; x + W <= width; x += STEP) {
      let sa = 0
      let sb = 0
      let saa = 0
      let sbb = 0
      let sab = 0
      for (let j = 0; j < W; j++) {
        const row = (y + j) * width + x
        for (let i = 0; i < W; i++) {
          const pa = a.data[row + i]
          const pb = b.data[row + i]
          sa += pa
          sb += pb
          saa += pa * pa
          sbb += pb * pb
          sab += pa * pb
        }
      }
      const n = W * W
      const ma = sa / n
      const mb = sb / n
      const va = saa / n - ma * ma
      const vb = sbb / n - mb * mb
      const cov = sab / n - ma * mb
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
      count++
    }
  }
  return count ? total / count : 1
}

/** Оценка словами по SSIM и PSNR. */
export function verdictOf(ssimValue: number, psnrValue: number): CompareVerdict {
  if (ssimValue >= 0.985 || psnrValue >= 42) return 'invisible'
  if (ssimValue >= 0.95) return 'small'
  if (ssimValue >= 0.85) return 'noticeable'
  return 'big'
}

async function toGray(png: Buffer, width: number, height: number): Promise<Gray> {
  const { data, info } = await sharp(png)
    .resize({ width, height, fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, info.width * info.height) }
}

/** Метрики двух картинок (в PNG-буферах); вторая приводится к размеру первой. */
export async function measure(before: Buffer, after: Buffer): Promise<{ psnr: number; ssim: number }> {
  const meta = await sharp(before).metadata()
  const w = meta.width ?? 1
  const h = meta.height ?? 1
  const k = Math.min(1, METRIC_SIDE / Math.max(w, h))
  const mw = Math.max(1, Math.round(w * k))
  const mh = Math.max(1, Math.round(h * k))
  const [ga, gb] = await Promise.all([toGray(before, mw, mh), toGray(after, mw, mh)])
  return { psnr: psnr(ga, gb), ssim: ssim(ga, gb) }
}

async function frameAt(path: string, time: number): Promise<Buffer> {
  const { stdout } = await run([
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, time)),
    '-i', path,
    '-frames:v', '1',
    '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'
  ])
  if (stdout.length === 0) throw new Error(tm('Не удалось получить кадр'))
  return stdout
}

async function imagePng(path: string): Promise<Buffer> {
  const img = await openImage(path)
  return img.rotate().png().toBuffer()
}

async function dataUrl(png: Buffer, width: number, height: number): Promise<string> {
  const buf = await sharp(png)
    .resize({ width, height, fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer()
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}

/**
 * Готовит пару «до/после». Для видео берётся кадр в момент `time` (секунды).
 * Результат приводится к размеру оригинала, чтобы слайдер совпадал по пикселям.
 */
export async function comparePair(inputPath: string, outputPath: string, time = 0): Promise<CompareResult> {
  const isVideo = VIDEO_EXTENSIONS.includes(extname(inputPath).slice(1).toLowerCase())
  let duration: number | undefined
  let a: Buffer
  let b: Buffer
  if (isVideo) {
    const info = await videoInfo(inputPath)
    duration = info.duration
    const t = Math.min(Math.max(0, time), Math.max(0, info.duration - 0.1))
    ;[a, b] = await Promise.all([frameAt(inputPath, t), frameAt(outputPath, t)])
  } else {
    ;[a, b] = await Promise.all([imagePng(inputPath), imagePng(outputPath)])
  }
  const meta = await sharp(a).metadata()
  const ow = meta.width ?? 1
  const oh = meta.height ?? 1
  const k = Math.min(1, SHOW_SIDE / Math.max(ow, oh))
  const sw = Math.max(1, Math.round(ow * k))
  const sh = Math.max(1, Math.round(oh * k))
  const [before, after, m, sizeBefore, sizeAfter] = await Promise.all([
    dataUrl(a, sw, sh),
    dataUrl(b, sw, sh),
    measure(a, b),
    fs.stat(inputPath).then((s) => s.size),
    fs.stat(outputPath).then((s) => s.size)
  ])
  return {
    before,
    after,
    width: sw,
    height: sh,
    originalWidth: ow,
    originalHeight: oh,
    sizeBefore,
    sizeAfter,
    psnr: Math.round(m.psnr * 10) / 10,
    ssim: Math.round(m.ssim * 1000) / 1000,
    verdict: verdictOf(m.ssim, m.psnr),
    duration
  }
}
