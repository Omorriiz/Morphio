import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { defaultMontagePlan, defaultUniversalOptions, INPUT_IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '@shared/types'
import type { FileItem, GifBuildOptions, GifFrame, GpuKind, MontagePlan, UniversalOptions, UniversalTarget } from '@shared/types'
import { defaultChain, migrateChain } from '@shared/chains'
import type { ChainConfig } from '@shared/chains'
import { BUILTIN_CHAINS, chainShortId } from '@shared/chainPresets'
import { MEDIA_PRESETS } from '@shared/mediaPresets'
import { runChainItem } from './chains'
import { inspectClips, runMontage } from './converters/montage'
import { calibreBinary } from './converters/documents'
import { detectGpu, extractVideoFrames, probeMedia, run as runFfmpeg } from './ffmpeg'
import { protectPath, setOverwrite } from './files'
import { buildGif, inspectFrames, MAX_FRAMES } from './converters/gif'
import { installModule, moduleList, removeModule } from './modules'
import { describeItem, getTargets, MERGE_TARGET, runMerge, runUniversal } from './registry'
import { tm } from './tm'

/**
 * Командная строка: `Morphio.exe --cli <команда> ...` (обёртка `morphio.cmd` делает из этого `morphio ...`).
 * Выход: пути созданных файлов в stdout, по одному на строку; прогресс и сообщения в stderr.
 * Коды завершения: 0 успех, 1 ошибка, 2 неверные аргументы, 3 часть файлов обработана с ошибками.
 */

export const EXIT = { ok: 0, error: 1, usage: 2, partial: 3 } as const

/** Запущено ли приложение как командная строка. */
export function cliRequested(argv: string[]): boolean {
  return argv.includes('--cli')
}

/** Аргументы после `--cli`. */
export function cliArgs(argv: string[]): string[] {
  const i = argv.indexOf('--cli')
  return i < 0 ? [] : argv.slice(i + 1)
}

// ---------- разбор аргументов ----------

const BOOL_FLAGS = new Set([
  'quiet', 'json', 'dry-run', 'recursive', 'strip-metadata', 'keep-metadata', 'mute', 'yes', 'join', 'help', 'version', 'no-settings',
  'overwrite', 'remove-bg'
])
const VALUE_FLAGS = new Set([
  'to', 'quality', 'width', 'out', 'password', 'level', 'delimiter', 'height', 'max-size', 'preset', 'gpu',
  'audio-bitrate', 'method', 'bg', 'format', 'trim', 'rotate', 'speed', 'normalize', 'name', 'aspect', 'fit', 'lang', 'model',
  'fps', 'delay', 'loop', 'order', 'colors', 'shift', 'track'
])
const SHORT: Record<string, string> = { o: 'out', q: 'quiet', h: 'help', v: 'version', y: 'yes' }

export interface Parsed {
  positionals: string[]
  flags: Record<string, string | true>
  errors: string[]
}

/** Разбирает аргументы: `--ключ значение`, `--ключ=значение`, флаги без значения, `--` заканчивает флаги. */
export function parseCli(args: string[]): Parsed {
  const out: Parsed = { positionals: [], flags: {}, errors: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      out.positionals.push(...args.slice(i + 1))
      break
    }
    let key: string | undefined
    let inline: string | undefined
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=')
      key = eq > 0 ? a.slice(2, eq) : a.slice(2)
      inline = eq > 0 ? a.slice(eq + 1) : undefined
    } else if (/^-[a-zA-Z]$/.test(a)) {
      key = SHORT[a.slice(1)]
      if (!key) {
        out.errors.push(tm('Неизвестный параметр {name}', { name: a }))
        continue
      }
    } else {
      out.positionals.push(a)
      continue
    }
    if (BOOL_FLAGS.has(key)) {
      out.flags[key] = true
    } else if (VALUE_FLAGS.has(key)) {
      const next = args[i + 1]
      // отрицательное число (--normalize -16) считается значением, а не параметром
      const isValue = next !== undefined && (!next.startsWith('-') || /^-\d/.test(next))
      const value = inline ?? (isValue ? next : undefined)
      if (value === undefined) out.errors.push(tm('У параметра --{name} нет значения', { name: key }))
      else {
        out.flags[key] = value
        if (inline === undefined) i++
      }
    } else {
      out.errors.push(tm('Неизвестный параметр {name}', { name: `--${key}` }))
    }
  }
  return out
}

/** «10MB», «500KB», «1.5GB», «12» (МБ) → мегабайты. */
export function parseSizeMB(text: string): number | undefined {
  const m = /^(\d+(?:[.,]\d+)?)\s*(kb|mb|gb)?$/i.exec(text.trim())
  if (!m) return undefined
  const n = Number(m[1].replace(',', '.'))
  const unit = (m[2] ?? 'mb').toLowerCase()
  const mb = unit === 'kb' ? n / 1024 : unit === 'gb' ? n * 1024 : n
  return mb > 0 ? mb : undefined
}

