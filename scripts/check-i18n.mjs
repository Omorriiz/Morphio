// Проверка переводов: все строки из t()/tm()/tr() есть в словаре, плейсхолдеры совпадают.
// Запуск: npm run i18n
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../src/', import.meta.url))

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : ['.ts', '.tsx'].includes(extname(p)) ? [p] : []
  })
}

const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\')

// Словарь
const enSrc = readFileSync(join(root, 'shared/en.ts'), 'utf8')
const en = new Map()
for (const m of enSrc.matchAll(/^ {2}'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)',?$/gm)) {
  en.set(unescape(m[1]), unescape(m[2]))
}

// Ключи в коде. Строки, которые попадают в t() не литералом (например, подписи в таблицах),
// перечислены в словаре отдельно и считаются «используемыми».
const used = new Set()
const missing = []
let allSource = ''
for (const file of walk(root)) {
  if (file.endsWith('devMock.ts') || file.endsWith('en.ts') || file.endsWith('i18n.ts') || file.endsWith('i18n.tsx')) continue
  const src = readFileSync(file, 'utf8')
  allSource += src + '\n'
  // Подписи в таблицах (label / hint / name) переводятся при показе: t(item.label).
  for (const m of src.matchAll(/\b(?:label|hint|name):\s*'((?:[^'\\]|\\.)*[А-Яа-яЁё](?:[^'\\]|\\.)*)'/g)) {
    const key = unescape(m[1])
    used.add(key)
    if (!en.has(key)) missing.push(`${file.replace(root, '')}: ${key}`)
  }
  for (const m of src.matchAll(/(?<![\w.])(?:t|tm|tr)\(\s*'((?:[^'\\]|\\.)*)'/g)) {
    const key = unescape(m[1])
    used.add(key)
    if (!en.has(key)) missing.push(`${file.replace(root, '')}: ${key}`)
  }
}

const bad = []
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
for (const [ru, eng] of en) {
  // «один|много»: у обеих форм те же подстановки, что у русского текста, и среди них есть {n}
  const forms = eng.split('|')
  if (forms.length > 1 && !ru.includes('{n}')) bad.push(`plural form needs {n}: ${ru}`)
  if (forms.some((f) => placeholders(ru) !== placeholders(f))) bad.push(`placeholders differ: ${ru}`)
  if (/[А-Яа-яЁё]/.test(eng)) bad.push(`Russian left in English text: ${ru}`)
}

// Лишние записи словаря: русский текст нигде в коде не встречается (строка переименована или удалена).
// Строки, которые попадают в t() не литералом (например, в devMock.ts), тоже ищутся по тексту.
const unused = [...en.keys()].filter((k) => !allSource.includes(k) && !allSource.includes(k.replace(/'/g, "\'")))
if (unused.length) bad.push(...unused.map((k) => `unused dictionary entry: ${k}`))

console.log(`dictionary: ${en.size} entries, ${used.size} literal keys in code`)
if (missing.length) console.log('MISSING translations:\n  ' + missing.join('\n  '))
if (bad.length) console.log('PROBLEMS:\n  ' + bad.join('\n  '))
process.exit(missing.length || bad.length ? 1 : 0)
