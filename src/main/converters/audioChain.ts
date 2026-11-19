import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { AUDIO_TARGETS } from '@shared/types'
import type { FileItem } from '@shared/types'
import { AUDIO_TAG_KEYS } from '@shared/chains'
import type { AudioBranch } from '@shared/chains'
import { freePath } from '../files'
import { run } from '../ffmpeg'
import { tm } from '../tm'
import type { JobResult } from '../queue'
import { audioCodecArgs } from './media'
import { parseLoudnorm } from './montage'

/** Звуковая ветка цепочки: тишина по краям, громкость по стандарту, формат и битрейт, теги. */

/** Убирает тишину в начале, затем разворачивает звук и делает то же с концом. */
const SILENCE =
  'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1,areverse'

const n1 = (n: number): string => String(Math.round(n * 10) / 10)
const fmt = (v: string | number): string => {
  const x = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(x) ? x.toFixed(1).replace('-', '−') : String(v)
}

/** Конвертирует один звуковой файл по настройкам ветки. `name` — имя результата без расширения. */
export async function runAudioBranch(
  item: FileItem,
  branch: AudioBranch,
  name: string,
  outputDir: string | undefined,
  onPercent: (percent: number) => void
): Promise<JobResult> {
  const dir = outputDir ?? dirname(item.path)
  await fs.mkdir(dir, { recursive: true })
  const outputPath = await freePath(dir, name, branch.format)
  const duration = item.duration ?? 0
  const lossy = AUDIO_TARGETS.find((a) => a.id === branch.format)?.lossy ?? false
  const notes: string[] = []

  const chain = (extra?: string): string => [branch.trimSilence ? SILENCE : '', extra ?? ''].filter(Boolean).join(',')
  const input = ['-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1', '-y', '-i', item.path]
  const progress = (offset: number, span: number) => (line: string): void => {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
    if (m && duration > 0) onPercent(Math.min(99, offset + Math.min(1, Number(m[1]) / 1e6 / duration) * span))
  }

  try {
    let measured: ReturnType<typeof parseLoudnorm>
    const target = branch.loudness.target
    if (branch.loudness.mode === 'loudnorm') {
      const r = await run(
        [...input, '-map', '0:a:0', '-af', chain(`loudnorm=I=${n1(target)}:TP=-1.5:LRA=11:print_format=json`), '-f', 'null', '-'],
        progress(0, 40)
      )
      measured = parseLoudnorm(r.stderr)
      if (!measured) throw new Error(tm('Не удалось измерить громкость'))
    }

    const norm = measured
      ? `loudnorm=I=${n1(target)}:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=json`
      : ''
    const af = chain(norm)
    const args = [...input, '-map', '0:a:0', '-vn', '-sn', '-dn']
    args.push(...(branch.keepTags ? ['-map_metadata', '0'] : ['-map_metadata', '-1', '-map_chapters', '-1']))
    if (af) args.push('-af', af)
    for (const k of AUDIO_TAG_KEYS) {
      const v = branch.tags?.[k]?.replace(/[\u0000-\u001f]/g, ' ').trim()
      if (v) args.push('-metadata', `${k === 'year' ? 'date' : k}=${v}`)
    }
    // loudnorm выдаёт 192 кГц: возвращаем разумную частоту
    if (measured) args.push('-ar', '48000')
    args.push(...audioCodecArgs(branch.format, branch.bitrate), outputPath)
    const r = await run(args, progress(measured ? 40 : 0, measured ? 60 : 100))
    if (r.code !== 0) {
      const last = r.stderr.trim().split('\n').filter(Boolean).pop() ?? ''
      throw new Error(tm('Не удалось конвертировать: {msg}', { msg: last }))
    }
    if (measured) {
      const out = parseLoudnorm(r.stderr)
      notes.push(tm('громкость {a} → {b} LUFS', { a: fmt(measured.input_i), b: fmt(out?.output_i ?? target) }))
    }
    if (branch.trimSilence) notes.push(tm('тишина по краям убрана'))
    if (AUDIO_TAG_KEYS.some((k) => branch.tags?.[k]?.trim())) notes.push(tm('теги записаны'))
    notes.unshift(lossy ? tm('{fmt} {kbps} кбит/с', { fmt: branch.format.toUpperCase(), kbps: branch.bitrate }) : branch.format.toUpperCase())
    onPercent(100)
    return { outputPath, outputSize: (await fs.stat(outputPath)).size, info: notes.join(' · ') }
  } catch (e) {
    await fs.rm(outputPath, { force: true })
    throw e
  }
}
