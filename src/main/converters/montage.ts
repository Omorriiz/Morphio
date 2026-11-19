import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { GpuKind, MontageClip, MontagePlan } from '@shared/types'
import { freePath } from '../files'
import { probeMedia, run, videoPoster } from '../ffmpeg'
import { tm } from '../tm'
import type { JobResult } from '../queue'
import { audioCodecArgs, heightForBitrate, videoCodecArgs } from './media'
import { decodeText } from './tables'
import { parseSilences } from '@shared/montageEdit'
import type { Range } from '@shared/montageEdit'

/**
 * Монтаж: обрезка по времени, поворот и отражение, склейка, скорость, субтитры и громкость.
 * Все правки собираются в один запуск FFmpeg (один граф фильтров), поэтому качество не теряется на
 * промежуточных файлах. Если можно обойтись без перекодирования, режет без него.
 */

const MAX_CLIPS = 100

const n3 = (n: number): string => String(Math.round(n * 1000) / 1000)

// ---------- чтение клипов ----------

/** Читает видеофайлы для плана монтажа. Файлы без видео пропускаются. */
export async function inspectClips(paths: string[]): Promise<MontageClip[]> {
  const out: MontageClip[] = []
  for (const path of paths) {
    try {
      const probe = await probeMedia(path)
      if (!probe.hasVideo || !probe.width || !probe.height || probe.duration <= 0) continue
      let thumbnail: string | undefined
      try {
        thumbnail = await videoPoster(path, Math.min(probe.duration * 0.1, 3), 160)
      } catch {
        /* превью необязательно */
      }
      out.push({
        id: randomUUID(),
        path,
        name: basename(path),
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        fps: probe.fps ?? 30,
        hasAudio: probe.hasAudio,
        audioTracks: probe.audioTracks,
        vcodec: probe.vcodec,
        acodec: probe.acodec,
        audioRate: probe.audioRate,
        rotation: probe.rotation || undefined,
        thumbnail
      })
    } catch {
      /* не видео */
    }
  }
  return out
}

/** Лента кадров: один JPEG с `count` равными по времени кадрами в ряд. */
export async function filmstrip(path: string, count: number, height: number): Promise<string> {
  const probe = await probeMedia(path)
  const n = Math.min(40, Math.max(2, Math.round(count)))
  const fps = n / Math.max(probe.duration, 0.1)
  const { stdout } = await run([
    '-hide_banner', '-loglevel', 'error',
    '-i', path,
    '-vf', `fps=${fps},scale=-2:${Math.round(height)},tile=${n}x1`,
    '-frames:v', '1',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1'
  ])
  if (stdout.length === 0) throw new Error(tm('Не удалось получить кадр'))
  return `data:image/jpeg;base64,${stdout.toString('base64')}`
}

// ---------- помощники плана ----------

const startOf = (c: MontageClip): number => Math.max(0, Math.min(c.start ?? 0, c.duration))
const endOf = (c: MontageClip): number => Math.min(c.duration, Math.max(c.end ?? c.duration, 0))
export const clipLength = (c: MontageClip): number => Math.max(0, endOf(c) - startOf(c))

/** Длительность результата, секунды. */
export function planDuration(plan: MontagePlan): number {
  const overlap = plan.transition && plan.clips.length > 1 ? (plan.clips.length - 1) * plan.transition.duration : 0
  return Math.max(0, plan.clips.reduce((s, c) => s + clipLength(c), 0) - overlap) / Math.max(plan.speed, 0.1)
}

/** `atempo` принимает 0.5–2: большие и малые скорости складываем из нескольких звеньев. */
export function atempoChain(speed: number): string {
  const parts: number[] = []
  let s = speed
  while (s > 2) {
    parts.push(2)
    s /= 2
  }
  while (s < 0.5) {
    parts.push(0.5)
    s /= 0.5
  }
  parts.push(s)
  return parts.map((x) => `atempo=${n3(x)}`).join(',')
}

