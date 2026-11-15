import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import ExcelJS from 'exceljs'
import { convertTable, decodeText, readTable } from '../../src/main/converters/tables'
import { defaultUniversalOptions } from '../../src/shared/types'
import type { UniversalOptions } from '../../src/shared/types'
import { cleanupAfterAll, exists, fileItem, tmpDir } from '../helpers'

cleanupAfterAll()

const opts = (target: string, out: string, extra: Partial<UniversalOptions> = {}): UniversalOptions => ({
  ...defaultUniversalOptions(target, out),
  csvBom: false,
  ...extra
})
const convert = async (path: string, target: string, out: string, extra: Partial<UniversalOptions> = {}) =>
  convertTable(await fileItem(path), opts(target, out, extra))

describe('decodeText', () => {
  it('UTF-8 с BOM и без', () => {
    expect(decodeText(Buffer.from('﻿привет', 'utf8'))).toBe('привет')
    expect(decodeText(Buffer.from('привет', 'utf8'))).toBe('привет')
  })

  it('Windows-1251 определяется сама', () => {
    expect(decodeText(iconv.encode('Имя;Город\nИван;Москва', 'win1251'))).toBe('Имя;Город\nИван;Москва')
  })

  it('UTF-16 с BOM', () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('текст', 'utf16le')]))).toBe('текст')
  })
})

describe('чтение CSV', () => {
  it('разделитель «;», кодировка Windows-1251, числа становятся числами', async () => {
    const dir = await tmpDir('csv')
    const p = join(dir, 'люди.csv')
    await fs.writeFile(p, iconv.encode('Имя;Город;Возраст;Индекс\nИван;Москва;30;007\nМария;Санкт-Петербург;25;190000\n', 'win1251'))
    const t = await readTable(p)
    expect(t.sheets).toHaveLength(1)
    expect(t.sheets[0].rows[0]).toEqual(['Имя', 'Город', 'Возраст', 'Индекс'])
    expect(t.sheets[0].rows[1]).toEqual(['Иван', 'Москва', 30, '007']) // «007» остаётся текстом
    expect(t.sheets[0].rows[2][3]).toBe(190000)
  })

  it('TSV, запятая и «|» тоже распознаются', async () => {
    const dir = await tmpDir('csv')
    await fs.writeFile(join(dir, 'a.tsv'), 'a\tb\n1\t2\n')
    await fs.writeFile(join(dir, 'b.csv'), 'a,b\n1,2\n')
    await fs.writeFile(join(dir, 'c.csv'), 'a|b\n1|2\n')
    for (const f of ['a.tsv', 'b.csv', 'c.csv']) {
      expect((await readTable(join(dir, f))).sheets[0].rows).toEqual([['a', 'b'], [1, 2]])
    }
  })

  it('пустые строки пропускаются, короткие строки дополняются', async () => {
    const dir = await tmpDir('csv')
    await fs.writeFile(join(dir, 'a.csv'), 'a,b,c\n\n1,2\n\n')
    expect((await readTable(join(dir, 'a.csv'))).sheets[0].rows).toEqual([['a', 'b', 'c'], [1, 2, null]])
  })

  it('десятичная запятая в файле с «;» даёт число, а в файле с запятой-разделителем — остаётся текстом', async () => {
    const dir = await tmpDir('csv')
    await fs.writeFile(join(dir, 'ru.csv'), 'цена;кол\n120,5;3\n-0,25;1\n')
    expect((await readTable(join(dir, 'ru.csv'))).sheets[0].rows).toEqual([['цена', 'кол'], [120.5, 3], [-0.25, 1]])
    await fs.writeFile(join(dir, 'en.csv'), 'a,b\n"1,5",2\n')
    expect((await readTable(join(dir, 'en.csv'))).sheets[0].rows[1][0]).toBe('1,5')
  })

  it('слишком длинные числа остаются текстом (не теряем цифры)', async () => {
    const dir = await tmpDir('csv')
    await fs.writeFile(join(dir, 'a.csv'), 'phone\n79991234567890123\n')
    expect((await readTable(join(dir, 'a.csv'))).sheets[0].rows[1][0]).toBe('79991234567890123')
  })
})

