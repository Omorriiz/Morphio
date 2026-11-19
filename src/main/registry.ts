import { promises as fs } from 'node:fs'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ARCHIVE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  AUDIO_TARGETS,
  DOCUMENT_EXTENSIONS,
  IMAGE_FORMATS,
  INPUT_IMAGE_EXTENSIONS,
  PDF_EXTENSIONS,
  TABLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  VIDEO_TARGETS
} from '@shared/types'
import { SUBTITLE_EXTENSIONS } from '@shared/subtitles'
import type {
  FileItem,
  FileKind,
  GpuKind,
  MediaOptions,
  UniversalOptions,
  UniversalTarget
} from '@shared/types'
import { convertImage, makeThumbnail } from './converters/image'
import { convertMedia, inspectMedia } from './converters/media'
import { convertTable } from './converters/tables'
import { packItem, unpackArchive } from './converters/archives'
import { CALIBRE_FORMATS, calibreBinary, convertDocument, docTargetIds, DOC_FORMATS } from './converters/documents'
import { moduleReady } from './modules'
import { upscaleImage } from './converters/upscale'
import { ocrFile } from './converters/ocr'
import { speechReady, transcribe } from './converters/speech'
import { convertSubtitles, extractSubtitles, SUB_FORMATS } from './converters/subtitles'
import type { SubFormat } from './converters/subtitles'
import { mergeToPdf, pdfToImages, pdfToText, splitPdf } from './converters/pdf'
import type { JobResult } from './queue'
import { tm } from './tm'

/**
 * Реестр форматов: единое место, которое знает, «из чего во что» умеет приложение.
 * Его используют вкладка «Любой файл», а позже окно быстрой конвертации и меню проводника.
 * Каждый движок отвечает на два вопроса: какие варианты предложить для файла и как его выполнить.
 */

export function kindOfExt(ext: string, isDir = false): FileKind {
  if (isDir) return 'folder'
  const e = ext.toLowerCase()
  if (INPUT_IMAGE_EXTENSIONS.includes(e)) return 'image'
  if (VIDEO_EXTENSIONS.includes(e)) return 'video'
  if (AUDIO_EXTENSIONS.includes(e)) return 'audio'
  if (TABLE_EXTENSIONS.includes(e)) return 'table'
  if (ARCHIVE_EXTENSIONS.includes(e)) return 'archive'
  if (PDF_EXTENSIONS.includes(e)) return 'pdf'
  if (SUBTITLE_EXTENSIONS.includes(e)) return 'subtitle'
  if (DOCUMENT_EXTENSIONS.includes(e)) return 'document'
  return 'other'
}

/** Вариант, который работает со всеми файлами сразу и даёт один результат. */
export const MERGE_TARGET = 'pdf:merge'

const TABLE_TARGETS = ['xlsx', 'csv', 'tsv', 'json', 'yaml', 'xml']

const PACK_TARGETS: { id: string; label: string; hint: () => string }[] = [
  { id: 'zip', label: 'ZIP', hint: () => tm('Открывается везде, можно с паролем') },
  { id: '7z', label: '7z', hint: () => tm('Сжимает сильнее ZIP, можно с паролем') },
  { id: 'tar', label: 'TAR', hint: () => tm('Без сжатия, как папка одним файлом') },
  { id: 'targz', label: 'TAR.GZ', hint: () => tm('Привычный формат для Linux и серверов') }
]

/**
 * Варианты для одного файла. «Тот же формат» тоже предлагается: так можно сжать картинку или видео,
 * уменьшить размер, сменить разделитель CSV или пересобрать архив с другим уровнем сжатия.
 */