function validate(plan: MontagePlan): void {
  if (plan.clips.length === 0) throw new Error(tm('Добавьте хотя бы один видеофайл'))
  if (plan.clips.length > MAX_CLIPS) throw new Error(tm('Слишком много клипов (больше {n})', { n: MAX_CLIPS }))
  if (plan.speed < 0.25 || plan.speed > 4) throw new Error(tm('Скорость должна быть от 0,25× до 4×'))
  for (const c of plan.clips) {
    if (clipLength(c) < 0.05) throw new Error(tm('В клипе «{name}» пустой отрезок: начало позже конца', { name: c.name }))
  }
  const cr = plan.crop
  if (cr && (cr.w < 0.05 || cr.h < 0.05 || cr.x < 0 || cr.y < 0 || cr.x + cr.w > 1.001 || cr.y + cr.h > 1.001)) {
    throw new Error(tm('Рамка кадрирования выходит за кадр или слишком мала'))
  }
  const tr = plan.transition
  if (tr && plan.clips.length > 1) {
    if (tr.duration < 0.1 || tr.duration > 5) throw new Error(tm('Переход должен длиться от 0,1 до 5 секунд'))
    plan.clips.forEach((c, i) => {
      const edges = i === 0 || i === plan.clips.length - 1 ? 1 : 2
      if (clipLength(c) < tr.duration * edges + 0.05) {
        throw new Error(tm('Клип «{name}» слишком короткий для перехода в {sec} с', { name: c.name, sec: tr.duration }))
      }
    })
  }
}

// ---------- субтитры ----------

interface PreparedSubs {
  dir: string
  /** Имя файла внутри dir (для фильтра subtitles, который запускается с cwd = dir) */
  file: string
  kind: 'srt' | 'ass'
}

