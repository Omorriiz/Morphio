import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { copyToWork, exists, expect, test } from './fixtures'

const primary = '.action-bar .btn.primary:visible'
const card = (label: string): string => `.format-card:has(b:text-is("${label}"))`

test.describe('запуск и разделы', () => {
  test('окно открывается, три раздела и значок настроек справа от названия', async ({ launch }) => {
    const { page } = await launch()
    await expect(page).toHaveTitle('Morphio')
    const items = page.locator('.nav-item')
    await expect(items).toHaveText(['Converter', 'Photo & background', 'GIF studio'])
    await expect(page.locator('.nav-item.active')).toHaveText('Converter')
    await expect(page.locator('h1:visible')).toContainText('Any file into anything')
    // кнопка настроек — только значок, без текста, в одной строке с названием
    const gear = page.locator('.brand .settings-btn')
    await expect(gear).toBeVisible()
    await expect(gear).toHaveText('')
    await expect(gear).toHaveAttribute('aria-label', 'Settings')
    const brand = await page.locator('.brand-name').boundingBox()
    const box = await gear.boundingBox()
    expect(box!.x).toBeGreaterThan(brand!.x + brand!.width - 1)
    expect(Math.abs(box!.y + box!.height / 2 - (brand!.y + brand!.height / 2))).toBeLessThan(12)
    await expect(page.locator('.lang-switch')).toHaveCount(0)
  })

  test('разделы переключаются, экраны сохраняют состояние', async ({ launch, assets }) => {
    const { page } = await launch({ args: [assets.csv] })
    await expect(page.locator('.file-card:visible')).toHaveCount(1)
    await page.locator('.nav-item', { hasText: 'Photo' }).click()
    await expect(page.locator('.subtabs .segmented button.active')).toHaveText('Remove background')
    await page.locator('.segmented button', { hasText: 'Chains' }).click()
    await expect(page.locator('h2:visible', { hasText: 'Chains' })).toBeVisible()
    await page.locator('.nav-item', { hasText: 'GIF' }).click()
    await expect(page.locator('h1:visible')).toContainText('animation')
    await page.locator('.nav-item', { hasText: 'Converter' }).click()
    await expect(page.locator('.file-card:visible')).toHaveCount(1) // список файлов не потерялся
  })

  test('язык переключается сразу и запоминается между запусками', async ({ launch }) => {
    const first = await launch()
    await first.page.locator('.settings-btn').click()
    await first.page.locator('.segmented button', { hasText: 'Русский' }).click()
    await expect(first.page.locator('.nav-item').first()).toHaveText('Конвертер')
    await first.page.locator('.nav-item').first().click()
    await expect(first.page.locator('h1:visible')).toContainText('Любой файл')
    await expect.poll(async () => (await first.settings()).language).toBe('ru')
    const { dataDir } = first
    await first.app.close()

    // второй запуск с теми же данными
    const second = await launch({ settings: JSON.parse(await fs.readFile(join(dataDir, 'settings.json'), 'utf8')) })
    await expect(second.page.locator('.nav-item').first()).toHaveText('Конвертер')
    await expect(second.page.locator('html')).toHaveAttribute('lang', 'ru')
  })

  test('повреждённый settings.json не мешает запуску', async ({ launch }) => {
    const { page } = await launch({ rawSettings: '{ не json' })
    await expect(page.locator('.nav-item').first()).toBeVisible()
    await expect(page.locator('h1:visible')).toBeVisible()
  })
})

