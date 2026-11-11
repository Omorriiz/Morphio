// Генерация иконок Morphio из логотипа: build/icon.ico, build/icon.png, ассеты интерфейса.
// Логотип (build/logo-icon.webp) — с прозрачным фоном. Запуск: node scripts/make-icon.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const logoFile = join(root, 'build', 'logo-icon.webp')

/** Рамка знака по прозрачности (слабые артефакты по краям игнорируем). */
async function logoBounds() {
  const { data, info } = await sharp(logoFile)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let minX = info.width
  let minY = info.height
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 40) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { minX, minY, maxX, maxY, w: info.width, h: info.height }
}

/** Квадратный кадр вокруг области (cx, cy, side), без выхода за границы исходника. */
function squareRegion(b, cx, cy, side) {
  side = Math.min(side, b.w, b.h)
  const left = Math.max(0, Math.min(b.w - side, Math.round(cx - side / 2)))
  const top = Math.max(0, Math.min(b.h - side, Math.round(cy - side / 2)))
  return { left, top, width: side, height: side }
}

const b = await logoBounds()
const cx = (b.minX + b.maxX) / 2
const cy = (b.minY + b.maxY) / 2
const side = Math.max(b.maxX - b.minX, b.maxY - b.minY)

// Весь знак с небольшим полем — для больших размеров.
const fullRegion = squareRegion(b, cx, cy, Math.round(side * 1.08))
// Крупный план «M» и папки — для маленьких размеров (в 16–48 px целый знак сливается).
const markRegion = squareRegion(b, cx - side * 0.02, cy + side * 0.03, Math.round(side * 0.66))

const render = (region, size) =>
  sharp(logoFile).ensureAlpha().extract(region).resize(size, size).png().toBuffer()
const full = (size) => render(fullRegion, size)
const mark = (size) => render(markRegion, size)

// ICO со встроенными PNG: большие размеры — полный знак, маленькие — крупный план.
const entries = []
for (const size of [256, 128, 64]) entries.push({ size, data: await full(size) })
for (const size of [48, 32, 24, 16]) entries.push({ size, data: await mark(size) })

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(entries.length, 4)
let offset = 6 + entries.length * 16
const dirs = []
for (const e of entries) {
  const d = Buffer.alloc(16)
  d.writeUInt8(e.size >= 256 ? 0 : e.size, 0)
  d.writeUInt8(e.size >= 256 ? 0 : e.size, 1)
  d.writeUInt8(0, 2)
  d.writeUInt8(0, 3)
  d.writeUInt16LE(1, 4)
  d.writeUInt16LE(32, 6)
  d.writeUInt32LE(e.data.length, 8)
  d.writeUInt32LE(offset, 12)
  offset += e.data.length
  dirs.push(d)
}
writeFileSync(join(root, 'build', 'icon.ico'), Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)]))
writeFileSync(join(root, 'build', 'icon.png'), await full(512))

// Ассеты интерфейса: знак в боковой панели (прозрачный фон, подходит к любой теме).
const assets = join(root, 'src', 'renderer', 'src', 'assets')
mkdirSync(assets, { recursive: true })
writeFileSync(join(assets, 'logo-mark.png'), await full(128))
writeFileSync(join(assets, 'logo.png'), await full(256))

console.log(
  `Иконки готовы (знак ${b.maxX - b.minX}×${b.maxY - b.minY}px): build/icon.ico, build/icon.png, src/renderer/src/assets/`
)