/** Приводит субтитры к UTF-8, применяет сдвиг и кладёт во временную папку под простым именем. */
async function prepareSubtitles(path: string, shift: number): Promise<PreparedSubs> {
  const dir = join(tmpdir(), `morphio-sub-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  const ext = extname(path).slice(1).toLowerCase()
  const kind = ext === 'ass' || ext === 'ssa' ? 'ass' : 'srt'
  const text = decodeText(await fs.readFile(path))
  const raw = `raw.${ext || 'srt'}`
  await fs.writeFile(join(dir, raw), text, 'utf8')
  const file = `sub.${kind}`
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  if (shift !== 0) args.push('-itsoffset', n3(shift))
  args.push('-sub_charenc', 'UTF-8', '-i', raw, '-c:s', kind === 'ass' ? 'ass' : 'srt', file)
  const r = await run(args, undefined, { cwd: dir })
  if (r.code !== 0) throw new Error(tm('Не удалось прочитать субтитры: {msg}', { msg: r.stderr.trim().split('\n').pop() ?? '' }))
  return { dir, file, kind }
}

/** Цвет #rrggbb в формат libass &HBBGGRR&. */
const assColor = (hex: string): string => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? `&H${m[3]}${m[2]}${m[1]}&`.toUpperCase() : '&HFFFFFF&'
}

// ---------- сборка команды ----------

interface Built {
  args: string[]
  duration: number
  copy: boolean
}

const COPY_VIDEO = ['h264', 'hevc']
const COPY_AUDIO = ['aac', 'mp3']

/** Можно ли резать без перекодирования. */
export function canCopy(plan: MontagePlan): boolean {
  if (plan.trimMode !== 'fast') return false
  if (plan.target === 'webm') return false
  if (plan.flipH || plan.flipV || plan.speed !== 1 || plan.crop || (plan.transition && plan.clips.length > 1)) return false
  // поворот без перекодирования: только метка в файле MP4, у одного клипа
  if (plan.rotate !== 0 && !(plan.target === 'mp4' && plan.clips.length === 1)) return false
  if (plan.loudness.mode !== 'off' || plan.subtitles.mode === 'burn' || plan.maxHeight) return false
  if (plan.fit || plan.targetMB) return false
  if (plan.audioTrack !== 0) return false
  const [a, ...rest] = plan.clips
  if (!a || !a.vcodec || !COPY_VIDEO.includes(a.vcodec)) return false
  if (!plan.mute && a.hasAudio && (!a.acodec || !COPY_AUDIO.includes(a.acodec))) return false
  return rest.every(
    (c) =>
      c.vcodec === a.vcodec &&
      c.width === a.width &&
      c.height === a.height &&
      Math.abs(c.fps - a.fps) < 0.01 &&
      c.hasAudio === a.hasAudio &&
      c.acodec === a.acodec &&
      c.audioRate === a.audioRate
  )
}

interface LoudnessMeasure {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
  output_i?: string
}

/** Достаёт блок JSON, который печатает loudnorm. */
export function parseLoudnorm(stderr: string): LoudnessMeasure | undefined {
  const end = stderr.lastIndexOf('}')
  const start = stderr.lastIndexOf('{', end)
  if (start < 0 || end < 0) return undefined
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as LoudnessMeasure
    return j.input_i !== undefined ? j : undefined
  } catch {
    return undefined
  }
}

/** Видео- и звуковая части графа. withVideo=false: только звук (для измерения громкости). */
function buildGraph(
  plan: MontagePlan,
  opts: { withVideo: boolean; loud?: LoudnessMeasure; sub?: PreparedSubs }
): { graph: string; hasAudio: boolean; outW: number; outH: number } {
  const clips = plan.clips
  const first = clips[0]
  const multi = clips.length > 1
  const anyAudio = !plan.mute && clips.some((c) => c.hasAudio)
  const rotated = plan.rotate === 90 || plan.rotate === 270
  // Размер: у склейки все клипы приводятся к размеру первого (с полями)
  const baseW = Math.round(first.width / 2) * 2
  const baseH = Math.round(first.height / 2) * 2
  const fps = Math.max(1, Math.round(first.fps * 100) / 100)

  const parts: string[] = []
  clips.forEach((c, i) => {
    if (opts.withVideo) {
      const norm = multi
        ? `setpts=PTS-STARTPTS,scale=${baseW}:${baseH}:force_original_aspect_ratio=decrease,pad=${baseW}:${baseH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${n3(fps)},format=yuv420p`
        : 'setpts=PTS-STARTPTS'
      parts.push(`[${i}:v:0]${norm}[v${i}]`)
    }
    if (anyAudio) {
      const len = clipLength(c)
      if (c.hasAudio && plan.audioTrack < c.audioTracks) {
        parts.push(`[${i}:a:${plan.audioTrack}]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`)
      } else {
        parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n3(len)},asetpts=PTS-STARTPTS[a${i}]`)
      }
    }
  })

  const labels = clips.map((_, i) => `${opts.withVideo ? `[v${i}]` : ''}${anyAudio ? `[a${i}]` : ''}`).join('')
  const outs = `${opts.withVideo ? '[vc]' : ''}${anyAudio ? '[ac]' : ''}`
  const tr = multi ? plan.transition : undefined
  if (tr) {
    const d = n3(tr.duration)
    if (opts.withVideo) {
      let acc = clipLength(clips[0])
      let prev = '[v0]'
      for (let i = 1; i < clips.length; i++) {
        const label = i === clips.length - 1 ? '[vc]' : `[vx${i}]`
        parts.push(`${prev}[v${i}]xfade=transition=${tr.kind}:duration=${d}:offset=${n3(acc - i * tr.duration)}${label}`)
        acc += clipLength(clips[i])
        prev = label
      }
    }
    if (anyAudio) {
      let prev = '[a0]'
      for (let i = 1; i < clips.length; i++) {
        const label = i === clips.length - 1 ? '[ac]' : `[ax${i}]`
        parts.push(`${prev}[a${i}]acrossfade=d=${d}${label}`)
        prev = label
      }
    }
  } else if (multi) {
    parts.push(`${labels}concat=n=${clips.length}:v=${opts.withVideo ? 1 : 0}:a=${anyAudio ? 1 : 0}${outs}`)
  } else {
    if (opts.withVideo) parts.push('[v0]null[vc]')
    if (anyAudio) parts.push('[a0]anull[ac]')
  }

  const cr = plan.crop
  const cw = cr ? Math.max(2, Math.floor((baseW * cr.w) / 2) * 2) : baseW
  const ch = cr ? Math.max(2, Math.floor((baseH * cr.h) / 2) * 2) : baseH
  let outW = rotated ? ch : cw
  let outH = rotated ? cw : ch

  if (opts.withVideo) {
    const v: string[] = []
    if (cr) {
      v.push(`crop=w='trunc(iw*${n3(cr.w)}/2)*2':h='trunc(ih*${n3(cr.h)}/2)*2':x='trunc(iw*${n3(cr.x)}/2)*2':y='trunc(ih*${n3(cr.y)}/2)*2'`)
    }
    if (plan.rotate === 90) v.push('transpose=1')
    if (plan.rotate === 180) v.push('hflip', 'vflip')
    if (plan.rotate === 270) v.push('transpose=2')
    if (plan.flipH) v.push('hflip')
    if (plan.flipV) v.push('vflip')
    if (plan.fit) {
      const [aw, ah] = plan.fit.aspect.split(':').map(Number)
      const A = aw / ah
      const ev = (x: number): number => Math.max(2, Math.floor(x / 2) * 2)
      if (plan.fit.mode === 'crop') {
        v.push(`crop=w='trunc(min(iw,ih*${n3(A)})/2)*2':h='trunc(min(ih,iw/${n3(A)})/2)*2'`)
        if (outW / outH > A) outW = ev(outH * A)
        else outH = ev(outW / A)
      } else {
        v.push(
          `pad=w='trunc(max(iw,ih*${n3(A)})/2)*2':h='trunc(max(ih,iw/${n3(A)})/2)*2':x='(ow-iw)/2':y='(oh-ih)/2':color=black`
        )
        if (outW / outH > A) outH = ev(outW / A)
        else outW = ev(outH * A)
      }
      v.push('setsar=1')
    }
    if (plan.maxHeight) {
      // «720p» — короткая сторона: у вертикального видео ограничиваем ширину
      const portrait = outW < outH
      v.push(portrait ? `scale='min(${plan.maxHeight},iw)':-2` : `scale=-2:'min(${plan.maxHeight},ih)'`)
      const short = Math.min(outW, outH)
      if (short > plan.maxHeight) {
        const k = plan.maxHeight / short
        outW = Math.round((outW * k) / 2) * 2
        outH = Math.round((outH * k) / 2) * 2
      }
    }
    if (plan.subtitles.mode === 'burn' && opts.sub) {
      const st = plan.subtitles
      const style = [
        `FontSize=${Math.round(st.fontSize)}`,
        `PrimaryColour=${assColor(st.color)}`,
        st.outline ? 'BorderStyle=1,Outline=2,Shadow=0' : 'BorderStyle=1,Outline=0,Shadow=0'
      ].join(',')
      v.push(
        opts.sub.kind === 'ass'
          ? `subtitles=${opts.sub.file}`
          : `subtitles=${opts.sub.file}:force_style='${style}'`
      )
    }
    if (plan.speed !== 1) v.push(`setpts=PTS/${n3(plan.speed)}`)
    parts.push(`[vc]${v.length ? v.join(',') : 'null'}[v]`)
  }

  if (anyAudio) {
    const a: string[] = []
    if (plan.speed !== 1) a.push(atempoChain(plan.speed))
    const l = plan.loudness
    if (l.mode === 'loudnorm') {
      const base = `loudnorm=I=${n3(l.target)}:TP=-1.5:LRA=11`
      a.push(
        opts.loud
          ? `${base}:measured_I=${opts.loud.input_i}:measured_TP=${opts.loud.input_tp}:measured_LRA=${opts.loud.input_lra}:measured_thresh=${opts.loud.input_thresh}:offset=${opts.loud.target_offset}:linear=true:print_format=json`
          : `${base}:print_format=json`
      )
    } else if (l.mode === 'dynaudnorm') {
      a.push('dynaudnorm=f=150:g=15')
    }
    parts.push(`[ac]${a.length ? a.join(',') : 'anull'}[a]`)
  }
  return { graph: parts.join(';'), hasAudio: anyAudio, outW, outH }
}

