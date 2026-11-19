import { beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { defaultAudioBranch, defaultChain, defaultVideoBranch, migrateChain } from '../../src/shared/chains'
import type { ChainConfig } from '../../src/shared/chains'
import { findSiblingSubtitles, runChainItem } from '../../src/main/chains'
import { inspectMedia } from '../../src/main/converters/media'
import { run } from '../../src/main/ffmpeg'
import type { FileItem } from '../../src/shared/types'
import { cleanupAfterAll, tmpDir } from '../helpers'

cleanupAfterAll()

let dir: string
let withSubs: FileItem
let lonely: FileItem
let track: FileItem

const SRT = '1\n00:00:00,500 --> 00:00:02,500\nTEST TEXT\n'

async function make(path: string, args: string[]): Promise<string> {
  const r = await run(['-hide_banner', '-loglevel', 'error', '-y', ...args, path])
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
  return path
}

beforeAll(async () => {
  dir = await tmpDir('chains2')
  const clip = (name: string): Promise<string> =>
    make(join(dir, name), ['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=10:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'])
  const a = await clip('фильм.mp4')
  await fs.writeFile(join(dir, 'фильм.ru.srt'), SRT, 'utf8')
  await fs.writeFile(join(dir, 'фильм.en.srt'), SRT, 'utf8')
  const b = await clip('одинокий.mp4')
  const t = await make(join(dir, 'песня.mp3'), ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-metadata', 'artist=Прежний', '-metadata', 'title=Название', '-c:a', 'libmp3lame'])
  ;[withSubs] = await inspectMedia([a])
  ;[lonely] = await inspectMedia([b])
  ;[track] = await inspectMedia([t])
})

const ctx = { gpu: null, modelPath: undefined }
const cfg = (extra: Partial<ChainConfig> = {}): ChainConfig => ({ ...defaultChain(), outputDir: join(dir, 'out'), ...extra })
const noop = (): void => {}

describe('цепочки: субтитры рядом с роликом', () => {
  it('поиск: имя совпадает, языковые суффиксы допустимы, чужие файлы не берутся', async () => {
    await fs.writeFile(join(dir, 'фильмец.srt'), SRT, 'utf8') // другое имя, начинающееся так же
    const found = await findSiblingSubtitles(withSubs.path)
    expect(found && found.endsWith('фильм.en.srt')).toBe(true) // при равной длине выигрывает алфавит
    expect(await findSiblingSubtitles(lonely.path)).toBeUndefined()
    await fs.writeFile(join(dir, 'фильм.srt'), SRT, 'utf8')
    expect((await findSiblingSubtitles(withSubs.path))!.endsWith('фильм.srt')).toBe(true) // файл без языка в приоритете
  })

  it('дорожкой: в результате появляется поток субтитров', async () => {
    const r = await runChainItem(withSubs, 0, cfg({ video: { ...defaultVideoBranch(), subtitles: 'soft', nameTemplate: '{name}-soft' } }), ctx, noop)
    const p = await run(['-hide_banner', '-i', r.outputPath])
    expect(p.stderr).toMatch(/Subtitle: mov_text/)
    expect(r.info).toContain('фильм.srt')
  })

  it('в картинку: кадр отличается от кадра без субтитров', async () => {
    const out = (name: string): Promise<string> =>
      runChainItem(withSubs, 0, cfg({ video: { ...defaultVideoBranch(), subtitles: name === 'burn' ? 'burn' : 'off', nameTemplate: `{name}-${name}` } }), ctx, noop).then((r) => r.outputPath)
    const frame = async (path: string): Promise<Buffer> =>
      (await run(['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])).stdout
    const burn = await frame(await out('burn'))
    const off = await frame(await out('off'))
    expect(burn.equals(off)).toBe(false)
    expect(burn.some((v) => v > 128)).toBe(true) // на чёрном фоне появился светлый текст
  })

  it('субтитров рядом нет: ролик сохраняется, в сообщении об этом сказано', async () => {
    const r = await runChainItem(lonely, 0, cfg({ video: { ...defaultVideoBranch(), subtitles: 'soft' } }), ctx, noop)
    expect(r.info).toContain('не найдены')
    const p = await run(['-hide_banner', '-i', r.outputPath])
    expect(p.stderr).not.toMatch(/Subtitle:/)
  })

  it('старые сохранённые цепочки открываются: шаг выключен', () => {
    const old = migrateChain({ version: 2, video: { enabled: true, trimStart: 1 }, audio: { enabled: true } })
    expect(old.video.subtitles).toBe('off')
    expect(old.audio.tags).toEqual({ artist: '', album: '', genre: '', year: '' })
    expect(migrateChain({ version: 2, audio: { tags: { artist: 'А', album: 5 } } }).audio.tags).toEqual({ artist: 'А', album: '', genre: '', year: '' })
  })
})

describe('цепочки: запись тегов', () => {
  const tagsOf = async (path: string): Promise<string> => (await run(['-hide_banner', '-i', path])).stderr

  it('новые теги пишутся поверх старых, пустые поля ничего не меняют', async () => {
    const r = await runChainItem(
      track,
      0,
      cfg({ audio: { ...defaultAudioBranch(), format: 'flac', tags: { artist: 'Новый исполнитель', album: 'Альбом', genre: '', year: '2024' } } }),
      ctx,
      noop
    )
    const s = await tagsOf(r.outputPath)
    expect(s).toMatch(/artist\s+:\s+Новый исполнитель/i)
    expect(s).toMatch(/album\s+:\s+Альбом/i)
    expect(s).toMatch(/date\s+:\s+2024/i)
    expect(s).toMatch(/title\s+:\s+Название/i) // прежнее название осталось
    expect(r.info).toContain('теги записаны')
  })

  it('теги записываются и без сохранения старых', async () => {
    const r = await runChainItem(
      track,
      1,
      cfg({ audio: { ...defaultAudioBranch(), format: 'flac', keepTags: false, tags: { artist: 'Только этот', album: '', genre: '', year: '' } } }),
      ctx,
      noop
    )
    const s = await tagsOf(r.outputPath)
    expect(s).toMatch(/artist\s+:\s+Только этот/i)
    expect(s).not.toContain('Название')
  })
})
