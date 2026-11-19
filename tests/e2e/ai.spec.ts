import { execFile, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import electronPath from 'electron'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'
import { copyToWork, exists, expect, test } from './fixtures'

const RELEASE = resolve(__dirname, '../../models-release')
const ROOT = resolve(__dirname, '../..')
const primary = '.action-bar .btn.primary:visible'
const card = (label: string): string => `.format-card:has(b:text-is("${label}"))`
const have = ['realesrgan-x4v3.onnx', 'rus.traineddata', 'eng.traineddata', 'whisper-bin-x64.zip', 'ggml-tiny.bin'].every((n) => existsSync(join(RELEASE, n)))

let server: Server
let base = ''

test.beforeAll(async () => {
  if (!have) return
  server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').slice(1))
    const file = join(RELEASE, name)
    if (name.includes('..') || !existsSync(file)) {
      res.writeHead(404)
      res.end()
      return
    }
    fs.stat(file).then((st) => {
      res.writeHead(200, { 'content-length': st.size })
      createReadStream(file).pipe(res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()))
})

test.skip(!have, 'нет папки models-release с файлами моделей')

/** Картинка с текстом: FFmpeg рисует строку шрифтом Windows. */
async function textPng(path: string, text: string): Promise<void> {
  const r = spawnSync(ffmpegPath as string, ['-y', '-f', 'lavfi', '-i', 'color=c=white:s=900x200', '-vf', `drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${text}':fontsize=56:fontcolor=black:x=40:y=60`, '-frames:v', '1', path])
  if (r.status !== 0) throw new Error(String(r.stderr))
}

test.describe('нейросети: модули скачиваются кнопкой из приложения', () => {
  test('увеличение фото: баннер → «Скачать» → результат вдвое больше', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('up')
    await fs.mkdir(dir, { recursive: true })
    const src = join(dir, 'малое.jpg')
    await sharp({ create: { width: 240, height: 160, channels: 3, background: '#4488cc' } }).jpeg().toFile(src)
    const { page } = await launch({ args: [src], env: { MORPHIO_MODELS_URL: base } })
    await page.locator(card('Enlarge ×2')).click()
    // без модуля: баннер с кнопкой, «Конвертировать» недоступна
    const need = page.locator('.module-need')
    await expect(need).toHaveCount(1)
    await expect(need).toContainText('Real-ESRGAN')
    await expect(page.locator(primary)).toBeDisabled()
    await need.locator('button', { hasText: 'Download' }).click()
    await expect(page.locator('.module-need')).toHaveCount(0, { timeout: 60_000 })
    await expect(page.locator(primary)).toBeEnabled()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 120_000 })
    const out = join(dir, 'малое-x2.jpg')
    expect(await exists(out)).toBe(true)
    const meta = await sharp(out).metadata()
    expect([meta.width, meta.height]).toEqual([480, 320])
  })

  test('распознавание текста: два языковых модуля, результат — TXT с текстом', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('ocr')
    await fs.mkdir(dir, { recursive: true })
    const src = join(dir, 'надпись.png')
    await textPng(src, 'Morphio recognises text 2024')
    const { page } = await launch({ args: [src], env: { MORPHIO_MODELS_URL: base } })
    await page.locator(card('Recognise text')).click()
    await expect(page.locator('.module-need')).toHaveCount(2) // русский и английский
    for (let i = 0; i < 2; i++) await page.locator('.module-need button', { hasText: 'Download' }).first().click()
    await expect(page.locator('.module-need')).toHaveCount(0, { timeout: 60_000 })
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 120_000 })
    const text = await fs.readFile(join(dir, 'надпись.txt'), 'utf8')
    expect(text).toMatch(/Morphio/i)
    expect(text).toMatch(/2024/)
  })

  test('речь в текст: программа и модель tiny скачиваются, получаются субтитры SRT', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('speech')
    await fs.mkdir(dir, { recursive: true })
    const wav = join(dir, 'речь.wav')
    const script = join(dir, 'say.ps1')
    await fs.writeFile(
      script,
      "\uFEFFAdd-Type -AssemblyName System.Speech\r\n$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\r\n$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-US' } | Select-Object -First 1\r\nif (-not $v) { exit 3 }\r\n$s.SelectVoice($v.VoiceInfo.Name)\r\n$s.SetOutputToWaveFile('" + wav + "')\r\n$s.Speak('Hello world. This is a test of the speech recognition.')\r\n$s.Dispose()\r\n",
      'utf8'
    )
    const said = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true })
    test.skip(said.status !== 0, 'в Windows нет английского голоса для проверки')
    const { page } = await launch({ args: [wav], env: { MORPHIO_MODELS_URL: base } })
    await page.locator(card('SRT subtitles')).click()
    await page.locator('.segmented button', { hasText: 'Fast' }).click() // модель tiny
    await expect(page.locator('.module-need')).toHaveCount(2) // программа и модель
    for (let i = 0; i < 2; i++) await page.locator('.module-need button', { hasText: 'Download' }).first().click()
    await expect(page.locator('.module-need')).toHaveCount(0, { timeout: 90_000 })
    await page.locator('select').filter({ hasText: 'English' }).first().selectOption('en')
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 180_000 })
    const srt = await fs.readFile(join(dir, 'речь.srt'), 'utf8')
    expect(srt).toMatch(/\d\d:\d\d:\d\d,\d{3} --> /)
    expect(srt.toLowerCase()).toContain('hello')
  })

  test('настройки: модули разложены по группам, установленный можно удалить', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('settings')
    await fs.mkdir(dir, { recursive: true })
    const src = join(dir, 'a.jpg')
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888888' } }).jpeg().toFile(src)
    const { page } = await launch({ args: [src], env: { MORPHIO_MODELS_URL: base } })
    await page.locator(card('Enlarge ×2')).click()
    await page.locator('.module-need button', { hasText: 'Download' }).click()
    await expect(page.locator('.module-need')).toHaveCount(0, { timeout: 60_000 })
    await page.locator('.settings-btn').click()
    const cardEl = page.locator('.settings-card', { hasText: 'Extra modules' })
    await expect(cardEl.locator('.module-group .field-label')).toHaveText(['Programs', 'Neural networks and languages'])
    const row = cardEl.locator('.module-row', { hasText: 'Photo enlargement' })
    await expect(row).toContainText('Installed')
    await row.locator('button', { hasText: 'Remove' }).click()
    await expect(row).not.toContainText('Installed')
    await expect(row.locator('button', { hasText: 'Download' })).toBeVisible()
  })
})

