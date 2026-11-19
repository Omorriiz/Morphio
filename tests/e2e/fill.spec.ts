import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { exists, expect, test } from './fixtures'

test.describe('редактор маски: инструмент «Заливка»', () => {
  test('клик убирает область, Ctrl+Z и Ctrl+Y работают, сохранение пишет результат', async ({ launch }, testInfo) => {
    const dir = testInfo.outputPath('fill')
    await fs.mkdir(dir, { recursive: true })
    const src = join(dir, 'спрайт.png')
    // слева розовый фон, справа голубой, в центре коричневый предмет
    const left = await sharp({ create: { width: 100, height: 160, channels: 3, background: '#ff00ff' } }).png().toBuffer()
    await sharp({ create: { width: 200, height: 160, channels: 3, background: '#a0d0ff' } })
      .composite([
        { input: left, left: 0, top: 0 },
        { input: { create: { width: 50, height: 50, channels: 3, background: '#7a4a2a' } }, left: 75, top: 55 }
      ])
      .png()
      .toFile(src)

    const { app, page } = await launch()
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never
    }, src)
    await page.locator('.nav-item', { hasText: 'Photo & background' }).click()
    await page.locator('button', { hasText: 'Choose photos' }).click()
    await page.locator('.segmented button', { hasText: 'Solid' }).first().click()
    await page.locator('.action-bar .btn.primary:visible').click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 60_000 })
    const out = join(dir, 'спрайт-no-bg.png')
    expect(await exists(out)).toBe(true)

    await page.locator('button[title="Edit with brush"]').click()
    await expect(page.locator('.editor-canvas')).toBeVisible()
    await page.locator('.editor-toolbar .chip', { hasText: 'Fill' }).click()
    await expect(page.locator('.fill-options')).toBeVisible()

    const undo = page.locator('button', { hasText: 'Undo' })
    await expect(undo).toBeDisabled()
    const box = (await page.locator('.editor-canvas').boundingBox())!
    // клик по голубой половине (справа сверху)
    await page.mouse.move(box.x + box.width * 0.92, box.y + box.height * 0.08)
    await page.mouse.click(box.x + box.width * 0.92, box.y + box.height * 0.08)
    await expect(undo).toBeEnabled()

    // отмена и повтор по горячим клавишам
    await page.keyboard.press('Control+z')
    await expect(undo).toBeDisabled()
    await page.keyboard.press('Control+y')
    await expect(undo).toBeEnabled()

    // повторный клик по уже убранному месту в историю не попадает
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.12)
    await page.keyboard.press('Control+z')
    await expect(undo).toBeDisabled()
    await page.keyboard.press('Control+y')

    // [ и ] меняют допуск, пока выбрана заливка
    const tol = page.locator('.fill-options input[type="range"]').first()
    const before = Number(await tol.inputValue())
    await page.keyboard.press(']')
    expect(Number(await tol.inputValue())).toBeGreaterThan(before)

    await page.locator('.modal-foot .btn.primary').click()
    await expect(page.locator('.modal')).toHaveCount(0, { timeout: 30_000 })

    const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const alpha = (x: number, y: number): number => data[(y * info.width + x) * 4 + 3]
    expect(alpha(5, 5)).toBe(0) // розовый убран при обработке
    expect(alpha(190, 10)).toBe(0) // голубой убран заливкой
    expect(alpha(100, 80)).toBe(255) // предмет цел
  })
})