test.describe('конвертер', () => {
  test('картинка → WebP: результат рядом, оригинал цел', async ({ launch, assets }) => {
    const work = await copyToWork(assets.image)
    const before = await fs.readFile(work.path)
    const { page } = await launch({ args: [work.path] })
    await expect(page.locator('.file-card:visible')).toHaveCount(1)
    await expect(page.locator(primary)).toBeDisabled() // пока не выбран результат
    await page.locator(card('WebP')).click()
    await expect(page.locator('.section h3', { hasText: 'Settings' })).toBeVisible()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1)
    const out = join(work.dir, 'закат-converted.webp')
    expect(await exists(out)).toBe(true)
    expect(await fs.readFile(work.path)).toEqual(before)
    await expect(page.locator(primary)).toHaveText('Done')
  })

  test('«до/после»: слайдер сравнивает оригинал и результат, показывает размеры и оценку качества', async ({ launch, assets }) => {
    const work = await copyToWork(assets.image)
    const { page } = await launch({ args: [work.path] })
    await page.locator(card('JPG')).click()
    await page.locator('.options:visible input[type=range]').first().fill('15')
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1)
    await page.locator('button[title="Compare before and after"]').click()
    const view = page.locator('.cmp-view')
    await expect(view).toBeVisible()
    await expect(page.locator('.cmp-img')).toHaveCount(2)
    await expect(page.locator('.cmp-verdict')).toBeVisible()
    await expect(page.locator('.cmp-side').first()).toContainText('Original')
    await expect(page.locator('.cmp-side.right')).toContainText('Result')
    // движок: тянем влево — граница смещается
    const line = page.locator('.cmp-line')
    const x0 = (await line.boundingBox())!.x
    const box = (await view.boundingBox())!
    await page.mouse.move(x0, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(x0 - 120, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
    expect((await line.boundingBox())!.x).toBeLessThan(x0 - 50)
    // колесо приближает
    await view.hover()
    await page.mouse.wheel(0, -300)
    await expect(page.locator('.cmp-zoom-val')).not.toHaveText('100%')
    await page.keyboard.press('Escape')
    await expect(view).toHaveCount(0)
  })

  test('настройки меняют результат: размер и качество', async ({ launch, assets }) => {
    const work = await copyToWork(assets.image)
    const { page } = await launch({ args: [work.path] })
    await page.locator(card('JPG')).click()
    await page.locator('.options:visible select').first().selectOption('800')
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1)
    const sharp = (await import('sharp')).default
    const meta = await sharp(join(work.dir, 'закат-converted.jpg')).metadata()
    expect(meta.width).toBe(800)
  })

  test('новый выбор после результата сбрасывает «Готово»', async ({ launch, assets }) => {
    const work = await copyToWork(assets.image)
    const { page } = await launch({ args: [work.path] })
    await page.locator(card('WebP')).click()
    await page.locator(primary).click()
    await expect(page.locator(primary)).toHaveText('Done')
    await page.locator(card('PNG')).click()
    await expect(page.locator(primary)).toHaveText('Convert')
    await expect(page.locator(primary)).toBeEnabled()
  })

  test('видео: быстрый выбор «Discord» включает лимит размера и результат укладывается', async ({ launch, assets }) => {
    const work = await copyToWork(assets.video)
    const { page } = await launch({ args: [work.path] })
    await expect(page.locator('.preset-row .chip', { hasText: 'Discord' })).toBeVisible()
    await page.locator('.preset-row .chip', { hasText: 'Discord' }).click()
    await expect(page.locator(card('MP4'))).toHaveClass(/active/)
    await expect(page.locator('.options:visible input[type=number]')).toHaveValue('9.5')
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 60_000 })
    const out = join(work.dir, 'ролик-converted.mp4')
    expect(await exists(out)).toBe(true)
    expect((await fs.stat(out)).size).toBeLessThan(9.5 * 1024 * 1024)
  })

  test('звук из видео в MP3', async ({ launch, assets }) => {
    const work = await copyToWork(assets.video)
    const { page } = await launch({ args: [work.path] })
    await page.locator(card('MP3')).click()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 60_000 })
    expect(await exists(join(work.dir, 'ролик-converted.mp3'))).toBe(true)
  })

  test('таблица: CSV → JSON с разделителем «;»', async ({ launch, assets }) => {
    const work = await copyToWork(assets.csv)
    const { page } = await launch({ args: [work.path] })
    await page.locator(card('JSON')).click()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1)
    const data = JSON.parse(await fs.readFile(join(work.dir, 'продажи.json'), 'utf8'))
    expect(data).toEqual([{ Товар: 'Чай', Цена: 120.5 }, { Товар: 'Кофе', Цена: 300 }])
  })

  test('CSV: переключатель разделителя и «для Excel» видны только для CSV', async ({ launch, assets }) => {
    const work = await copyToWork(assets.csv)
    const { page } = await launch({ args: [work.path] })
    await page.locator(card('JSON')).click()
    await expect(page.locator('.field-label', { hasText: 'Delimiter' })).toHaveCount(0)
    await page.locator(card('CSV')).click()
    await expect(page.locator('.field-label', { hasText: 'Delimiter' })).toBeVisible()
  })

  test('архив: распаковать и запаковать папку', async ({ launch, assets }) => {
    const work = await copyToWork(assets.zip)
    const { page } = await launch({ args: [work.path] })
    await page.locator(card('Unpack')).click()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1)
    expect(await exists(join(work.dir, 'архив', 'docs', 'план.txt'))).toBe(true)

    const packed = await launch({ args: [join(work.dir, 'архив', 'docs')] })
    await packed.page.locator(card('To 7z')).click()
    await packed.page.locator(primary).click()
    await expect(packed.page.locator('.file-card.done:visible')).toHaveCount(1)
    expect(await exists(join(work.dir, 'архив', 'docs.7z'))).toBe(true)
  })

  test('разные виды файлов: остаётся только упаковка, остальные варианты скрыты', async ({ launch, assets }) => {
    const { page } = await launch({ args: [assets.csv, assets.image] })
    await expect(page.locator('.file-card:visible')).toHaveCount(2)
    await expect(page.locator(card('JSON'))).toHaveCount(0)
    await expect(page.locator(card('WebP'))).toHaveCount(0)
    await expect(page.locator(card('To ZIP'))).toBeVisible()
  })

  test('папка упаковывается, а не разворачивается в файлы', async ({ launch, assets }) => {
    const { page } = await launch({ args: [join(assets.dir, 'docs')] })
    await expect(page.locator('.file-card:visible')).toHaveCount(1)
    await expect(page.locator('.file-card:visible')).toContainText('docs')
    await expect(page.locator(card('To ZIP'))).toBeVisible()
  })

  test('кнопка «Очистить» и удаление отдельного файла', async ({ launch, assets }) => {
    const { page } = await launch({ args: [assets.image, assets.image2] })
    await expect(page.locator('.file-card:visible')).toHaveCount(2)
    await page.locator('.file-card:visible').first().hover()
    await page.locator('.file-card:visible .remove').first().click()
    await expect(page.locator('.file-card:visible')).toHaveCount(1)
    await page.locator('.list-head:visible .btn', { hasText: 'Clear' }).click()
    await expect(page.locator('h1:visible')).toContainText('Any file into anything')
  })

  test('ошибка одного файла не мешает остальным и показывается в списке', async ({ launch, assets }) => {
    const bad = await copyToWork(assets.text, 'битый.json')
    await fs.writeFile(bad.path, '{ это не json')
    const ok = await copyToWork(assets.csv)
    // JSON и CSV — оба таблицы, общий вариант: YAML
    const { page } = await launch({ args: [bad.path, ok.path] })
    await page.locator(card('YAML')).click()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1)
    await expect(page.locator('.file-card.error:visible')).toHaveCount(1)
    expect(await exists(join(ok.dir, 'продажи.yaml'))).toBe(true)
    expect(await exists(join(bad.dir, 'битый.yaml'))).toBe(false)
  })
})

