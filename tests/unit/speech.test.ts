import { beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseProgress, speechReady, transcribe } from '../../src/main/converters/speech'
import { run } from '../../src/main/ffmpeg'
import { configureModules } from '../../src/main/modules'
import { getTargets } from '../../src/main/registry'
import { defaultUniversalOptions } from '../../src/shared/types'
import { cleanupAfterAll, fileItem, installFromRelease, releaseHas, tmpDir } from '../helpers'

cleanupAfterAll()

const noop = (): void => {}
const opts = (dir: string, extra: object = {}): ReturnType<typeof defaultUniversalOptions> => ({ ...defaultUniversalOptions('speech:txt', dir), ...extra })

/** Речь для проверок: офлайн-голоса Windows (SAPI) читают заданную фразу в WAV. */
function speak(path: string, text: string, culture: string): boolean {
  if (process.platform !== 'win32') return false
  const script = path + '.ps1'
  const body = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq '${culture}' } | Select-Object -First 1`,
    'if (-not $v) { exit 3 }',
    '$s.SelectVoice($v.VoiceInfo.Name)',
    '$s.Rate = -1',
    `$s.SetOutputToWaveFile('${path}')`,
    `$s.Speak('${text}')`,
    '$s.Dispose()'
  ].join('\r\n')
  require('node:fs').writeFileSync(script, '\uFEFF' + body, 'utf8')
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true })
  return r.status === 0
}

describe('чистые функции', () => {
  it('ход работы читается из вывода whisper', () => {
    expect(parseProgress('whisper_print_progress_callback: progress =  42%')).toBe(42)
    expect(parseProgress('progress = 5%')).toBe(5)
    expect(parseProgress('ничего')).toBeUndefined()
  })

  it('без модулей: понятные ошибки, варианты помечены', async () => {
    configureModules([])
    expect(speechReady()).toBe(false)
    const dir = await tmpDir('speech')
    await fs.writeFile(join(dir, 'a.wav'), 'x')
    await expect(transcribe(await fileItem(join(dir, 'a.wav')), 'srt', opts(dir), noop)).rejects.toThrow(/модул|программ/i)
    const t = getTargets([{ ...(await fileItem(join(dir, 'a.wav'))), kind: 'audio' }]).filter((x) => x.id.startsWith('speech:'))
    expect(t.map((x) => x.id)).toEqual(['speech:srt', 'speech:vtt', 'speech:txt'])
    expect(t.every((x) => x.group === 'ai' && x.needs === 'whisper' && x.missing)).toBe(true)
  })
})

const can = releaseHas('whisper-bin-x64.zip', 'ggml-tiny.bin', 'ggml-base.bin')

describe.skipIf(!can)('Whisper (настоящая программа и модели)', () => {
  let dir: string
  let en: string | null = null
  let ru: string | null = null

  beforeAll(async () => {
    expect(await installFromRelease(['whisper', 'whisper-tiny', 'whisper-base'])).toBe(true)
    expect(speechReady()).toBe(true)
    dir = await tmpDir('speech')
    const e = join(dir, 'english.wav')
    en = speak(e, 'Hello world. This is a test of the speech recognition. The quick brown fox jumps over the lazy dog.', 'en-US') ? e : null
    const r = join(dir, 'russian.wav')
    ru = speak(r, 'Привет мир. Это проверка распознавания речи в программе Морфио.', 'ru-RU') ? r : null
  }, 120_000)

  it('английская речь → TXT (модель tiny)', async () => {
    if (!en) return
    const r = await transcribe(await fileItem(en), 'txt', opts(dir, { aiModel: 'tiny', lang: 'en' }), noop)
    const text = (await fs.readFile(r.outputPath, 'utf8')).toLowerCase()
    expect(text).toContain('hello')
    expect(text).toContain('test')
    expect(r.info).toContain('tiny')
  }, 180_000)

  it('SRT: нумерация и время, VTT: заголовок WEBVTT', async () => {
    if (!en) return
    const srt = await transcribe(await fileItem(en), 'srt', opts(dir, { aiModel: 'tiny', lang: 'en' }), noop)
    const s = await fs.readFile(srt.outputPath, 'utf8')
    expect(s).toMatch(/^1\r?\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}/)
    expect(s.toLowerCase()).toContain('hello')
    const vtt = await transcribe(await fileItem(en), 'vtt', opts(dir, { aiModel: 'tiny', lang: 'en' }), noop)
    expect((await fs.readFile(vtt.outputPath, 'utf8')).startsWith('WEBVTT')).toBe(true)
  }, 240_000)

  it('русская речь с автоопределением языка (модель base)', async () => {
    if (!ru) return
    const r = await transcribe(await fileItem(ru), 'txt', opts(dir, { aiModel: 'base', lang: 'auto' }), noop)
    const text = (await fs.readFile(r.outputPath, 'utf8')).toLowerCase()
    expect(text).toMatch(/привет/)
    expect(r.info).toMatch(/ru/)
  }, 240_000)

  it('видео со звуком: речь берётся из дорожки; прогресс доходит до 100', async () => {
    if (!en) return
    const video = join(dir, 'ролик.mp4')
    const k = await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=12', '-i', en, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video])
    expect(k.code).toBe(0)
    const seen: number[] = []
    const r = await transcribe({ ...(await fileItem(video)), kind: 'video' }, 'txt', opts(dir, { aiModel: 'tiny', lang: 'en' }), (p) => seen.push(p.percent))
    expect((await fs.readFile(r.outputPath, 'utf8')).toLowerCase()).toContain('hello')
    expect(seen.at(-1)).toBe(100)
  }, 240_000)

  it('видео без звука: понятная ошибка', async () => {
    const silent = join(dir, 'немое.mp4')
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent])
    await expect(transcribe(await fileItem(silent), 'txt', opts(dir, { aiModel: 'tiny' }), noop)).rejects.toThrow(/звук/i)
  }, 60_000)

  it('нет модели small: сообщение называет модель', async () => {
    if (!en) return
    await expect(transcribe(await fileItem(en), 'txt', opts(dir, { aiModel: 'small' }), noop)).rejects.toThrow(/small/)
  }, 60_000)
})
