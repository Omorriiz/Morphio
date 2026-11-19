// Типы, общие для main, preload и renderer.
import type { Language, LanguageSetting } from './i18n'

export type ImageFormat = 'png' | 'jpg' | 'webp' | 'avif' | 'tiff' | 'gif'

export interface FormatInfo {
  id: ImageFormat
  label: string
  hint: string
  /** Поддерживает ли формат настройку качества */
  hasQuality: boolean
}

export const IMAGE_FORMATS: FormatInfo[] = [
  { id: 'webp', label: 'WebP', hint: 'Лёгкий, для сайтов', hasQuality: true },
  { id: 'jpg', label: 'JPG', hint: 'Фото, всё открывает', hasQuality: true },
  { id: 'png', label: 'PNG', hint: 'Без потерь, прозрачность', hasQuality: false },
  { id: 'avif', label: 'AVIF', hint: 'Самый компактный', hasQuality: true },
  { id: 'tiff', label: 'TIFF', hint: 'Для печати', hasQuality: true },
  { id: 'gif', label: 'GIF', hint: 'Простая анимация', hasQuality: false }
]

/** Расширения, которые приложение умеет читать как изображения. */
export const INPUT_IMAGE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'webp', 'avif', 'tif', 'tiff', 'gif', 'bmp', 'svg', 'heic', 'heif'
]

/** Вид файла: по нему реестр форматов решает, во что его можно превратить. */
import type { ChainConfig } from './chains'
import type { LayerAnim } from './layerAnim'
import type { Cue } from './subtitles'

export type FileKind = 'image' | 'video' | 'audio' | 'table' | 'archive' | 'pdf' | 'document' | 'subtitle' | 'folder' | 'other'