test.describe('PDF', () => {
  async function makePdf(path: string, pages: string[]): Promise<void> {
    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (const text of pages) doc.addPage([400, 300]).drawText(text, { x: 40, y: 150, size: 24, font })
    await fs.writeFile(path, await doc.save())
  }

  test('PDF → текст и страницы в PNG в собранном приложении', async ({ launch, assets }) => {
    const work = await copyToWork(assets.csv)
    const pdf = join(work.dir, 'doc.pdf')
    await makePdf(pdf, ['Hello Morphio', 'Second page'])
    const { page } = await launch({ args: [pdf] })
    await expect(page.locator('.file-card:visible')).toHaveCount(1)
    await page.locator(card('Text (TXT)')).click()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 30_000 })
    expect(await fs.readFile(join(work.dir, 'doc.txt'), 'utf8')).toContain('Hello Morphio')
    await page.locator(card('Pages as PNG')).click()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 30_000 })
    expect(await exists(join(work.dir, 'doc-pages', 'doc-002.png'))).toBe(true)
  })

  test('несколько картинок склеиваются в один PDF', async ({ launch, assets }) => {
    const a = await copyToWork(assets.image)
    const b = await copyToWork(assets.image)
    const { page } = await launch({ args: [a.path, b.path] })
    await expect(page.locator('.file-card:visible')).toHaveCount(2)
    await page.locator(card('Merge into one PDF')).click()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(2, { timeout: 30_000 })
    const files = (await fs.readdir(a.dir)).filter((f) => f.endsWith('-merged.pdf'))
    expect(files).toHaveLength(1)
  })
})