/** «90», «1:30», «0:01:30.5» → секунды. */
export function parseClock(text: string): number | undefined {
  const t = text.trim().replace(',', '.')
  if (!t) return undefined
  const parts = t.split(':').map(Number)
  if (parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return undefined
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/** «00:10-00:25», «10-», «-25» → отрезок. */
export function parseTrim(text: string): { start?: number; end?: number } | undefined {
  const m = /^([^-]*)-([^-]*)$/.exec(text.trim())
  if (!m) return undefined
  const start = m[1] ? parseClock(m[1]) : undefined
  const end = m[2] ? parseClock(m[2]) : undefined
  if ((m[1] && start === undefined) || (m[2] && end === undefined)) return undefined
  if (start === undefined && end === undefined) return undefined
  if (start !== undefined && end !== undefined && end <= start) return undefined
  return { start, end }
}

// ---------- входные файлы ----------

const wildcard = (pattern: string): RegExp =>
  new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')

async function walk(dir: string, out: string[]): Promise<void> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else out.push(p)
  }
}

/**
 * Превращает аргументы в список путей: файлы как есть, маски (`*.jpg`) раскрываются, папки с `--recursive`
 * заменяются файлами внутри. Несуществующие пути возвращаются отдельно.
 */
export async function expandInputs(
  patterns: string[],
  recursive: boolean,
  cwd = process.cwd()
): Promise<{ paths: string[]; missing: string[] }> {
  const paths: string[] = []
  const missing: string[] = []
  for (const raw of patterns) {
    const p = resolve(cwd, raw)
    if (/[*?]/.test(basename(raw))) {
      const dir = dirname(p)
      const re = wildcard(basename(p))
      let names: string[] = []
      try {
        names = (await fs.readdir(dir)).filter((n) => re.test(n)).sort()
      } catch {
        /* папки нет */
      }
      const found: string[] = []
      for (const n of names) {
        const full = join(dir, n)
        const st = await fs.stat(full)
        if (st.isFile()) found.push(full)
        else if (recursive) await walk(full, found)
      }
      if (found.length === 0) missing.push(raw)
      else paths.push(...found)
      continue
    }
    try {
      const st = await fs.stat(p)
      if (st.isDirectory() && recursive) {
        const found: string[] = []
        await walk(p, found)
        paths.push(...found.sort())
      } else paths.push(p)
    } catch {
      missing.push(raw)
    }
  }
  const unique = [...new Set(paths)]
  // исходные файлы нельзя перезаписать, даже с --overwrite
  for (const p of unique) protectPath(p)
  return { paths: unique, missing }
}

// ---------- выбор варианта ----------

const norm = (s: string): string => s.trim().toLowerCase().replace(/[\s_]/g, '')

/** Находит вариант по полному id (`image:webp`), по короткому имени (`webp`) или по названию. */
export function resolveTarget(name: string, targets: UniversalTarget[]): UniversalTarget | undefined {
  const n = norm(name)
  return (
    targets.find((t) => norm(t.id) === n) ??
    targets.find((t) => norm(t.id.split(':')[1] ?? '') === n) ??
    targets.find((t) => norm(t.label) === n)
  )
}

/** Название цепочки: короткий id (`shop`), полный (`builtin-shop`) или имя. */
export function findPreset(name: string): (typeof BUILTIN_CHAINS)[number] | undefined {
  const n = norm(name)
  return BUILTIN_CHAINS.find((p) => norm(p.id) === n || norm(chainShortId(p)) === n || norm(tm(p.name)) === n || norm(p.name) === n)
}

// ---------- вывод ----------

export interface Io {
  out: (text: string) => void
  err: (text: string) => void
}

export interface CliContext {
  version: string
  /** Для `doctor` */
  info: Record<string, string>
  /** Папка с настройками и данными */
  dataDir: string
  io: Io
  /** Модель удаления фона (может быть не скачана) */
  bgModel: () => string | undefined
  /** Запущено внутри Electron (есть Chromium для печати PDF) */
  electron: boolean
  /** Аргументы командной строки как есть: нужны, чтобы передать работу приложению */
  args: string[]
  /** Передаёт команду приложению с Chromium (документ в PDF) */
  delegate?: (args: string[]) => Promise<number>
}

interface Result {
  input: string
  output?: string
  size?: number
  info?: string
  error?: string
}

function report(ctx: CliContext, flags: Parsed['flags'], results: Result[], extra: Record<string, unknown> = {}): number {
  const failed = results.filter((r) => r.error)
  const done = results.filter((r) => !r.error)
  if (flags['json']) {
    ctx.io.out(JSON.stringify({ ok: failed.length === 0, results: done, errors: failed.map((r) => ({ input: r.input, error: r.error })), ...extra }, null, 2))
  } else {
    for (const r of done) if (r.output) ctx.io.out(r.output)
  }
  if (failed.length === 0) return EXIT.ok
  return done.length === 0 ? EXIT.error : EXIT.partial
}

const say = (ctx: CliContext, flags: Parsed['flags'], text: string): void => {
  if (!flags['quiet']) ctx.io.err(text)
}

