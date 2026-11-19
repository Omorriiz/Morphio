import { beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { run } from '../../src/main/ffmpeg'
import { convertSubtitles, extractSubtitles, loadCues, saveCues } from '../../src/main/converters/subtitles'
import { getTargets, kindOfExt } from '../../src/main/registry'
import { formatStamp, parseCues, parseStamp, shiftCues, stripMarkup, writeSrt, writeText, writeVtt } from '../../src/shared/subtitles'
import { defaultUniversalOptions } from '../../src/shared/types'
import { cleanupAfterAll, fileItem, tmpDir } from '../helpers'

cleanupAfterAll()

const SRT = '1\r\n00:00:01,000 --> 00:00:03,500\r\nПривет, <i>мир</i>\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nВторая строка\r\nи третья\r\n'

describe('субтитры: разбор и запись', () => {
  it('время читается и пишется', () => {
    expect(parseStamp('01:02:03,450')).toBeCloseTo(3723.45)
    expect(parseStamp('02:03.5')).toBeCloseTo(123.5)
    expect(parseStamp('чепуха')).toBeUndefined()
    expect(formatStamp(3723.45, ',')).toBe('01:02:03,450')
    expect(formatStamp(1.2, '.')).toBe('00:00:01.200')
    expect(formatStamp(-5, ',')).toBe('00:00:00,000')
  })

  it('SRT и VTT читаются одинаково', () => {
    const a = parseCues(SRT)
    expect(a).toHaveLength(2)
    expect(a[1]).toEqual({ start: 4, end: 6, text: 'Вторая строка\nи третья' })
    const b = parseCues(writeVtt(a))
    expect(b).toEqual(a)
    expect(parseCues('﻿' + writeSrt(a))).toEqual(a)
  })

  it('сдвиг: вперёд, назад, реплики в минусе пропадают', () => {
    const a = parseCues(SRT)
    expect(shiftCues(a, 2)[0]).toMatchObject({ start: 3, end: 5.5 })
    const back = shiftCues(a, -3.2)
    expect(back).toHaveLength(2)
    expect(back[0].start).toBe(0)
    expect(back[0].end).toBeCloseTo(0.3)
    expect(shiftCues(a, -3.6)).toHaveLength(1)
  })

  it('текст без разметки', () => {
    expect(stripMarkup('<i>a</i> {\\an8}b')).toBe('a b')
    expect(writeText(parseCues(SRT))).toBe('Привет, мир\nВторая строка и третья\n')
  })
})

describe('субтитры: перевод форматов', () => {
  let dir: string
  beforeAll(async () => {
    dir = await tmpDir('subs')
    await fs.writeFile(join(dir, 'a.srt'), SRT, 'utf8')
  })
  const update = (): void => {}

  it('SRT → VTT, TXT, ASS и обратно', async () => {
    const src = await fileItem(join(dir, 'a.srt'))
    const opt = (t: string) => ({ ...defaultUniversalOptions(t), outputDir: dir })
    const vtt = await convertSubtitles(src, 'vtt', opt('subs:vtt'), update)
    expect((await fs.readFile(vtt.outputPath, 'utf8')).startsWith('WEBVTT')).toBe(true)
    const txt = await convertSubtitles(src, 'txt', opt('subs:txt'), update)
    expect(await fs.readFile(txt.outputPath, 'utf8')).toContain('Привет, мир')
    const ass = await convertSubtitles(src, 'ass', opt('subs:ass'), update)
    expect(await fs.readFile(ass.outputPath, 'utf8')).toContain('[Events]')
    const back = await convertSubtitles(await fileItem(ass.outputPath), 'srt', { ...opt('subs:srt'), outputDir: join(dir, 'back') }, update)
    const cues = parseCues(await fs.readFile(back.outputPath, 'utf8'))
    expect(cues).toHaveLength(2)
    expect(cues[0].start).toBeCloseTo(1, 1)
    expect(cues[0].text).toContain('Привет')
  })

  it('сдвиг и то же имя формата: файл не затирается', async () => {
    const src = await fileItem(join(dir, 'a.srt'))
    const r = await convertSubtitles(src, 'srt', { ...defaultUniversalOptions('subs:srt'), outputDir: dir, shift: 2.5 }, update)
    expect(r.outputPath).not.toBe(src.path)
    expect(await fs.readFile(src.path, 'utf8')).toBe(SRT)
    expect(parseCues(await fs.readFile(r.outputPath, 'utf8'))[0].start).toBeCloseTo(3.5)
    expect(r.info).toContain('+2.5')
  })

  it('кодировка windows-1251 определяется', async () => {
    const iconv = await import('iconv-lite')
    await fs.writeFile(join(dir, 'ru.srt'), iconv.default.encode(SRT, 'win1251'))
    const r = await convertSubtitles(await fileItem(join(dir, 'ru.srt')), 'vtt', { ...defaultUniversalOptions('subs:vtt'), outputDir: dir }, update)
    expect(await fs.readFile(r.outputPath, 'utf8')).toContain('Привет')
  })

  it('пустой файл и сдвиг в минус дают понятную ошибку', async () => {
    await fs.writeFile(join(dir, 'empty.srt'), 'ничего', 'utf8')
    await expect(convertSubtitles(await fileItem(join(dir, 'empty.srt')), 'vtt', defaultUniversalOptions('subs:vtt'), update)).rejects.toThrow('нет субтитров')
    await expect(
      convertSubtitles(await fileItem(join(dir, 'a.srt')), 'vtt', { ...defaultUniversalOptions('subs:vtt'), shift: -100 }, update)
    ).rejects.toThrow('не осталось')
  })

  it('редактор: чтение и сохранение правок', async () => {
    const p = join(dir, 'edit.vtt')
    await fs.writeFile(p, writeVtt(parseCues(SRT)), 'utf8')
    const cues = await loadCues(p)
    cues[0].text = 'Исправлено'
    await saveCues(p, cues)
    const again = await loadCues(p)
    expect(again[0].text).toBe('Исправлено')
    expect(again).toHaveLength(2)
  })

  it('реестр: у субтитров свои варианты', async () => {
    expect(kindOfExt('srt')).toBe('subtitle')
    const t = getTargets([await fileItem(join(dir, 'a.srt'))])
    expect(t.map((x) => x.id)).toEqual(expect.arrayContaining(['subs:srt', 'subs:vtt', 'subs:ass', 'subs:txt']))
  })
})

describe('субтитры из видео', () => {
  it('дорожка достаётся, без дорожки — понятная ошибка', async () => {
    const dir = await tmpDir('subs-video')
    const srt = join(dir, 's.srt')
    await fs.writeFile(srt, SRT, 'utf8')
    const video = join(dir, 'v.mkv')
    const r = await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=8', '-i', srt, '-c:v', 'libx264', '-c:s', 'srt', video])
    expect(r.code).toBe(0)
    const item = await fileItem(video, { subtitleTracks: 1 })
    const ids = getTargets([item]).map((t) => t.id)
    expect(ids).toContain('subs:srt')
    const out = await extractSubtitles(item, 'vtt', { ...defaultUniversalOptions('subs:vtt'), outputDir: dir }, () => {})
    const cues = parseCues(await fs.readFile(out.outputPath, 'utf8'))
    expect(cues).toHaveLength(2)
    expect(cues[0].text).toContain('Привет')
    await expect(extractSubtitles(item, 'srt', { ...defaultUniversalOptions('subs:srt'), subTrack: 3 }, () => {})).rejects.toThrow()
    // видео без дорожек не предлагает вариант
    const plain = await fileItem(video, { subtitleTracks: 0 })
    expect(getTargets([plain]).some((t) => t.id.startsWith('subs:'))).toBe(false)
  })
})