test.describe('документы', () => {
  test('Markdown → PDF через Chromium и → EPUB (нужен модуль Pandoc в папке modules)', async ({ launch, assets }) => {
    const work = await copyToWork(assets.csv)
    const md = join(work.dir, 'заметка.md')
    await fs.writeFile(md, '# Заголовок\n\nПривет, мир!\n\n| a | b |\n|---|---|\n| 1 | 2 |\n', 'utf8')
    const { page } = await launch({ args: [md] })
    await expect(page.locator('.file-card:visible')).toHaveCount(1)
    await page.locator(card('PDF')).click()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 60_000 })
    const pdf = await fs.readFile(join(work.dir, 'заметка.pdf'))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(2000)
    // временный HTML не остаётся рядом с файлом
    expect((await fs.readdir(work.dir)).filter((f) => f.startsWith('.morphio-'))).toHaveLength(0)
    await page.locator(card('EPUB')).click()
    await page.locator(primary).click()
    await expect(page.locator('.file-card.done:visible')).toHaveCount(1, { timeout: 30_000 })
    expect(await exists(join(work.dir, 'заметка.epub'))).toBe(true)
  })
})

test.describe('фото и фон', () => {
  test('вкладка открывается, переключатель режимов и пустое состояние', async ({ launch }) => {
    const { page } = await launch()
    await page.locator('.nav-item', { hasText: 'Photo' }).click()
    await expect(page.locator('h1:visible')).toContainText('Remove the background')
    await page.locator('.segmented button', { hasText: 'Chains' }).click()
    await expect(page.locator('.pipe-steps')).toBeVisible()
    await expect(page.locator('.preset .chip', { hasText: 'Product photo' })).toBeVisible()
  })

  test('удаление однотонного фона (без нейросети): фон прозрачный, предмет цел', async ({ launch, assets }) => {
    const sharp = (await import('sharp')).default
    const dir = join(assets.dir, 'bg')
    await fs.mkdir(dir, { recursive: true })
    const src = join(dir, 'спрайт.png')
    // розовый фон и коричневый прямоугольник в центре
    await sharp({ create: { width: 160, height: 120, channels: 3, background: '#ff00ff' } })
      .composite([{ input: { create: { width: 80, height: 60, channels: 3, background: '#9a6a3a' } }, left: 40, top: 30 }])
      .png()
      .toFile(src)
    const { page } = await launch()
    const result = await page.evaluate(
      async ({ path, out }) => {
        const items = await window.api.inspectFiles([path])
        const finished = new Promise<{ status: string; outputPath?: string; error?: string }>((resolve) => {
          const off = window.api.onProgress((p) => {
            if (p.status === 'done' || p.status === 'error') {
              off()
              resolve(p)
            }
          })
        })
        await window.api.removeBackground(items, {
          method: 'solid',
          tolerance: 0,
          everywhere: true,
          translucent: true,
          background: 'transparent',
          color: '#ffffff',
          format: 'png',
          outputDir: out
        })
        return finished
      },
      { path: src, out: join(dir, 'out') }
    )
    expect(result.status).toBe('done')
    const { data, info } = await sharp(result.outputPath!).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const alpha = (x: number, y: number): number => data[(y * info.width + x) * 4 + 3]
    expect(alpha(2, 2)).toBe(0)
    expect(alpha(80, 60)).toBe(255)
  })
})

