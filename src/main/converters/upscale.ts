import { promises as fs } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import type { FileItem, UniversalOptions } from '@shared/types'
import { freePath } from '../files'
import { openImage } from '../imageInput'
import { modulePath } from '../modules'
import { tm } from '../tm'
import type { JobResult } from '../queue'
import { encodeAs } from './image'

/**
 * Увеличение фото нейросетью Real-ESRGAN (модель general-x4v3, ONNX). Модель принимает кадр строго 128×128
 * и даёт 512×512, поэтому картинка режется на плитки с запасом по краям («pad»), и из каждой плитки берётся
 * только середина: швы не видны. ×2 получается из ×4 уменьшением середины плитки.
 */

const TILE = 128
const PAD = 12
const STEP = TILE - 2 * PAD // 104 px входа на плитку
/** Потолок результата: больше не влезет в память (3 байта на точку, плюс запас). */
const MAX_OUT_PIXELS = 110_000_000
const MAX_OUT_SIDE = 16_384

let sessionPromise: { path: string; session: Promise<ort.InferenceSession> } | null = null

/** Сессия создаётся один раз: сначала видеокарта (DirectML), при проблемах процессор. */
function getSession(path: string): Promise<ort.InferenceSession> {
  if (!sessionPromise || sessionPromise.path !== path) {
    const session = (async () => {
      try {
        return await ort.InferenceSession.create(path, { executionProviders: ['dml'], enableMemPattern: false, executionMode: 'sequential' })
      } catch {
        return ort.InferenceSession.create(path, { executionProviders: ['cpu'] })
      }
    })()
    session.catch(() => (sessionPromise = null))
    sessionPromise = { path, session }
  }
  return sessionPromise.session
}

let stopped = false
/** Кнопка «Остановить». */
export function cancelUpscale(): void {
  stopped = true
}

/** Размеры результата для входа w×h; null — слишком много. */
export function outputSize(w: number, h: number, scale: 2 | 4): { width: number; height: number } | null {
  const width = w * scale
  const height = h * scale
  if (width > MAX_OUT_SIDE || height > MAX_OUT_SIDE || width * height > MAX_OUT_PIXELS) return null
  return { width, height }
}

/**
 * Увеличивает RGB-картинку (3 байта на точку) в `scale` раз. `report` получает долю готовности 0–1.
 * Возвращает RGB нового размера.
 */
export async function upscaleRgb(
  modelPath: string,
  rgb: Buffer,
  w: number,
  h: number,
  scale: 2 | 4,
  report: (fraction: number) => void = () => {}
): Promise<Buffer> {
  const session = await getSession(modelPath)
  const input = session.inputNames[0]
  const nx = Math.ceil(w / STEP)
  const ny = Math.ceil(h / STEP)

  // Холст с запасом: края отражаются, а длина добивается до целого числа плиток
  const padded = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .extend({
      top: PAD,
      left: PAD,
      right: PAD + (nx * STEP - w),
      bottom: PAD + (ny * STEP - h),
      extendWith: w > PAD && h > PAD ? 'mirror' : 'copy'
    })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pw = padded.info.width
  const outW = w * scale
  const outH = h * scale
  const out = Buffer.alloc(outW * outH * 3)
  const plane = TILE * TILE
  const centre = (STEP * scale) | 0 // сторона середины плитки в результате
  const data = new Float32Array(3 * plane)

  stopped = false
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      if (stopped) throw new Error(tm('Остановлено'))
      for (let y = 0; y < TILE; y++) {
        const row = ((ty * STEP + y) * pw + tx * STEP) * 3
        for (let x = 0; x < TILE; x++) {
          const s = row + x * 3
          const d = y * TILE + x
          data[d] = padded.data[s] / 255
          data[plane + d] = padded.data[s + 1] / 255
          data[2 * plane + d] = padded.data[s + 2] / 255
        }
      }
      const res = await session.run({ [input]: new ort.Tensor('float32', data, [1, 3, TILE, TILE]) })
      const o = res[session.outputNames[0]].data as Float32Array
      const big = TILE * 4
      const bigPlane = big * big
      // середина плитки ×4: PAD·4 … (PAD+STEP)·4
      const mid = Buffer.alloc(STEP * 4 * STEP * 4 * 3)
      for (let y = 0; y < STEP * 4; y++) {
        for (let x = 0; x < STEP * 4; x++) {
          const s = (PAD * 4 + y) * big + PAD * 4 + x
          const d = (y * STEP * 4 + x) * 3
          mid[d] = Math.max(0, Math.min(255, Math.round(o[s] * 255)))
          mid[d + 1] = Math.max(0, Math.min(255, Math.round(o[bigPlane + s] * 255)))
          mid[d + 2] = Math.max(0, Math.min(255, Math.round(o[2 * bigPlane + s] * 255)))
        }
      }
      const tileRgb =
        scale === 4
          ? mid
          : await sharp(mid, { raw: { width: STEP * 4, height: STEP * 4, channels: 3 } })
              .resize(centre, centre, { kernel: 'lanczos3' })
              .raw()
              .toBuffer()
      // кладём в результат, обрезая то, что вышло за края картинки
      const ox = tx * centre
      const oy = ty * centre
      const cw = Math.min(centre, outW - ox)
      const ch = Math.min(centre, outH - oy)
      for (let y = 0; y < ch; y++) {
        tileRgb.copy(out, ((oy + y) * outW + ox) * 3, y * centre * 3, (y * centre + cw) * 3)
      }
      report((ty * nx + tx + 1) / (nx * ny))
    }
  }
  return out
}