async function loadItems(ctx: CliContext, p: Parsed, patterns: string[]): Promise<{ items: FileItem[]; early?: number; results: Result[] } | number> {
  const { paths, missing } = await expandInputs(patterns, !!p.flags['recursive'])
  const results: Result[] = missing.map((m) => ({ input: m, error: tm('Файл или папка не найдены') }))
  for (const m of missing) say(ctx, p.flags, `${m}: ${tm('Файл или папка не найдены')}`)
  const items: FileItem[] = []
  for (const path of paths) {
    const it = await describeItem(path, false)
    if (it) items.push(it)
    else {
      results.push({ input: path, error: tm('Не удалось прочитать файл') })
      say(ctx, p.flags, `${path}: ${tm('Не удалось прочитать файл')}`)
    }
  }
  if (items.length === 0) {
    if (!p.flags['json']) ctx.io.err(tm('Нет файлов для обработки'))
    else ctx.io.out(JSON.stringify({ ok: false, results: [], errors: results.map((r) => ({ input: r.input, error: r.error })) }, null, 2))
    return EXIT.usage
  }
  return { items, results }
}

const num = (v: string | true | undefined): number | undefined => {
  if (typeof v !== 'string') return undefined
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : undefined
}

async function pickGpu(flags: Parsed['flags']): Promise<GpuKind | null> {
  const mode = typeof flags['gpu'] === 'string' ? flags['gpu'] : 'auto'
  return mode === 'off' ? null : (await detectGpu()).gpu
}

/** Печатает ход работы для одного файла (в консоли — полоской, в канале — отдельными строками). */
function progressLine(ctx: CliContext, flags: Parsed['flags'], index: number, total: number, name: string): (patch: { percent?: number }) => void {
  let last = -1
  return (patch) => {
    if (flags['quiet'] || patch.percent === undefined) return
    const p = Math.round(patch.percent / 10) * 10
    if (p === last || p === 0) return
    last = p
    ctx.io.err(`[${index}/${total}] ${name} ${p}%`)
  }
}

// ---------- команды ----------

async function cmdConvert(ctx: CliContext, p: Parsed): Promise<number> {
  const loaded = await loadItems(ctx, p, p.positionals.slice(1))
  if (typeof loaded === 'number') return loaded
  const { items, results } = loaded
  const f = p.flags
  const mediaPreset = typeof f['preset'] === 'string' ? MEDIA_PRESETS.find((m) => m.id === f['preset']) : undefined
  if (typeof f['preset'] === 'string' && !mediaPreset) {
    ctx.io.err(tm('Неизвестный набор настроек «{name}». Доступны: {list}', { name: String(f['preset']), list: MEDIA_PRESETS.map((m) => m.id).join(', ') }))
    return EXIT.usage
  }
  const name = typeof f['to'] === 'string' ? f['to'] : mediaPreset?.format
  if (!name) {
    ctx.io.err(tm('Укажите, во что превратить: --to <формат>. Список вариантов: morphio targets <файлы>'))
    return EXIT.usage
  }
  const available = getTargets(items)
  let target = f['join'] && ['pdf', 'merge'].includes(norm(name)) ? available.find((t) => t.id === MERGE_TARGET) : undefined
  target ??= resolveTarget(name, available)
  if (!target) {
    ctx.io.err(
      available.length === 0
        ? tm('У выбранных файлов нет общих вариантов')
        : tm('Такого варианта нет для этих файлов. Доступны: {list}', { list: available.map((t) => t.id.split(':')[1]).join(', ') })
    )
    return EXIT.usage
  }
  if (target.missing && target.group === 'ai') {
    ctx.io.err(tm('Нужен модуль нейросети. Установите его командой: morphio modules install <имя> --yes. Список: morphio modules list'))
    return EXIT.error
  }
  if (target.missing) {
    ctx.io.err(
      target.needs === 'pandoc'
        ? tm('Нужен модуль Pandoc. Установите его командой: morphio modules install pandoc --yes')
        : tm('Для MOBI и AZW3 нужна программа Calibre. Установите её с calibre-ebook.com')
    )
    return EXIT.error
  }

  // Печать документа в PDF идёт через Chromium: в лёгком режиме без окна передаём работу приложению
  if (target.id === 'doc:pdf' && !ctx.electron && ctx.delegate && !f['dry-run']) return ctx.delegate(ctx.args)

  const o: UniversalOptions = defaultUniversalOptions(target.id, typeof f['out'] === 'string' ? resolve(f['out']) : undefined, num(f['quality']) ?? 85)
  o.maxSize = num(f['width'])
  o.keepMetadata = !!f['keep-metadata'] && !f['strip-metadata']
  if (typeof f['password'] === 'string') o.password = f['password']
  if (typeof f['lang'] === 'string') o.lang = f['lang']
  if (typeof f['model'] === 'string') o.aiModel = f['model']
  if (typeof f['shift'] === 'string') {
    const s = num(f['shift'])
    if (s === undefined) {
      ctx.io.err(tm('Сдвиг субтитров — число секунд, например --shift -1.5'))
      return EXIT.usage
    }
    o.shift = s
  }
  if (typeof f['track'] === 'string') o.subTrack = Math.max(0, Math.round(num(f['track']) ?? 1) - 1)
  if (f['level'] === 'fast' || f['level'] === 'normal' || f['level'] === 'max') o.archiveLevel = f['level']
  if (f['delimiter'] === ';' || f['delimiter'] === ',' || f['delimiter'] === 'tab') o.csvDelimiter = f['delimiter'] === 'tab' ? '\t' : f['delimiter']
  const gpu = await pickGpu(f)
  const sizeMB = typeof f['max-size'] === 'string' ? parseSizeMB(f['max-size']) : undefined
  if (typeof f['max-size'] === 'string' && sizeMB === undefined) {
    ctx.io.err(tm('Не понял размер «{v}». Примеры: 10MB, 500KB', { v: f['max-size'] }))
    return EXIT.usage
  }
  o.media = {
    quality: 'medium',
    maxHeight: num(f['height']),
    audioBitrate: num(f['audio-bitrate']) ?? 192,
    mute: !!f['mute'],
    stripMetadata: !f['keep-metadata'],
    useGpu: gpu !== null,
    targetMB: sizeMB,
    ...(mediaPreset?.media ?? {}),
    ...(sizeMB !== undefined ? { targetMB: sizeMB } : {}),
    ...(num(f['height']) !== undefined ? { maxHeight: num(f['height']) } : {}),
    ...(typeof f['audio-bitrate'] === 'string' ? { audioBitrate: num(f['audio-bitrate']) ?? 192 } : {})
  }

  if (f['dry-run']) {
    for (const it of items) ctx.io.out(`${it.path} -> ${target.id}`)
    return EXIT.ok
  }

  const merging = target.id === MERGE_TARGET
  if (merging) {
    say(ctx, f, tm('Склеиваю файлов: {n}', { n: items.length }))
    try {
      const r = await runMerge(items, o, progressLine(ctx, f, 1, 1, tm('склейка')))
      for (const it of items) results.push({ input: it.path, output: r.outputPath, size: r.outputSize, info: r.info })
      // путь результата один на все файлы: в списке stdout он встречается один раз
      const out = results.filter((x) => !x.error)
      const seen = new Set<string>()
      const uniq = out.filter((x) => !seen.has(x.output ?? '') && seen.add(x.output ?? ''))
      return report(ctx, f, [...results.filter((x) => x.error), ...uniq])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      ctx.io.err(msg)
      return EXIT.error
    }
  }

  let n = 0
  for (const it of items) {
    n++
    say(ctx, f, `[${n}/${items.length}] ${it.name}`)
    try {
      const r = await runUniversal(it, o, { gpu }, progressLine(ctx, f, n, items.length, it.name))
      results.push({ input: it.path, output: r.outputPath, size: r.outputSize, info: r.info })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ input: it.path, error: msg })
      ctx.io.err(`${it.name}: ${msg}`)
    }
  }
  return report(ctx, f, results)
}

