import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { configureModules } from '../../src/main/modules'
import { convertDocument, docTargetIds, normalizeExt, textToHtml } from '../../src/main/converters/documents'
import { getTargets, kindOfExt } from '../../src/main/registry'
import { defaultUniversalOptions } from '../../src/shared/types'
import { cleanupAfterAll, fileItem, tmpDir } from '../helpers'

cleanupAfterAll()

describe('документы: чистая логика', () => {
  it('textToHtml: абзацы по пустым строкам, разметка не интерпретируется', () => {
    const html = textToHtml('Первая *строка*\nвторая <b>\n\nАбзац два & всё', 'Т')
    expect(html).toContain('<p>Первая *строка*<br>\nвторая &lt;b&gt;</p>')
    expect(html).toContain('<p>Абзац два &amp; всё</p>')
    expect(html).toContain('<title>Т</title>')
  })

  it('варианты: свой формат не предлагается, htm = html, Kindle только через Calibre', () => {
    const ids = (ext: string): string[] => docTargetIds(ext).map((x) => x.id)
    expect(ids('docx')).not.toContain('docx')
    expect(ids('docx')).toEqual(expect.arrayContaining(['pdf', 'epub', 'fb2', 'md', 'txt', 'html']))
    expect(ids('htm')).not.toContain('html')
    expect(ids('markdown')).not.toContain('md')
    expect(docTargetIds('epub').filter((x) => x.calibre).map((x) => x.id)).toEqual(['mobi', 'azw3'])
    expect(docTargetIds('docx').find((x) => x.id === 'pdf')?.calibre).toBe(false)
    // из MOBI Pandoc не читает: все варианты идут через Calibre
    expect(docTargetIds('mobi').every((x) => x.calibre)).toBe(true)
    expect(normalizeExt('HTM')).toBe('html')
  })

  it('реестр: документ определяется, варианты помечены нужным модулем', async () => {
    configureModules([])
    expect(kindOfExt('docx')).toBe('document')
    expect(kindOfExt('mobi')).toBe('document')
    const dir = await tmpDir('doc')
    const f = join(dir, 'a.docx')
    await fs.writeFile(f, 'x')
    const targets = getTargets([await fileItem(f)])
    const pdf = targets.find((t) => t.id === 'doc:pdf')!
    expect(pdf.needs).toBe('pandoc')
    expect(pdf.missing).toBe(true)
    expect(targets.find((t) => t.id === 'doc:mobi')?.needs).toBe('calibre')
  })

  it('без модуля Pandoc выдаётся понятная ошибка', async () => {
    configureModules([])
    const dir = await tmpDir('doc')
    const f = join(dir, 'a.md')
    await fs.writeFile(f, '# Привет')
    await expect(convertDocument(await fileItem(f), 'docx', defaultUniversalOptions('doc:docx'), () => {})).rejects.toThrow(/Pandoc/)
  })
})

// Настоящий Pandoc: тест выполняется, если модуль лежит в папке modules проекта (его докачивает приложение).
const projectModules = join(process.cwd(), 'modules')
const pandocHere = existsSync(join(projectModules, 'pandoc', '3.14', '.ok'))

describe.skipIf(!pandocHere)('документы с настоящим Pandoc', () => {
  const run = async (name: string, content: string | Buffer, format: string): Promise<{ out: string; dir: string }> => {
    configureModules([projectModules])
    const dir = await tmpDir('doc')
    const f = join(dir, name)
    await fs.writeFile(f, content)
    const r = await convertDocument(await fileItem(f), format, defaultUniversalOptions(`doc:${format}`), () => {})
    return { out: r.outputPath, dir }
  }

  it('Markdown → DOCX → Markdown: текст сохраняется (русский тоже)', async () => {
    const a = await run('статья.md', '# Заголовок\n\nПривет, **мир**! Список:\n\n- один\n- два\n', 'docx')
    expect((await fs.readFile(a.out)).subarray(0, 2).toString()).toBe('PK')
    const b = await convertDocument(await fileItem(a.out), 'md', defaultUniversalOptions('doc:md'), () => {})
    const md = await fs.readFile(b.outputPath, 'utf8')
    expect(md).toContain('Заголовок')
    expect(md).toContain('**мир**')
    expect(md).toContain('- один')
  })

  it('TXT → EPUB и EPUB → FB2', async () => {
    const a = await run('книга.txt', 'Глава первая\n\nЖил-был кот.\n\nКонец.', 'epub')
    expect((await fs.readFile(a.out)).subarray(0, 2).toString()).toBe('PK')
    const b = await convertDocument(await fileItem(a.out), 'fb2', defaultUniversalOptions('doc:fb2'), () => {})
    const xml = await fs.readFile(b.outputPath, 'utf8')
    expect(xml).toContain('FictionBook')
    expect(xml).toContain('Жил-был кот')
  })

  it('HTML → TXT, оригинал не тронут, имя не перезаписывается', async () => {
    const a = await run('страница.html', '<html><body><h1>Привет</h1><p>Текст страницы</p></body></html>', 'txt')
    expect(await fs.readFile(a.out, 'utf8')).toContain('Текст страницы')
    const again = await convertDocument(await fileItem(join(a.dir, 'страница.html')), 'txt', defaultUniversalOptions('doc:txt'), () => {})
    expect(again.outputPath).not.toBe(a.out)
  })

  it('внешние картинки в HTML не скачиваются из сети (режим sandbox)', async () => {
    const a = await run('p.html', '<html><body><img src="http://127.0.0.1:9/x.png"><p>ok</p></body></html>', 'docx')
    expect(await exists(a.out)).toBe(true)
  })
})

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false)
}
