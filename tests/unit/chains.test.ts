import { beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { defaultAudioBranch, defaultChain, defaultVideoBranch, migrateChain, migratePresets } from '../../src/shared/chains'
import type { ChainConfig } from '../../src/shared/chains'
import { runChainItem, videoPlan } from '../../src/main/chains'
import { inspectMedia } from '../../src/main/converters/media'
import { inspectClips } from '../../src/main/converters/montage'
import { probeMedia, run } from '../../src/main/ffmpeg'
import type { FileItem } from '../../src/shared/types'
import { cleanupAfterAll, fileItem, makeImage, tmpDir } from '../helpers'

cleanupAfterAll()

let dir: string
let video: FileItem // 640x360, 6 с, звук
let audioPadded: FileItem // тишина 1,5 с + тон 2 с + тишина 1,5 с
let audioQuiet: FileItem
let audioTagged: FileItem

async function make(path: string, args: string[]): Promise<string> {
  const r = await run(['-hide_banner', '-loglevel', 'error', '-y', ...args, path])
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
  return path
}

beforeAll(async () => {
  dir = await tmpDir('chains')
  const v = await make(join(dir, 'ролик.mp4'), [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'
  ])
  const a = await make(join(dir, 'пауза.wav'), ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'adelay=1500|1500,apad=pad_dur=1.5'])
  const q = await make(join(dir, 'тихо.wav'), ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-af', 'volume=0.03'])
  const t = await make(join(dir, 'трек.mp3'), ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-metadata', 'title=Тестовый трек', '-metadata', 'artist=Morphio', '-c:a', 'libmp3lame'])
  ;[video] = await inspectMedia([v])
  ;[audioPadded] = await inspectMedia([a])
  ;[audioQuiet] = await inspectMedia([q])
  ;[audioTagged] = await inspectMedia([t])
})

const cfg = (extra: Partial<ChainConfig> = {}): ChainConfig => ({ ...defaultChain(), outputDir: join(dir, 'out'), ...extra })
const noop = (): void => {}

describe('схема цепочек и миграция', () => {
  it('по умолчанию все три ветки включены, версия 2', () => {
    const c = defaultChain()
    expect(c.version).toBe(2)
    expect([c.image.enabled, c.video.enabled, c.audio.enabled]).toEqual([true, true, true])
  })

  it('старая цепочка (только картинки) открывается как ветка картинок, видео и звук выключены', () => {
    const old = { removeBg: true, format: 'png', quality: 70, maxSize: 512, nameTemplate: '{name}-s', fill: 'transparent' }
    const m = migrateChain(old)
    expect(m.version).toBe(2)
    expect(m.image).toMatchObject({ enabled: true, removeBg: true, format: 'png', quality: 70, maxSize: 512, nameTemplate: '{name}-s' })
    expect(m.video.enabled).toBe(false)
    expect(m.audio.enabled).toBe(false)
  })

  it('новая цепочка достраивается значениями по умолчанию', () => {
    const m = migrateChain({ version: 2, video: { targetMB: 30, enabled: true }, audio: { format: 'flac' } })
    expect(m.video.targetMB).toBe(30)
    expect(m.video.target).toBe('mp4')
    expect(m.audio.format).toBe('flac')
    expect(m.audio.bitrate).toBe(192)
    expect(m.image.format).toBe('webp')
  })

  it('мусор вместо цепочки даёт цепочку по умолчанию', () => {
    expect(migrateChain(null)).toEqual(defaultChain())
    expect(migrateChain('x')).toEqual(defaultChain())
    expect(migrateChain([1])).toEqual(defaultChain())
  })

  it('список пользовательских цепочек: старые мигрируют, испорченные отбрасываются', () => {
    const list = migratePresets([
      { id: 'u1', name: 'Старая', config: { format: 'jpg', removeBg: false } },
      { id: 'u2', name: 'Новая', config: { version: 2, audio: { format: 'opus' } } },
      { name: 'без id' },
      'мусор',
      null
    ])
    expect(list.map((p) => p.id)).toEqual(['u1', 'u2'])
    expect(list[0].config.image.format).toBe('jpg')
    expect(list[0].config.video.enabled).toBe(false)
    expect(list[1].config.audio.format).toBe('opus')
    expect(migratePresets('x')).toEqual([])
  })
})

describe('видео-ветка', () => {
  it('план: срез краёв превращается в отрезок', async () => {
    const [clip] = await inspectClips([video.path])
    const plan = videoPlan(clip, { ...defaultVideoBranch(), trimStart: 1, trimEnd: 2 }, 'имя', undefined, false)
    expect(plan.clips[0].start).toBe(1)
    expect(plan.clips[0].end).toBeCloseTo(clip.duration - 2, 3)
    expect(plan.outputName).toBe('имя')
  })

  it('ролик короче срезаемых краёв: понятная ошибка', async () => {
    const [clip] = await inspectClips([video.path])
    expect(() => videoPlan(clip, { ...defaultVideoBranch(), trimStart: 4, trimEnd: 3 }, 'x', undefined, false)).toThrow()
  })

  it('обрезка краёв, поворот и шаблон имени', async () => {
    const config = cfg({ video: { ...defaultVideoBranch(), trimStart: 1, trimEnd: 2, rotate: 90, nameTemplate: '{n}-{name}' } })
    const r = await runChainItem(video, 4, config, { gpu: null, modelPath: undefined }, noop)
    expect(r.outputPath.endsWith('005-ролик.mp4')).toBe(true)
    const p = await probeMedia(r.outputPath)
    expect(p.duration).toBeGreaterThan(2.7)
    expect(p.duration).toBeLessThan(3.4)
    expect([p.width, p.height]).toEqual([360, 640])
  })

  it('«для сторис»: 9:16 с обрезкой кадра и лимитом размера', async () => {
    const config = cfg({
      video: { ...defaultVideoBranch(), fit: { aspect: '9:16', mode: 'crop' }, targetMB: 0.5, nameTemplate: '{name}-story' }
    })
    const r = await runChainItem(video, 0, config, { gpu: null, modelPath: undefined }, noop)
    const p = await probeMedia(r.outputPath)
    expect(p.width! / p.height!).toBeGreaterThan(0.55)
    expect(p.width! / p.height!).toBeLessThan(0.575)
    expect(r.outputSize).toBeLessThanOrEqual(0.5 * 1024 * 1024 * 1.1)
  })

  it('выключенная ветка и другой вид файла: ошибка, а не молчаливый пропуск', async () => {
    const off = cfg({ video: { ...defaultVideoBranch(), enabled: false } })
    await expect(runChainItem(video, 0, off, { gpu: null, modelPath: undefined }, noop)).rejects.toThrow()
    const txt = join(dir, 'a.txt')
    await fs.writeFile(txt, 'x')
    await expect(runChainItem(await fileItem(txt), 0, cfg(), { gpu: null, modelPath: undefined }, noop)).rejects.toThrow()
  })
})

describe('звуковая ветка', () => {
  const ctx = { gpu: null, modelPath: undefined }

  it('тишина по краям убирается', async () => {
    const before = await probeMedia(audioPadded.path)
    expect(before.duration).toBeGreaterThan(4.9)
    const config = cfg({ audio: { ...defaultAudioBranch(), format: 'wav', trimSilence: true } })
    const r = await runChainItem(audioPadded, 0, config, ctx, noop)
    const after = await probeMedia(r.outputPath)
    expect(after.duration).toBeGreaterThan(1.6)
    expect(after.duration).toBeLessThan(2.6)
    expect(r.info).toContain('тишина')
  })

  it('нормализация громкости −16 LUFS и формат MP3 128', async () => {
    const config = cfg({ audio: { ...defaultAudioBranch(), format: 'mp3', bitrate: 128, loudness: { mode: 'loudnorm', target: -16 } } })
    const r = await runChainItem(audioQuiet, 0, config, ctx, noop)
    expect(r.outputPath.endsWith('.mp3')).toBe(true)
    expect(r.info).toContain('LUFS')
    expect(r.info).toContain('128')
    const m = await run(['-hide_banner', '-nostats', '-i', r.outputPath, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'])
    const all = [...m.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)]
    const lufs = Number(all[all.length - 1][1])
    expect(lufs).toBeGreaterThan(-18)
    expect(lufs).toBeLessThan(-14)
  })

  it('теги: сохраняются или убираются; FLAC', async () => {
    const keep = await runChainItem(audioTagged, 0, cfg({ audio: { ...defaultAudioBranch(), format: 'flac', keepTags: true } }), ctx, noop)
    const kept = await run(['-hide_banner', '-i', keep.outputPath])
    expect(kept.stderr).toContain('Morphio')
    expect(kept.stderr).toMatch(/title\s+:\s+Тестовый трек/)
    const strip = await runChainItem(audioTagged, 1, cfg({ audio: { ...defaultAudioBranch(), format: 'flac', keepTags: false } }), ctx, noop)
    const stripped = await run(['-hide_banner', '-i', strip.outputPath])
    expect(stripped.stderr).not.toContain('Тестовый трек')
  })
})

describe('картинка в цепочке', () => {
  it('идёт через ветку картинок; выключенная ветка — ошибка', async () => {
    const src = await makeImage(join(dir, 'pic.png'), 800, 600)
    const item = await fileItem(src)
    const ok = await runChainItem(item, 0, cfg({ image: { ...defaultChain().image, format: 'jpg', maxSize: 400, nameTemplate: '{name}-c' } }), { gpu: null, modelPath: undefined }, noop)
    const meta = await sharp(ok.outputPath).metadata()
    expect([meta.format, meta.width]).toEqual(['jpeg', 400])
    await expect(
      runChainItem(item, 0, cfg({ image: { ...defaultChain().image, enabled: false } }), { gpu: null, modelPath: undefined }, noop)
    ).rejects.toThrow()
  })
})