describe('преобразования', () => {
  const csv = 'Имя;Возраст\nАнна;30\nБорис;25\n'

  it('CSV → JSON: список объектов с типами', async () => {
    const dir = await tmpDir('conv')
    const p = join(dir, 'a.csv')
    await fs.writeFile(p, csv)
    const r = await convert(p, 'table:json', join(dir, 'out'))
    expect(JSON.parse(await fs.readFile(r.outputPath, 'utf8'))).toEqual([
      { Имя: 'Анна', Возраст: 30 },
      { Имя: 'Борис', Возраст: 25 }
    ])
    expect(r.info).toContain('2')
  })

  it('JSON → CSV с разделителем «;» и BOM для Excel', async () => {
    const dir = await tmpDir('conv')
    const p = join(dir, 'a.json')
    await fs.writeFile(p, JSON.stringify([{ имя: 'Анна', город: 'Москва' }]))
    const r = await convert(p, 'table:csv', join(dir, 'out'), { csvDelimiter: ';', csvBom: true })
    const buf = await fs.readFile(r.outputPath)
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(buf.toString('utf8')).toContain('имя;город\r\nАнна;Москва')
  })

  it('CSV → XLSX → CSV: данные не меняются', async () => {
    const dir = await tmpDir('conv')
    const p = join(dir, 'a.csv')
    await fs.writeFile(p, csv)
    const x = await convert(p, 'table:xlsx', join(dir, 'out'))
    const back = await readTable(x.outputPath)
    expect(back.sheets[0].rows).toEqual([['Имя', 'Возраст'], ['Анна', 30], ['Борис', 25]])
  })

  it('CSV → YAML → XLSX', async () => {
    const dir = await tmpDir('conv')
    const p = join(dir, 'a.csv')
    await fs.writeFile(p, csv)
    const y = await convert(p, 'table:yaml', join(dir, 'out'))
    expect(await fs.readFile(y.outputPath, 'utf8')).toContain('Имя: Анна')
    const x = await convert(y.outputPath, 'table:xlsx', join(dir, 'out2'))
    expect((await readTable(x.outputPath)).sheets[0].rows).toHaveLength(3)
  })

  it('CSV → XML → CSV: имена тегов — кириллица, значения сохраняются', async () => {
    const dir = await tmpDir('conv')
    const p = join(dir, 'a.csv')
    await fs.writeFile(p, csv)
    const x = await convert(p, 'table:xml', join(dir, 'out'))
    expect(await fs.readFile(x.outputPath, 'utf8')).toContain('<Имя>Анна</Имя>')
    const back = await convert(x.outputPath, 'table:csv', join(dir, 'out2'))
    expect((await readTable(back.outputPath)).sheets[0].rows).toEqual([['Имя', 'Возраст'], ['Анна', 30], ['Борис', 25]])
  })

  it('заголовки: пустые и повторяющиеся получают имена', async () => {
    const dir = await tmpDir('conv')
    const p = join(dir, 'a.csv')
    await fs.writeFile(p, 'a,a,\n1,2,3\n')
    const r = await convert(p, 'table:json', join(dir, 'out'))
    expect(JSON.parse(await fs.readFile(r.outputPath, 'utf8'))[0]).toEqual({ a: 1, a_2: 2, column3: 3 })
  })

  it('XML: недопустимые символы в именах колонок заменяются', async () => {
    const dir = await tmpDir('conv')
    const p = join(dir, 'a.csv')
    await fs.writeFile(p, '1 цена,имя товара\n5,чай\n')
    const r = await convert(p, 'table:xml', join(dir, 'out'))
    const xml = await fs.readFile(r.outputPath, 'utf8')
    expect(xml).toContain('<_1_цена>5</_1_цена>')
    expect(xml).toContain('<имя_товара>чай</имя_товара>')
  })

  it('результат не перезаписывает существующий файл', async () => {
    const dir = await tmpDir('conv')
    const p = join(dir, 'a.csv')
    await fs.writeFile(p, csv)
    const first = await convert(p, 'table:json', dir)
    const second = await convert(p, 'table:json', dir)
    expect(first.outputPath).not.toBe(second.outputPath)
    expect(await exists(first.outputPath)).toBe(true)
  })
})

