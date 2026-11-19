import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { runCli, EXIT } from '../../src/main/cli'
import type { CliContext } from '../../src/main/cli'
import { freePath, protectPath, setOverwrite } from '../../src/main/files'
import { run } from '../../src/main/ffmpeg'
import { cleanupAfterAll, exists, makeImage, tmpDir } from '../helpers'

cleanupAfterAll()

function context(dataDir: string): { ctx: CliContext; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    ctx: {
      version: '0.0.0-test',
      info: {},
      dataDir,
      io: { out: (t) => out.push(t), err: (t) => err.push(t) },
      bgModel: () => undefined,
      electron: false,
      args: []
    }
  }
}

afterEach(() => setOverwrite(false))

let dir: string
let frames: string[]
let video: string

beforeAll(async () => {
  dir = await tmpDir('cli2')
  frames = []
  for (let i = 0; i < 4; i++) {
    const p = join(dir, `кадр-${i + 1}.png`)
    await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 40 + i * 50, g: 90, b: 160 } } }).png().toFile(p)
    frames.push(p)
  }
  video = join(dir, 'ролик.mp4')
  const r = await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video])
  if (r.code !== 0) throw new Error(r.stderr)
})

describe('morphio gif', () => {
  it('из картинок: файл создан, имя по первому кадру, путь в stdout', async () => {
    const { ctx, out } = context(dir)
    const code = await runCli(['gif', ...frames, '--delay', '200', '--out', join(dir, 'g1'), '--quiet'], ctx)
    expect(code).toBe(EXIT.ok)
    expect(out).toHaveLength(1)
    const meta = await sharp(out[0], { pages: -1 }).metadata()
    expect(meta.format).toBe('gif')
    expect(meta.pages).toBe(4)
    expect(meta.delay?.[0]).toBe(200)
  })

  it('webp, порядок туда-обратно, повторы и своё имя', async () => {
    const { ctx, out } = context(dir)
    const code = await runCli(['gif', ...frames, '--format', 'webp', '--order', 'pingpong', '--loop', '3', '--name', 'пинг', '--out', join(dir, 'g2'), '-q'], ctx)
    expect(code).toBe(EXIT.ok)
    expect(out[0].endsWith('пинг.webp')).toBe(true)
    expect((await sharp(out[0], { pages: -1 }).metadata()).pages).toBe(6) // 4 + 2 обратных
  })

  it('из видео: отрезок и частота кадров', async () => {
    const { ctx, out } = context(dir)
    const code = await runCli(['gif', video, '--trim', '1-3', '--fps', '5', '--width', '160', '--out', join(dir, 'g3'), '-q'], ctx)
    expect(code).toBe(EXIT.ok)
    const meta = await sharp(out[0], { pages: -1 }).metadata()
    expect(meta.width).toBe(160)
    expect(meta.pages).toBeGreaterThanOrEqual(9)
    expect(meta.pages).toBeLessThanOrEqual(11) // 2 с × 5 кадров/с
    expect(meta.delay?.[0]).toBe(200)
  })

  it('без --out: результат рядом с исходником и не пропадает вместе с временными кадрами', async () => {
    const work = await tmpDir('cli2-near')
    const v = join(work, 'рядом.mp4')
    await fs.copyFile(video, v)
    const a = context(dir)
    expect(await runCli(['gif', v, '--fps', '4', '--width', '120', '-q'], a.ctx)).toBe(EXIT.ok)
    expect(a.out[0]).toBe(join(work, 'рядом.gif'))
    expect(await exists(a.out[0])).toBe(true)
    const frames = [join(work, 'a1.png'), join(work, 'a2.png')]
    for (const f of frames) await sharp({ create: { width: 40, height: 40, channels: 3, background: '#336699' } }).png().toFile(f)
    const b = context(dir)
    expect(await runCli(['gif', ...frames, '-q'], b.ctx)).toBe(EXIT.ok)
    expect(b.out[0]).toBe(join(work, 'a1.gif'))
  })

  it('--max-size: результат укладывается или сказано, что не вышло', async () => {
    const { ctx, out } = context(dir)
    const code = await runCli(['gif', video, '--fps', '10', '--max-size', '200KB', '--out', join(dir, 'g4'), '-q'], ctx)
    expect(code).toBe(EXIT.ok)
    expect((await fs.stat(out[0])).size).toBeLessThan(220 * 1024)
  })

  it('--json и ошибки: смесь видео и картинок, неверный формат, нет файлов', async () => {
    const a = context(dir)
    expect(await runCli(['gif', video, frames[0]], a.ctx)).toBe(EXIT.usage)
    expect(a.err.join('\n')).toContain('либо одно видео')
    const b = context(dir)
    expect(await runCli(['gif', ...frames, '--format', 'mov'], b.ctx)).toBe(EXIT.usage)
    const c = context(dir)
    expect(await runCli(['gif', join(dir, 'нет.png')], c.ctx)).toBe(EXIT.usage)
    const d = context(dir)
    expect(await runCli(['gif', video, '--trim', '9-1'], d.ctx)).toBe(EXIT.usage)
    const e = context(dir)
    expect(await runCli(['gif', ...frames, '--json', '--out', join(dir, 'g5'), '-q'], e.ctx)).toBe(EXIT.ok)
    const json = JSON.parse(e.out.join('\n'))
    expect(json.ok).toBe(true)
    expect(json.results[0].info).toContain('120×80')
  })
})

