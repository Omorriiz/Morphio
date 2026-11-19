import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { run, probeMedia } from '../../src/main/ffmpeg'
import { canCopy, detectSilence, inspectClips, planDuration, runMontage } from '../../src/main/converters/montage'
import { cutOut, keepRanges, parseSilences, removedSeconds, speechRanges, splitClip } from '../../src/shared/montageEdit'
import { defaultMontagePlan } from '../../src/shared/types'
import type { MontageClip, MontagePlan } from '../../src/shared/types'
import { cleanupAfterAll, tmpDir } from '../helpers'

cleanupAfterAll()

let dir: string
let a: MontageClip // 640x360, 6 с, звук
let b: MontageClip // 640x360, 5 с, звук
let talk: MontageClip // 6 с: звук 0–2, тишина 2–4, звук 4–6

async function make(path: string, args: string[]): Promise<string> {
  const r = await run(['-hide_banner', '-loglevel', 'error', '-y', ...args, path])
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
  return path
}

beforeAll(async () => {
  dir = await tmpDir('montage2')
  const clip = (name: string, dur: number, af = 'anull'): Promise<string> =>
    make(join(dir, name), [
      '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=24:duration=${dur}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
      '-af', af, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '24', '-c:a', 'aac', '-shortest'
    ])
  ;[a, b, talk] = await inspectClips([
    await clip('a.mp4', 6),
    await clip('b.mp4', 5),
    await clip('talk.mp4', 6, "volume=enable='between(t,2,4)':volume=0")
  ])
})

const plan = (clips: MontageClip[], extra: Partial<MontagePlan> = {}): MontagePlan => ({
  ...defaultMontagePlan(),
  clips,
  outputDir: join(dir, 'out'),
  useGpu: false,
  ...extra
})
const withRange = (c: MontageClip, start?: number, end?: number): MontageClip => ({ ...c, start, end })

