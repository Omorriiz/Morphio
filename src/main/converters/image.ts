import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import sharp from 'sharp'
import type { ConvertOptions, FileItem, ImageFormat } from '@shared/types'
import { openImage, type SharpImage } from '../imageInput'
import { freePath } from '../files'

const EXT_FOR: Record<ConvertOptions['format'], string> = {
  png: 'png',
  jpg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  tiff: 'tiff',
  gif: 'gif'
}

/**
 * Выбирает кодек и применяет настройки качества.
 * По умолчанию метаданные (GPS, модель камеры, дата съёмки) удаляются — так безопаснее
 * делиться файлами; keepMetadata оставляет их.
 */
export function encodeAs(
  pipeline: SharpImage,
  format: ImageFormat,
  quality: number,
  keepMetadata = false
): SharpImage {
  const q = Math.min(100, Math.max(1, Math.round(quality)))
  if (keepMetadata) pipeline = pipeline.keepMetadata()

  switch (format) {
    case 'jpg':
      // JPG не умеет прозрачность — подложим белый фон.
      return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: q, mozjpeg: true })
    case 'png':
      return pipeline.png({ compressionLevel: 9 })
    case 'webp':
      return pipeline.webp({ quality: q })
    case 'avif':
      return pipeline.avif({ quality: q })
    case 'tiff':
      return pipeline.tiff({ quality: q, compression: 'lzw' })
    case 'gif':
      return pipeline.gif()
  }
}

export async function convertImage(
  item: FileItem,
  options: ConvertOptions
): Promise<{ outputPath: string; outputSize: number }> {
  const dir = options.outputDir ?? dirname(item.path)
  await fs.mkdir(dir, { recursive: true })

  const base = basename(item.path, extname(item.path))
  const ext = EXT_FOR[options.format]
  // Если конвертируем в тот же формат рядом с оригиналом, добавим суффикс.
  const sameFolder = !options.outputDir
  const outBase = sameFolder ? `${base}-converted` : base
  const outputPath = await freePath(dir, outBase, ext)

  let pipeline = (await openImage(item.path, { animated: options.format === 'gif' || options.format === 'webp' }))
    .rotate() // учитываем EXIF-ориентацию

  if (options.maxSize) {
    pipeline = pipeline.resize({
      width: options.maxSize,
      height: options.maxSize,
      fit: 'inside',
      withoutEnlargement: true
    })
  }

  pipeline = encodeAs(pipeline, options.format, options.quality, options.keepMetadata)

  await pipeline.toFile(outputPath)
  const { size } = await fs.stat(outputPath)
  return { outputPath, outputSize: size }
}

export async function makeThumbnail(path: string): Promise<{
  thumbnail?: string
  width?: number
  height?: number
}> {
  try {
    const image = await openImage(path)
    const meta = await image.metadata()
    const buf = await image
      .rotate()
      .resize(160, 160, { fit: 'cover' })
      .webp({ quality: 70 })
      .toBuffer()
    return {
      thumbnail: `data:image/webp;base64,${buf.toString('base64')}`,
      width: meta.width,
      height: meta.height
    }
  } catch {
    return {}
  }
}