describe('книга с несколькими листами', () => {
  async function workbook(dir: string): Promise<string> {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('Продажи').addRows([['Товар', 'Цена'], ['Чай', 12.5], ['Кофе', 30]])
    wb.addWorksheet('Склад, адрес').addRows([['Адрес'], ['Москва']])
    const f = wb.addWorksheet('Формулы')
    f.addRows([['a', 'b'], [1, 2]])
    f.getCell('C2').value = { formula: 'A2+B2', result: 3 }
    const p = join(dir, 'книга.xlsx')
    await wb.xlsx.writeFile(p)
    return p
  }

  it('в CSV: по файлу на лист', async () => {
    const dir = await tmpDir('wb')
    const out = join(dir, 'out')
    const r = await convert(await workbook(dir), 'table:csv', out)
    expect(r.info).toContain('3')
    const names = (await fs.readdir(out)).sort()
    expect(names).toEqual(['книга-Формулы.csv', 'книга-Продажи.csv', 'книга-Склад, адрес.csv'].sort())
  })

  it('в JSON: объект «лист → записи», формулы дают значения', async () => {
    const dir = await tmpDir('wb')
    const r = await convert(await workbook(dir), 'table:json', join(dir, 'out'))
    const data = JSON.parse(await fs.readFile(r.outputPath, 'utf8'))
    expect(Object.keys(data)).toEqual(['Продажи', 'Склад, адрес', 'Формулы'])
    expect(data['Продажи'][0]).toEqual({ Товар: 'Чай', Цена: 12.5 })
    expect(data['Формулы'][0]).toMatchObject({ a: 1, b: 2 })
  })

  it('JSON по листам → XLSX возвращает три листа', async () => {
    const dir = await tmpDir('wb')
    const j = await convert(await workbook(dir), 'table:json', join(dir, 'out'))
    const x = await convert(j.outputPath, 'table:xlsx', join(dir, 'out2'))
    expect((await readTable(x.outputPath)).sheets.map((s) => s.name)).toEqual(['Продажи', 'Склад, адрес', 'Формулы'])
  })

  it('в XML: листы как элементы с именем', async () => {
    const dir = await tmpDir('wb')
    const r = await convert(await workbook(dir), 'table:xml', join(dir, 'out'))
    expect(await fs.readFile(r.outputPath, 'utf8')).toContain('name="Продажи"')
  })

  it('имя листа Excel: запрещённые символы убираются, длина до 31', async () => {
    const dir = await tmpDir('wb')
    const p = join(dir, 'a.json')
    await fs.writeFile(p, JSON.stringify({ 'Отчёт: итоги/2026 [черновик] очень длинное название листа': [{ a: 1 }], Второй: [{ b: 2 }] }))
    const r = await convert(p, 'table:xlsx', join(dir, 'out'))
    const names = (await readTable(r.outputPath)).sheets.map((s) => s.name)
    expect(names[0].length).toBeLessThanOrEqual(31)
    expect(names[0]).not.toMatch(/[[\]:*?/\\]/)
  })
})

describe('ошибки', () => {
  it('битый JSON — ошибка, файлов-обломков нет', async () => {
    const dir = await tmpDir('err')
    const p = join(dir, 'bad.json')
    await fs.writeFile(p, '{ oops')
    const out = join(dir, 'out')
    await expect(convert(p, 'table:csv', out)).rejects.toThrow()
    expect(await fs.readdir(out).catch(() => [])).toEqual([])
  })

  it('пустая книга и пустой файл не падают без объяснения', async () => {
    const dir = await tmpDir('err')
    const p = join(dir, 'empty.csv')
    await fs.writeFile(p, '')
    const t = await readTable(p)
    expect(t.sheets[0].rows).toEqual([])
  })

  it('неизвестное расширение', async () => {
    const dir = await tmpDir('err')
    const p = join(dir, 'a.dat')
    await fs.writeFile(p, 'x')
    await expect(readTable(p)).rejects.toThrow()
  })
})