async function cmdMedia(ctx: CliContext, p: Parsed): Promise<number> {
  const f = p.flags
  const { paths, missing } = await expandInputs(p.positionals.slice(1), !!f['recursive'])
  const results: Result[] = missing.map((m) => ({ input: m, error: tm('Файл или папка не найдены') }))
  for (const m of missing) say(ctx, f, `${m}: ${tm('Файл или папка не найдены')}`)
  const clips = await inspectClips(paths)
  if (clips.length === 0) {
    ctx.io.err(tm('Нет видеофайлов для обработки'))
    return EXIT.usage
  }
  const to = typeof f['to'] === 'string' ? norm(f['to']) : 'mp4'
  if (!['mp4', 'mkv', 'webm'].includes(to)) {
    ctx.io.err(tm('Формат видео: mp4, mkv или webm'))
    return EXIT.usage
  }
  let trim: ReturnType<typeof parseTrim>
  if (typeof f['trim'] === 'string') {
    trim = parseTrim(f['trim'])
    if (!trim) {
      ctx.io.err(tm('Не понял отрезок «{v}». Пример: --trim 00:10-00:25', { v: f['trim'] }))
      return EXIT.usage
    }
  }
  const rotate = f['rotate'] === undefined ? 0 : Number(f['rotate'])
  if (![0, 90, 180, 270].includes(rotate)) {
    ctx.io.err(tm('Поворот: 90, 180 или 270'))
    return EXIT.usage
  }
  const speed = f['speed'] === undefined ? 1 : (num(f['speed']) ?? NaN)
  if (!(speed >= 0.25 && speed <= 4)) {
    ctx.io.err(tm('Скорость должна быть от 0,25× до 4×'))
    return EXIT.usage
  }
  const sizeMB = typeof f['max-size'] === 'string' ? parseSizeMB(f['max-size']) : undefined
  if (typeof f['max-size'] === 'string' && sizeMB === undefined) {
    ctx.io.err(tm('Не понял размер «{v}». Примеры: 10MB, 500KB', { v: f['max-size'] }))
    return EXIT.usage
  }
  const aspect = typeof f['aspect'] === 'string' ? f['aspect'] : undefined
  if (aspect && !['9:16', '1:1', '16:9', '4:5'].includes(aspect)) {
    ctx.io.err(tm('Соотношение сторон: 9:16, 1:1, 4:5 или 16:9'))
    return EXIT.usage
  }
  const gpu = await pickGpu(f)
  const out = typeof f['out'] === 'string' ? resolve(f['out']) : undefined
  const loud = f['normalize'] === undefined ? undefined : num(f['normalize'])
  if (f['normalize'] !== undefined && (loud === undefined || loud > 0 || loud < -70)) {
    ctx.io.err(tm('Громкость: число LUFS от −70 до 0, например −16'))
    return EXIT.usage
  }

  const make = (list: typeof clips): MontagePlan => ({
    ...defaultMontagePlan(),
    clips: list.map((c) => ({
      ...c,
      start: trim?.start,
      end: trim?.end !== undefined ? Math.min(trim.end, c.duration) : undefined
    })),
    trimMode: 'accurate',
    rotate: rotate as MontagePlan['rotate'],
    speed,
    mute: !!f['mute'],
    loudness: loud === undefined ? { mode: 'off', target: -16 } : { mode: 'loudnorm', target: loud },
    fit: aspect ? { aspect: aspect as '9:16', mode: f['fit'] === 'pad' ? 'pad' : 'crop' } : undefined,
    target: to as 'mp4',
    maxHeight: num(f['height']),
    targetMB: sizeMB,
    outputDir: out,
    outputName: typeof f['name'] === 'string' ? f['name'] : undefined,
    useGpu: gpu !== null
  })

  const groups = f['join'] ? [clips] : clips.map((c) => [c])
  if (f['dry-run']) {
    for (const g of groups) ctx.io.out(`${g.map((c) => c.path).join(' + ')} -> ${to}`)
    return EXIT.ok
  }
  let n = 0
  for (const g of groups) {
    n++
    const label = g.length > 1 ? tm('склейка {n} клипов', { n: g.length }) : g[0].name
    say(ctx, f, `[${n}/${groups.length}] ${label}`)
    try {
      const plan = make(g)
      const r = await runMontage(plan, gpu, (percent) => progressLine(ctx, f, n, groups.length, label)({ percent }))
      results.push({ input: g.map((c) => c.path).join(' + '), output: r.outputPath, size: r.outputSize, info: r.info })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ input: g.map((c) => c.path).join(' + '), error: msg })
      ctx.io.err(`${label}: ${msg}`)
    }
  }
  return report(ctx, f, results)
}