export function targetsFor(item: FileItem): UniversalTarget[] {
  const kind = item.kind ?? kindOfExt(item.ext)
  const out: UniversalTarget[] = []

  if (kind === 'image') {
    for (const f of IMAGE_FORMATS) {
      out.push({ id: `image:${f.id}`, label: f.label, group: 'image', hint: tm(f.hint) })
    }
  }
  if (kind === 'video') {
    for (const t of VIDEO_TARGETS) {
      out.push({ id: `video:${t.id}`, label: t.label, group: 'video', hint: tm(t.hint) })
    }
  }
  // готовые субтитры в видео важнее распознавания речи: короткое имя «srt» выбирает их
  if (kind === 'video' && (item.subtitleTracks ?? 0) > 0) {
    for (const f of SUB_FORMATS) {
      out.push({ id: `subs:${f}`, label: tm('Достать субтитры: {f}', { f: f === 'txt' ? 'TXT' : f.toUpperCase() }), group: 'subtitle', hint: subsHint(f) })
    }
  }
  if (kind === 'video' || kind === 'audio') {
    const missing = !speechReady()
    for (const [id, label, hint] of [
      ['srt', 'Субтитры SRT', 'Нейросеть слушает речь и пишет субтитры с временем'],
      ['vtt', 'Субтитры VTT', 'То же для сайтов и видеоплееров'],
      ['txt', 'Текст речи', 'Нейросеть записывает сказанное обычным текстом']
    ] as const) {
      out.push({ id: `speech:${id}`, label: tm(label), group: 'ai', hint: tm(hint), needs: 'whisper', missing })
    }
  }
  if (kind === 'video' || kind === 'audio') {
    for (const t of AUDIO_TARGETS) {
      out.push({ id: `audio:${t.id}`, label: t.label, group: 'audio', hint: tm(t.hint) })
    }
  }
  if (kind === 'subtitle') {
    for (const f of SUB_FORMATS) {
      out.push({ id: `subs:${f}`, label: f === 'txt' ? tm('Просто текст') : f.toUpperCase(), group: 'subtitle', hint: subsHint(f) })
    }
  }
  if (kind === 'table') {
    for (const t of TABLE_TARGETS) {
      out.push({ id: `table:${t}`, label: t.toUpperCase(), group: 'table', hint: tableHint(t) })
    }
  }
  if (kind === 'image') {
    const missing = !moduleReady('upscale')
    out.push(
      { id: 'upscale:x2', label: tm('Увеличить ×2'), group: 'ai', hint: tm('Нейросеть: больше деталей и меньше шума'), needs: 'upscale', missing },
      { id: 'upscale:x4', label: tm('Увеличить ×4'), group: 'ai', hint: tm('Нейросеть: для маленьких картинок и старых фото'), needs: 'upscale', missing }
    )
  }
  if (kind === 'image') {
    out.push({ id: 'pdf:each', label: 'PDF', group: 'pdf', hint: tm('Картинка превратится в страницу PDF') })
  }
  if (kind === 'image' || kind === 'pdf') {
    const missing = !moduleReady('tess-rus') && !moduleReady('tess-eng')
    out.push(
      { id: 'ocr:txt', label: tm('Распознать текст'), group: 'ai', hint: tm('Нейросеть читает текст с картинки или скана: русский и английский'), needs: 'tess-rus', missing },
      { id: 'ocr:pdftext', label: tm('PDF с текстом'), group: 'ai', hint: tm('Картинка или скан превращается в PDF, где текст можно искать и копировать'), needs: 'tess-rus', missing }
    )
  }
  if (kind === 'pdf') {
    out.push(
      { id: 'pdf:txt', label: tm('Текст (TXT)'), group: 'pdf', hint: tm('Весь текст документа одним файлом') },
      { id: 'pdf:png', label: tm('Страницы в PNG'), group: 'pdf', hint: tm('Каждая страница картинкой, в папку') },
      { id: 'pdf:jpg', label: tm('Страницы в JPG'), group: 'pdf', hint: tm('Каждая страница лёгкой картинкой, в папку') },
      { id: 'pdf:split', label: tm('Разделить на страницы'), group: 'pdf', hint: tm('Каждая страница в свой PDF, в папку') }
    )
  }
  if (kind === 'document') {
    const pandocMissing = !moduleReady('pandoc')
    const calibreMissing = !calibreBinary()
    for (const d of docTargetIds(item.ext)) {
      const f = [...DOC_FORMATS, ...CALIBRE_FORMATS].find((x) => x.id === d.id)
      if (!f) continue
      out.push({
        id: `doc:${f.id}`,
        label: f.label,
        group: 'document',
        hint: tm(f.hint),
        needs: d.calibre ? 'calibre' : 'pandoc',
        missing: d.calibre ? calibreMissing : pandocMissing
      })
    }
  }
  if (kind === 'archive') {
    out.push({
      id: 'archive:unpack',
      label: tm('Распаковать'),
      group: 'archive',
      hint: tm('В папку с именем архива')
    })
  }
  for (const p of PACK_TARGETS) {
    const label = tm('В {fmt}', { fmt: p.label })
    out.push({ id: `archive:${p.id}`, label, group: 'archive', hint: p.hint() })
  }
  return out
}

function subsHint(f: SubFormat): string {
  switch (f) {
    case 'srt':
      return tm('Самый распространённый формат субтитров')
    case 'vtt':
      return tm('Для сайтов и видеоплееров')
    case 'ass':
      return tm('Формат со стилями; из других форматов стили не появятся')
    default:
      return tm('Только слова, без времени')
  }
}

function tableHint(t: string): string {
  switch (t) {
    case 'xlsx':
      return tm('Книга Excel')
    case 'csv':
      return tm('Текст с разделителями, для Excel и баз данных')
    case 'tsv':
      return tm('Текст с табуляцией')
    case 'json':
      return tm('Для программистов и сайтов')
    case 'yaml':
      return tm('Читаемые файлы настроек')
    default:
      return tm('Разметка XML')
  }
}