const baseArgs = ['-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1', '-y']

/** Входы с отрезками: `-ss`/`-t` перед `-i` дают точную границу при перекодировании. */
const clipInputs = (clips: MontageClip[]): string[] =>
  clips.flatMap((c) => ['-ss', n3(startOf(c)), '-t', n3(clipLength(c)), '-i', c.path])

const SOFT_CODEC: Record<string, string> = { mp4: 'mov_text', mkv: 'srt', webm: 'webvtt' }

function softSubArgs(plan: MontagePlan, sub: PreparedSubs, inputIndex: number): { input: string[]; map: string[] } {
  // субтитры хранят время исходного видео: при обрезке единственного клипа сдвигаем на начало отрезка
  return {
    input: ['-i', join(sub.dir, sub.file)],
    map: ['-map', `${inputIndex}:0`, '-c:s', SOFT_CODEC[plan.target] ?? 'srt', '-metadata:s:s:0', 'language=und']
  }
}

/** Команда «без перекодирования». */
function buildCopy(plan: MontagePlan, outputPath: string, soft?: PreparedSubs, listFile?: string): Built {
  const first = plan.clips[0]
  const keepAudio = !plan.mute && first.hasAudio
  const common = ['-map', '0:v:0', ...(keepAudio ? ['-map', '0:a:0'] : ['-an']), ...(soft ? [] : ['-sn']), '-dn']
  const args = [...baseArgs]
  if (plan.clips.length === 1) {
    // поворот меткой: к повороту, который уже записан в файле, добавляем нужный (по часовой)
    if (plan.rotate !== 0) args.push('-display_rotation', String((((first.rotation ?? 0) - plan.rotate) % 360 + 360) % 360))
    args.push('-ss', n3(startOf(first)), '-t', n3(clipLength(first)), '-i', first.path)
  } else {
    args.push('-f', 'concat', '-safe', '0', '-i', listFile!)
  }
  let subArgs: string[] = []
  if (soft) {
    const s = softSubArgs(plan, soft, 1)
    args.push(...s.input)
    subArgs = s.map
  }
  args.push(...common, ...subArgs, '-c:v', 'copy', ...(keepAudio ? ['-c:a', 'copy'] : []))
  if (soft) args.push('-c:s', SOFT_CODEC[plan.target] ?? 'srt')
  args.push('-avoid_negative_ts', 'make_zero')
  if (plan.target === 'mp4') args.push('-movflags', '+faststart')
  args.push(outputPath)
  return { args, duration: planDuration(plan), copy: true }
}