/** Увеличивает файл-картинку и сохраняет рядом (имя «…-x4»). */
export async function upscaleImage(
  item: FileItem,
  scale: 2 | 4,
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const model = modulePath('upscale')
  if (!model) throw new Error(tm('Нужен модуль «Увеличение фото». Скачайте его кнопкой в приложении'))

  const img = (await openImage(item.path)).rotate()
  const meta = await img.clone().metadata()
  const { data, info } = await img.clone().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const size = outputSize(info.width, info.height, scale)
  if (!size) {
    throw new Error(
      tm('Картинка слишком большая для увеличения в {n} раз (результат не больше {px} млн точек). Уменьшите её или выберите ×2', {
        n: scale,
        px: Math.round(MAX_OUT_PIXELS / 1e6)
      })
    )
  }
  let alpha: Buffer | undefined
  if (meta.hasAlpha) {
    // прозрачность увеличивается обычным способом: нейросеть её не знает
    alpha = await img.clone().ensureAlpha().extractChannel(3).resize(size.width, size.height, { kernel: 'lanczos3' }).raw().toBuffer()
  }

  update({ percent: 1 })
  const up = await upscaleRgb(model, data, info.width, info.height, scale, (f) => update({ percent: Math.min(98, f * 98) }))
  let result: ReturnType<typeof sharp>
  if (alpha) {
    const rgba = Buffer.alloc(size.width * size.height * 4)
    for (let i = 0; i < size.width * size.height; i++) {
      rgba[i * 4] = up[i * 3]
      rgba[i * 4 + 1] = up[i * 3 + 1]
      rgba[i * 4 + 2] = up[i * 3 + 2]
      rgba[i * 4 + 3] = alpha[i]
    }
    result = sharp(rgba, { raw: { width: size.width, height: size.height, channels: 4 } })
  } else {
    result = sharp(up, { raw: { width: size.width, height: size.height, channels: 3 } })
  }

  const ext = extname(item.path).slice(1).toLowerCase()
  const format = ext === 'jpg' || ext === 'jpeg' ? 'jpg' : ext === 'webp' ? 'webp' : 'png'
  const dir = options.outputDir ?? dirname(item.path)
  await fs.mkdir(dir, { recursive: true })
  const outputPath = await freePath(dir, `${basename(item.path, extname(item.path))}-x${scale}`, format)
  await encodeAs(result, format, Math.max(options.quality, 90), options.keepMetadata ?? false).toFile(outputPath)
  update({ percent: 100 })
  return {
    outputPath,
    outputSize: (await fs.stat(outputPath)).size,
    info: tm('{a} → {b} (нейросеть)', { a: `${info.width}×${info.height}`, b: `${size.width}×${size.height}` })
  }
}