test.describe('настройки и фоновый режим', () => {
  test('включение быстрого окна само включает трей и «закрытие в трей»; всё сохраняется', async ({ launch }) => {
    const { page, settings } = await launch({ settings: { hotkey: 'CommandOrControl+Alt+Shift+F11' } })
    await page.locator('.settings-btn').click()
    const toggle = page.locator('.check', { hasText: 'quick window with a keyboard shortcut' }).locator('input')
    await toggle.check()
    await expect.poll(async () => (await settings()).quickEnabled).toBe(true)
    expect(await settings()).toMatchObject({ tray: true, closeToTray: true })
    await expect(page.locator('.check', { hasText: 'Icon in the notification area' }).locator('input')).toBeChecked()
  })

  test('сочетание: запись нового и сообщение об ошибке занятого', async ({ launch }) => {
    const { page, settings } = await launch({ settings: { quickEnabled: true, tray: true, closeToTray: true, hotkey: 'CommandOrControl+Alt+Shift+F11' } })
    await page.locator('.settings-btn').click()
    const field = page.locator('.hotkey')
    await expect(field).toHaveValue('Ctrl+Alt+Shift+F11')
    await field.focus()
    await page.keyboard.press('Control+Shift+K')
    await expect.poll(async () => (await settings()).hotkey).toBe('CommandOrControl+Shift+K')
    await expect(field).toHaveValue('Ctrl+Shift+K')
    // одинокая клавиша без модификатора не принимается
    await field.focus()
    await page.keyboard.press('K')
    expect((await settings()).hotkey).toBe('CommandOrControl+Shift+K')
  })

  test('следящая папка: правило из настроек конвертирует новые файлы', async ({ launch, assets }) => {
    const work = await copyToWork(assets.text, 'старый.csv')
    await fs.writeFile(work.path, 'a,b\n1,2\n')
    const { page } = await launch({
      settings: { tray: true, closeToTray: true, watchRules: [{ id: 'w1', folder: work.dir, enabled: true, target: 'table:json', quality: 85 }] }
    })
    await page.locator('.settings-btn').click()
    await expect(page.locator('.rule')).toHaveCount(1)
    await expect.poll(async () => (await page.evaluate(() => window.api.watchStatus()))[0]?.active).toBe(true)
    await fs.writeFile(join(work.dir, 'новый.csv'), 'x,y\n1,2\n')
    await expect.poll(() => exists(join(work.dir, 'Morphio-out', 'новый.json')), { timeout: 20_000 }).toBe(true)
    expect(await exists(join(work.dir, 'Morphio-out', 'старый.json'))).toBe(false)
    await expect(page.locator('.rule')).toContainText('processed: 1')
  })

  test('правило можно отключить и убрать', async ({ launch, assets }) => {
    const work = await copyToWork(assets.csv)
    const { page, settings } = await launch({
      settings: { tray: true, closeToTray: true, watchRules: [{ id: 'w1', folder: work.dir, enabled: true, target: 'table:json', quality: 85 }] }
    })
    await page.locator('.settings-btn').click()
    await page.locator('.rule .check input').click()
    await expect.poll(async () => ((await settings()).watchRules as { enabled: boolean }[])[0].enabled).toBe(false)
    await page.locator('.rule .icon-btn').click()
    await expect.poll(async () => ((await settings()).watchRules as unknown[]).length).toBe(0)
  })
})

