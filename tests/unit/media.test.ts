import { beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { cancelFfmpeg, detectGpu, ffmpegBinary, probeMedia, run, videoInfo, videoPoster } from '../../src/main/ffmpeg'
import { convertMedia, inspectMedia } from '../../src/main/converters/media'
import type { FileItem, MediaOptions } from '../../src/shared/types'
import { cleanupAfterAll, exists, tmpDir } from '../helpers'

cleanupAfterAll()

let dir: string
let video: string
let audio: string
let silent: string
let portrait: string

async function make(path: string, args: string[]): Promise<string> {
  const r = await run(['-hide_banner', '-loglevel', 'error', '-y', ...args, path])
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
  return path
}

beforeAll(async () => {
  dir = await tmpDir('media')
  video = await make(join(dir, 'ролик.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'])
  audio = await make(join(dir, 'мелодия.wav'), ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=4'])
  silent = await make(join(dir, 'без-звука.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
  portrait = await make(join(dir, 'вертикальное.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
})

const base = (target: MediaOptions['target'], out: string, extra: Partial<MediaOptions> = {}): MediaOptions => ({
  target,
  quality: 'medium',
  audioBitrate: 128,
  mute: false,
  stripMetadata: true,
  useGpu: false,
  outputDir: out,
  ...extra
})

async function item(path: string): Promise<FileItem> {
  const [it] = await inspectMedia([path])
  return it
}

describe('ffmpeg: сведения о файлах', () => {
  it('videoInfo и probeMedia', async () => {
    const v = await videoInfo(video)
    expect(v).toMatchObject({ width: 640, height: 360 })
    expect(v.duration).toBeCloseTo(3, 0)
    expect(v.fps).toBeCloseTo(24, 0)
    const p = await probeMedia(audio)
    expect(p).toMatchObject({ hasVideo: false, hasAudio: true })
    expect(p.duration).toBeCloseTo(4, 0)
  })

  it('кадр-превью — data URL', async () => {
    const url = await videoPoster(video, 1, 200)
    expect(url.startsWith('data:image/')).toBe(true)
  })

  it('не видео — понятная ошибка', async () => {
    const f = join(dir, 'не-видео.mp4')
    await fs.writeFile(f, 'text')
    await expect(videoInfo(f)).rejects.toThrow()
  })

  it('detectGpu возвращает корректный ответ (с ускорением или без)', async () => {
    const caps = await detectGpu()
    expect(caps.gpu === null || ['nvenc', 'amf', 'qsv'].includes(caps.gpu)).toBe(true)
  })

  it('ffmpegBinary существует', async () => {
    expect(await exists(ffmpegBinary())).toBe(true)
  })
})

describe('inspectMedia', () => {
  it('видео: длительность, размер кадра, звук, превью', async () => {
    const it = await item(video)
    expect(it).toMatchObject({ kind: 'video', width: 640, height: 360, hasAudio: true })
    expect(it.duration).toBeCloseTo(3, 0)
    expect(it.thumbnail).toBeTruthy()
  })

  it('звук: вид audio, без превью', async () => {
    const it = await item(audio)
    expect(it.kind).toBe('audio')
    expect(it.thumbnail).toBeUndefined()
  })

  it('видео без звука', async () => {
    expect((await item(silent)).hasAudio).toBe(false)
  })

  it('не медиафайл пропускается', async () => {
    const f = join(dir, 'a.txt')
    await fs.writeFile(f, 'x')
    expect(await inspectMedia([f])).toEqual([])
  })
})

describe('convertMedia: видео', () => {
  it('MP4 (H.264): файл открывается, длительность та же', async () => {
    const out = join(dir, 'o1')
    let last = 0
    const r = await convertMedia(await item(video), base('mp4', out), null, (p) => (last = p))
    expect(r.outputPath.endsWith('.mp4')).toBe(true)
    expect(last).toBe(100)
    const p = await probeMedia(r.outputPath)
    expect(p).toMatchObject({ hasVideo: true, hasAudio: true, width: 640, height: 360 })
    expect(p.duration).toBeCloseTo(3, 0)
  })

  it('WebM (VP9)', async () => {
    const r = await convertMedia(await item(video), base('webm', join(dir, 'o2'), { quality: 'low' }), null, () => {})
    expect(r.outputPath.endsWith('.webm')).toBe(true)
    expect((await probeMedia(r.outputPath)).hasVideo).toBe(true)
  })

  it('ограничение высоты: 180p', async () => {
    const r = await convertMedia(await item(video), base('mp4', join(dir, 'o3'), { maxHeight: 180 }), null, () => {})
    expect((await probeMedia(r.outputPath)).height).toBe(180)
  })

  it('вертикальное видео: «240p» ограничивает короткую сторону, а не высоту', async () => {
    const r = await convertMedia(await item(portrait), base('mp4', join(dir, 'o4'), { maxHeight: 240 }), null, () => {})
    const p = await probeMedia(r.outputPath)
    expect(p.width).toBe(240)
    expect(p.height!).toBeGreaterThan(p.width!)
  })

  it('«без звука»: дорожка убирается', async () => {
    const r = await convertMedia(await item(video), base('mp4', join(dir, 'o5'), { mute: true }), null, () => {})
    expect((await probeMedia(r.outputPath)).hasAudio).toBe(false)
  })

  it('лимит размера: результат укладывается или повторяется до трёх раз', async () => {
    const r = await convertMedia(await item(video), base('mp4', join(dir, 'o6'), { targetMB: 0.05 }), null, () => {})
    expect(r.info).toContain('0.05')
    expect(r.outputSize).toBeLessThan(400 * 1024)
  })

  it('результат не перезаписывает существующий; рядом с оригиналом — суффикс «-converted»', async () => {
    const copy = join(dir, 'копия.mp4')
    await fs.copyFile(silent, copy)
    const it = await item(copy)
    const a = await convertMedia(it, { ...base('mp4', ''), outputDir: undefined }, null, () => {})
    const b = await convertMedia(it, { ...base('mp4', ''), outputDir: undefined }, null, () => {})
    expect(a.outputPath).toBe(join(dir, 'копия-converted.mp4'))
    expect(b.outputPath).not.toBe(a.outputPath)
  })
})

describe('convertMedia: звук', () => {
  it('звук из видео в MP3', async () => {
    const r = await convertMedia(await item(video), base('mp3', join(dir, 'a1'), { audioBitrate: 192 }), null, () => {})
    const p = await probeMedia(r.outputPath)
    expect(p).toMatchObject({ hasVideo: false, hasAudio: true })
    expect(r.info).toContain('192')
  })

  it.each(['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'] as const)('WAV → %s', async (target) => {
    const r = await convertMedia(await item(audio), base(target, join(dir, `a-${target}`)), null, () => {})
    expect(r.outputPath.endsWith(`.${target}`)).toBe(true)
    expect((await probeMedia(r.outputPath)).hasAudio).toBe(true)
  })
})

describe('convertMedia: ошибки', () => {
  it('видео из звукового файла сделать нельзя', async () => {
    await expect(convertMedia(await item(audio), base('mp4', join(dir, 'e1')), null, () => {})).rejects.toThrow()
  })

  it('звук из видео без звука сделать нельзя', async () => {
    await expect(convertMedia(await item(silent), base('mp3', join(dir, 'e2')), null, () => {})).rejects.toThrow()
  })

  it('битый файл — ошибка и ни одного файла-обломка', async () => {
    const f = join(dir, 'битый.mp4')
    await fs.writeFile(f, 'это не видео')
    const out = join(dir, 'e3')
    const fake: FileItem = { id: 'x', path: f, name: 'битый.mp4', ext: 'mp4', size: 12, kind: 'video', duration: 3, hasAudio: true }
    await expect(convertMedia(fake, base('mp4', out), null, () => {})).rejects.toThrow()
    expect((await fs.readdir(out).catch(() => [])).length).toBe(0)
  })

  it('отмена останавливает кодирование и удаляет недоделанный файл', async () => {
    const long = await make(join(dir, 'длинное.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'])
    const out = join(dir, 'e4')
    const it = await item(long)
    const job = convertMedia(it, base('mp4', out, { quality: 'high' }), null, () => {})
    setTimeout(() => cancelFfmpeg(), 800)
    await expect(job).rejects.toThrow()
    expect((await fs.readdir(out).catch(() => [])).length).toBe(0)
  })
})
