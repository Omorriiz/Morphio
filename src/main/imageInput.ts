import { promises as fs } from 'node:fs'
import { extname } from 'node:path'
import sharp from 'sharp'
import decode from 'heic-decode'

/** Форматы, которые sharp не читает сам: декодируем отдельной библиотекой (WASM). */
const HEIC_EXTENSIONS = ['.heic', '.heif']

export function isHeic(path: string): boolean {
  return HEIC_EXTENSIONS.includes(extname(path).toLowerCase())
}

export type SharpImage = ReturnType<typeof sharp>
type SharpOpts = NonNullable<Parameters<typeof sharp>[1]>

/**
 * Открывает изображение для sharp. Обычные форматы читает sharp, HEIC/HEIF (фото с iPhone)
 * сначала раскодируются в сырые пиксели.
 */
export async function openImage(path: string, options?: SharpOpts): Promise<SharpImage> {
  if (isHeic(path)) {
    const buffer = await fs.readFile(path)
    const { width, height, data } = await decode({ buffer })
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 }
    })
  }
  return sharp(path, options)
}
