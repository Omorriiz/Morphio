import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const gifFormat = (page: import('@playwright/test').Page, label: string): import('@playwright/test').Locator =>
  page.locator('.gif .step', { hasText: 'Format' }).locator('.segmented button', { hasText: label }).first()

test.describe('фундамент: настройки, журнал, сообщение о проблеме', () => {
  test('значения экранов и вкладка запоминаются в settings.json и возвращаются после перезапуска', async ({ launch }) => {
    const first = await launch()
    await first.page.locator('.nav-item', { hasText: 'GIF' }).click()
    // вкладка записывается сама (с задержкой); ждём это и добавляем значение, которое в студии выбирается только с кадрами
    await expect.poll(async () => (await first.settings()).ui).toMatchObject({ 'app.view': 'gif' })
    await first.page.evaluate(async () => {
      const s = await window.api.getSettings()
      await window.api.patchSettings({ ui: { ...s.settings.ui, 'gif.format': 'webp', 'app.view': 'gif', chains: [] } })
    })
    await expect.poll(async () => (await first.settings()).ui).toMatchObject({ 'gif.format': 'webp', 'app.view': 'gif' })

    const saved = await first.settings()
    const second = await launch({ settings: saved })
    // вкладка вернулась на GIF-студию
    await expect(second.page.locator('h1:visible')).toContainText('animation')
  })

  test('положение и размер окна сохраняются при закрытии', async ({ launch }) => {
    const l = await launch()
    await l.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setBounds({ x: 120, y: 90, width: 900, height: 640 })
    })
    await l.app.close()
    const s = await l.settings()
    const w = s['window'] as { width: number; height: number; maximized: boolean }
    expect(Math.abs(w.width - 900)).toBeLessThan(20)
    expect(Math.abs(w.height - 640)).toBeLessThan(20)
    expect(w.maximized).toBe(false)
  })

  test('ошибка окна пишется в журнал без имени пользователя; раздел «О программе» работает', async ({ launch }) => {
    const l = await launch()
    const home = homedir()
    const user = home.split(/[\\/]/).pop()!
    await l.page.evaluate(
      async (h) => window.api.logRendererError(`сбой в ${h}\\Видео\\a.mp4`, 'at fake (file.js:1:1)'),
      home
    )
    const logs = join(l.dataDir, 'logs')
    await expect.poll(async () => (await fs.readdir(logs).catch(() => [])).length).toBeGreaterThan(0)
    const file = (await fs.readdir(logs))[0]
    const text = await fs.readFile(join(logs, file), 'utf8')
    expect(text).toContain('сбой в %USERPROFILE%')
    expect(text).not.toContain(`Users\\${user}`)
    expect(text).toContain('started')

    await l.page.locator('.settings-btn').click()
    const about = l.page.locator('.settings-card', { hasText: 'About and data' })
    await expect(about).toBeVisible()
    await expect(about.locator('button', { hasText: 'Report a problem' })).toBeVisible()
    await expect(about.locator('button', { hasText: 'Open the log folder' })).toBeVisible()
  })

  test('«Сбросить настройки» спрашивает подтверждение и возвращает значения по умолчанию', async ({ launch }) => {
    const l = await launch({ settings: { theme: 'dark', hotkey: 'CommandOrControl+Shift+Y', ui: { 'convert.quality': 40 } } })
    await l.page.locator('.settings-btn').click()
    const about = l.page.locator('.settings-card', { hasText: 'About and data' })
    await about.locator('button', { hasText: 'Reset settings' }).click()
    await expect(about).toContainText('Files are not touched')
    await about.locator('button', { hasText: 'Cancel' }).click()
    expect((await l.settings())['theme']).toBe('dark')
    await about.locator('button', { hasText: 'Reset settings' }).click()
    await about.locator('button', { hasText: 'Yes, reset' }).click()
    await expect.poll(async () => (await l.settings())['theme']).toBe('system')
    const s = await l.settings()
    expect(s['ui']).toEqual({})
    expect(s['hotkey']).toBe('CommandOrControl+Shift+X')
  })
})
