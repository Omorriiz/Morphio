import { promises as fs } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import Papa from 'papaparse'
import ExcelJS from 'exceljs'
import YAML from 'yaml'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import iconv from 'iconv-lite'
import jschardet from 'jschardet'
import type { FileItem, UniversalOptions } from '@shared/types'
import { freePath } from '../files'
import { tm } from '../tm'
import type { JobResult } from '../queue'

export type Cell = string | number | boolean | null
export interface Sheet {
  name: string
  /** Первая строка — заголовки */
  rows: Cell[][]
}
export interface Table {
  sheets: Sheet[]
}

/** Лимит на размер входного файла, чтобы случайно не съесть всю память. */
const MAX_BYTES = 200 * 1024 * 1024

// ---------- чтение ----------

/** Расшифровывает текст: сначала строгий UTF-8, потом определение кодировки (русские CSV часто в Windows-1251). */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    const guess = jschardet.detect(buf.subarray(0, 200_000))
    const enc = guess.encoding && iconv.encodingExists(guess.encoding) ? guess.encoding : 'windows-1251'
    return iconv.decode(buf, enc)
  }
}

/** Числа и логические значения в CSV становятся настоящими (для XLSX и JSON), но «007» и длинные номера остаются текстом. */
function infer(value: string, decimalComma = false): Cell {
  if (value === '') return null
  if (/^-?(0|[1-9]\d{0,14})(\.\d{1,15})?$/.test(value)) return Number(value)
  // «120,5» в файлах с разделителем «;» (как сохраняет русский Excel) — тоже число
  if (decimalComma && /^-?(0|[1-9]\d{0,14}),\d{1,15}$/.test(value)) return Number(value.replace(',', '.'))
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

const isPrimitive = (v: unknown): v is string | number | boolean | null =>
  v === null || ['string', 'number', 'boolean'].includes(typeof v)

function toCell(v: unknown): Cell {
  if (v === undefined || v === null) return null
  if (v instanceof Date) return v.toISOString()
  if (isPrimitive(v)) return v
  return JSON.stringify(v)
}

/** Список записей → строки с заголовками (объединение ключей по порядку появления). */
function recordsToRows(records: unknown[]): Cell[][] {
  if (records.length > 0 && records.every((r) => Array.isArray(r))) {
    return (records as unknown[][]).map((r) => r.map(toCell))
  }
  if (records.every((r) => isPrimitive(r))) {
    return [['value'], ...records.map((r) => [toCell(r)])]
  }
  const keys: string[] = []
  for (const r of records) {
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k)
    }
  }
  if (keys.length === 0) keys.push('value')
  return [
    keys,
    ...records.map((r) =>
      r && typeof r === 'object' && !Array.isArray(r)
        ? keys.map((k) => toCell((r as Record<string, unknown>)[k]))
        : keys.map((k, i) => (i === 0 ? toCell(r) : null))
    )
  ]
}

/** Находит в разобранном XML/JSON список однотипных записей. */
function findRecords(node: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(node)) return node
  if (node && typeof node === 'object' && depth < 4) {
    for (const v of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(v)) return v
    }
    for (const v of Object.values(node as Record<string, unknown>)) {
      const found = findRecords(v, depth + 1)
      if (found) return found
    }
  }
  return null
}

function dataToTable(data: unknown, fallbackName: string): Table {
  // {"Лист1": [...], "Лист2": [...]} — несколько листов (так мы сами пишем многолистовые файлы).
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data as Record<string, unknown>)
    if (entries.length > 1 && entries.every(([, v]) => Array.isArray(v))) {
      return { sheets: entries.map(([name, v]) => ({ name, rows: recordsToRows(v as unknown[]) })) }
    }
  }
  const records = Array.isArray(data) ? data : findRecords(data)
  return { sheets: [{ name: fallbackName, rows: recordsToRows(records ?? [data]) }] }
}

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>
    if ('result' in o) return cellValue(o.result as ExcelJS.CellValue)
    if ('richText' in o) return (o.richText as { text: string }[]).map((r) => r.text).join('')
    if ('text' in o) return String(o.text)
    if ('error' in o) return String(o.error)
    return JSON.stringify(v)
  }
  return v as Cell
}

export async function readTable(path: string): Promise<Table> {
  const stat = await fs.stat(path)
  if (stat.size > MAX_BYTES) throw new Error(tm('Файл слишком большой для таблицы (больше 200 МБ)'))
  const ext = extname(path).slice(1).toLowerCase()
  const name = basename(path, extname(path))

  if (ext === 'xlsx') {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(path)
    const sheets: Sheet[] = []
    wb.eachSheet((ws) => {
      const rows: Cell[][] = []
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = (row.values as ExcelJS.CellValue[]).slice(1)
        rows.push(Array.from({ length: Math.max(vals.length, 0) }, (_, i) => cellValue(vals[i])))
      })
      const width = rows.reduce((m, r) => Math.max(m, r.length), 0)
      sheets.push({ name: ws.name, rows: rows.map((r) => [...r, ...Array(width - r.length).fill(null)]) })
    })
    if (sheets.length === 0) throw new Error(tm('В книге нет листов'))
    return { sheets }
  }

  const text = decodeText(await fs.readFile(path))
  if (ext === 'csv' || ext === 'tsv') {
    const parsed = Papa.parse<string[]>(text, {
      skipEmptyLines: 'greedy',
      delimiter: ext === 'tsv' ? '\t' : '',
      delimitersToGuess: [',', ';', '\t', '|']
    })
    // Если запятая не разделитель столбцов, она может быть десятичной
    const decimalComma = parsed.meta.delimiter !== ','
    const rows = parsed.data.map((r) => r.map((c) => infer(c, decimalComma)))
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0)
    return { sheets: [{ name, rows: rows.map((r) => [...r, ...Array(width - r.length).fill(null)]) }] }
  }
  if (ext === 'json') return dataToTable(JSON.parse(text), name)
  if (ext === 'yaml' || ext === 'yml') return dataToTable(YAML.parse(text), name)
  if (ext === 'xml') {
    const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: true, trimValues: true })
    return dataToTable(xml.parse(text), name)
  }
  throw new Error(tm('Неизвестный формат таблицы: {ext}', { ext }))
}

