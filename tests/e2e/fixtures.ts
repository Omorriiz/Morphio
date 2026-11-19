import { _electron as electron, expect, test as base } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'
import { path7za } from '7zip-bin'

const ROOT = resolve(__dirname, '../..')

export interface Launched {
  app: ElectronApplication
  page: Page
  dataDir: string
  /** Читает settings.json этого запуска */
  settings: () => Promise<Record<string, unknown>>
  close: () => Promise<void>
}

/** Файлы для проверок, созданные один раз на весь прогон. */
export interface Assets {
  dir: string
  image: string
  image2: string
  video: string
  audio: string
  csv: string
  zip: string
  text: string
}

async function build(): Promise<Assets> {
  const dir = join(tmpdir(), `morphio-e2e-assets-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(join(dir, 'docs', 'вложенная'), { recursive: true })
  const svg = (w: number, h: number, a: string, b: string): Buffer =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 4}" fill="#fff"/></svg>`
    )
  const image = join(dir, 'закат.jpg')
  const image2 = join(dir, 'лес.png')
  await sharp(svg(1600, 1000, '#ff7ab6', '#7364f0')).jpeg({ quality: 92 }).toFile(image)
  await sharp(svg(1200, 800, '#22cc88', '#4f8cff')).png().toFile(image2)
  const video = join(dir, 'ролик.mp4')
  execFileSync(ffmpegPath as string, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video], { stdio: 'ignore' })
  const audio = join(dir, 'мелодия.wav')
  execFileSync(ffmpegPath as string, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', audio], { stdio: 'ignore' })
  const csv = join(dir, 'продажи.csv')
  await fs.writeFile(csv, 'Товар;Цена\nЧай;120,5\nКофе;300\n')
  const text = join(dir, 'заметка.txt')
  await fs.writeFile(text, 'x'.repeat(100))
  await fs.writeFile(join(dir, 'docs', 'план.txt'), 'план '.repeat(500))
  await fs.writeFile(join(dir, 'docs', 'вложенная', 'данные.bin'), Buffer.alloc(20_000, 3))
  const zip = join(dir, 'архив.zip')
  execFileSync(path7za, ['a', '-tzip', zip, join(dir, 'docs')], { stdio: 'ignore' })
  return { dir, image, image2, video, audio, csv, zip, text }
}

type Fixtures = {
  assets: Assets
  launch: (opts?: {
    settings?: Record<string, unknown>
    /** Содержимое settings.json как есть (например, повреждённое) */
    rawSettings?: string
    args?: string[]
    env?: Record<string, string>
  }) => Promise<Launched>
}

let cachedAssets: Promise<Assets> | null = null

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  assets: async ({}, use) => {
    cachedAssets ??= build()
    await use(await cachedAssets)
  },
  // eslint-disable-next-line no-empty-pattern
  launch: async ({}, use) => {
    const opened: Launched[] = []
    const launch: Fixtures['launch'] = async (opts = {}) => {
      const dataDir = join(tmpdir(), `morphio-e2e-data-${randomUUID().slice(0, 8)}`)
      await fs.mkdir(dataDir, { recursive: true })
      await fs.writeFile(
        join(dataDir, 'settings.json'),
        opts.rawSettings ?? JSON.stringify({ version: 1, language: 'en', ...opts.settings })
      )
      const app = await electron.launch({
        executablePath: require('electron') as unknown as string,
        args: [ROOT, `--user-data-dir=${dataDir}`, ...(opts.args ?? [])],
        env: { ...process.env, MORPHIO_KEEP_QUICK: '1', ...opts.env } as Record<string, string>
      })
      // Окон может быть два (главное и быстрое): выбираем нужное по адресу страницы
      const wantQuick = (opts.args ?? []).includes('--quick')
      const page = await windowByUrl(app, wantQuick ? 'quick.html' : 'index.html')
      await page.waitForLoadState('domcontentloaded')
      const launched: Launched = {
        app,
        page,
        dataDir,
        settings: async () => JSON.parse(await fs.readFile(join(dataDir, 'settings.json'), 'utf8')),
        close: async () => {
          await app.close().catch(() => {})
          // дать Windows освободить файлы перед удалением
          await new Promise((r) => setTimeout(r, 500))
          await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {})
        }
      }
      opened.push(launched)
      return launched
    }
    await use(launch)
    await Promise.all(opened.map((o) => o.close()))
  }
})

/** Ждёт окно, адрес страницы которого содержит указанный текст. */
export async function windowByUrl(app: ElectronApplication, part: string, timeoutMs = 20_000): Promise<Page> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const w = app.windows().find((x) => x.url().includes(part))
    if (w) return w
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`окно ${part} не появилось`)
}

/** Копия файла в отдельной папке: тест может спокойно создавать рядом результаты. */
export async function copyToWork(src: string, name?: string): Promise<{ dir: string; path: string }> {
  const dir = join(tmpdir(), `morphio-e2e-work-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  const path = join(dir, name ?? src.split(/[\\/]/).pop()!)
  await fs.copyFile(src, path)
  return { dir, path }
}

/** Pandoc лежит в modules (в разработке да, на чистой машине CI нет): тесты документов без него пропускаются. */
export const hasPandoc = existsSync(join(ROOT, 'modules', 'pandoc', '3.14', '.ok'))

export const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false)

export { expect }