async function runChain(ctx: CliContext, p: Parsed, config: ChainConfig, patterns: string[]): Promise<number> {
  const loaded = await loadItems(ctx, p, patterns)
  if (typeof loaded === 'number') return loaded
  const { items, results } = loaded
  const gpu = await pickGpu(p.flags)
  if (p.flags['dry-run']) {
    for (const it of items) ctx.io.out(`${it.path} -> ${it.kind}`)
    return EXIT.ok
  }
  const modelPath = ctx.bgModel()
  if (config.image.enabled && config.image.removeBg && config.image.bgMethod === 'ai' && !modelPath) {
    ctx.io.err(tm('Модель нейросети не скачана. Откройте приложение: «Фото и фон» → «Удалить фон» → «Скачать модель»'))
    return EXIT.error
  }
  let n = 0
  for (const it of items) {
    n++
    say(ctx, p.flags, `[${n}/${items.length}] ${it.name}`)
    try {
      const r = await runChainItem(it, n - 1, config, { gpu, modelPath }, progressLine(ctx, p.flags, n, items.length, it.name))
      results.push({ input: it.path, output: r.outputPath, size: r.outputSize, info: r.info })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ input: it.path, error: msg })
      ctx.io.err(`${it.name}: ${msg}`)
    }
  }
  return report(ctx, p.flags, results)
}

