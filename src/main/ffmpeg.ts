import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import ffmpegStatic from 'ffmpeg-static'
import type {
  GifProgress,
  GpuKind,
  MediaCapabilities,
  VideoExtractOptions,
  VideoExtractResult,
  VideoInfo
} from '@shared/types'
import { inspectFrames, MAX_FRAMES } from './converters/gif'

/** Куда складываем кадры, вынутые из видео. Папка временная и чистится при запуске и выходе. */
const FRAMES_ROOT = join(tmpdir(), 'morphio-frames')

/** FFmpeg нельзя запускать изнутри asar-архива: в собранном приложении он лежит рядом, в .unpacked. */
export function ffmpegBinary(): string {
  if (!ffmpegStatic) throw new Error('FFmpeg не найден в приложении')
  return ffmpegStatic.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

export interface RunResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

const running = new Set<ChildProcess>()
const stopped = new WeakSet<ChildProcess>()

/** Останавливает все запущенные процессы FFmpeg (кнопка «Остановить»). */
export function cancelFfmpeg(): void {
  for (const child of running) {
    stopped.add(child)
    child.kill()
  }
}

export function run(args: string[], onStdoutLine?: (line: string) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary(), args, { windowsHide: true })
    running.add(child)
    const out: Buffer[] = []
    const err: Buffer[] = []
    let pending = ''
    child.stdout.on('data', (d: Buffer) => {
      if (onStdoutLine) {
        pending += d.toString('utf8')
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        lines.forEach(onStdoutLine)
      } else {
        out.push(d)
      }
    })
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => {
      running.delete(child)
      reject(e)
    })
    child.on('close', (code) => {
      running.delete(child)
      if (stopped.has(child)) return reject(new Error('Остановлено'))
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/** Читает сведения о видео из вывода `ffmpeg -i` (отдельного ffprobe в пакете нет). */
export async function videoInfo(path: string): Promise<VideoInfo> {
  const { stderr } = await run(['-hide_banner', '-i', path])

  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const size = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr)
  if (!size) throw new Error('Не удалось прочитать видео. Возможно, файл повреждён или это не видео')

  let width = Number(size[1])
  let height = Number(size[2])
  // Видео с телефона часто снято «на боку»: размеры меняем местами, как это увидит зритель.
  const rot = /rotat(?:e\s*:|ion of)\s*(-?\d+)/i.exec(stderr)
  if (rot && Math.abs(Number(rot[1])) % 180 === 90) [width, height] = [height, width]

  const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(stderr)
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0
  return {
    path,
    name: basename(path),
    duration,
    width,
    height,
    fps: fps ? Number(fps[1]) : 25
  }
}

/** Один кадр видео в нужный момент — для выбора отрезка. Возвращает data URL. */
export async function videoPoster(path: string, time: number, maxSide: number): Promise<string> {
  const { stdout, code } = await run([
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(Math.max(0, time)),
    '-i',
    path,
    '-frames:v',
    '1',
    '-vf',
    `scale=${maxSide}:-2`,
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-q:v',
    '4',
    'pipe:1'
  ])
  if (stdout.length === 0) throw new Error(`Не удалось получить кадр (код ${code})`)
  return `data:image/jpeg;base64,${stdout.toString('base64')}`
}

/** Достаёт кадры выбранного отрезка и возвращает их готовыми для GIF-студии. */
export async function extractVideoFrames(
  options: VideoExtractOptions,
  report: (p: GifProgress) => void
): Promise<VideoExtractResult> {
  const fps = Math.min(60, Math.max(1, options.fps))
  const duration = Math.min(options.duration, MAX_FRAMES / fps)
  if (duration <= 0) throw new Error('Длина отрезка должна быть больше нуля')

  const dir = join(FRAMES_ROOT, randomUUID())
  await fs.mkdir(dir, { recursive: true })

  const filters = [`fps=${fps}`]
  if (options.width) filters.push(`scale=${Math.round(options.width / 2) * 2}:-2:flags=lanczos`)

  const expected = Math.max(1, Math.round(duration * fps))
  const { code, stderr } = await run(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostats',
      '-progress',
      'pipe:1',
      '-ss',
      String(Math.max(0, options.start)),
      '-t',
      String(duration),
      '-i',
      options.path,
      '-vf',
      filters.join(','),
      '-frames:v',
      String(MAX_FRAMES),
      '-start_number',
      '1',
      join(dir, 'f%04d.png')
    ],
    (line) => {
      const m = /^frame=(\d+)/.exec(line)
      if (m) report({ text: 'Вынимаю кадры из видео…', done: Math.min(Number(m[1]), expected), total: expected })
    }
  )
  if (code !== 0) throw new Error(`FFmpeg завершился с ошибкой: ${stderr.trim().split('\n').pop() ?? code}`)

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort()
  if (files.length === 0) throw new Error('В выбранном отрезке нет кадров')

  const frames = await inspectFrames(
    files.map((f) => join(dir, f)),
    (done, total) => report({ text: 'Готовлю превью кадров…', done, total })
  )
  return { frames, delay: Math.round(1000 / fps) }
}

export interface MediaProbe {
  duration: number
  hasVideo: boolean
  hasAudio: boolean
  width?: number
  height?: number
  fps?: number
}

/** Быстрый разбор видео- или аудиофайла из вывода `ffmpeg -i`. */
export async function probeMedia(path: string): Promise<MediaProbe> {
  const { stderr } = await run(['-hide_banner', '-i', path])
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0
  const video = /Stream #[^\n]*Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(stderr)
  // У звуковых файлов с обложкой «видеодорожка» — это картинка; такой файл всё равно звук.
  const attached = /Stream #[^\n]*Video:[^\n]*attached pic/.test(stderr)
  const hasAudio = /Stream #[^\n]*Audio:/.test(stderr)
  let width = video ? Number(video[1]) : undefined
  let height = video ? Number(video[2]) : undefined
  const rot = /rotat(?:e\s*:|ion of)\s*(-?\d+)/i.exec(stderr)
  if (width && height && rot && Math.abs(Number(rot[1])) % 180 === 90) [width, height] = [height, width]
  const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(stderr)
  return {
    duration,
    hasVideo: !!video && !attached,
    hasAudio,
    width,
    height,
    fps: fps ? Number(fps[1]) : undefined
  }
}

let gpuCache: Promise<MediaCapabilities> | null = null

/** Проверяет, какое аппаратное ускорение H.264 реально работает на этом компьютере. */
export function detectGpu(): Promise<MediaCapabilities> {
  if (!gpuCache) {
    gpuCache = (async () => {
      const tryEncoder = async (codec: string): Promise<boolean> => {
        try {
          const { code } = await run([
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=c=black:s=320x240:d=0.2',
            '-c:v',
            codec,
            '-f',
            'null',
            '-'
          ])
          return code === 0
        } catch {
          return false
        }
      }
      const candidates: [GpuKind, string, string][] = [
        ['nvenc', 'h264_nvenc', 'NVIDIA NVENC'],
        ['amf', 'h264_amf', 'AMD AMF'],
        ['qsv', 'h264_qsv', 'Intel Quick Sync']
      ]
      for (const [kind, codec, label] of candidates) {
        if (await tryEncoder(codec)) return { gpu: kind, gpuLabel: label }
      }
      return { gpu: null }
    })()
  }
  return gpuCache
}

/** Удаляет временные кадры (при запуске и выходе из приложения). */
export async function cleanupFrameDirs(): Promise<void> {
  await fs.rm(FRAMES_ROOT, { recursive: true, force: true }).catch(() => {})
}
