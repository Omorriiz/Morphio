import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import sharp from 'sharp'
import type { Page } from '@playwright/test'
import { copyToWork, exists, expect, test } from './fixtures'

const card = (label: string): string => `.format-card:has(b:text-is("${label}"))`

function probe(path: string): { duration: number; size: string } {
  let err = ''
  try {
    execFileSync(ffmpegPath as string, ['-hide_banner', '-i', path], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    err = String((e as { stderr?: Buffer }).stderr ?? '')
  }
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err)
  const v = /Video:.*?,\s*(\d{2,5}x\d{2,5})/.exec(err)
  return { duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0, size: v?.[1] ?? '' }
}

const SRT = '1\n00:00:01,000 --> 00:00:03,000\nПривет, мир\n\n2\n00:00:04,000 --> 00:00:06,000\nВторая строка\n'

test.describe('субтитры в конвертере', () => {
  test('SRT → VTT со сдвигом, затем правка текста в редакторе', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('subs')
    await fs.mkdir(dir, { recursive: true })
    const src = join(dir, 'речь.srt')
    await fs.writeFile(src, SRT, 'utf8')
    const { page } = await launch({ args: [src] })
    await page.locator(card('VTT')).click()
    await page.locator('input[type="number"]').first().fill('2')
    await page.locator('.action-bar .btn.primary:visible').click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 60_000 })
    const out = join(dir, 'речь.vtt')
    expect(await exists(out)).toBe(true)
    const first = await fs.readFile(out, 'utf8')
    expect(first).toContain('00:00:03.000 --> 00:00:05.000')

    // редактор: поменять текст первой реплики
    await page.locator('button[title="Edit subtitles"]').click()
    const box = page.locator('.subs-row textarea').first()
    await expect(box).toHaveValue('Привет, мир')
    await box.fill('Исправлено')
    await page.locator('.modal-foot .btn.primary').click()
    await expect(page.locator('.subs-status')).toContainText('Saved')
    expect(await fs.readFile(out, 'utf8')).toContain('Исправлено')
    // неверное время блокирует сохранение
    await page.locator('.subs-row .time-input').first().fill('не время')
    await expect(page.locator('.modal-foot .btn.primary')).toBeDisabled()
  })

  test('дорожка субтитров достаётся из видео', async ({ launch, assets }, testInfo) => {
    const dir = testInfo.outputPath('mkv')
    await fs.mkdir(dir, { recursive: true })
    const srt = join(dir, 'в.srt')
    await fs.writeFile(srt, SRT, 'utf8')
    const mkv = join(dir, 'фильм.mkv')
    execFileSync(ffmpegPath as string, ['-y', '-i', assets.video, '-i', srt, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'srt', mkv], { stdio: 'ignore' })
    const { page } = await launch({ args: [mkv] })
    await page.locator(card('Extract subtitles: SRT')).click()
    await page.locator('.action-bar .btn.primary:visible').click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 60_000 })
    expect(await fs.readFile(join(dir, 'фильм.srt'), 'utf8')).toContain('Привет, мир')
  })
})