export const TABLE_EXTENSIONS = ['csv', 'tsv', 'xlsx', 'json', 'xml', 'yaml', 'yml']
export const PDF_EXTENSIONS = ['pdf']
/** Текстовые документы и книги (читает Pandoc) */
export const DOCUMENT_EXTENSIONS = ['docx', 'odt', 'rtf', 'html', 'htm', 'md', 'markdown', 'txt', 'epub', 'fb2', 'mobi', 'azw3']
export const ARCHIVE_EXTENSIONS = ['zip', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar']

export interface FileItem {
  id: string
  path: string
  name: string
  ext: string
  size: number
  /** Маленькое превью в виде data URL (может отсутствовать) */
  thumbnail?: string
  width?: number
  height?: number
  /** Для видео и звука: длительность в секундах */
  duration?: number
  kind?: FileKind
  /** Есть ли в файле звуковая дорожка */
  hasAudio?: boolean
  /** Для видео: сколько в нём дорожек субтитров */
  subtitleTracks?: number
}

export interface ConvertOptions {
  format: ImageFormat
  /** 1–100 */
  quality: number
  /** Максимальная сторона в пикселях; undefined = исходный размер */
  maxSize?: number
  /** Папка сохранения; undefined = рядом с оригиналом */
  outputDir?: string
  /** Сохранить метаданные (EXIF, GPS). По умолчанию они удаляются. */
  keepMetadata?: boolean
}

export type BgOutputFormat = 'png' | 'webp' | 'jpg'

/**
 * auto — если фон однотонный, вырезаем цвет, иначе работает нейросеть;
 * ai — всегда нейросеть (фото); solid — всегда однотонный фон (спрайты, иконки).
 */
export type BgMethod = 'auto' | 'ai' | 'solid'

export interface BgRemoveOptions {
  method: BgMethod
  /** Допуск по цвету для однотонного фона; 0 = подобрать автоматически */
  tolerance: number
  /** Убирать цвет фона везде, включая участки внутри объектов */
  everywhere: boolean
  /** Раскладывать полупрозрачные участки (паутина, дымка, свечение) */
  translucent: boolean
  /** Цвет фона, выбранный пипеткой (#rrggbb); без него цвет находится автоматически */
  bgColor?: string
  /** transparent — прозрачный фон; color — залить выбранным цветом */
  background: 'transparent' | 'color'
  /** Цвет заливки в формате #rrggbb */
  color: string
  format: BgOutputFormat
  outputDir?: string
}

export type JobStatus = 'pending' | 'working' | 'done' | 'error'

export interface JobProgress {
  id: string
  status: JobStatus
  outputPath?: string
  outputSize?: number
  /** Маленькое превью результата (data URL) */
  preview?: string
  /** Короткая заметка о том, как обработан файл */
  info?: string
  /** Ход работы, 0–100 (видео и звук) */
  percent?: number
  error?: string
}

export interface ModelStatus {
  available: boolean
  name: string
  sizeMB: number
}

export interface ModelDownloadProgress {
  received: number
  total: number
  done?: boolean
  error?: string
}

/** Цепочка действий: убрать фон → изменить размер → формат → имя файла. */
export interface PipelineConfig {
  removeBg: boolean
  bgMethod: BgMethod
  bgTolerance: number
  bgEverywhere: boolean
  bgTranslucent: boolean
  bgColor?: string
  fill: 'transparent' | 'color'
  fillColor: string
  maxSize?: number
  format: ImageFormat
  quality: number
  keepMetadata: boolean
  /** Шаблон имени: {name}, {n}, {date}, {format} */
  nameTemplate: string
  outputDir?: string
}

export interface PipelinePreset {
  id: string
  name: string
  builtin?: boolean
  config: Omit<PipelineConfig, 'outputDir'>
}

/** Мазок кисти в координатах исходного изображения (пиксели). */
export interface BrushStroke {
  mode: 'erase' | 'restore'
  radius: number
  /** [x0, y0, x1, y1, ...] */
  points: number[]
}

/** Заливка областью по цвету (инструмент «Заливка»): координаты в пикселях изображения. */
export interface FillOp {
  type: 'fill'
  x: number
  y: number
  /** Допуск, ΔE в Lab (1–100) */
  tolerance: number
  contiguous: boolean
  /** Опорный цвет; не задан — цвет под точкой клика */
  color?: [number, number, number]
  /** Мягкость краёв, 0–1 */
  feather: number
}

/** Правка маски: мазок кисти или заливка. Порядок правок важен, поэтому хранится последовательность. */
export type EditOp = BrushStroke | FillOp

export interface MaskEditSession {
  /** Размер исходного изображения */
  width: number
  height: number
  /** Размер превью, с которым работает редактор */
  previewWidth: number
  previewHeight: number
  /** Цвета объекта (JPEG data URL) */
  imageUrl: string
  /** Маска прозрачности (PNG data URL, оттенки серого) */
  maskUrl: string
}

export type CompareVerdict = 'invisible' | 'small' | 'noticeable' | 'big'

/** Пара «до/после» для слайдера: два кадра одного размера и оценка потери качества. */
export interface CompareResult {
  before: string
  after: string
  width: number
  height: number
  originalWidth: number
  originalHeight: number
  sizeBefore: number
  sizeAfter: number
  psnr: number
  ssim: number
  verdict: CompareVerdict
  /** Длительность видео в секундах (для картинок нет) */
  duration?: number
}

export interface ImagePreview {
  dataUrl: string
  width: number
  height: number
}

export interface SavedResult {
  outputPath: string
  outputSize: number
  preview?: string
  info?: string
}

/** Кадр анимации: отдельная картинка или один кадр из GIF/WebP. */
export interface GifFrame {
  id: string
  path: string
  /** Номер кадра в анимированном файле (для обычных картинок не задан) */
  page?: number
  name: string
  /** Индивидуальная задержка в мс; если не задана — берётся общая */
  delay?: number
  width: number
  height: number
  /** Маленькое превью для ленты кадров (data URL) */
  thumbnail: string
  /** Превью побольше для проигрывателя (data URL) */
  preview: string
}

/** Звуковые форматы. */
export const AUDIO_EXTENSIONS = [
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma', 'aiff', 'aif', 'amr'
]

export type VideoTarget = 'mp4' | 'webm' | 'mkv'
export type AudioTarget = 'mp3' | 'm4a' | 'wav' | 'flac' | 'ogg' | 'opus'
export type MediaTarget = VideoTarget | AudioTarget

export const VIDEO_TARGETS: { id: VideoTarget; label: string; hint: string }[] = [
  { id: 'mp4', label: 'MP4', hint: 'Открывается везде' },
  { id: 'webm', label: 'WebM', hint: 'Для сайтов, меньше размер' },
  { id: 'mkv', label: 'MKV', hint: 'Гибкий контейнер' }
]

export const AUDIO_TARGETS: { id: AudioTarget; label: string; hint: string; lossy: boolean }[] = [
  { id: 'mp3', label: 'MP3', hint: 'Играет везде', lossy: true },
  { id: 'm4a', label: 'M4A', hint: 'AAC, лучше MP3 при том же размере', lossy: true },
  { id: 'wav', label: 'WAV', hint: 'Без сжатия', lossy: false },
  { id: 'flac', label: 'FLAC', hint: 'Без потерь, но меньше WAV', lossy: false },
  { id: 'ogg', label: 'OGG', hint: 'Открытый формат', lossy: true },
  { id: 'opus', label: 'OPUS', hint: 'Лучший для голоса и малых битрейтов', lossy: true }
]

export type GpuKind = 'nvenc' | 'amf' | 'qsv'

export interface MediaCapabilities {
  /** Какое ускорение H.264 доступно на этом компьютере (null — только процессор) */
  gpu: GpuKind | null
  gpuLabel?: string
}

export interface MediaOptions {
  target: MediaTarget
  quality: 'high' | 'medium' | 'low'
  /** Максимальная высота кадра; не задана — как в исходнике */
  maxHeight?: number
  /** Битрейт звука, кбит/с (для форматов с потерями) */
  audioBitrate: number
  mute: boolean
  stripMetadata: boolean
  useGpu: boolean
  /** Лимит размера результата, МБ (только видео) */
  targetMB?: number
  outputDir?: string
}

/** Клип в плане монтажа: файл и отрезок, который берём. */
export interface MontageClip {
  id: string
  path: string
  name: string
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  audioTracks: number
  vcodec?: string
  acodec?: string
  audioRate?: number
  thumbnail?: string
  /** Метка поворота в файле (градусы против часовой, как в FFmpeg); у телефонных роликов −90 или 90 */
  rotation?: number
  /** Начало и конец отрезка, секунды; не заданы — клип целиком */
  start?: number
  end?: number
}

export interface MontageCrop {
  x: number
  y: number
  w: number
  h: number
}

export const MONTAGE_TRANSITIONS = ['fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circleopen', 'fadeblack'] as const
export type MontageTransition = (typeof MONTAGE_TRANSITIONS)[number]

export interface MontagePlan {
  clips: MontageClip[]
  /** Быстро: без перекодирования, граница по ключевым кадрам. Точно: кадр в кадр. */
  trimMode: 'fast' | 'accurate'
  rotate: 0 | 90 | 180 | 270
  flipH: boolean
  flipV: boolean
  /** Скорость: 1 — как есть, 2 — вдвое быстрее */
  speed: number
  mute: boolean
  /** Номер звуковой дорожки (с нуля) */
  audioTrack: number
  loudness: { mode: 'off' | 'loudnorm' | 'dynaudnorm'; target: number }
  subtitles: {
    mode: 'none' | 'soft' | 'burn'
    path?: string
    /** Сдвиг времени субтитров, секунды (минус — раньше) */
    shift: number
    fontSize: number
    /** Цвет текста, #rrggbb */
    color: string
    outline: boolean
  }
  /** Кадрирование рамкой: доли кадра от 0 до 1 (левый верхний угол и размеры) */
  crop?: MontageCrop
  /** Переход между клипами: плавный вместо резкой склейки */
  transition?: { kind: MontageTransition; duration: number }
  /** Привести кадр к соотношению сторон: обрезать лишнее или добавить поля */
  fit?: { aspect: '9:16' | '1:1' | '16:9' | '4:5'; mode: 'crop' | 'pad' }
  target: VideoTarget
  quality: 'high' | 'medium' | 'low'
  maxHeight?: number
  /** Уложиться в размер файла, МБ: битрейт и разрешение подбираются сами */
  targetMB?: number
  audioBitrate: number
  useGpu: boolean
  outputDir?: string
  /** Имя результата без расширения (по умолчанию «имя-edited») */
  outputName?: string
}

export function defaultMontagePlan(): MontagePlan {
  return {
    clips: [],
    trimMode: 'accurate',
    rotate: 0,
    flipH: false,
    flipV: false,
    speed: 1,
    mute: false,
    audioTrack: 0,
    loudness: { mode: 'off', target: -16 },
    subtitles: { mode: 'none', shift: 0, fontSize: 24, color: '#ffffff', outline: true },
    target: 'mp4',
    quality: 'medium',
    audioBitrate: 192,
    useGpu: true
  }
}

export interface MontageProgress {
  percent: number
  text?: string
}

/** Видеоформаты, которые можно превратить в анимацию. */
export const VIDEO_EXTENSIONS = [
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp'
]

export interface VideoInfo {
  path: string
  name: string
  /** Длительность, секунды */
  duration: number
  /** Размеры кадра с учётом поворота (как видит зритель) */
  width: number
  height: number
  fps: number
}

export interface VideoExtractOptions {
  path: string
  /** Начало отрезка, секунды */
  start: number
  /** Длина отрезка, секунды */
  duration: number
  fps: number
  /** Ширина кадров; не задана — как в видео */
  width?: number
}

export interface VideoExtractResult {
  frames: GifFrame[]
  /** Задержка между кадрами, мс (1000 / fps) */
  delay: number
}

/** Порядок проигрывания: обычный, обратный или «туда-обратно» (крайние кадры не повторяются). */
export function orderFrames<T>(frames: T[], order: 'normal' | 'reverse' | 'pingpong'): T[] {
  if (order === 'reverse') return [...frames].reverse()
  if (order === 'pingpong' && frames.length > 2) {
    return [...frames, ...frames.slice(1, -1).reverse()]
  }
  return frames
}

/** Слой поверх анимации: текст или стикер. Картинку слоя рисует окно (там есть все шрифты Windows). */
export interface GifLayer {
  id: string
  kind: 'text' | 'sticker'
  /** PNG слоя (data URL); размер считается для кадра шириной 1000 px */
  png: string
  /** Центр слоя: доли ширины и высоты кадра (0–1) */
  x: number
  y: number
  /** Ширина слоя: доля ширины кадра */
  w: number
  /** Поворот, градусы */
  rotation: number
  /** Показывать с кадра … по кадр … (номера кадров в списке, с нуля, включительно); не заданы — всегда */
  from?: number
  to?: number
  /** Непрозрачность, 0–1 */
  opacity?: number
  /** Анимация слоя за время показа */
  anim?: LayerAnim
  /** Только для окна: исходные настройки, чтобы слой можно было править */
  edit?: Record<string, unknown>
}

/** Рамка обрезки в долях кадра. */
export interface GifCrop {
  x: number
  y: number
  w: number
  h: number
}

export interface GifBgRemoval {
  method: 'auto' | 'solid' | 'ai'
  /** Для GIF: цвет, на который «подмешиваются» края, чтобы не было светлой каймы */
  matte: string
  /** Сгладить маску по времени, чтобы края не мерцали (для нейросети) */
  smooth: boolean
}

/** Часть кадров с другой скоростью: 2 — вдвое быстрее, 0.5 — вдвое медленнее. */
export interface GifSpeedRange {
  from: number
  to: number
  factor: number
}

/** Скорость, которая применяется к кадру с таким номером (первый подходящий диапазон). */
export function speedFor(ranges: GifSpeedRange[] | undefined, index: number): number {
  const r = ranges?.find((x) => index >= x.from && index <= x.to && x.factor > 0)
  return r ? r.factor : 1
}

export interface GifBuildOptions {
  format: 'gif' | 'webp' | 'apng'
  /** Обрезка рамкой: применяется ко всем кадрам */
  crop?: GifCrop
  /** Текст и стикеры поверх анимации */
  layers?: GifLayer[]
  /** Удалить фон у всех кадров (прозрачная анимация) */
  removeBg?: GifBgRemoval
  /** Ускорить или замедлить часть кадров: номера кадров в списке (с нуля, включительно) */
  speedRanges?: GifSpeedRange[]
  /** Ширина результата в пикселях; не задана = как у первого кадра (не больше 1200) */
  width?: number
  fit: 'contain' | 'cover'
  /** 'transparent' или цвет #rrggbb — чем залить поля при вписывании */
  background: string
  /** Задержка по умолчанию, мс */
  defaultDelay: number
  /** Сколько раз повторять; 0 — бесконечно */
  loop: number
  order: 'normal' | 'reverse' | 'pingpong'
  /** Число цветов GIF (2–256) */
  colours: number
  dither: boolean
  /** Качество WebP (1–100) */
  quality: number
  /** Если задан — подбираем размер и качество, чтобы уложиться в этот вес (КБ) */
  targetKB?: number
  /** Имя файла без расширения */
  name: string
  outputDir?: string
}

export interface GifResult {
  outputPath: string
  outputSize: number
  width: number
  height: number
  frames: number
  /** Что пришлось уменьшить, чтобы уложиться в целевой размер */
  note?: string
  /** Удалось ли уложиться в целевой размер (если он задан) */
  reachedTarget?: boolean
  /** Сам результат для показа в проигрывателе (data URL), если он не слишком большой */
  previewUrl?: string
}

export interface GifProgress {
  text: string
  done: number
  total: number
}

/** Правило следящей папки: что появилось в папке, то конвертируется выбранным способом. */
export interface WatchRule {
  id: string
  folder: string
  enabled: boolean
  /** Вариант из реестра форматов, например image:webp */
  target: string
  quality: number
  /** Куда класть результат; по умолчанию подпапка Morphio-out внутри следимой папки */
  outputDir?: string
}

export interface WatchStatus {
  id: string
  active: boolean
  processed: number
  lastFile?: string
  lastAt?: number
  lastError?: string
}

/** Настройки приложения (файл settings.json в %APPDATA%\Morphio). */
export type ThemeSetting = 'system' | 'light' | 'dark'

export interface AppSettings {
  version: 1
  language: LanguageSetting
  /** Оформление: как в Windows, светлое или тёмное */
  theme: ThemeSetting
  /** Значок в трее */
  tray: boolean
  /** Закрытие окна прячет его в трей, приложение продолжает работать */
  closeToTray: boolean
  launchAtLogin: boolean
  /** Окно быстрой конвертации по сочетанию клавиш */
  quickEnabled: boolean
  /** Сочетание в формате Electron, например CommandOrControl+Shift+X */
  hotkey: string
  /** Пункт «Конвертировать в Morphio» в меню Проводника */
  explorerMenu: boolean
  /** Последние выбранные варианты в быстром окне (первыми показываются они) */
  quickLast: string[]
  watchRules: WatchRule[]
}

export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+X'

export interface SettingsState {
  settings: AppSettings
  /** Язык, который действует сейчас (если выбран «системный» — уже определён). */
  language: Language
  /** Удалось ли занять сочетание клавиш (false — оно занято другой программой) */
  hotkeyOk: boolean
  /** Почему не удалось добавить или убрать пункт в меню Проводника */
  explorerMenuError?: string
}

/** Один вариант «во что превратить» из реестра форматов. */
/** Модуль, который докачивается по кнопке (Pandoc и другие) */
export interface ModuleInfo {
  id: string
  /** Программа или модель (нейросеть, язык) */
  group: 'tool' | 'model'
  name: string
  version: string
  description: string
  license: string
  /** Откуда скачивается, для показа пользователю */
  source: string
  sizeMB: number
  installed: boolean
}

export interface ModuleProgress {
  id: string
  phase: 'download' | 'extract' | 'done' | 'error'
  received: number
  total: number
  error?: string
}

export interface UniversalTarget {
  /** engine:формат, например image:webp, table:xlsx, archive:unpack */
  id: string
  label: string
  /** Раздел в списке вариантов (ai — нейросети) */
  group: FileKind | 'ai'
  hint: string
  /** Нужен модуль (например pandoc) */
  needs?: string
  /** Модуль нужен, но ещё не скачан */
  missing?: boolean
}

export interface UniversalOptions {
  target: string
  /** Качество картинок, 1–100 */
  quality: number
  outputDir?: string
  archiveLevel: 'fast' | 'normal' | 'max'
  /** Пароль для ZIP/7z (необязательно) */
  password?: string
  csvDelimiter: ',' | ';' | '\t'
  /** CSV в UTF-8 с BOM: так русские буквы правильно открываются в Excel */
  csvBom: boolean
  /** Картинки: максимальная сторона, px (не задана — как в оригинале) */
  maxSize?: number
  /** Картинки: сохранить скрытые данные (GPS, камера). По умолчанию они удаляются. */
  keepMetadata?: boolean
  /** Видео и звук: подробные настройки (не заданы — значения по умолчанию) */
  media?: UniversalMedia
  /** Нейросети: язык распознавания текста («rus+eng») или речи («ru», «auto») */
  lang?: string
  /** Нейросети: модель речи (tiny, base, small) */
  aiModel?: string
  /** Субтитры: сдвиг времени, секунды (минус — раньше) */
  shift?: number
  /** Субтитры из видео: номер дорожки с нуля */
  subTrack?: number
}

export interface UniversalMedia {
  quality: 'high' | 'medium' | 'low'
  /** Максимальная высота кадра (для вертикального видео — ширина); не задана — как в оригинале */
  maxHeight?: number
  audioBitrate: number
  mute: boolean
  stripMetadata: boolean
  useGpu: boolean
  /** Лимит размера результата, МБ (только видео) */
  targetMB?: number
}

/** Настройки по умолчанию для действий без окна настроек (быстрое окно, следящие папки). */
export function defaultUniversalOptions(target: string, outputDir?: string, quality = 85): UniversalOptions {
  return { target, quality, outputDir, archiveLevel: 'normal', csvDelimiter: ',', csvBom: true }
}

export interface MorphioApi {
  watchStatus(): Promise<WatchStatus[]>
  targetsForKind(kind: FileKind): Promise<UniversalTarget[]>
  /** Основное окно: пришли файлы из трея, меню Проводника или быстрого окна */
  onOpenFiles(callback: (paths: string[]) => void): () => void
  /** Быстрое окно: пришли файлы после нажатия сочетания клавиш */
  onQuickFiles(callback: (paths: string[]) => void): () => void
  quickClose(): Promise<void>
  quickOpenMain(paths: string[]): Promise<void>
  quickReady(): Promise<void>
  quickRemember(target: string): Promise<void>
  /** Основное окно при запуске: файлы, которые пришли из меню Проводника или быстрого окна */
  takeOpenFiles(): Promise<string[]>
  pickAny(): Promise<string[]>
  pickAnyFolder(): Promise<string[]>
  inspectAny(paths: string[]): Promise<FileItem[]>
  universalTargets(items: FileItem[]): Promise<UniversalTarget[]>
  universalConvert(items: FileItem[], options: UniversalOptions): Promise<void>
  getSettings(): Promise<SettingsState>
  patchSettings(patch: Partial<AppSettings>): Promise<SettingsState>
  getPathForFile(file: File): string
  pickFiles(): Promise<string[]>
  pickFolder(): Promise<string | undefined>
  inspectFiles(paths: string[]): Promise<FileItem[]>
  removeBackground(items: FileItem[], options: BgRemoveOptions): Promise<void>
  mediaCapabilities(): Promise<MediaCapabilities>
  pickVideo(): Promise<string | undefined>
  videoInfo(path: string): Promise<VideoInfo>
  videoPoster(path: string, time: number, maxSide: number): Promise<string>
  extractVideoFrames(options: VideoExtractOptions): Promise<VideoExtractResult>
  inspectFrames(paths: string[]): Promise<GifFrame[]>
  buildGif(frames: GifFrame[], options: GifBuildOptions): Promise<GifResult>
  /** Картинка файла для стикера (до maxSide, с прозрачностью) */
  stickerImage(path: string, maxSide: number): Promise<ImagePreview>
  exportFrames(frames: GifFrame[], outputDir: string, extra?: { crop?: GifCrop; layers?: GifLayer[] }): Promise<{ dir: string; count: number }>
  onGifProgress(callback: (progress: GifProgress) => void): () => void
  runChain(items: FileItem[], config: ChainConfig): Promise<void>
  previewImage(path: string, maxSide: number): Promise<ImagePreview>
  montagePickVideos(): Promise<string[]>
  montagePickSubtitles(): Promise<string | undefined>
  montageInspect(paths: string[]): Promise<MontageClip[]>
  /** Лента кадров: одна картинка с равными кадрами по длине ролика */
  montageStrip(path: string, count: number, height: number): Promise<string>
  /** Паузы в звуке ролика: отрезки тишины, секунды */
  montageSilence(path: string, noiseDb: number, minSilence: number): Promise<{ start: number; end: number }[]>
  montageRun(plan: MontagePlan): Promise<SavedResult>
  onMontageProgress(callback: (progress: MontageProgress) => void): () => void
  /** Редактор субтитров: прочитать реплики файла и сохранить правки */
  subtitlesLoad(path: string): Promise<Cue[]>
  subtitlesSave(path: string, cues: Cue[]): Promise<void>
  compare(inputPath: string, outputPath: string, time?: number): Promise<CompareResult>
  openMaskEditor(item: FileItem, options: BgRemoveOptions): Promise<MaskEditSession>
  saveMaskEdit(
    item: FileItem,
    options: BgRemoveOptions,
    strokes: EditOp[],
    outputPath: string
  ): Promise<SavedResult>
  cancel(): Promise<void>
  onProgress(callback: (progress: JobProgress) => void): () => void
  revealInFolder(path: string): Promise<void>
  modelStatus(): Promise<ModelStatus>
  downloadModel(): Promise<void>
  modulesList(): Promise<ModuleInfo[]>
  modulesInstall(id: string): Promise<void>
  modulesRemove(id: string): Promise<void>
  onModuleProgress(callback: (progress: ModuleProgress) => void): () => void
  /** Найдена ли программа Calibre (нужна для MOBI и AZW3) */
  calibreFound(): Promise<boolean>
  onModelDownload(callback: (progress: ModelDownloadProgress) => void): () => void
}
