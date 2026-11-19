import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { FileItem, UniversalOptions } from '@shared/types'
import { parseCues, shiftCues, writeSrt, writeText, writeVtt } from '@shared/subtitles'
import type { Cue } from '@shared/subtitles'
import { freePath } from '../files'
import { run } from '../ffmpeg'
import { tm } from '../tm'
import type { JobResult } from '../queue'
import { decodeText } from './tables'

/**
 * Субтитры: перевод между SRT, VTT, ASS и простым текстом, сдвиг времени, дорожка субтитров из видео.
 * SRT и VTT разбираются и пишутся здесь, ASS читает и пишет FFmpeg (стили ASS при переводе в другие форматы теряются).
 */

export type SubFormat = 'srt' | 'vtt' | 'ass' | 'txt'
export const SUB_FORMATS: SubFormat[] = ['srt', 'vtt', 'ass', 'txt']

const lastLine = (s: string): string => s.trim().split('\n').filter(Boolean).pop() ?? ''

/** Делает из файла любого формата субтитров список реплик. */
async function readCues(path: string, tmp: string): Promise<Cue[]> {
  const ext = extname(path).slice(1).toLowerCase()
  let text = decodeText(await fs.readFile(path))
  if (ext === 'ass' || ext === 'ssa') {
    const src = join(tmp, `in-${randomUUID().slice(0, 6)}.${ext}`)
    const dst = join(tmp, `in-${randomUUID().slice(0, 6)}.srt`)
    await fs.writeFile(src, text, 'utf8')
    const r = await run(['-hide_banner', '-loglevel', 'error', '-y', '-sub_charenc', 'UTF-8', '-i', src, '-c:s', 'srt', dst])
    if (r.code !== 0) throw new Error(tm('Не удалось прочитать субтитры: {msg}', { msg: lastLine(r.stderr) }))
    text = await fs.readFile(dst, 'utf8')
  }
  return parseCues(text)
}

/** Записывает реплики в нужном формате; для ASS зовёт FFmpeg. */
async function writeCues(cues: Cue[], format: SubFormat, out: string, tmp: string): Promise<void> {
  if (format === 'srt') return fs.writeFile(out, writeSrt(cues), 'utf8')
  if (format === 'vtt') return fs.writeFile(out, writeVtt(cues), 'utf8')
  if (format === 'txt') return fs.writeFile(out, writeText(cues), 'utf8')
  const src = join(tmp, `ass-${randomUUID().slice(0, 6)}.srt`)
  await fs.writeFile(src, writeSrt(cues), 'utf8')
  const r = await run(['-hide_banner', '-loglevel', 'error', '-y', '-sub_charenc', 'UTF-8', '-i', src, '-c:s', 'ass', out])
  if (r.code !== 0) throw new Error(tm('Не удалось сохранить: {msg}', { msg: lastLine(r.stderr) }))
}

async function outName(item: FileItem, format: SubFormat, options: UniversalOptions, suffix: string): Promise<string> {
  const dir = options.outputDir ?? dirname(item.path)
  await fs.mkdir(dir, { recursive: true })
  const base = basename(item.path, extname(item.path))
  const same = extname(item.path).slice(1).toLowerCase() === format
  return freePath(dir, same || suffix ? `${base}${suffix || '-sub'}` : base, format)
}

const shiftNote = (s: number): string => (s === 0 ? '' : tm('сдвиг {s} с', { s: `${s > 0 ? '+' : '−'}${Math.abs(Math.round(s * 1000) / 1000)}` }))

/** Файл субтитров в другой формат, со сдвигом времени. */
export async function convertSubtitles(
  item: FileItem,
  format: SubFormat,
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const tmp = join(tmpdir(), `morphio-subs-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(tmp, { recursive: true })
  try {
    update({ percent: 10 })
    let cues = await readCues(item.path, tmp)
    if (cues.length === 0) throw new Error(tm('В файле нет субтитров'))
    const shift = Number.isFinite(options.shift) ? (options.shift as number) : 0
    if (shift !== 0) cues = shiftCues(cues, shift)
    if (cues.length === 0) throw new Error(tm('После сдвига не осталось ни одной реплики'))
    const out = await outName(item, format, options, '')
    await writeCues(cues, format, out, tmp)
    update({ percent: 100 })
    return {
      outputPath: out,
      outputSize: (await fs.stat(out)).size,
      info: [tm('реплик: {n}', { n: cues.length }), shiftNote(shift)].filter(Boolean).join(' · ')
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

/** Достаёт дорожку субтитров из видео (текстовые дорожки; картинки DVD и Blu-ray не читаются). */
export async function extractSubtitles(
  item: FileItem,
  format: SubFormat,
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const tmp = join(tmpdir(), `morphio-subs-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(tmp, { recursive: true })
  try {
    const track = Math.max(0, Math.floor(options.subTrack ?? 0))
    const raw = join(tmp, 'track.srt')
    update({ percent: 10 })
    const r = await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', item.path, '-map', `0:s:${track}`, '-c:s', 'srt', raw])
    if (r.code !== 0 || !(await fs.stat(raw).catch(() => null))) {
      const msg = lastLine(r.stderr)
      if (/matches no streams|does not contain/i.test(msg)) throw new Error(tm('В видео нет такой дорожки субтитров'))
      throw new Error(tm('Не удалось достать субтитры. Дорожка может быть картинкой (DVD, Blu-ray): такие не читаются'))
    }
    let cues = parseCues(await fs.readFile(raw, 'utf8'))
    if (cues.length === 0) throw new Error(tm('В файле нет субтитров'))
    const shift = Number.isFinite(options.shift) ? (options.shift as number) : 0
    if (shift !== 0) cues = shiftCues(cues, shift)
    const out = await outName(item, format, options, track > 0 ? `-${track + 1}` : '')
    await writeCues(cues, format, out, tmp)
    update({ percent: 100 })
    return {
      outputPath: out,
      outputSize: (await fs.stat(out)).size,
      info: [tm('дорожка {n}', { n: track + 1 }), tm('реплик: {n}', { n: cues.length }), shiftNote(shift)].filter(Boolean).join(' · ')
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

/** Читает файл субтитров для редактора: реплики и формат. */
export async function loadCues(path: string): Promise<Cue[]> {
  const tmp = join(tmpdir(), `morphio-subs-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(tmp, { recursive: true })
  try {
    return await readCues(path, tmp)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

/** Сохраняет правки редактора поверх файла (формат определяется по расширению; ASS пересобирается без стилей). */
export async function saveCues(path: string, cues: Cue[]): Promise<void> {
  const ext = extname(path).slice(1).toLowerCase()
  const format: SubFormat = ext === 'vtt' ? 'vtt' : ext === 'ass' || ext === 'ssa' ? 'ass' : ext === 'txt' ? 'txt' : 'srt'
  const tmp = join(tmpdir(), `morphio-subs-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(tmp, { recursive: true })
  try {
    await writeCues(cues, format, path, tmp)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}