const concatLine = (p: string): string => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`

// ---------- запуск ----------

function lastLine(stderr: string): string {
  const lines = stderr.trim().split('\n').filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

function fmtLufs(v: string | number): string {
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) ? n.toFixed(1).replace('-', '−') : String(v)
}

/** Выполняет план монтажа и возвращает результат. */
export async function runMontage(
  plan: MontagePlan,
  gpuKind: GpuKind | null,
  onPercent: (percent: number, text?: string) => void
): Promise<JobResult> {
  validate(plan)
  const first = plan.clips[0]
  const dir = plan.outputDir ?? dirname(first.path)
  await fs.mkdir(dir, { recursive: true })
  const base = basename(first.path, extname(first.path))
  const outputPath = await freePath(
    dir,
    plan.outputName ?? (plan.outputDir ? `${base}-edit` : `${base}-edited`),
    plan.target
  )
  const duration = planDuration(plan)
  const temp: string[] = []
  const progress = (total: number, offset = 0, span = 100) => (line: string): void => {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
    if (m && total > 0) onPercent(Math.min(99, offset + Math.min(1, Number(m[1]) / 1e6 / total) * span))
  }

  try {
    // субтитры
    let sub: PreparedSubs | undefined
    const st = plan.subtitles
    if (st.mode !== 'none' && st.path) {
      // время субтитров относится к исходному видео: у одного клипа вычитаем начало отрезка
      const shift = st.shift - (plan.clips.length === 1 ? startOf(first) : 0)
      sub = await prepareSubtitles(st.path, shift)
      temp.push(sub.dir)
    }

    let listFile: string | undefined
    if (canCopy(plan)) {
      if (plan.clips.length > 1) {
        const lines = plan.clips.flatMap((c) => [concatLine(c.path), `inpoint ${n3(startOf(c))}`, `outpoint ${n3(endOf(c))}`])
        const tdir = join(tmpdir(), `morphio-list-${randomUUID().slice(0, 8)}`)
        await fs.mkdir(tdir, { recursive: true })
        temp.push(tdir)
        listFile = join(tdir, 'list.txt')
        await fs.writeFile(listFile, lines.join('\n'), 'utf8')
      }
      const job = buildCopy(plan, outputPath, st.mode === 'soft' ? sub : undefined, listFile)
      onPercent(2)
      const r = await run(job.args, progress(job.duration))
      if (r.code !== 0) throw new Error(tm('Не удалось сохранить: {msg}', { msg: lastLine(r.stderr) }))
      const { size } = await fs.stat(outputPath)
      onPercent(100)
      return { outputPath, outputSize: size, info: tm('без перекодирования') }
    }

    // громкость: первый проход измеряет
    const notes: string[] = []
    let measure: LoudnessMeasure | undefined
    const wantsLoud = plan.loudness.mode === 'loudnorm' && !plan.mute && plan.clips.some((c) => c.hasAudio)
    if (wantsLoud) {
      onPercent(1, tm('Измеряю громкость…'))
      const a = buildGraph(plan, { withVideo: false })
      // в измерительном проходе фильтр без measured_*: он печатает JSON с результатами
      const r = await run(
        [...baseArgs, ...clipInputs(plan.clips), '-filter_complex', a.graph, '-map', '[a]', '-vn', '-f', 'null', '-'],
        progress(duration, 0, 25)
      )
      measure = parseLoudnorm(r.stderr)
      if (!measure) throw new Error(tm('Не удалось измерить громкость'))
    }

    const gpu = plan.useGpu && plan.target !== 'webm' ? gpuKind : null
    const encodeOnce = async (p: MontagePlan, vk?: number): Promise<{ g: ReturnType<typeof buildGraph>; stderr: string }> => {
      const g = buildGraph(p, { withVideo: true, loud: measure, sub })
      const args = [...baseArgs, ...clipInputs(p.clips)]
      let softMap: string[] = []
      if (st.mode === 'soft' && sub) {
        const sa = softSubArgs(p, sub, p.clips.length)
        args.push(...sa.input)
        softMap = sa.map
      }
      args.push('-filter_complex', g.graph, '-map', '[v]')
      if (g.hasAudio) args.push('-map', '[a]')
      args.push(...softMap)
      args.push(...videoCodecArgs(p.target, p.quality, gpu, vk))
      if (g.hasAudio) args.push(...audioCodecArgs(p.target === 'webm' ? 'webm' : 'm4a', p.audioBitrate))
      args.push('-pix_fmt', 'yuv420p')
      if (p.target === 'mp4') args.push('-movflags', '+faststart')
      args.push(outputPath)
      const r = await run(args, progress(duration, wantsLoud ? 25 : 0, wantsLoud ? 75 : 100), sub ? { cwd: sub.dir } : {})
      if (r.code !== 0) throw new Error(tm('Не удалось сохранить: {msg}', { msg: lastLine(r.stderr) }))
      return { g, stderr: r.stderr }
    }

    onPercent(wantsLoud ? 25 : 2, tm('Сохраняю…'))
    let g: ReturnType<typeof buildGraph>
    let stderr: string
    if (plan.targetMB && duration > 0) {
      // Целимся в размер: битрейт видео из лимита и длительности, при промахе повторяем
      const targetBytes = plan.targetMB * 1024 * 1024
      const hasA = plan.clips.some((c) => c.hasAudio) && !plan.mute
      let vk = Math.max(60, Math.floor((targetBytes * 8 * 0.95) / duration / 1000 - (hasA ? plan.audioBitrate : 0)))
      const sw = Math.max(first.width, first.height)
      const sh = Math.min(first.width, first.height)
      const height = plan.maxHeight ?? heightForBitrate(vk, sw, sh, first.fps)
      let attempts = 0
      for (;;) {
        attempts++
        ;({ g, stderr } = await encodeOnce({ ...plan, maxHeight: height }, vk))
        const { size } = await fs.stat(outputPath)
        if (size <= targetBytes || attempts >= 3 || vk <= 40) break
        vk = Math.max(40, Math.floor(vk * ((targetBytes * 0.94) / size)))
      }
      notes.push(tm('под {mb} МБ', { mb: plan.targetMB }))
    } else {
      ;({ g, stderr } = await encodeOnce(plan))
    }

    if (wantsLoud && measure) {
      const out = parseLoudnorm(stderr)
      notes.push(
        tm('громкость {a} → {b} LUFS', {
          a: fmtLufs(measure.input_i),
          b: fmtLufs(out?.output_i ?? plan.loudness.target)
        })
      )
    } else if (plan.loudness.mode === 'dynaudnorm' && g.hasAudio) {
      notes.push(tm('громкость выровнена'))
    }
    const { size } = await fs.stat(outputPath)
    onPercent(100)
    const label = plan.target === 'webm' ? 'VP9' : 'H.264'
    return {
      outputPath,
      outputSize: size,
      info: [`${label} · ${g.outW}×${g.outH}`, plan.clips.length > 1 ? tm('клипов: {n}', { n: plan.clips.length }) : '', ...notes]
        .filter(Boolean)
        .join(' · ')
    }
  } catch (e) {
    await fs.rm(outputPath, { force: true })
    throw e
  } finally {
    await Promise.all(temp.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}

/** Паузы в звуке: уровень тише noiseDb дольше minSilence секунд. */
export async function detectSilence(path: string, noiseDb = -35, minSilence = 0.6): Promise<Range[]> {
  const probe = await probeMedia(path)
  if (!probe.hasAudio) throw new Error(tm('В этом видео нет звука, тишину искать негде'))
  const r = await run([
    '-hide_banner', '-nostats', '-i', path, '-vn', '-af',
    `silencedetect=noise=${n3(noiseDb)}dB:d=${n3(minSilence)}`, '-f', 'null', '-'
  ])
  if (r.code !== 0) throw new Error(tm('Не удалось проверить звук: {msg}', { msg: lastLine(r.stderr) }))
  return parseSilences(r.stderr, probe.duration)
}
