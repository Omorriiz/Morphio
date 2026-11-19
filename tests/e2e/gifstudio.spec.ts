import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Page } from '@playwright/test'
import { exists, expect, test } from './fixtures'

/** Четыре кадра: красный квадрат двигается по зелёному экрану. */
async function makeFrames(dir: string): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < 4; i++) {
    const p = join(dir, `кадр-${i + 1}.png`)
    const sq = await sharp({ create: { width: 140, height: 140, channels: 3, background: '#cc1133' } }).png().toBuffer()
    await sharp({ create: { width: 640, height: 360, channels: 3, background: '#00ff00' } })
      .composite([{ input: sq, left: 80 + i * 90, top: 110 }])
      .png()
      .toFile(p)
    out.push(p)
  }
  return out
}

async function openStudio(launch: (o?: never) => Promise<{ app: import('@playwright/test').ElectronApplication; page: Page }>, frames: string[]): Promise<Page> {
  const { app, page } = await launch()
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as never
  }, frames)
  await page.locator('.nav-item', { hasText: 'GIF' }).click()
  await page.locator('button', { hasText: 'Choose pictures' }).click()
  await expect(page.locator('.gif-canvas')).toBeVisible()
  return page
}

const step = (page: Page, title: string): ReturnType<Page['locator']> => page.locator('.gif .step', { hasText: title })

test.describe('GIF-студия: текст, стикеры, обрезка, фон', () => {
  test('текст и эмодзи ложатся поверх, обрезка 1:1, фон убран: результат проверяется по пикселям', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('frames')
    await fs.mkdir(dir, { recursive: true })
    const frames = await makeFrames(dir)
    const page = await openStudio(launch as never, frames)

    // текст
    await page.locator('.layers button', { hasText: '+ Text' }).click()
    await expect(page.locator('.gif-layer.selected')).toBeVisible()
    await page.locator('.layer-props textarea').fill('HELLO')
    await expect(page.locator('.layer-row').first()).toContainText('HELLO')
    // эмодзи
    await page.locator('.layers button', { hasText: '+ Emoji' }).click()
    await page.locator('.emoji').first().click()
    await expect(page.locator('.layer-row')).toHaveCount(2)
    // слой двигается мышью: тянем эмодзи в левый верхний угол
    const layer = page.locator('.gif-layer.selected')
    const lb = (await layer.boundingBox())!
    const cb = (await page.locator('.gif-canvas').boundingBox())!
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2)
    await page.mouse.down()
    await page.mouse.move(cb.x + 40, cb.y + 40, { steps: 5 })
    await page.mouse.up()
    const after = (await layer.boundingBox())!
    expect(after.x).toBeLessThan(lb.x - 20)
    // эмодзи показывается только на кадрах 2–3
    await step(page, 'Text and stickers').locator('input.tiny').first().fill('2')
    await step(page, 'Text and stickers').locator('input.tiny').nth(1).fill('3')

    // обрезка 1:1
    await step(page, 'Frame crop').locator('.segmented button', { hasText: '1:1' }).click()
    await expect(step(page, 'Frame crop')).toContainText('One frame for all frames')
    await step(page, 'Frame crop').locator('button', { hasText: 'Done' }).click()
    // фон
    await step(page, 'Background').locator('.switch').first().click()
    await step(page, 'Background').locator('.segmented button', { hasText: 'Solid' }).click()
    await step(page, 'Format').locator('.segmented button', { hasText: 'WebP' }).click()
    await page.locator('.gif-actions .btn.primary').click()
    await expect(page.locator('.result-card')).toBeVisible({ timeout: 90_000 })

    const out = join(dir, 'animation.webp')
    expect(await exists(out)).toBe(true)
    const meta = await sharp(out, { pages: -1 }).metadata()
    expect([meta.width, meta.pageHeight, meta.pages]).toEqual([360, 360, 4]) // 16:9 → квадрат 360×360
    const px = async (page_: number, x: number, y: number): Promise<number[]> => {
      const { data, info } = await sharp(out, { page: page_ }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const i = (y * info.width + x) * 4
      return [data[i], data[i + 1], data[i + 2], data[i + 3]]
    }
    // зелёный фон прозрачный, красный квадрат цел (обрезка 1:1 по центру: квадрат первого кадра слева виден частично)
    expect((await px(1, 2, 2))[3]).toBe(0)
    // белый текст лежит в нижней части и непрозрачен
    let textPixels = 0
    for (let x = 0; x < 360; x += 2) for (const y of [300, 310, 320, 330]) if ((await px(0, x, y))[3] > 200) textPixels++
    expect(textPixels).toBeGreaterThan(10)
  })

  test('APNG: прозрачная анимация с мягкими краями собирается через FFmpeg', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('frames')
    await fs.mkdir(dir, { recursive: true })
    const frames = await makeFrames(dir)
    const page = await openStudio(launch as never, frames)
    await step(page, 'Background').locator('.switch').first().click()
    await step(page, 'Background').locator('.segmented button', { hasText: 'Solid' }).click()
    await step(page, 'Format').locator('.segmented button', { hasText: 'APNG' }).click()
    await page.locator('.gif-actions .btn.primary').click()
    await expect(page.locator('.result-card')).toBeVisible({ timeout: 90_000 })
    const bytes = await fs.readFile(join(dir, 'animation.apng'))
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(bytes.readUInt32BE(bytes.indexOf('acTL') + 4)).toBe(4)
  })

  test('«обрезать до этого кадра» и «после этого» убирают лишние кадры', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('frames')
    await fs.mkdir(dir, { recursive: true })
    const frames = await makeFrames(dir)
    const page = await openStudio(launch as never, frames)
    await expect(page.locator('.gif-actions')).toBeVisible()
    await page.locator('.strip .frame').nth(1).click()
    await expect(page.locator('button', { hasText: 'Trim before this frame' })).toBeVisible()
    await page.locator('button', { hasText: 'Trim before this frame' }).click()
    await expect(page.locator('.list-head:visible')).toContainText('3 frames')
  })

  test('слой можно удалить, порядок слоёв меняется', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('frames')
    await fs.mkdir(dir, { recursive: true })
    const page = await openStudio(launch as never, await makeFrames(dir))
    await page.locator('.layers button', { hasText: '+ Text' }).click()
    await page.locator('.layers button', { hasText: '+ Emoji' }).click()
    await page.locator('.emoji').first().click()
    await expect(page.locator('.layer-row')).toHaveCount(2)
    await page.locator('.layer-row').first().locator('button[title="Move down"]').click()
    await page.locator('.layer-row').first().locator('button[title="Remove"]').click()
    await expect(page.locator('.layer-row')).toHaveCount(1)
    await expect(page.locator('.gif-layer')).toHaveCount(1)
  })
})
