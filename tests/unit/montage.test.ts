import { beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { run, probeMedia } from '../../src/main/ffmpeg'
import { atempoChain, canCopy, inspectClips, parseLoudnorm, planDuration, runMontage, filmstrip } from '../../src/main/converters/montage'
import { defaultMontagePlan } from '../../src/shared/types'
import type { MontageClip, MontagePlan } from '../../src/shared/types'
import { cleanupAfterAll, exists, tmpDir } from '../helpers'

cleanupAfterAll()

let dir: string
let main: MontageClip // 640x360, 6 с, со звуком
let second: MontageClip // 320x180, 3 с, со звуком
let silent: MontageClip // 640x360, 2 с, без звука
let quiet: MontageClip // тихий звук для нормализации громкости
let copyA: MontageClip
let copyB: MontageClip

async function make(path: string, args: string[]): Promise<string> {
  const r = await run(['-hide_banner', '-loglevel', 'error', '-y', ...args, path])
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
  return path
}

const video = (size: string, dur: number, extra: string[] = []): string[] => [
  '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24:duration=${dur}`, ...extra
]

beforeAll(async () => {
  dir = await tmpDir('montage')
  const withAudio = (size: string, dur: number, vol = 1): string[] => [
    ...video(size, dur),
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
    '-af', `volume=${vol}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-shortest'
  ]
  const a = await make(join(dir, 'main.mp4'), withAudio('640x360', 6))
  const b = await make(join(dir, 'second.mp4'), withAudio('320x180', 3))
  const s = await make(join(dir, 'silent.mp4'), [...video('640x360', 2), '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
  const q = await make(join(dir, 'quiet.mp4'), withAudio('320x180', 8, 0.03))
  const c1 = await make(join(dir, 'copy1.mp4'), withAudio('640x360', 4))
  const c2 = await make(join(dir, 'copy2.mp4'), withAudio('640x360', 4))
  const clips = await inspectClips([a, b, s, q, c1, c2])
  ;[main, second, silent, quiet, copyA, copyB] = clips
})

const plan = (clips: MontageClip[], extra: Partial<MontagePlan> = {}): MontagePlan => ({
  ...defaultMontagePlan(),
  clips,
  outputDir: join(dir, 'out'),
  useGpu: false,
  ...extra
})

const withRange = (c: MontageClip, start?: number, end?: number): MontageClip => ({ ...c, start, end })

async function info(path: string): Promise<{ duration: number; width?: number; height?: number; hasAudio: boolean; audioTracks: number }> {
  return probeMedia(path)
}

async function loudness(path: string): Promise<number> {
  const r = await run(['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'])
  const all = [...r.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)]
  return Number(all[all.length - 1][1])
}

async function frameAt(path: string, t: number): Promise<Buffer> {
  const r = await run(['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '160x90', 'pipe:1'])
  return r.stdout
}

describe('чтение клипов', () => {
  it('размеры, длительность, звук, кодеки', () => {
    expect(main.width).toBe(640)
    expect(main.duration).toBeGreaterThan(5.5)
    expect(main.hasAudio).toBe(true)
    expect(main.vcodec).toBe('h264')
    expect(main.acodec).toBe('aac')
    expect(main.audioTracks).toBe(1)
    expect(silent.hasAudio).toBe(false)
  })

  it('не видео пропускается', async () => {
    const txt = join(dir, 'a.txt')
    await fs.writeFile(txt, 'hello')
    expect(await inspectClips([txt])).toEqual([])
  })

  it('лента кадров: одна картинка', async () => {
    const strip = await filmstrip(main.path, 8, 48)
    expect(strip.startsWith('data:image/jpeg;base64,')).toBe(true)
  })
})

describe('чистые функции', () => {
  it('atempo: скорости за пределами 0,5–2 складываются из звеньев', () => {
    expect(atempoChain(1.5)).toBe('atempo=1.5')
    expect(atempoChain(4)).toBe('atempo=2,atempo=2')
    expect(atempoChain(0.25)).toBe('atempo=0.5,atempo=0.5')
  })

  it('длительность результата: отрезки и скорость', () => {
    expect(planDuration(plan([withRange(main, 1, 3), withRange(second, 0, 1)]))).toBeCloseTo(3, 1)
    expect(planDuration(plan([withRange(main, 0, 4)], { speed: 2 }))).toBeCloseTo(2, 1)
  })

  it('разбор JSON loudnorm', () => {
    const j = parseLoudnorm('шум\n{\n"input_i" : "-23.5",\n"input_tp" : "-4.0",\n"input_lra" : "1.0",\n"input_thresh" : "-33.5",\n"target_offset" : "0.5"\n}\n')
    expect(j?.input_i).toBe('-23.5')
    expect(parseLoudnorm('нет json')).toBeUndefined()
  })

  it('быстрый режим доступен только без других правок и для h264/aac', () => {
    expect(canCopy(plan([main], { trimMode: 'fast' }))).toBe(true)
    expect(canCopy(plan([main], { trimMode: 'accurate' }))).toBe(false)
    expect(canCopy(plan([main], { trimMode: 'fast', flipH: true }))).toBe(false)
    expect(canCopy(plan([main], { trimMode: 'fast', speed: 2 }))).toBe(false)
    expect(canCopy(plan([main], { trimMode: 'fast', target: 'webm' }))).toBe(false)
    expect(canCopy(plan([main, second], { trimMode: 'fast' }))).toBe(false) // разный размер
    expect(canCopy(plan([copyA, copyB], { trimMode: 'fast' }))).toBe(true)
  })
})

describe('runMontage', () => {
  it('ошибки плана: нет клипов, пустой отрезок, скорость', async () => {
    await expect(runMontage(plan([]), null, () => {})).rejects.toThrow()
    await expect(runMontage(plan([withRange(main, 3, 3)]), null, () => {})).rejects.toThrow()
    await expect(runMontage(plan([main], { speed: 9 }), null, () => {})).rejects.toThrow()
  })

  it('точная обрезка: длина отрезка, звук есть, оригинал цел', async () => {
    const before = await fs.readFile(main.path)
    const r = await runMontage(plan([withRange(main, 1, 3.5)]), null, () => {})
    const i = await info(r.outputPath)
    expect(i.duration).toBeGreaterThan(2.3)
    expect(i.duration).toBeLessThan(2.8)
    expect(i.hasAudio).toBe(true)
    expect(await fs.readFile(main.path)).toEqual(before)
  })

  it('быстрая обрезка без перекодирования', async () => {
    const r = await runMontage(plan([withRange(main, 1, 4)], { trimMode: 'fast' }), null, () => {})
    expect(r.info).toContain('без перекодирования')
    const i = await info(r.outputPath)
    expect(i.duration).toBeGreaterThan(2)
    expect(i.duration).toBeLessThan(4.5)
  })

  it('поворот на 90° меняет размеры местами, отражение не меняет', async () => {
    const r = await runMontage(plan([withRange(main, 0, 1)], { rotate: 90 }), null, () => {})
    const i = await info(r.outputPath)
    expect([i.width, i.height]).toEqual([360, 640])
    const f = await runMontage(plan([withRange(main, 0, 1)], { flipH: true }), null, () => {})
    const fi = await info(f.outputPath)
    expect([fi.width, fi.height]).toEqual([640, 360])
    // отражённый кадр отличается от исходного
    const a = await frameAt(main.path, 0.5)
    const b = await frameAt(f.outputPath, 0.5)
    expect(a.equals(b)).toBe(false)
  })

  it('скорость ×2: вдвое короче, звук на месте', async () => {
    const r = await runMontage(plan([withRange(main, 0, 4)], { speed: 2 }), null, () => {})
    const i = await info(r.outputPath)
    expect(i.duration).toBeGreaterThan(1.7)
    expect(i.duration).toBeLessThan(2.4)
    expect(i.hasAudio).toBe(true)
  })

  it('склейка клипов разного размера: размер первого, длительности складываются, звук есть', async () => {
    const r = await runMontage(plan([withRange(main, 0, 2), withRange(second, 0, 2)]), null, () => {})
    const i = await info(r.outputPath)
    expect([i.width, i.height]).toEqual([640, 360])
    expect(i.duration).toBeGreaterThan(3.7)
    expect(i.duration).toBeLessThan(4.4)
    expect(i.hasAudio).toBe(true)
    expect(r.info).toContain('2')
  })

  it('склейка клипа без звука с клипом со звуком: тишина вместо недостающего звука', async () => {
    const r = await runMontage(plan([withRange(silent, 0, 1.5), withRange(main, 0, 1.5)]), null, () => {})
    const i = await info(r.outputPath)
    expect(i.hasAudio).toBe(true)
    expect(i.duration).toBeGreaterThan(2.7)
    expect(i.duration).toBeLessThan(3.4)
  })

  it('склейка без перекодирования для одинаковых файлов', async () => {
    const r = await runMontage(plan([withRange(copyA, 0, 2), withRange(copyB, 0, 2)], { trimMode: 'fast' }), null, () => {})
    expect(r.info).toContain('без перекодирования')
    const i = await info(r.outputPath)
    expect(i.duration).toBeGreaterThan(3)
    expect(i.duration).toBeLessThan(5)
  })

  it('«без звука»', async () => {
    const r = await runMontage(plan([withRange(main, 0, 1)], { mute: true }), null, () => {})
    expect((await info(r.outputPath)).hasAudio).toBe(false)
  })

  it('нормализация громкости до −16 LUFS: тихий ролик становится громче', async () => {
    const before = await loudness(quiet.path)
    expect(before).toBeLessThan(-30)
    const r = await runMontage(plan([quiet], { loudness: { mode: 'loudnorm', target: -16 } }), null, () => {})
    const after = await loudness(r.outputPath)
    expect(after).toBeGreaterThan(-18)
    expect(after).toBeLessThan(-14)
    expect(r.info).toContain('LUFS')
  })

  it('WebM и MKV', async () => {
    const w = await runMontage(plan([withRange(main, 0, 1)], { target: 'webm' }), null, () => {})
    expect(w.outputPath.endsWith('.webm')).toBe(true)
    expect((await info(w.outputPath)).hasAudio).toBe(true)
    const k = await runMontage(plan([withRange(main, 0, 1)], { target: 'mkv' }), null, () => {})
    expect(await exists(k.outputPath)).toBe(true)
  })

  it('ограничение высоты кадра', async () => {
    const r = await runMontage(plan([withRange(main, 0, 1)], { maxHeight: 180 }), null, () => {})
    const i = await info(r.outputPath)
    expect(i.height).toBe(180)
  })

  it('под соотношение сторон 9:16: обрезка и поля', async () => {
    const crop = await runMontage(plan([withRange(main, 0, 1)], { fit: { aspect: '9:16', mode: 'crop' } }), null, () => {})
    const c = await info(crop.outputPath)
    expect(c.height).toBe(360)
    expect(c.width! / c.height!).toBeGreaterThan(0.55)
    expect(c.width! / c.height!).toBeLessThan(0.575)
    const pad = await runMontage(plan([withRange(main, 0, 1)], { fit: { aspect: '9:16', mode: 'pad' } }), null, () => {})
    const p = await info(pad.outputPath)
    expect(p.width).toBe(640)
    expect(p.width! / p.height!).toBeGreaterThan(0.55)
    expect(p.width! / p.height!).toBeLessThan(0.575)
  })

  it('лимит размера: результат укладывается', async () => {
    const r = await runMontage(plan([main], { targetMB: 0.4 }), null, () => {})
    expect(r.outputSize).toBeLessThanOrEqual(0.4 * 1024 * 1024 * 1.1)
    expect(r.info).toContain('0.4')
  })

  it('своё имя результата', async () => {
    const r = await runMontage(plan([withRange(main, 0, 0.5)], { outputName: 'моё-имя' }), null, () => {})
    expect(r.outputPath.endsWith('моё-имя.mp4')).toBe(true)
  })

  it('имя результата не перезаписывает существующие файлы', async () => {
    const p = plan([withRange(main, 0, 0.5)])
    const a = await runMontage(p, null, () => {})
    const b = await runMontage(p, null, () => {})
    expect(a.outputPath).not.toBe(b.outputPath)
  })

  it('ход работы доходит до 100', async () => {
    const seen: number[] = []
    await runMontage(plan([withRange(main, 0, 1)]), null, (p) => seen.push(p))
    expect(seen.at(-1)).toBe(100)
    expect(Math.max(...seen.slice(0, -1))).toBeLessThan(100)
  })
})

describe('субтитры', () => {
  const srt = '1\n00:00:00,000 --> 00:00:02,000\nПривет, мир! Hello\n\n2\n00:00:02,000 --> 00:00:04,000\nВторая строка\n'

  it('вшитая дорожка: появляется поток субтитров, видео не перекодируется заново лишний раз', async () => {
    const path = join(dir, 'sub.srt')
    await fs.writeFile(path, srt, 'utf8')
    const r = await runMontage(
      plan([withRange(main, 0, 4)], { subtitles: { mode: 'soft', path, shift: 0, fontSize: 24, color: '#ffffff', outline: true } }),
      null,
      () => {}
    )
    const probe = await run(['-hide_banner', '-i', r.outputPath])
    expect(probe.stderr).toMatch(/Subtitle: mov_text/)
  })

  it('вшитая дорожка в быстром режиме', async () => {
    const path = join(dir, 'sub-fast.srt')
    await fs.writeFile(path, srt, 'utf8')
    const r = await runMontage(
      plan([withRange(main, 0, 4)], {
        trimMode: 'fast',
        subtitles: { mode: 'soft', path, shift: 0, fontSize: 24, color: '#ffffff', outline: true }
      }),
      null,
      () => {}
    )
    expect(r.info).toContain('без перекодирования')
    expect((await run(['-hide_banner', '-i', r.outputPath])).stderr).toMatch(/Subtitle: mov_text/)
  })

  it('вжигание: кадр с субтитрами отличается от кадра без них (русский текст в cp1251 тоже читается)', async () => {
    const path = join(dir, 'sub1251.srt')
    await fs.writeFile(path, iconv.encode(srt, 'windows-1251'))
    const plain = await runMontage(plan([withRange(main, 0, 3)]), null, () => {})
    const burned = await runMontage(
      plan([withRange(main, 0, 3)], { subtitles: { mode: 'burn', path, shift: 0, fontSize: 32, color: '#ffff00', outline: true } }),
      null,
      () => {}
    )
    const a = await frameAt(plain.outputPath, 1)
    const b = await frameAt(burned.outputPath, 1)
    expect(a.equals(b)).toBe(false)
  })

  it('сдвиг времени: субтитры, показанные в первую секунду, после сдвига на +2 с в первую секунду не видны', async () => {
    const path = join(dir, 'sub-shift.srt')
    await fs.writeFile(path, '1\n00:00:00,000 --> 00:00:01,500\nSHIFT TEST TEXT\n', 'utf8')
    const style = { fontSize: 40, color: '#ffffff', outline: true }
    const noSub = await runMontage(plan([withRange(main, 0, 3)]), null, () => {})
    const shown = await runMontage(plan([withRange(main, 0, 3)], { subtitles: { mode: 'burn', path, shift: 0, ...style } }), null, () => {})
    const moved = await runMontage(plan([withRange(main, 0, 3)], { subtitles: { mode: 'burn', path, shift: 2, ...style } }), null, () => {})
    const base = await frameAt(noSub.outputPath, 0.7)
    expect((await frameAt(shown.outputPath, 0.7)).equals(base)).toBe(false) // текст виден
    expect((await frameAt(moved.outputPath, 0.7)).equals(base)).toBe(true) // сдвинут на 2 с: пока пусто
  })
})