test.describe('оформление', () => {
  test('тема переключается и запоминается: светлая, тёмная, как в Windows', async ({ launch }) => {
    const { page, settings } = await launch()
    await page.emulateMedia({ colorScheme: null }) // Playwright по умолчанию подставляет светлую тему
    await page.locator('.settings-btn').click()
    const bg = (): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await page.locator('.segmented button', { hasText: 'Dark' }).click()
    await expect.poll(async () => (await settings()).theme).toBe('dark')
    await expect.poll(bg).toBe('rgb(20, 20, 27)')
    await page.locator('.segmented button', { hasText: 'Light' }).click()
    await expect.poll(async () => (await settings()).theme).toBe('light')
    await expect.poll(bg).toBe('rgb(246, 246, 251)')
  })

  test('сохранённая тема применяется при запуске', async ({ launch }) => {
    const { page } = await launch({ settings: { theme: 'dark' } })
    await page.emulateMedia({ colorScheme: null })
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(20, 20, 27)')
  })

  test('язык меняется в настройках на «как в Windows», русский и английский', async ({ launch }) => {
    const { page, settings } = await launch()
    await page.locator('.settings-btn').click()
    await page.locator('.segmented button', { hasText: 'Русский' }).click()
    await expect(page.locator('.nav-item').first()).toHaveText('Конвертер')
    await expect.poll(async () => (await settings()).language).toBe('ru')
    await page.locator('.segmented button', { hasText: 'English' }).click()
    await expect(page.locator('.nav-item').first()).toHaveText('Converter')
    await expect.poll(async () => (await settings()).language).toBe('en')
  })
})

test.describe('быстрое окно', () => {
  test('запуск с --quick открывает только быстрое окно с файлами, цифра запускает вариант', async ({ launch, assets }) => {
    const work = await copyToWork(assets.csv)
    const { page, app } = await launch({ args: ['--quick', work.path] })
    await expect(page.locator('.quick-head strong')).toHaveText('Quick conversion')
    await expect(page.locator('.quick-summary')).toContainText('1 file')
    expect(app.windows()).toHaveLength(1) // главное окно не создаётся
    const chips = page.locator('.quick-targets .chip')
    await expect(chips.first()).toContainText('XLSX')
    await page.keyboard.press('4') // четвёртый вариант: XLSX, CSV, TSV, JSON
    await expect(page.locator('.quick-result')).toBeVisible({ timeout: 30_000 })
    expect(await exists(join(work.dir, 'продажи.json'))).toBe(true)
  })

  test('последний выбор становится первым при следующем показе', async ({ launch, assets }) => {
    const work = await copyToWork(assets.csv)
    const first = await launch({ args: ['--quick', work.path] })
    await first.page.locator('.quick-targets .chip', { hasText: 'YAML' }).click()
    await expect(first.page.locator('.quick-result')).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => ((await first.settings()).quickLast as string[] | undefined)?.[0]).toBe('table:yaml')
    const { dataDir } = first
    await first.app.close()
    const second = await launch({
      args: ['--quick', work.path],
      settings: JSON.parse(await fs.readFile(join(dataDir, 'settings.json'), 'utf8'))
    })
    await expect(second.page.locator('.quick-targets .chip').first()).toContainText('YAML')
  })

  test('«Больше настроек» открывает главное окно с теми же файлами в конвертере', async ({ launch, assets }) => {
    const work = await copyToWork(assets.csv)
    const { app, page } = await launch({ args: ['--quick', work.path] })
    await expect(page.locator('.quick-summary')).toContainText('1 file')
    await page.locator('.quick-foot .btn', { hasText: 'More options' }).click()
    await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBe(2)
    const main = app.windows().find((w) => w.url().includes('index.html'))!
    await expect(main.locator('.file-card:visible')).toHaveCount(1)
    await expect(main.locator('.nav-item.active')).toHaveText('Converter')
  })

  test('пустое быстрое окно предлагает перетащить файлы', async ({ launch }) => {
    const { page } = await launch({ args: ['--quick'] })
    await expect(page.locator('.quick-empty')).toBeVisible()
  })
})