async function frame(path: string, t = 1): Promise<Buffer> {
  const r = await run(['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '64x36', 'pipe:1'])
  return r.stdout
}
const diff = (x: Buffer, y: Buffer): number => {
  let s = 0
  for (let i = 0; i < Math.min(x.length, y.length); i++) s += Math.abs(x[i] - y[i])
  return s / Math.min(x.length, y.length)
}

describe('отрезки одного ролика: чистые функции', () => {
  it('разрезать', () => {
    const [p, q] = splitClip(a, 2, ['p', 'q'])
    expect([p.start, p.end, q.start, q.end]).toEqual([undefined, 2, 2, undefined])
    expect(splitClip(a, 0.1, ['p', 'q'])).toHaveLength(1)
    expect(splitClip(a, 5.9, ['p', 'q'])).toHaveLength(1)
  })

  it('вырезать середину; края вместо вырезанного пропадают', () => {
    const r = cutOut(a, 2, 4, ['p', 'q'])
    expect(r).toHaveLength(2)
    expect([r[0].end, r[1].start]).toEqual([2, 4])
    expect(cutOut(a, 0, 3, ['p', 'q'])).toHaveLength(1)
    expect(cutOut(a, 0, 3, ['p', 'q'])[0].start).toBe(3)
    expect(cutOut(a, 4, 2, ['p', 'q'])).toHaveLength(2) // границы можно задать наоборот
    expect(cutOut(a, 0, 6, ['p', 'q'])).toHaveLength(0)
  })

  it('вырезать из уже обрезанного клипа', () => {
    const r = cutOut(withRange(a, 1, 5), 2, 3, ['p', 'q'])
    expect([r[0].start, r[0].end, r[1].start, r[1].end]).toEqual([1, 2, 3, 5])
  })

  it('разбор пауз и куски с речью', () => {
    const log = 'silence_start: 2.0\nsilence_end: 4.0 | silence_duration: 2.0\nsilence_start: 5.5'
    const s = parseSilences(log, 6)
    expect(s).toEqual([{ start: 2, end: 4 }, { start: 5.5, end: 6 }])
    const speech = speechRanges(s, 0, 6, { pad: 0.1 })
    expect(speech).toHaveLength(2)
    expect(speech[0].start).toBe(0)
    expect(speech[0].end).toBeCloseTo(2.1)
    expect(speech[1].start).toBeCloseTo(3.9)
    expect(speech[1].end).toBeCloseTo(5.6)
    // близкие куски сливаются, короткие пропадают
    expect(speechRanges([{ start: 1, end: 1.1 }], 0, 3)).toHaveLength(1)
    expect(speechRanges([{ start: 0.2, end: 2.9 }], 0, 3, { minKeep: 0.5 })).toHaveLength(0)
    expect(keepRanges(a, speech, (() => { let n = 0; return () => `k${n++}` })())).toHaveLength(2)
    expect(removedSeconds(a, speech)).toBeGreaterThan(1.5)
  })
})

describe('кадрирование, переходы, быстрый поворот', () => {
  it('кадрирование рамкой: размеры и содержимое', async () => {
    const r = await runMontage(plan([a], { crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } }), null, () => {})
    const p = await probeMedia(r.outputPath)
    expect([p.width, p.height]).toEqual([320, 180])
    // правая верхняя четверть оригинала
    const ref = await run(['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', a.path, '-vf', 'crop=320:180:320:0,scale=64:36', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])
    expect(diff(await frame(r.outputPath), ref.stdout)).toBeLessThan(6)
  })

  it('кадрирование вместе с поворотом: размеры меняются местами', async () => {
    const r = await runMontage(plan([a], { crop: { x: 0, y: 0, w: 0.5, h: 1 }, rotate: 90 }), null, () => {})
    const p = await probeMedia(r.outputPath)
    expect([p.width, p.height]).toEqual([360, 320])
  })

  it('неверная рамка — понятная ошибка', async () => {
    await expect(runMontage(plan([a], { crop: { x: 0.8, y: 0, w: 0.5, h: 1 } }), null, () => {})).rejects.toThrow('Рамка')
    await expect(runMontage(plan([a], { crop: { x: 0, y: 0, w: 0.01, h: 1 } }), null, () => {})).rejects.toThrow('Рамка')
  })

  it('переход между клипами: итог короче на длину перехода, звук и видео на месте', async () => {
    const p = plan([withRange(a, 0, 3), withRange(b, 0, 3)], { transition: { kind: 'fade', duration: 1 } })
    expect(planDuration(p)).toBeCloseTo(5)
    const r = await runMontage(p, null, () => {})
    const info = await probeMedia(r.outputPath)
    expect(info.duration).toBeGreaterThan(4.8)
    expect(info.duration).toBeLessThan(5.3)
    expect(info.hasAudio).toBe(true)
    // в середине перехода кадр отличается и от первого, и от второго клипа
    const mid = await frame(r.outputPath, 2.5)
    const first = await frame(a.path, 2.5)
    const second = await frame(b.path, 0.5)
    expect(diff(mid, first)).toBeGreaterThan(2)
    expect(diff(mid, second)).toBeGreaterThan(2)
  })

  it('три клипа с переходом и разные виды перехода', async () => {
    for (const kind of ['dissolve', 'wipeleft', 'circleopen'] as const) {
      const p = plan([withRange(a, 0, 3), withRange(b, 0, 3), withRange(a, 3, 6)], { transition: { kind, duration: 0.5 } })
      const r = await runMontage(p, null, () => {})
      expect((await probeMedia(r.outputPath)).duration).toBeCloseTo(8, 0)
    }
  })

  it('переход длиннее клипа — понятная ошибка; у одного клипа переход не мешает', async () => {
    await expect(
      runMontage(plan([withRange(a, 0, 1), withRange(b, 0, 3)], { transition: { kind: 'fade', duration: 2 } }), null, () => {})
    ).rejects.toThrow('слишком короткий')
    const single = await runMontage(plan([withRange(a, 0, 2)], { transition: { kind: 'fade', duration: 1 } }), null, () => {})
    expect((await probeMedia(single.outputPath)).duration).toBeCloseTo(2, 0)
  })

  it('быстрый поворот: метка в файле, кадры не пересжимаются, картинка как при настоящем повороте', async () => {
    const p = plan([withRange(a, 0, 3)], { rotate: 90, trimMode: 'fast' })
    expect(canCopy(p)).toBe(true)
    expect(canCopy({ ...p, target: 'mkv' })).toBe(false)
    expect(canCopy({ ...p, clips: [a, b] })).toBe(false)
    const fast = await runMontage(p, null, () => {})
    expect(fast.info).toContain('без перекодирования')
    const pf = await probeMedia(fast.outputPath)
    expect([pf.width, pf.height]).toEqual([360, 640])
    const slow = await runMontage(plan([withRange(a, 0, 3)], { rotate: 90 }), null, () => {})
    expect(diff(await frame(fast.outputPath, 1), await frame(slow.outputPath, 1))).toBeLessThan(8)
  })

  it('быстрый поворот добавляется к уже записанному в файле', async () => {
    const phone = await make(join(dir, 'phone.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
    // записываем метку поворота копированием потока
    const tagged = join(dir, 'tagged.mp4')
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', '90', '-i', phone, '-c', 'copy', tagged])
    const [clip] = await inspectClips([tagged])
    expect(clip.rotation).toBe(90)
    expect([clip.width, clip.height]).toEqual([180, 320])
    const r = await runMontage(plan([clip], { rotate: 90, trimMode: 'fast' }), null, () => {})
    const p = await probeMedia(r.outputPath)
    // было 90° против часовой, добавили 90° по часовой: метка исчезает, кадр снова 320×180
    expect([p.width, p.height]).toEqual([320, 180])
  })
})

describe('поиск тишины', () => {
  it('находит паузу посередине', async () => {
    const s = await detectSilence(talk.path, -35, 0.6)
    expect(s).toHaveLength(1)
    expect(s[0].start).toBeGreaterThan(1.7)
    expect(s[0].start).toBeLessThan(2.3)
    expect(s[0].end).toBeGreaterThan(3.7)
    expect(s[0].end).toBeLessThan(4.3)
  })

  it('«убрать тишину» целиком: два куска склеиваются, ролик короче на паузу', async () => {
    const s = await detectSilence(talk.path, -35, 0.6)
    const keep = speechRanges(s, 0, talk.duration)
    let n = 0
    const pieces = keepRanges(talk, keep, () => `p${n++}`)
    expect(pieces).toHaveLength(2)
    const r = await runMontage(plan(pieces), null, () => {})
    const info = await probeMedia(r.outputPath)
    expect(info.duration).toBeGreaterThan(3.5)
    expect(info.duration).toBeLessThan(4.6)
  })

  it('без звука — понятная ошибка', async () => {
    const mute = await make(join(dir, 'mute.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
    await expect(detectSilence(mute)).rejects.toThrow('нет звука')
  })
})
