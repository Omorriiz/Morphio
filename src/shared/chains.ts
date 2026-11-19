import type { AudioTarget, ImageFormat, MontagePlan, PipelineConfig, VideoTarget } from './types'

/**
 * Цепочка действий: для каждого вида файла своя «ветка» шагов. Файл проходит через ветку своего вида
 * (картинка, видео или звук), остальные ветки его не касаются. Один пресет может содержать все три.
 */

export type ImageBranch = Omit<PipelineConfig, 'outputDir'> & { enabled: boolean }

export interface VideoBranch {
  enabled: boolean
  /** Сколько секунд срезать с начала и с конца */
  trimStart: number
  trimEnd: number
  rotate: 0 | 90 | 180 | 270
  fit?: MontagePlan['fit']
  loudness: MontagePlan['loudness']
  mute: boolean
  /** Субтитры из файла рядом с роликом (то же имя: фильм.mp4 и фильм.srt, фильм.ru.srt): дорожкой или в картинку */
  subtitles: 'off' | 'soft' | 'burn'
  target: VideoTarget
  quality: 'high' | 'medium' | 'low'
  maxHeight?: number
  /** Уложиться в размер, МБ */
  targetMB?: number
  audioBitrate: number
  nameTemplate: string
}

export interface AudioBranch {
  enabled: boolean
  /** Убрать тишину в начале и в конце */
  trimSilence: boolean
  loudness: { mode: 'off' | 'loudnorm'; target: number }
  format: AudioTarget
  /** кбит/с, для форматов с потерями */
  bitrate: number
  /** Оставить теги (исполнитель, название, обложка) */
  keepTags: boolean
  /** Записать эти теги во все файлы; пустое поле не трогает тег */
  tags: AudioTags
  nameTemplate: string
}

export interface AudioTags {
  artist: string
  album: string
  genre: string
  year: string
}

export const AUDIO_TAG_KEYS: (keyof AudioTags)[] = ['artist', 'album', 'genre', 'year']

export interface ChainBranches {
  /** Версия схемы: нужна, чтобы старые сохранённые цепочки открывались после обновлений */
  version: 2
  image: ImageBranch
  video: VideoBranch
  audio: AudioBranch
}

export interface ChainConfig extends ChainBranches {
  outputDir?: string
}

export interface ChainPreset {
  id: string
  name: string
  builtin?: boolean
  config: ChainBranches
}

export const defaultImageBranch = (): ImageBranch => ({
  enabled: true,
  removeBg: false,
  bgMethod: 'auto',
  bgTolerance: 0,
  bgEverywhere: true,
  bgTranslucent: true,
  fill: 'transparent',
  fillColor: '#ffffff',
  maxSize: undefined,
  format: 'webp' as ImageFormat,
  quality: 85,
  keepMetadata: false,
  nameTemplate: '{name}-morphio'
})

export const defaultVideoBranch = (): VideoBranch => ({
  enabled: true,
  trimStart: 0,
  trimEnd: 0,
  rotate: 0,
  fit: undefined,
  loudness: { mode: 'off', target: -16 },
  mute: false,
  subtitles: 'off',
  target: 'mp4',
  quality: 'medium',
  maxHeight: undefined,
  targetMB: undefined,
  audioBitrate: 192,
  nameTemplate: '{name}-morphio'
})

export const defaultAudioBranch = (): AudioBranch => ({
  enabled: true,
  trimSilence: false,
  loudness: { mode: 'off', target: -16 },
  format: 'mp3',
  bitrate: 192,
  keepTags: true,
  tags: { artist: '', album: '', genre: '', year: '' },
  nameTemplate: '{name}-morphio'
})

export const defaultChain = (): ChainBranches => ({
  version: 2,
  image: defaultImageBranch(),
  video: defaultVideoBranch(),
  audio: defaultAudioBranch()
})

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function mergeAudio(base: AudioBranch, raw: unknown): AudioBranch {
  if (!isObj(raw)) return base
  const merged = { ...base, ...(raw as Partial<AudioBranch>) }
  const tags = isObj(raw['tags']) ? raw['tags'] : {}
  merged.tags = { ...base.tags }
  for (const k of AUDIO_TAG_KEYS) if (typeof tags[k] === 'string') merged.tags[k] = tags[k] as string
  return merged
}

/**
 * Приводит сохранённую цепочку к текущей схеме. Понимает старый формат (только картинки, без версии):
 * он становится веткой «картинки», а видео и звук выключены, чтобы прежние цепочки вели себя как раньше.
 */
export function migrateChain(raw: unknown): ChainBranches {
  const base = defaultChain()
  if (!isObj(raw)) return base
  if (raw['version'] === 2) {
    return {
      version: 2,
      image: { ...base.image, ...(isObj(raw['image']) ? (raw['image'] as Partial<ImageBranch>) : {}) },
      video: { ...base.video, ...(isObj(raw['video']) ? (raw['video'] as Partial<VideoBranch>) : {}) },
      audio: mergeAudio(base.audio, raw['audio'])
    }
  }
  // старый формат: плоские настройки картинок
  return {
    version: 2,
    image: { ...base.image, ...(raw as Partial<ImageBranch>), enabled: true },
    video: { ...base.video, enabled: false },
    audio: { ...base.audio, enabled: false }
  }
}

/** Сохранённый список цепочек пользователя → актуальный формат; испорченные записи отбрасываются. */
export function migratePresets(raw: unknown): ChainPreset[] {
  if (!Array.isArray(raw)) return []
  const out: ChainPreset[] = []
  for (const p of raw) {
    if (!isObj(p) || typeof p['id'] !== 'string' || typeof p['name'] !== 'string') continue
    out.push({ id: p['id'], name: p['name'], config: migrateChain(p['config']) })
  }
  return out
}

/** Подставляет в шаблон имени {name}, {n}, {date}, {format} и убирает запрещённые символы. */
export function resolveName(template: string, ctx: { name: string; n: number; format: string }): string {
  const date = new Date().toISOString().slice(0, 10)
  const out = template
    .replaceAll('{name}', ctx.name)
    .replaceAll('{n}', String(ctx.n).padStart(3, '0'))
    .replaceAll('{date}', date)
    .replaceAll('{format}', ctx.format)
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
  return out || ctx.name
}