/** Варианты, общие для всех выбранных файлов (в том же порядке, что у первого). */
export function getTargets(items: FileItem[]): UniversalTarget[] {
  if (items.length === 0) return []
  const [first, ...rest] = items.map(targetsFor)
  const common = first.filter((t) => rest.every((list) => list.some((x) => x.id === t.id)))
  // Склейка в один PDF: несколько файлов, и все они картинки или PDF
  if (items.length > 1 && items.every((i) => (i.kind ?? kindOfExt(i.ext)) === 'image' || (i.kind ?? kindOfExt(i.ext)) === 'pdf')) {
    const at = common.findIndex((x) => x.group === 'pdf')
    const merge: UniversalTarget = {
      id: MERGE_TARGET,
      label: tm('Склеить в один PDF'),
      group: 'pdf',
      hint: tm('Все файлы в одном документе, в порядке списка')
    }
    common.splice(at < 0 ? common.length : at, 0, merge)
  }
  return common
}

export interface RunContext {
  gpu: GpuKind | null
}

/** Выполняет выбранный вариант для одного файла. */
export async function runUniversal(
  item: FileItem,
  options: UniversalOptions,
  ctx: RunContext,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const known = targetsFor(item).some((t) => t.id === options.target)
  if (!known) throw new Error(tm('Для этого файла такой вариант недоступен'))
  const [engine, format] = options.target.split(':')

  if (engine === 'image') {
    return convertImage(item, {
      format: format as never,
      quality: options.quality,
      maxSize: options.maxSize,
      outputDir: options.outputDir,
      keepMetadata: options.keepMetadata ?? false
    })
  }
  if (engine === 'video' || engine === 'audio') {
    const m = options.media
    const media: MediaOptions = {
      target: format as MediaOptions['target'],
      quality: m?.quality ?? 'medium',
      maxHeight: m?.maxHeight,
      audioBitrate: m?.audioBitrate ?? 192,
      mute: m?.mute ?? false,
      stripMetadata: m?.stripMetadata ?? false,
      useGpu: m?.useGpu ?? ctx.gpu !== null,
      targetMB: engine === 'video' ? m?.targetMB : undefined,
      outputDir: options.outputDir
    }
    return convertMedia(item, media, ctx.gpu, (percent) => update({ percent }))
  }
  if (engine === 'subs') {
    const fmt = format as SubFormat
    return (item.kind ?? kindOfExt(item.ext)) === 'video' ? extractSubtitles(item, fmt, options, update) : convertSubtitles(item, fmt, options, update)
  }
  if (engine === 'doc') return convertDocument(item, format, options, update)
  if (engine === 'speech') return transcribe(item, format as 'srt', options, update)
  if (engine === 'ocr') return ocrFile(item, format === 'pdftext' ? 'pdf' : 'txt', options, update)
  if (engine === 'upscale') return upscaleImage(item, format === 'x2' ? 2 : 4, options, update)
  if (engine === 'pdf') {
    if (format === 'txt') return pdfToText(item, options, update)
    if (format === 'png' || format === 'jpg') return pdfToImages(item, format, options, update)
    if (format === 'split') return splitPdf(item, options, update)
    return mergeToPdf([item], options, update)
  }
  if (engine === 'table') return convertTable(item, options)
  if (format === 'unpack') return unpackArchive(item, options, update)
  return packItem(item, options, update)
}

/** Склейка нескольких файлов в один PDF (один результат на все файлы). */
export function runMerge(
  items: FileItem[],
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  return mergeToPdf(items, options, update)
}

/** Читает файл или папку: вид, размер, для видео и звука длительность, для картинок (по желанию) превью. Папки не разворачиваются. */
export async function describeItem(path: string, withThumbnail = true): Promise<FileItem | null> {
  try {
    const stat = await fs.stat(path)
    const isDir = stat.isDirectory()
    const ext = extname(path).slice(1).toLowerCase()
    const kind = kindOfExt(ext, isDir)
    if (kind === 'video' || kind === 'audio') {
      const [media] = await inspectMedia([path])
      if (media) return media
    }
    let thumb: Partial<FileItem> = {}
    if (kind === 'image' && withThumbnail) {
      try {
        thumb = await makeThumbnail(path)
      } catch {
        /* превью необязательно */
      }
    }
    return { id: randomUUID(), path, name: basename(path), ext, size: isDir ? 0 : stat.size, kind, ...thumb }
  } catch {
    return null // недоступный путь
  }
}

/** Варианты для целого вида файлов (для настройки следящих папок). */
export function targetsForKind(kind: FileKind): UniversalTarget[] {
  return targetsFor({ id: '', path: '', name: '', ext: '', size: 0, kind })
}
