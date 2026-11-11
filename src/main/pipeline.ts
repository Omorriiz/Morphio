import { promises as fs } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import sharp from 'sharp'
import type { FileItem, PipelineConfig } from '@shared/types'
import { openImage, type SharpImage } from './imageInput'
import { composeCutout, computeCutout } from './converters/background'
import { encodeAs } from './converters/image'
import { freePath } from './files'
import type { JobResult } from './queue'

const EXT: Record<PipelineConfig['format'], string> = {
  png: 'png',
  jpg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  tiff: 'tiff',
  gif: 'gif'
}

/** Подставляет в шаблон имени {name}, {n}, {date}, {format} и убирает запрещённые символы. */
export function resolveName(
  template: string,
  ctx: { name: string; n: number; format: string }
): string {
  const date = new Date().toISOString().slice(0, 10)
  const out = template
    .replaceAll('{name}', ctx.name)
    .replaceAll('{n}', String(ctx.n).padStart(3, '0'))
    .replaceAll('{date}', date)
    .replaceAll('{format}', ctx.format)
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
  return out || ctx.name
}

/** Выполняет всю цепочку для одного файла. */
export async function runPipelineItem(
  item: FileItem,
  index: number,
  config: PipelineConfig,
  modelPath: string | undefined
): Promise<JobResult> {
  let image: SharpImage
  let note = ''

  if (config.removeBg) {
    const cutout = await computeCutout(
      item,
      {
        method: config.bgMethod,
        tolerance: config.bgTolerance,
        everywhere: config.bgEverywhere,
        translucent: config.bgTranslucent,
        bgColor: config.bgColor
      },
      modelPath
    )
    image = composeCutout(
      cutout,
      { mode: config.fill, color: config.fillColor },
      config.format === 'jpg'
    )
    note = cutout.note
  } else {
    image = (
      await openImage(item.path, { animated: config.format === 'gif' || config.format === 'webp' })
    ).rotate()
  }

  if (config.maxSize) {
    image = image.resize({
      width: config.maxSize,
      height: config.maxSize,
      fit: 'inside',
      withoutEnlargement: true
    })
  }

  image = encodeAs(image, config.format, config.quality, config.keepMetadata)

  const dir = config.outputDir ?? dirname(item.path)
  await fs.mkdir(dir, { recursive: true })
  const base = resolveName(config.nameTemplate, {
    name: basename(item.path, extname(item.path)),
    n: index + 1,
    format: config.format
  })
  const outputPath = await freePath(dir, base, EXT[config.format])
  await image.toFile(outputPath)

  const { size } = await fs.stat(outputPath)
  let preview: string | undefined
  try {
    const buf = await sharp(outputPath)
      .resize(160, 160, { fit: 'cover' })
      .webp({ quality: 80, alphaQuality: 100 })
      .toBuffer()
    preview = `data:image/webp;base64,${buf.toString('base64')}`
  } catch {
    /* превью необязательно */
  }
  return { outputPath, outputSize: size, preview, info: note || undefined }
}