test.describe('нейросети в командной строке', () => {
  function cli(args: string[], data: string): Promise<{ code: number; out: string; err: string }> {
    return new Promise((res) => {
      execFile(
        electronPath as unknown as string,
        [join(ROOT, 'out', 'main', 'cli.js'), `--user-data-dir=${data}`, ...args],
        { cwd: ROOT, windowsHide: true, timeout: 180_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MORPHIO_MODELS_URL: base } },
        (error, stdout, stderr) => res({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr })
      )
    })
  }

  test('modules install --yes скачивает модуль, convert --to txt распознаёт текст; без модуля — понятная ошибка', async () => {
    const data = join(tmpdir(), `morphio-cli-ai-${randomUUID().slice(0, 8)}`)
    await fs.mkdir(data, { recursive: true })
    await fs.writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, language: 'en' }))
    const src = join(data, 'text.png')
    await textPng(src, 'Command line OCR 4096')
    const before = await cli(['convert', src, '--to', 'txt'], data)
    expect(before.code).toBe(1)
    expect(before.err).toContain('neural network module')
    const noYes = await cli(['modules', 'install', 'tess-eng'], data)
    expect(noYes.code).toBe(2)
    const inst = await cli(['modules', 'install', 'tess-eng', '--yes'], data)
    expect(inst.code).toBe(0)
    const list = await cli(['modules', 'list'], data)
    expect(list.out).toMatch(/tess-eng\s+fast\s+installed/)
    const r = await cli(['convert', src, '--to', 'txt', '--lang', 'eng'], data)
    expect(r.code).toBe(0)
    expect((await fs.readFile(r.out.trim().split(/\r?\n/)[0], 'utf8')).toLowerCase()).toContain('command line')
  })
})
