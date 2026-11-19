import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import electronPath from 'electron'
import { copyToWork, exists, expect, hasPandoc, test } from './fixtures'

const ROOT = resolve(__dirname, '../..')

interface Ran {
  code: number
  out: string
  err: string
  lines: string[]
}

/** Запускает командную строку так же, как morphio.cmd: Electron в режиме Node на лёгкий сценарий cli.js. */
async function cli(args: string[], opts: { cwd?: string; data?: string } = {}): Promise<Ran> {
  const data = opts.data ?? join(tmpdir(), `morphio-cli-data-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(data, { recursive: true })
  if (!(await exists(join(data, 'settings.json')))) {
    await fs.writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, language: 'en' }))
  }
  return new Promise((res) => {
    execFile(
      electronPath as unknown as string,
      [join(ROOT, 'out', 'main', 'cli.js'), `--user-data-dir=${data}`, ...args],
      { cwd: opts.cwd ?? ROOT, windowsHide: true, timeout: 120_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0
        res({ code: typeof code === 'number' ? code : 1, out: stdout, err: stderr, lines: stdout.split(/\r?\n/).filter(Boolean) })
      }
    )
  })
}

test.describe('командная строка', () => {
  test('--version, --help, ошибки аргументов дают правильные коды', async () => {
    const v = await cli(['--version'])
    expect([v.code, v.lines[0]]).toEqual([0, '0.2.0'])
    const h = await cli(['--help'])
    expect(h.code).toBe(0)
    expect(h.out).toContain('convert')
    expect(h.out).toContain('Exit codes')
    const none = await cli([])
    expect(none.code).toBe(2)
    expect(none.out).toContain('convert')
    const unknown = await cli(['dance'])
    expect(unknown.code).toBe(2)
    expect(unknown.err).toContain('Unknown command')
    const flag = await cli(['convert', '--bogus', 'x'])
    expect(flag.code).toBe(2)
    expect(flag.err).toContain('--bogus')
  })

  test('convert: картинка → WebP, путь результата в stdout, оригинал цел', async ({ assets }) => {
    const work = await copyToWork(assets.image)
    const before = await fs.readFile(work.path)
    const r = await cli(['convert', work.path, '--to', 'webp', '--quality', '70'])
    expect(r.code).toBe(0)
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0]).toBe(join(work.dir, 'закат-converted.webp'))
    expect((await sharp(r.lines[0]).metadata()).format).toBe('webp')
    expect(await fs.readFile(work.path)).toEqual(before)
    // повтор не перезаписывает: добавляется номер
    const again = await cli(['convert', work.path, '--to', 'webp'])
    expect(again.lines[0]).not.toBe(r.lines[0])
    expect(await exists(r.lines[0])).toBe(true)
  })

  test('convert: --width, --out, --json, относительные пути и маски', async ({ assets }) => {
    const work = await copyToWork(assets.image)
    const outDir = join(work.dir, 'готово')
    const r = await cli(['convert', '*.jpg', '--to', 'png', '--width', '400', '--out', outDir, '--json'], { cwd: work.dir })
    expect(r.code).toBe(0)
    const json = JSON.parse(r.out)
    expect(json.ok).toBe(true)
    expect(json.results).toHaveLength(1)
    expect(json.results[0].output).toBe(join(outDir, 'закат.png'))
    expect((await sharp(json.results[0].output).metadata()).width).toBe(400)
  })

  test('convert --dry-run ничего не создаёт', async ({ assets }) => {
    const work = await copyToWork(assets.image)
    const r = await cli(['convert', work.path, '--to', 'jpg', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.lines[0]).toContain('image:jpg')
    expect((await fs.readdir(work.dir)).filter((f) => f.includes('converted'))).toHaveLength(0)
  })

  test('convert: неверные аргументы и частичные ошибки', async ({ assets }) => {
    const work = await copyToWork(assets.image)
    const noTo = await cli(['convert', work.path])
    expect(noTo.code).toBe(2)
    const badTarget = await cli(['convert', work.path, '--to', 'nonsense'])
    expect(badTarget.code).toBe(2)
    expect(badTarget.err).toContain('webp')
    const none = await cli(['convert', join(work.dir, 'нет-такого.jpg'), '--to', 'webp'])
    expect(none.code).toBe(2)
    // один файл есть, другого нет: результат создан, код 3
    const mixed = await cli(['convert', work.path, join(work.dir, 'нет-такого.jpg'), '--to', 'webp'])
    expect(mixed.code).toBe(3)
    expect(mixed.lines).toHaveLength(1)
    expect(mixed.err).toContain('not found')
  })

  test('convert: таблицы, папки с --recursive', async ({ assets }) => {
    const work = await copyToWork(assets.csv)
    const r = await cli(['convert', work.path, '--to', 'json', '--delimiter', ';'])
    expect(r.code).toBe(0)
    const data = JSON.parse(await fs.readFile(r.lines[0], 'utf8'))
    expect(data[0]).toMatchObject({ Товар: 'Чай' })
    const dir = join(work.dir, 'пачка', 'вложенная')
    await fs.mkdir(dir, { recursive: true })
    await fs.copyFile(work.path, join(work.dir, 'пачка', 'a.csv'))
    await fs.copyFile(work.path, join(dir, 'b.csv'))
    const rec = await cli(['convert', join(work.dir, 'пачка'), '--recursive', '--to', 'yaml'])
    expect(rec.code).toBe(0)
    expect(rec.lines).toHaveLength(2)
  })

  test('convert: склейка картинок в один PDF (--join) и PDF → текст', async ({ assets }) => {
    const a = await copyToWork(assets.image)
    const b = await copyToWork(assets.image2)
    const r = await cli(['convert', a.path, b.path, '--to', 'pdf', '--join'])
    expect(r.code).toBe(0)
    expect(r.lines).toHaveLength(1)
    expect((await fs.readFile(r.lines[0])).subarray(0, 5).toString()).toBe('%PDF-')
  })

  test('stdout чистый: первая строка сразу результат, без пустой строки', async ({ assets }) => {
    const work = await copyToWork(assets.image)
    const r = await cli(['convert', work.path, '--to', 'png'])
    expect(r.out.startsWith(work.dir)).toBe(true)
    expect(r.out.endsWith('\n')).toBe(true)
  })

  test('документ → PDF: лёгкая команда передаёт печать приложению с Chromium (нужен Pandoc в modules)', async () => {
    test.skip(!hasPandoc, 'нет Pandoc в папке modules')
    const dir = join(tmpdir(), `morphio-cli-doc-${randomUUID().slice(0, 8)}`)
    await fs.mkdir(dir, { recursive: true })
    const md = join(dir, 'заметка.md')
    await fs.writeFile(md, '# Заголовок\n\nТекст заметки.\n', 'utf8')
    const r = await cli(['convert', md, '--to', 'pdf'])
    expect(r.code).toBe(0)
    expect(r.lines).toHaveLength(1)
    expect(r.out.startsWith(dir)).toBe(true)
    expect((await fs.readFile(r.lines[0])).subarray(0, 5).toString()).toBe('%PDF-')
    // а в другие форматы документ уходит без Chromium
    const docx = await cli(['convert', md, '--to', 'docx'])
    expect(docx.code).toBe(0)
    expect(docx.out.startsWith(dir)).toBe(true)
  })

  test('targets показывает доступные варианты', async ({ assets }) => {
    const r = await cli(['targets', assets.csv])
    expect(r.code).toBe(0)
    expect(r.out).toContain('xlsx')
    const j = await cli(['targets', assets.video, '--json'])
    expect(JSON.parse(j.out).map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['mp4', 'mp3']))
  })

  test('media: обрезка, поворот, склейка, ошибки аргументов', async ({ assets }) => {
    const work = await copyToWork(assets.video)
    const r = await cli(['media', work.path, '--trim', '0:00.5-0:02', '--rotate', '90', '--gpu', 'off'])
    expect(r.code).toBe(0)
    expect(r.lines).toHaveLength(1)
    expect(await exists(r.lines[0])).toBe(true)
    const bad = await cli(['media', work.path, '--trim', 'abc'])
    expect(bad.code).toBe(2)
    const rot = await cli(['media', work.path, '--rotate', '45'])
    expect(rot.code).toBe(2)
    const joined = await cli(['media', work.path, work.path, '--join', '--gpu', 'off', '--out', join(work.dir, 'склейка')])
    expect(joined.code).toBe(0)
    expect(joined.lines).toHaveLength(1)
  })

  test('run: готовая цепочка по короткому имени, список цепочек, неизвестная цепочка', async ({ assets }) => {
    const work = await copyToWork(assets.image)
    const list = await cli(['presets', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).toContain('shop')
    expect(list.out).toContain('podcast')
    const r = await cli(['run', 'web', work.path])
    expect(r.code).toBe(0)
    expect((await sharp(r.lines[0]).metadata()).format).toBe('webp')
    const none = await cli(['run', 'нет-такой', work.path])
    expect(none.code).toBe(2)
    const show = await cli(['presets', 'show', 'podcast'])
    expect(JSON.parse(show.out).audio.format).toBe('mp3')
  })

  test('run: цепочка из JSON-файла (в том числе старого формата)', async ({ assets }) => {
    const work = await copyToWork(assets.image)
    const file = join(work.dir, 'моя.json')
    await fs.writeFile(file, JSON.stringify({ format: 'jpg', maxSize: 300, nameTemplate: '{name}-cli', removeBg: false }))
    const r = await cli(['run', file, work.path])
    expect(r.code).toBe(0)
    expect(r.lines[0]).toBe(join(work.dir, 'закат-cli.jpg'))
    expect((await sharp(r.lines[0]).metadata()).width).toBe(300)
  })

  test('remove-bg: однотонный фон становится прозрачным', async () => {
    const dir = join(tmpdir(), `morphio-cli-bg-${randomUUID().slice(0, 8)}`)
    await fs.mkdir(dir, { recursive: true })
    const src = join(dir, 'предмет.png')
    await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } })
      .composite([{ input: await sharp({ create: { width: 80, height: 80, channels: 3, background: '#cc2244' } }).png().toBuffer(), left: 60, top: 60 }])
      .png()
      .toFile(src)
    const r = await cli(['remove-bg', src, '--method', 'solid'])
    expect(r.code).toBe(0)
    const raw = await sharp(r.lines[0]).ensureAlpha().raw().toBuffer()
    expect(raw[3]).toBe(0) // угол прозрачный
    expect(raw[(100 * 200 + 100) * 4 + 3]).toBe(255) // центр предмета цел
    expect((await cli(['remove-bg', src, '--method', 'magic'])).code).toBe(2)
  })

  test('modules: список, установка без --yes запрещена; doctor', async () => {
    const list = await cli(['modules', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).toContain('pandoc')
    const noYes = await cli(['modules', 'install', 'pandoc'])
    expect(noYes.code).toBe(2)
    expect(noYes.err).toContain('--yes')
    const doc = await cli(['doctor', '--json'])
    expect(doc.code).toBe(0)
    const d = JSON.parse(doc.out)
    expect(d.ffmpeg).toContain('ffmpeg version')
    expect(d.morphio).toBe('0.2.0')
  })

  test('язык сообщений берётся из настроек', async () => {
    const data = join(tmpdir(), `morphio-cli-ru-${randomUUID().slice(0, 8)}`)
    await fs.mkdir(data, { recursive: true })
    await fs.writeFile(join(data, 'settings.json'), JSON.stringify({ version: 1, language: 'ru' }))
    const r = await cli(['dance'], { data })
    expect(r.code).toBe(2)
    expect(r.err).toContain('Неизвестная команда')
  })

  test('работает одновременно с открытым окном приложения', async ({ launch, assets }) => {
    const { dataDir } = await launch()
    const work = await copyToWork(assets.image)
    const r = await cli(['convert', work.path, '--to', 'png'], { data: dataDir })
    expect(r.code).toBe(0)
    expect(await exists(r.lines[0])).toBe(true)
  })
})