/** Анимация из картинок или из куска видео: gif, webp или apng. */
async function cmdGif(ctx: CliContext, p: Parsed): Promise<number> {
  const f = p.flags
  const { paths, missing } = await expandInputs(p.positionals.slice(1), !!f['recursive'])
  const results: Result[] = missing.map((m) => ({ input: m, error: tm('Файл или папка не найдены') }))
  for (const m of missing) say(ctx, f, `${m}: ${tm('Файл или папка не найдены')}`)
  const extOf = (s: string): string => s.slice(s.lastIndexOf('.') + 1).toLowerCase()
  const videos = paths.filter((x) => VIDEO_EXTENSIONS.includes(extOf(x)))
  const images = paths.filter((x) => INPUT_IMAGE_EXTENSIONS.includes(extOf(x)))
  if (videos.length + images.length === 0) {
    ctx.io.err(tm('Нет картинок или видео для анимации'))
    return EXIT.usage
  }
  if (videos.length > 1 || (videos.length === 1 && images.length > 0)) {
    ctx.io.err(tm('Дайте либо одно видео, либо несколько картинок'))
    return EXIT.usage
  }
  const format = typeof f['format'] === 'string' ? norm(f['format']) : 'gif'
  if (!['gif', 'webp', 'apng'].includes(format)) {
    ctx.io.err(tm('Формат анимации: gif, webp или apng'))
    return EXIT.usage
  }
  const order = typeof f['order'] === 'string' ? f['order'] : 'normal'
  if (!['normal', 'reverse', 'pingpong'].includes(order)) {
    ctx.io.err(tm('Порядок: normal, reverse или pingpong'))
    return EXIT.usage
  }
  const sizeMB = typeof f['max-size'] === 'string' ? parseSizeMB(f['max-size']) : undefined
  if (typeof f['max-size'] === 'string' && sizeMB === undefined) {
    ctx.io.err(tm('Не понял размер «{v}». Примеры: 10MB, 500KB', { v: f['max-size'] }))
    return EXIT.usage
  }
  const fps = Math.min(30, Math.max(1, num(f['fps']) ?? 12))
  let frames: GifFrame[] = []
  let tempDir: string | undefined
  let defaultDelay = Math.max(20, Math.round(num(f['delay']) ?? 100))
  try {
    if (videos.length === 1) {
      const probe = await probeMedia(videos[0])
      if (!probe.hasVideo) {
        ctx.io.err(tm('В файле нет видео'))
        return EXIT.error
      }
      let start = 0
      let end = probe.duration
      if (typeof f['trim'] === 'string') {
        const t = parseTrim(f['trim'])
        if (!t) {
          ctx.io.err(tm('Не понял отрезок «{v}». Примеры: 0:05-0:12, 10-, -0:30', { v: f['trim'] }))
          return EXIT.usage
        }
        start = t.start ?? 0
        end = Math.min(t.end ?? probe.duration, probe.duration)
      }
      const length = Math.min(end - start, MAX_FRAMES / fps)
      if (length <= 0) {
        ctx.io.err(tm('Отрезок пустой: начало позже конца'))
        return EXIT.usage
      }
      say(ctx, f, tm('Беру кадры из видео: {n} кадр/с', { n: fps }))
      const r = await extractVideoFrames({ path: videos[0], start, duration: length, fps, width: num(f['width']) }, () => {})
      frames = r.frames
      defaultDelay = typeof f['delay'] === 'string' ? defaultDelay : r.delay
      tempDir = frames[0] ? dirname(frames[0].path) : undefined
    } else {
      frames = await inspectFrames(images)
    }
    if (frames.length === 0) {
      ctx.io.err(tm('Не удалось получить кадры'))
      return EXIT.error
    }
    const input = videos[0] ?? images[0]
    const options: GifBuildOptions = {
      format: format as GifBuildOptions['format'],
      width: num(f['width']),
      fit: 'contain',
      background: 'transparent',
      defaultDelay,
      loop: Math.max(0, Math.round(num(f['loop']) ?? 0)),
      order: order as GifBuildOptions['order'],
      colours: Math.min(256, Math.max(2, Math.round(num(f['colors']) ?? 256))),
      dither: true,
      quality: num(f['quality']) ?? 80,
      targetKB: sizeMB !== undefined ? Math.round(sizeMB * 1024) : undefined,
      removeBg: f['remove-bg'] ? { method: 'auto', matte: '#ffffff', smooth: true } : undefined,
      name: typeof f['name'] === 'string' ? f['name'] : basename(input, input.slice(input.lastIndexOf('.'))).replace(/[\\/:*?"<>|]/g, '_'),
      // без --out результат лежит рядом с исходником (кадры видео живут во временной папке, её нельзя использовать)
      outputDir: typeof f['out'] === 'string' ? resolve(f['out']) : dirname(input)
    }
    say(ctx, f, tm('Собираю {fmt}: кадров {n}', { fmt: format.toUpperCase(), n: frames.length }))
    let last = -1
    const r = await buildGif(
      frames,
      options,
      (pr) => {
        const pct = Math.round((pr.done / Math.max(1, pr.total)) * 10) * 10
        if (!f['quiet'] && pct !== last && pct > 0) ctx.io.err(`${pr.text} ${pct}%`)
        last = pct
      },
      { modelPath: ctx.bgModel() }
    )
    const info = [`${r.width}×${r.height}`, tm('кадров: {n}', { n: r.frames }), r.note].filter(Boolean).join(' · ')
    if (r.reachedTarget === false) say(ctx, f, tm('Не удалось уложиться в {mb} МБ: получилось {size} КБ', { mb: sizeMB ?? 0, size: Math.round(r.outputSize / 1024) }))
    results.push({ input, output: r.outputPath, size: r.outputSize, info })
    return report(ctx, f, results)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ctx.io.err(msg)
    return EXIT.error
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function cmdRemoveBg(ctx: CliContext, p: Parsed): Promise<number> {
  const f = p.flags
  const method = typeof f['method'] === 'string' ? f['method'] : 'auto'
  if (!['auto', 'solid', 'ai'].includes(method)) {
    ctx.io.err(tm('Метод: auto, solid или ai'))
    return EXIT.usage
  }
  const format = typeof f['format'] === 'string' ? norm(f['format']) : 'png'
  if (!['png', 'webp', 'jpg', 'tiff', 'avif', 'gif'].includes(format)) {
    ctx.io.err(tm('Формат картинки: png, webp, jpg, tiff, avif или gif'))
    return EXIT.usage
  }
  const bg = typeof f['bg'] === 'string' ? f['bg'] : 'transparent'
  if (bg !== 'transparent' && !/^#[0-9a-f]{6}$/i.test(bg)) {
    ctx.io.err(tm('Фон: transparent или цвет вида #ffffff'))
    return EXIT.usage
  }
  const chain = defaultChain()
  const config: ChainConfig = {
    ...chain,
    outputDir: typeof f['out'] === 'string' ? resolve(f['out']) : undefined,
    image: {
      ...chain.image,
      removeBg: true,
      bgMethod: method as 'auto',
      fill: bg === 'transparent' ? 'transparent' : 'color',
      fillColor: bg === 'transparent' ? '#ffffff' : bg,
      format: format as 'png',
      quality: num(f['quality']) ?? 90,
      maxSize: num(f['width']),
      nameTemplate: typeof f['name'] === 'string' ? f['name'] : '{name}-nobg'
    }
  }
  return runChain(ctx, p, config, p.positionals.slice(1))
}

async function cmdRun(ctx: CliContext, p: Parsed): Promise<number> {
  const [, ref, ...files] = p.positionals
  if (!ref || files.length === 0) {
    ctx.io.err(tm('Использование: morphio run <цепочка или файл.json> <файлы>'))
    return EXIT.usage
  }
  let config: ChainConfig
  const preset = findPreset(ref)
  if (preset) config = { ...preset.config }
  else {
    try {
      config = { ...migrateChain(JSON.parse(await fs.readFile(resolve(ref), 'utf8'))) }
    } catch {
      ctx.io.err(tm('Цепочка «{name}» не найдена. Список: morphio presets list', { name: ref }))
      return EXIT.usage
    }
  }
  if (typeof p.flags['out'] === 'string') config.outputDir = resolve(p.flags['out'])
  return runChain(ctx, p, config, files)
}

function cmdPresets(ctx: CliContext, p: Parsed): number {
  const [, sub = 'list', ref] = p.positionals
  if (sub === 'list') {
    if (p.flags['json']) ctx.io.out(JSON.stringify(BUILTIN_CHAINS.map((c) => ({ id: chainShortId(c), name: tm(c.name) })), null, 2))
    else for (const c of BUILTIN_CHAINS) ctx.io.out(`${chainShortId(c).padEnd(12)} ${tm(c.name)}`)
    return EXIT.ok
  }
  if (sub === 'show' && ref) {
    const c = findPreset(ref)
    if (!c) {
      ctx.io.err(tm('Цепочка «{name}» не найдена. Список: morphio presets list', { name: ref }))
      return EXIT.usage
    }
    ctx.io.out(JSON.stringify(c.config, null, 2))
    return EXIT.ok
  }
  ctx.io.err(tm('Использование: morphio presets list / show <имя>'))
  return EXIT.usage
}

async function cmdModules(ctx: CliContext, p: Parsed): Promise<number> {
  const [, sub = 'list', id] = p.positionals
  const list = moduleList()
  if (sub === 'list') {
    if (p.flags['json']) ctx.io.out(JSON.stringify(list, null, 2))
    else for (const m of list) ctx.io.out(`${m.id.padEnd(10)} ${m.version.padEnd(8)} ${m.installed ? tm('установлен') : tm('не установлен')}  ${m.sizeMB} ${tm('МБ')}  ${m.license}`)
    return EXIT.ok
  }
  const mod = list.find((m) => m.id === id)
  if (!id || !mod) {
    ctx.io.err(tm('Использование: morphio modules list / install <имя> --yes / remove <имя>'))
    return EXIT.usage
  }
  if (sub === 'install') {
    if (!p.flags['yes']) {
      ctx.io.err(tm('Будет скачано {size} МБ с {source}. Добавьте --yes, чтобы подтвердить.', { size: mod.sizeMB, source: mod.source }))
      return EXIT.usage
    }
    let error: string | undefined
    let lastPct = -1
    await installModule(id, (pr) => {
      if (pr.phase === 'error') error = pr.error
      else if (pr.phase === 'download' && pr.total > 0 && !p.flags['quiet']) {
        const pct = Math.floor((pr.received / pr.total) * 10) * 10
        if (pct !== lastPct) {
          lastPct = pct
          ctx.io.err(`${mod.name}: ${pct}%`)
        }
      }
    })
    if (error) {
      ctx.io.err(error)
      return EXIT.error
    }
    ctx.io.err(tm('Модуль {name} установлен', { name: mod.name }))
    return EXIT.ok
  }
  if (sub === 'remove') {
    await removeModule(id)
    ctx.io.err(tm('Модуль {name} удалён', { name: mod.name }))
    return EXIT.ok
  }
  ctx.io.err(tm('Использование: morphio modules list / install <имя> --yes / remove <имя>'))
  return EXIT.usage
}

async function cmdTargets(ctx: CliContext, p: Parsed): Promise<number> {
  const loaded = await loadItems(ctx, p, p.positionals.slice(1))
  if (typeof loaded === 'number') return loaded
  const t = getTargets(loaded.items)
  if (p.flags['json']) ctx.io.out(JSON.stringify(t.map((x) => ({ id: x.id, name: x.id.split(':')[1], label: x.label, hint: x.hint, needs: x.needs, missing: !!x.missing })), null, 2))
  else for (const x of t) ctx.io.out(`${(x.id.split(':')[1] ?? x.id).padEnd(12)} ${x.label}${x.missing ? `  (${tm('нужен {name}', { name: x.needs ?? '' })})` : ''}`)
  return EXIT.ok
}

async function cmdDoctor(ctx: CliContext, p: Parsed): Promise<number> {
  let ffmpeg = tm('не найден')
  try {
    const r = await runFfmpeg(['-hide_banner', '-version'])
    ffmpeg = r.stderr.split('\n')[0] || r.stdout.toString('utf8').split('\n')[0] || ffmpeg
  } catch {
    /* оставляем «не найден» */
  }
  const gpu = (await detectGpu()).gpuLabel ?? tm('нет (работает процессор)')
  const mods = moduleList().map((m) => `${m.name} ${m.version}: ${m.installed ? tm('установлен') : tm('не установлен')}`)
  const data = {
    morphio: ctx.version,
    ...ctx.info,
    ffmpeg: ffmpeg.trim(),
    gpu,
    calibre: calibreBinary() ?? tm('не найден'),
    modules: mods,
    dataDir: ctx.dataDir
  }
  if (p.flags['json']) ctx.io.out(JSON.stringify(data, null, 2))
  else {
    ctx.io.out(`Morphio ${ctx.version}`)
    for (const [k, v] of Object.entries(data)) if (k !== 'morphio') ctx.io.out(`${k}: ${Array.isArray(v) ? v.join('; ') : v}`)
  }
  return EXIT.ok
}

function help(ctx: CliContext): void {
  const lines = [
    tm('Morphio: конвертер файлов. Всё работает офлайн.'),
    '',
    tm('Команды:'),
    '  convert <файлы|папки|маски> --to <формат>   ' + tm('конвертировать (webp, jpg, mp3, csv, zip, pdf, docx …)'),
    '  media <видео> [--trim 0:10-0:25] [--rotate 90] [--normalize -16] [--join]   ' + tm('монтаж видео'),
    '  gif <картинки|видео> [--fps 12] [--trim 0:05-0:12] [--width 480] [--max-size 2MB] [--format gif|webp|apng]   ' + tm('анимация из картинок или куска видео'),
    '  remove-bg <картинки> [--method auto|solid|ai] [--bg transparent|#fff]   ' + tm('убрать фон'),
    '  run <цепочка|файл.json> <файлы>   ' + tm('цепочка действий из окна'),
    '  presets list | show <имя>   ' + tm('готовые цепочки'),
    '  targets <файлы>   ' + tm('какие варианты доступны для файлов'),
    '  modules list | install <имя> --yes | remove <имя>',
    '  doctor   ' + tm('версии, FFmpeg, видеокарта, модули, пути'),
    '  convert film.srt --to vtt --shift 2.5 | movie.mkv --to srt --track 2   ' + tm('субтитры: формат, сдвиг, дорожка из видео'),
    '  convert photo.png --to x4 | scan.pdf --to txt --lang rus+eng | talk.mp4 --to srt --lang ru --model small   ' + tm('нейросети (нужны модули)'),
    '',
    tm('Общие параметры:'),
    '  --out, -o <папка>   --quiet, -q   --json   --dry-run   --recursive   --gpu auto|off',
    '  --quality 80   --width 1600   --max-size 10MB   --height 720   --mute   --keep-metadata   --password …',
    '',
    tm('Результат: пути созданных файлов в stdout, ход работы в stderr. Существующие файлы не перезаписываются (к имени добавляется номер); с --overwrite результат заменяет файл с тем же именем, исходные файлы не трогаются.'),
    tm('Коды завершения: 0 успех, 1 ошибка, 2 неверные аргументы, 3 часть файлов не обработана.')
  ]
  for (const l of lines) ctx.io.out(l)
}

/** Выполняет команду и возвращает код завершения. */
export async function runCli(args: string[], ctx: CliContext): Promise<number> {
  const p = parseCli(args)
  if (p.errors.length > 0) {
    for (const e of p.errors) ctx.io.err(e)
    ctx.io.err(tm('Справка: morphio --help'))
    return EXIT.usage
  }
  const cmd = p.positionals[0]
  if (p.flags['version'] || cmd === 'version') {
    ctx.io.out(ctx.version)
    return EXIT.ok
  }
  if (p.flags['help'] || !cmd || cmd === 'help') {
    help(ctx)
    return cmd || p.flags['help'] ? EXIT.ok : EXIT.usage
  }
  setOverwrite(!!p.flags['overwrite'])
  try {
    switch (cmd) {
      case 'convert':
        return await cmdConvert(ctx, p)
      case 'media':
        return await cmdMedia(ctx, p)
      case 'gif':
        return await cmdGif(ctx, p)
      case 'remove-bg':
        return await cmdRemoveBg(ctx, p)
      case 'run':
        return await cmdRun(ctx, p)
      case 'presets':
        return cmdPresets(ctx, p)
      case 'modules':
        return await cmdModules(ctx, p)
      case 'targets':
        return await cmdTargets(ctx, p)
      case 'doctor':
        return await cmdDoctor(ctx, p)
      default:
        ctx.io.err(tm('Неизвестная команда «{name}». Справка: morphio --help', { name: cmd }))
        return EXIT.usage
    }
  } catch (e) {
    ctx.io.err(e instanceof Error ? e.message : String(e))
    return EXIT.error
  }
}