// ---------- запись ----------

/** Заголовки без пустых и повторяющихся имён. */
function headers(first: Cell[]): string[] {
  const seen = new Map<string, number>()
  return first.map((c, i) => {
    let h = c === null || c === '' ? `column${i + 1}` : String(c)
    const n = (seen.get(h) ?? 0) + 1
    seen.set(h, n)
    if (n > 1) h = `${h}_${n}`
    return h
  })
}

function sheetRecords(sheet: Sheet): Record<string, Cell>[] {
  const [head = [], ...body] = sheet.rows
  const keys = headers(head)
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null])))
}

function xmlName(s: string): string {
  const clean = s.replace(/[^\p{L}\p{N}_.-]/gu, '_')
  return /^[\p{L}_]/u.test(clean) ? clean : `_${clean}`
}

function sheetFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'sheet'
}

function excelSheetName(name: string, used: Set<string>): string {
  let n = name.replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet'
  let i = 2
  while (used.has(n.toLowerCase())) n = `${n.slice(0, 28)}_${i++}`
  used.add(n.toLowerCase())
  return n
}

async function writeOne(
  path: string,
  target: string,
  sheets: Sheet[],
  options: UniversalOptions
): Promise<void> {
  if (target === 'xlsx') {
    const wb = new ExcelJS.Workbook()
    const used = new Set<string>()
    for (const s of sheets) {
      const ws = wb.addWorksheet(excelSheetName(s.name, used))
      ws.addRows(s.rows)
      ws.getRow(1).font = { bold: true }
      ws.columns.forEach((col, i) => {
        const longest = s.rows.reduce((m, r) => Math.max(m, String(r[i] ?? '').length), 0)
        col.width = Math.min(60, Math.max(8, longest + 2))
      })
    }
    await wb.xlsx.writeFile(path)
    return
  }
  if (target === 'json' || target === 'yaml') {
    const data =
      sheets.length === 1
        ? sheetRecords(sheets[0])
        : Object.fromEntries(sheets.map((s) => [s.name, sheetRecords(s)]))
    await fs.writeFile(path, target === 'json' ? JSON.stringify(data, null, 2) : YAML.stringify(data), 'utf8')
    return
  }
  if (target === 'xml') {
    const rowsOf = (s: Sheet): unknown[] =>
      sheetRecords(s).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [xmlName(k), v ?? ''])))
    const body =
      sheets.length === 1
        ? { row: rowsOf(sheets[0]) }
        : { sheet: sheets.map((s) => ({ '@_name': s.name, row: rowsOf(s) })) }
    const builder = new XMLBuilder({ format: true, ignoreAttributes: false, indentBy: '  ', suppressEmptyNode: false })
    await fs.writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({ data: body })}`, 'utf8')
    return
  }
  // csv / tsv
  const delimiter = target === 'tsv' ? '\t' : options.csvDelimiter
  const csv = Papa.unparse(sheets[0].rows.map((r) => r.map((c) => (c === null ? '' : c))), {
    delimiter,
    newline: '\r\n'
  })
  await fs.writeFile(path, (target === 'csv' && options.csvBom ? '﻿' : '') + csv, 'utf8')
}

/** Превращает таблицу из одного формата в другой. Многолистовая книга в CSV/TSV даёт по файлу на лист. */
export async function convertTable(item: FileItem, options: UniversalOptions): Promise<JobResult> {
  const target = options.target.split(':')[1]
  const table = await readTable(item.path)
  const dir = options.outputDir ?? dirname(item.path)
  await fs.mkdir(dir, { recursive: true })
  const base = basename(item.path, extname(item.path))
  const rowCount = table.sheets.reduce((n, s) => n + Math.max(0, s.rows.length - 1), 0)

  const written: string[] = []
  try {
    if ((target === 'csv' || target === 'tsv') && table.sheets.length > 1) {
      for (const s of table.sheets) {
        const out = await freePath(dir, `${base}-${sheetFileName(s.name)}`, target)
        await writeOne(out, target, [s], options)
        written.push(out)
      }
    } else {
      const out = await freePath(dir, base, target)
      await writeOne(out, target, table.sheets, options)
      written.push(out)
    }
  } catch (e) {
    await Promise.all(written.map((f) => fs.rm(f, { force: true })))
    throw e
  }

  let size = 0
  for (const f of written) size += (await fs.stat(f)).size
  const info =
    written.length > 1
      ? tm('{files} файлов по листам, строк: {rows}', { files: written.length, rows: rowCount })
      : tm('строк: {rows}', { rows: rowCount })
  return { outputPath: written[0], outputSize: size, info }
}
