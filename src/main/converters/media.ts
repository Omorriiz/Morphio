import { promises as fs } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AUDIO_EXTENSIONS, AUDIO_TARGETS } from '@shared/types'
import type { FileItem, GpuKind, MediaOptions, VideoTarget } from '@shared/types'
import { freePath } from '../files'
import { probeMedia, run, videoPoster } from '../ffmpeg'
import type { JobResult } from '../queue'
import { tm } from '../tm'

const gpuLabel = (k: GpuKind): string =>
  ({ nvenc: tm('видеокарта NVIDIA'), amf: tm('видеокарта AMD'), qsv: tm('графика Intel') })[k]

/** Читает файлы: длительность, размер кадра, наличие звука и кадр-превью для видео. */
export async function inspectMedia(paths: string[]): Promise<FileItem[]> {
  const items: FileItem[] = []
  for (const path of paths) {
    try {
      const ext = extname(path).slice(1).toLowerCase()
      const stat = await fs.stat(path)
      const probe = await probeMedia(path)
      const isAudio = AUDIO_EXTENSIONS.includes(ext) || (!probe.hasVideo && probe.hasAudio)
      if (!isAudio && !probe.hasVideo) continue

      let thumbnail: string | undefined
      if (!isAudio) {
        try {
          thumbnail = await videoPoster(path, Math.min(probe.duration * 0.1, 3), 160)
        } catch {
          /* превью необязательно */
        }
      }
      items.push({
        id: randomUUID(),
        path,
        name: basename(path),
        ext,
        size: stat.size,
        kind: isAudio ? 'audio' : 'video',
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        hasAudio: probe.hasAudio,
        subtitleTracks: probe.subtitleTracks,
        thumbnail
      })
    } catch {
      /* не медиафайл — пропускаем */
    }
  }
  return items
}

const CRF = {
  x264: { high: 19, medium: 23, low: 28 },
  vp9: { high: 28, medium: 33, low: 38 },
  nvenc: { high: 21, medium: 25, low: 30 },
  amf: { high: 20, medium: 24, low: 29 },
  qsv: { high: 20, medium: 24, low: 29 }
} as const

/** Подходящая высота кадра для заданного битрейта: чтобы маленький лимит не давал «кашу». */
export function heightForBitrate(vk: number, srcW: number, srcH: number, fps: number): number | undefined {
  const pixelsPerSec = srcW * srcH * Math.max(fps, 1)
  if ((vk * 1000) / pixelsPerSec >= 0.05) return undefined
  for (const h of [1080, 720, 480, 360, 240]) {
    if (h >= srcH) continue
    const w = (srcW / srcH) * h
    if ((vk * 1000) / (w * h * Math.max(fps, 1)) >= 0.05) return h
  }
  return 240
}