test.describe('монтаж: куски, переход, рамка', () => {
  async function openMontage(launch: (o?: never) => Promise<{ app: import('@playwright/test').ElectronApplication; page: Page }>, file: string): Promise<Page> {
    const { app, page } = await launch()
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never
    }, file)
    await page.locator('.nav-item', { hasText: 'Montage' }).click()
    await page.locator('button', { hasText: 'Choose video' }).click()
    await expect(page.locator('.clip-row')).toHaveCount(1)
    return page
  }

  test('вырезать середину, переход между кусками, квадратная рамка', async ({ launch, assets }) => {
    const work = await copyToWork(assets.video)
    const page = await openMontage(launch as never, work.path)
    const seek = async (s: number): Promise<void> => {
      await page.locator('.trim-time').fill(String(s))
    }
    // ролик 3 с: вырезаем 1–2 с, остаются два куска по секунде
    await seek(1)
    await page.locator('button', { hasText: /^From:/ }).click()
    await seek(2)
    await page.locator('button', { hasText: /^To:/ }).click()
    await page.locator('button', { hasText: /^Cut out$/ }).click()
    await expect(page.locator('.clip-row')).toHaveCount(2)
    await expect(page.locator('.notice', { hasText: 'Cut out 1 s' })).toBeVisible()
    // переход «Плавное затухание» 0,5 с: итог 2 − 0,5 = 1,5 с
    await page.locator('select').filter({ hasText: 'No transition' }).selectOption('fade')
    await page.locator('select').filter({ hasText: '0.5 s' }).selectOption('0.5')
    // квадратная рамка: 640×360 → 360×360
    await page.locator('.montage .segmented button', { hasText: '1:1' }).click()
    await expect(page.locator('.crop-frame')).toBeVisible()
    await page.locator('.cv-footer .btn.primary', { hasText: 'Save' }).click()
    await expect(page.locator('.montage-status')).toContainText('Done!', { timeout: 90_000 })
    const info = probe(join(work.dir, 'ролик-edited.mp4'))
    expect(info.size).toBe('360x360')
    expect(info.duration).toBeGreaterThan(1.3)
    expect(info.duration).toBeLessThan(1.8)
  })

  test('«разрезать здесь» делит клип, у края предупреждает', async ({ launch, assets }) => {
    const work = await copyToWork(assets.video)
    const page = await openMontage(launch as never, work.path)
    await page.locator('button', { hasText: 'Cut here' }).click() // время 0: слишком близко к краю
    await expect(page.locator('.notice', { hasText: 'too close to the edge' })).toBeVisible()
    await page.locator('.trim-time').fill('1.5')
    await page.locator('button', { hasText: 'Cut here' }).click()
    await expect(page.locator('.clip-row')).toHaveCount(2)
  })
})

test.describe('GIF-студия: скорость части кадров, анимация слоя', () => {
  test('диапазон скорости попадает в готовый файл, у слоя есть выбор анимации', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('frames')
    await fs.mkdir(dir, { recursive: true })
    const frames: string[] = []
    for (let i = 0; i < 4; i++) {
      const p = join(dir, `к-${i + 1}.png`)
      await sharp({ create: { width: 200, height: 120, channels: 3, background: { r: 40 + i * 50, g: 120, b: 200 } } }).png().toFile(p)
      frames.push(p)
    }
    const { app, page } = await launch()
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as never
    }, frames)
    await page.locator('.nav-item', { hasText: 'GIF' }).click()
    await page.locator('button', { hasText: 'Choose pictures' }).click()
    await expect(page.locator('.gif-canvas')).toBeVisible()
    // кадры 1–2 вдвое быстрее
    const speed = page.locator('.gif .step', { hasText: 'Speed' })
    await speed.locator('input.tiny').nth(1).fill('2')
    await speed.locator('button', { hasText: 'Add' }).click()
    await expect(speed.locator('.layer-row')).toContainText('Frames 1–2: 2×')
    // анимация текста
    await page.locator('.layers button', { hasText: '+ Text' }).click()
    const anim = page.locator('.layer-props select').last()
    await anim.selectOption('fade')
    await expect(page.locator('.layer-props')).toContainText('The animation runs while the layer is shown')
    await page.locator('.gif .step', { hasText: 'Format' }).locator('.segmented button', { hasText: 'GIF' }).first().click()
    await page.locator('.gif-actions .btn.primary').click()
    await expect(page.locator('.result-card')).toBeVisible({ timeout: 90_000 })
    const meta = await sharp(join(dir, 'animation.gif'), { pages: -1 }).metadata()
    expect(meta.pages).toBe(4)
    expect(meta.delay?.slice(0, 2)).toEqual([50, 50])
    expect(meta.delay?.[3]).toBe(100)
  })
})
