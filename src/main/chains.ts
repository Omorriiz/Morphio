import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { SUBTITLE_EXTENSIONS } from '@shared/subtitles'
import { defaultMontagePlan } from '@shared/types'
import type { FileItem, GpuKind, MontagePlan } from '@shared/types'
import { resolveName } from '@shared/chains'
import type { ChainConfig, VideoBranch } from '@shared/chains'
import { runAudioBranch } from './converters/audioChain'
import { inspectClips, runMontage } from './converters/montage'
import { runPipelineItem } from './pipeline'
import { kindOfExt } from './registry'
import { tm } from './tm'
import type { JobResult } from './queue'

/**
 * Ищет субтитры рядом с роликом: «фильм.srt», «фильм.ru.srt», «фильм.en.ass». Приоритет у файла без языка,
 * затем по алфавиту, чтобы выбор не зависел от порядка в папке.
 */
export async function findSiblingSubtitles(videoPath: string): Promise<string | undefined> {
  const dir = dirname(videoPath)
  const base = basename(videoPath, extname(videoPath)).toLowerCase()
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return undefined
  }
  const found = names
    .filter((n) => {
      const low = n.toLowerCase()
      const ext = extname(low).slice(1)
      if (!SUBTITLE_EXTENSIONS.includes(ext)) return false
      const stem = low.slice(0, -(ext.length + 1))
      return stem === base || stem.startsWith(base + '.')
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  return found[0] ? join(dir, found[0]) : undefined
}

/** Превращает ветку «видео» в план монтажа для одного ролика. */
export function videoPlan(
  clip: MontagePlan['clips'][number],
  b: VideoBranch,
  outputName: string,
  outputDir: string | undefined,
  gpu: boolean,
  subtitlePath?: string
): MontagePlan {
  const start = b.trimStart > 0 ? b.trimStart : undefined
  const end = b.trimEnd > 0 ? clip.duration - b.trimEnd : undefined
  if ((start ?? 0) >= (end ?? clip.duration) - 0.1) {
    throw new Error(tm('Ролик короче, чем срезаемые края ({sec} с)', { sec: Math.round(clip.duration * 10) / 10 }))
  }
  return {
    ...defaultMontagePlan(),
    clips: [{ ...clip, start, end }],
    trimMode: 'accurate',
    rotate: b.rotate,
    fit: b.fit,
    mute: b.mute,
    subtitles: subtitlePath && b.subtitles !== 'off' ? { ...defaultMontagePlan().subtitles, mode: b.subtitles, path: subtitlePath } : defaultMontagePlan().subtitles,
    loudness: b.loudness,
    target: b.target,
    quality: b.quality,
    maxHeight: b.maxHeight,
    targetMB: b.targetMB,
    audioBitrate: b.audioBitrate,
    useGpu: gpu,
    outputDir,
    outputName
  }
}

/** Выполняет цепочку для одного файла: подходящая ветка выбирается по виду файла. */
export async function runChainItem(
  item: FileItem,
  index: number,
  config: ChainConfig,
  ctx: { gpu: GpuKind | null; modelPath: string | undefined },
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const kind = item.kind ?? kindOfExt(item.ext)

  if (kind === 'image') {
    if (!config.image.enabled) throw new Error(tm('В цепочке выключены шаги для картинок'))
    const { enabled: _on, ...image } = config.image
    void _on
    return runPipelineItem(item, index, { ...image, outputDir: config.outputDir }, ctx.modelPath)
  }

  if (kind === 'video') {
    const b = config.video
    if (!b.enabled) throw new Error(tm('В цепочке выключены шаги для видео'))
    const [clip] = await inspectClips([item.path])
    if (!clip) throw new Error(tm('Не удалось прочитать видео. Возможно, файл повреждён или это не видео'))
    const name = resolveName(b.nameTemplate, { name: basename(item.path, extname(item.path)), n: index + 1, format: b.target })
    const sub = b.subtitles !== 'off' ? await findSiblingSubtitles(item.path) : undefined
    const plan = videoPlan(clip, b, name, config.outputDir, ctx.gpu !== null, sub)
    const r = await runMontage(plan, ctx.gpu, (p) => update({ percent: p }))
    if (b.subtitles !== 'off') {
      const note = sub ? tm('субтитры: {name}', { name: basename(sub) }) : tm('субтитры рядом не найдены')
      r.info = [r.info, note].filter(Boolean).join(' · ')
    }
    return r
  }

  if (kind === 'audio') {
    const b = config.audio
    if (!b.enabled) throw new Error(tm('В цепочке выключены шаги для звука'))
    const name = resolveName(b.nameTemplate, { name: basename(item.path, extname(item.path)), n: index + 1, format: b.format })
    return runAudioBranch(item, b, name, config.outputDir, (p) => update({ percent: p }))
  }

  throw new Error(tm('Для этого вида файлов в цепочке нет шагов'))
}