/** Параметры видеокодека. bitrate (кбит/с) задан — целимся в размер, иначе постоянное качество. */
export function videoCodecArgs(
  target: 'mp4' | 'webm' | 'mkv',
  quality: MediaOptions['quality'],
  gpu: GpuKind | null,
  bitrate?: number
): string[] {
  if (target === 'webm') {
    const base = ['-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4']
    return bitrate
      ? [...base, '-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.5)}k`]
      : [...base, '-crf', String(CRF.vp9[quality]), '-b:v', '0']
  }
  const rate = bitrate
    ? ['-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.5)}k`, '-bufsize', `${bitrate * 2}k`]
    : null
  if (gpu === 'nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', ...(rate ?? ['-rc', 'vbr', '-cq', String(CRF.nvenc[quality]), '-b:v', '0'])]
  }
  if (gpu === 'amf') {
    const q = CRF.amf[quality]
    return ['-c:v', 'h264_amf', '-quality', 'quality', ...(rate ?? ['-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q + 2)])]
  }
  if (gpu === 'qsv') {
    return ['-c:v', 'h264_qsv', '-preset', 'medium', ...(rate ?? ['-global_quality', String(CRF.qsv[quality])])]
  }
  return ['-c:v', 'libx264', '-preset', 'medium', ...(rate ?? ['-crf', String(CRF.x264[quality])])]
}

export function audioCodecArgs(target: MediaOptions['target'], kbps: number): string[] {
  switch (target) {
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`]
    case 'm4a':
      return ['-c:a', 'aac', '-b:a', `${kbps}k`, '-movflags', '+faststart']
    case 'wav':
      return ['-c:a', 'pcm_s16le']
    case 'flac':
      return ['-c:a', 'flac']
    case 'ogg':
      return ['-c:a', 'libvorbis', '-b:a', `${kbps}k`]
    case 'opus':
      return ['-c:a', 'libopus', '-b:a', `${kbps}k`]
    case 'webm':
      return ['-c:a', 'libopus', '-b:a', `${kbps}k`]
    default:
      return ['-c:a', 'aac', '-b:a', `${kbps}k`]
  }
}

/** Конвертирует один файл. */
export async function convertMedia(
  item: FileItem,
  options: MediaOptions,
  gpuKind: GpuKind | null,
  onPercent: (percent: number) => void
): Promise<JobResult> {
  const target = options.target
  const audioOnly = AUDIO_TARGETS.some((a) => a.id === target)

  if (!audioOnly && item.kind === 'audio') throw new Error(tm('Из звукового файла нельзя сделать видео'))
  if (audioOnly && item.hasAudio === false) throw new Error(tm('В этом видео нет звука'))

  const dir = options.outputDir ?? dirname(item.path)
  await fs.mkdir(dir, { recursive: true })
  const base = basename(item.path, extname(item.path))
  const outputPath = await freePath(dir, options.outputDir ? base : `${base}-converted`, target)
  const duration = item.duration ?? 0
  const gpu = options.useGpu && target !== 'webm' ? gpuKind : null

  const encode = async (codecArgs: string[], filters: string[]): Promise<void> => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-i', item.path]
    if (audioOnly) {
      args.push('-map', '0:a:0', '-vn')
    } else {
      args.push('-map', '0:v:0')
      if (!options.mute) args.push('-map', '0:a:0?')
      else args.push('-an')
      args.push('-sn', '-dn')
    }
    if (options.stripMetadata) args.push('-map_metadata', '-1', '-map_chapters', '-1')
    if (filters.length > 0) args.push('-vf', filters.join(','))
    args.push(...codecArgs)
    if (!audioOnly) args.push('-pix_fmt', 'yuv420p')
    if (target === 'mp4') args.push('-movflags', '+faststart')
    args.push(outputPath)

    const { code, stderr } = await run(args, (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
      if (m && duration > 0) onPercent(Math.min(99, (Number(m[1]) / 1e6 / duration) * 100))
    })
    if (code !== 0) {
      const last = stderr.trim().split('\n').filter(Boolean).pop() ?? tm('код {code}', { code: code ?? -1 })
      throw new Error(tm('Не удалось конвертировать: {msg}', { msg: last }))
    }
  }

  try {
    let note: string

    if (audioOnly) {
      const lossy = AUDIO_TARGETS.find((a) => a.id === target)?.lossy
      await encode([...audioCodecArgs(target, options.audioBitrate)], [])
      note = lossy ? tm('{fmt} {kbps} кбит/с', { fmt: target.toUpperCase(), kbps: options.audioBitrate }) : target.toUpperCase()
    } else {
      // «720p» — это короткая сторона кадра: у вертикального видео ограничиваем ширину.
      const portrait = !!item.width && !!item.height && item.width < item.height
      const heightFilter = (h?: number): string[] =>
        h ? [portrait ? `scale='min(${h},iw)':-2` : `scale=-2:'min(${h},ih)'`] : []
      const audioArgs = options.mute ? [] : audioCodecArgs(target === 'webm' ? 'webm' : 'm4a', options.audioBitrate)
      const label = target === 'webm' ? 'VP9' : 'H.264'
      const hw = gpu ? ` · ${gpuLabel(gpu)}` : ''

      if (options.targetMB && duration > 0) {
        // Целимся в размер: считаем битрейт видео из лимита и длительности, при промахе повторяем.
        const targetBytes = options.targetMB * 1024 * 1024
        const audioKbps = options.mute ? 0 : options.audioBitrate
        let vk = Math.max(
          60,
          Math.floor((targetBytes * 8 * 0.95) / duration / 1000 - audioKbps)
        )
        const height = options.maxHeight ??
          (item.width && item.height
            ? heightForBitrate(vk, Math.max(item.width, item.height), Math.min(item.width, item.height), 30)
            : undefined)
        let attempts = 0
        for (;;) {
          attempts++
          await encode([...videoCodecArgs(target as VideoTarget, options.quality, gpu, vk), ...audioArgs], heightFilter(height))
          const { size } = await fs.stat(outputPath)
          if (size <= targetBytes || attempts >= 3 || vk <= 40) break
          vk = Math.max(40, Math.floor(vk * ((targetBytes * 0.94) / size)))
        }
        note = `${label}${hw} · ${tm('под {mb} МБ', { mb: options.targetMB })}${height ? `, ${height}p` : ''}`
      } else {
        await encode(
          [...videoCodecArgs(target as VideoTarget, options.quality, gpu), ...audioArgs],
          heightFilter(options.maxHeight)
        )
        note = `${label}${hw}${options.maxHeight ? ` · ${options.maxHeight}p` : ''}`
      }
    }

    const { size } = await fs.stat(outputPath)
    onPercent(100)
    return { outputPath, outputSize: size, info: note }
  } catch (e) {
    await fs.rm(outputPath, { force: true }) // не оставляем недоделанный файл
    throw e
  }
}
