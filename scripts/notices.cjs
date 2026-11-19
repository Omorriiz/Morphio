#!/usr/bin/env node
/**
 * THIRD_PARTY_NOTICES.txt: список программ и библиотек, которые идут в сборку, с лицензиями.
 * Читает только package.json пакетов из node_modules (без сети): `node scripts/notices.cjs`.
 * Основа: рабочие зависимости проекта и все их зависимости; программы вне npm (FFmpeg, модели, Pandoc и др.) перечислены вручную.
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Внешние программы и модели, которые не приходят из npm. */
const EXTRA = [
  { name: 'FFmpeg (gyan.dev essentials 6.1.1)', license: 'GPL-3.0-or-later', url: 'https://ffmpeg.org/ , https://www.gyan.dev/ffmpeg/builds/', note: 'Запускается как отдельная программа. Исходный код: https://ffmpeg.org/download.html и https://github.com/GyanD/codexffmpeg' },
  { name: 'ISNet general use (DIS)', license: 'Apache-2.0', url: 'https://github.com/xuebinqin/DIS', note: 'Модель удаления фона, скачивается по кнопке' },
  { name: 'Real-ESRGAN general-x4v3', license: 'BSD-3-Clause', url: 'https://github.com/xinntao/Real-ESRGAN', note: 'Модель увеличения фото, скачивается по кнопке' },
  { name: 'Tesseract OCR data (tessdata_fast)', license: 'Apache-2.0', url: 'https://github.com/tesseract-ocr/tessdata_fast', note: 'Языки распознавания, скачиваются по кнопке' },
  { name: 'whisper.cpp / Whisper models', license: 'MIT', url: 'https://github.com/ggml-org/whisper.cpp', note: 'Распознавание речи, скачивается по кнопке' },
  { name: 'Pandoc', license: 'GPL-2.0-or-later', url: 'https://pandoc.org', note: 'Отдельный модуль документов, скачивается по кнопке; запускается как отдельная программа' },
  { name: '7-Zip', license: 'LGPL-2.1-or-later (с правилом unRAR)', url: 'https://www.7-zip.org', note: 'Архивы, через пакет 7zip-bin' }
]

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function licenseOf(j) {
  if (!j) return 'UNKNOWN'
  if (typeof j.license === 'string') return j.license
  if (j.license && j.license.type) return j.license.type
  if (Array.isArray(j.licenses)) return j.licenses.map((l) => l.type || l).join(' OR ')
  return 'UNKNOWN'
}

/** Находит пакет по имени, начиная с папки родителя (как это делает Node). */
function find(name, from) {
  let dir = from
  for (;;) {
    const p = path.join(dir, 'node_modules', name, 'package.json')
    if (fs.existsSync(p)) return p
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function collect() {
  const seen = new Map()
  const queue = Object.keys(pkg.dependencies || {}).map((n) => ({ name: n, from: root }))
  while (queue.length) {
    const { name, from } = queue.shift()
    const p = find(name, from)
    if (!p) continue
    const j = readJson(p)
    if (!j) continue
    const key = `${j.name}@${j.version}`
    if (seen.has(key)) continue
    seen.set(key, { name: j.name, version: j.version, license: licenseOf(j), url: (j.repository && (j.repository.url || j.repository)) || j.homepage || '' })
    for (const dep of Object.keys(j.dependencies || {})) queue.push({ name: dep, from: path.dirname(p) })
    for (const dep of Object.keys(j.optionalDependencies || {})) queue.push({ name: dep, from: path.dirname(p) })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

function render(list) {
  const lines = [
    'THIRD-PARTY NOTICES / СТОРОННИЕ КОМПОНЕНТЫ',
    '',
    'Morphio uses the programs and libraries below. Each keeps its own licence.',
    'Morphio использует перечисленные программы и библиотеки; у каждой своя лицензия.',
    '',
    '== Programs and models outside npm / Программы и модели вне npm ==',
    ''
  ]
  for (const e of EXTRA) lines.push(`${e.name}\n  Licence: ${e.license}\n  ${e.url}\n  ${e.note}\n`)
  lines.push('== npm packages / Пакеты npm ==', '')
  for (const e of list) lines.push(`${e.name} ${e.version}  [${e.license}]${e.url ? '  ' + String(e.url).replace(/^git\+/, '') : ''}`)
  const unknown = list.filter((e) => e.license === 'UNKNOWN')
  if (unknown.length) lines.push('', `Licence not found in package.json for: ${unknown.map((e) => e.name).join(', ')}`)
  return lines.join('\n') + '\n'
}

if (require.main === module) {
  const list = collect()
  fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), render(list))
  console.log(`THIRD_PARTY_NOTICES.txt: ${list.length} packages`)
}
module.exports = { collect, render, licenseOf }
