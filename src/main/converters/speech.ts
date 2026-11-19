import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { cpus, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { FileItem, UniversalOptions } from '@shared/types'
import { freePath } from '../files'
import { run } from '../ffmpeg'
import { moduleReady, modulePath } from '../modules'
import { tm } from '../tm'
import type { JobResult } from '../queue'

/**
 * Речь в текст: программа whisper.cpp (модуль) и модель Whisper (tiny, base или small). Звук сначала переводится
 * FFmpeg в моно WAV 16 кГц, затем whisper пишет субтитры SRT, VTT или обычный текст. Всё работает офлайн, на процессоре.
 */

export const SPEECH_MODELS = ['tiny', 'base', 'small'] as const
export type SpeechModel = (typeof SPEECH_MODELS)[number]

/** Языки, которые можно задать явно; остальное определяется само (auto). */
export const SPEECH_LANGS = ['auto', 'ru', 'en', 'de', 'fr', 'es', 'it', 'pt', 'uk', 'pl', 'tr', 'zh', 'ja']

export const speechModule = (model: string): string => `whisper-${model}`

/** Установлена ли программа и хотя бы одна модель. */
export function speechReady(): boolean {
  return moduleReady('whisper') && SPEECH_MODELS.some((m) => moduleReady(speechModule(m)))
}

let child: ChildProcess | null = null
let stopped = false
/** Кнопка «Остановить». */
export function cancelSpeech(): void {
  stopped = true
  child?.kill()
}

/** Разбирает процент из строки «progress =  42%». */
export function parseProgress(line: string): number | undefined {
  const m = /progress\s*=\s*(\d+)%/.exec(line)
  return m ? Number(m[1]) : undefined
}

/** Превращает аудио или видео в субтитры (srt, vtt) или текст (txt). */
export async function transcribe(
  item: FileItem,
  format: 'srt' | 'vtt' | 'txt',
  options: UniversalOptions,
  update: (patch: { percent: number }) => void
): Promise<JobResult> {
  const wanted = (SPEECH_MODELS as readonly string[]).includes(options.aiModel ?? '') ? (options.aiModel as SpeechModel) : undefined
  // Модель не задана (быстрое окно, следящие папки): обычная, иначе точная, иначе быстрая
  const model: SpeechModel = wanted ?? (['base', 'small', 'tiny'] as const).find((m) => moduleReady(speechModule(m))) ?? 'base'
  const exe = modulePath('whisper')
  if (!exe) throw new Error(tm('Нужна программа распознавания речи. Скачайте модуль «Речь в текст» в приложении'))
  const modelFile = modulePath(speechModule(model))
  if (!modelFile) throw new Error(tm('Нужна модель речи «{m}». Скачайте её в приложении', { m: model }))
  const lang = SPEECH_LANGS.includes(options.lang ?? '') ? options.lang! : 'auto'

  const tmp = join(tmpdir(), `morphio-speech-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(tmp, { recursive: true })
  stopped = false
  try {
    const wav = join(tmp, 'audio.wav')
    const conv = await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', item.path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav])
    if (conv.code !== 0 || !(await fs.stat(wav).catch(() => null))?.size) {
      throw new Error(tm('В этом файле нет звука или он не читается'))
    }
    update({ percent: 3 })

    const base = join(tmp, 'out')
    const args = ['-m', modelFile, '-f', wav, '-l', lang, '-of', base, `-o${format}`, '--print-progress', '-t', String(Math.max(1, Math.min(8, cpus().length)))]
    let detected = ''
    let tail = ''
    const code = await new Promise<number | null>((resolve, reject) => {
      const c = spawn(exe, args, { cwd: dirname(exe), windowsHide: true })
      child = c
      const onData = (d: Buffer): void => {
        const text = d.toString('utf8')
        tail = (tail + text).slice(-1500)
        for (const line of text.split(/\r?\n/)) {
          const p = parseProgress(line)
          if (p !== undefined) update({ percent: 3 + p * 0.96 })
          const l = /auto-detected language:\s*(\w+)/.exec(line)
          if (l) detected = l[1]
        }
      }
      c.stdout.on('data', onData)
      c.stderr.on('data', onData)
      c.on('error', reject)
      c.on('close', (k) => resolve(k))
    })
    child = null
    if (stopped) throw new Error(tm('Остановлено'))
    const produced = `${base}.${format}`
    if (code !== 0 || !(await fs.stat(produced).catch(() => null))) {
      throw new Error(tm('Не удалось распознать речь: {msg}', { msg: tail.trim().split('\n').pop() ?? String(code) }))
    }
    const dir = options.outputDir ?? dirname(item.path)
    await fs.mkdir(dir, { recursive: true })
    const out = await freePath(dir, basename(item.path, extname(item.path)), format)
    await fs.copyFile(produced, out)
    update({ percent: 100 })
    return {
      outputPath: out,
      outputSize: (await fs.stat(out)).size,
      info: tm('модель {m}, язык {l}', { m: model, l: detected || lang })
    }
  } finally {
    child = null
    await fs.rm(tmp, { recursive: true, force: true })
  }
}