describe('--overwrite', () => {
  it('без флага: добавляется номер; с флагом: старый результат заменяется', async () => {
    const src = await makeImage(join(dir, 'фото.png'), 100, 60)
    const outDir = join(dir, 'ow')
    const a = context(dir)
    await runCli(['convert', src, '--to', 'jpg', '--out', outDir, '-q'], a.ctx)
    const b = context(dir)
    await runCli(['convert', src, '--to', 'jpg', '--out', outDir, '-q'], b.ctx)
    expect(b.out[0]).not.toBe(a.out[0])
    expect(b.out[0]).toContain('(1)')
    const c = context(dir)
    expect(await runCli(['convert', src, '--to', 'jpg', '--out', outDir, '--overwrite', '-q'], c.ctx)).toBe(EXIT.ok)
    expect(c.out[0]).toBe(a.out[0])
    expect((await fs.readdir(outDir)).length).toBe(2) // два файла, а не три
  })

  it('исходный файл не перезаписывается, даже если результат получил бы то же имя', async () => {
    const src = await makeImage(join(dir, 'тот-же.png'), 100, 60)
    const before = await fs.readFile(src)
    const { ctx, out } = context(dir)
    expect(await runCli(['convert', src, '--to', 'png', '--overwrite', '-q'], ctx)).toBe(EXIT.ok)
    expect(out[0]).not.toBe(src)
    expect(await fs.readFile(src)).toEqual(before)
  })

  it('режим выключается сам при следующем запуске и в freePath', async () => {
    const f = join(dir, 'busy')
    await fs.mkdir(f, { recursive: true })
    await fs.writeFile(join(f, 'x.txt'), '1')
    setOverwrite(true)
    expect(await freePath(f, 'x', 'txt')).toBe(join(f, 'x.txt'))
    expect(await exists(join(f, 'x.txt'))).toBe(false) // старый файл убран заранее
    await fs.writeFile(join(f, 'x.txt'), '2')
    protectPath(join(f, 'x.txt'))
    expect(await freePath(f, 'x', 'txt')).toBe(join(f, 'x (1).txt'))
    setOverwrite(false)
    expect(await freePath(f, 'x', 'txt')).toBe(join(f, 'x (1).txt'))
  })
})

describe('субтитры в командной строке', () => {
  it('convert файл.srt --to vtt --shift; неверный сдвиг — ошибка аргументов', async () => {
    const srt = join(dir, 'с.srt')
    await fs.writeFile(srt, '1\n00:00:01,000 --> 00:00:03,000\nHi there\n', 'utf8')
    const a = context(dir)
    expect(await runCli(['convert', srt, '--to', 'vtt', '--shift', '2.5', '--out', join(dir, 'sv'), '-q'], a.ctx)).toBe(EXIT.ok)
    expect(await fs.readFile(a.out[0], 'utf8')).toContain('00:00:03.500 --> 00:00:05.500')
    const b = context(dir)
    expect(await runCli(['convert', srt, '--to', 'vtt', '--shift', 'abc'], b.ctx)).toBe(EXIT.usage)
  })

  it('convert фильм.mkv --to srt --track 2: вторая дорожка', async () => {
    const srt1 = join(dir, 't1.srt')
    const srt2 = join(dir, 't2.srt')
    await fs.writeFile(srt1, '1\n00:00:01,000 --> 00:00:02,000\nFIRST\n', 'utf8')
    await fs.writeFile(srt2, '1\n00:00:01,000 --> 00:00:02,000\nSECOND\n', 'utf8')
    const mkv = join(dir, 'два.mkv')
    const r = await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', srt1, '-i', srt2, '-map', '0', '-map', '1', '-map', '2', '-c', 'copy', '-c:s', 'srt', mkv])
    expect(r.code).toBe(0)
    const { ctx, out } = context(dir)
    expect(await runCli(['convert', mkv, '--to', 'srt', '--track', '2', '--out', join(dir, 'tr'), '-q'], ctx)).toBe(EXIT.ok)
    expect(await fs.readFile(out[0], 'utf8')).toContain('SECOND')
  })
})
