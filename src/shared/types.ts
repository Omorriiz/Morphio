// Типы, общие для main, preload и renderer.

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
  kind?: 'video' | 'audio'
  /** Есть ли в файле звуковая дорожка */
  hasAudio?: boolean
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

export interface GifBuildOptions {
  format: 'gif' | 'webp'
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

export interface MorphioApi {
  getPathForFile(file: File): string
  pickFiles(): Promise<string[]>
  pickFolder(): Promise<string | undefined>
  inspectFiles(paths: string[]): Promise<FileItem[]>
  convert(items: FileItem[], options: ConvertOptions): Promise<void>
  removeBackground(items: FileItem[], options: BgRemoveOptions): Promise<void>
  pickMedia(): Promise<string[]>
  inspectMedia(paths: string[]): Promise<FileItem[]>
  mediaCapabilities(): Promise<MediaCapabilities>
  convertMedia(items: FileItem[], options: MediaOptions): Promise<void>
  pickVideo(): Promise<string | undefined>
  videoInfo(path: string): Promise<VideoInfo>
  videoPoster(path: string, time: number, maxSide: number): Promise<string>
  extractVideoFrames(options: VideoExtractOptions): Promise<VideoExtractResult>
  inspectFrames(paths: string[]): Promise<GifFrame[]>
  buildGif(frames: GifFrame[], options: GifBuildOptions): Promise<GifResult>
  exportFrames(frames: GifFrame[], outputDir: string): Promise<{ dir: string; count: number }>
  onGifProgress(callback: (progress: GifProgress) => void): () => void
  runPipeline(items: FileItem[], config: PipelineConfig): Promise<void>
  previewImage(path: string, maxSide: number): Promise<ImagePreview>
  openMaskEditor(item: FileItem, options: BgRemoveOptions): Promise<MaskEditSession>
  saveMaskEdit(
    item: FileItem,
    options: BgRemoveOptions,
    strokes: BrushStroke[],
    outputPath: string
  ): Promise<SavedResult>
  cancel(): Promise<void>
  onProgress(callback: (progress: JobProgress) => void): () => void
  revealInFolder(path: string): Promise<void>
  modelStatus(): Promise<ModelStatus>
  downloadModel(): Promise<void>
  onModelDownload(callback: (progress: ModelDownloadProgress) => void): () => void
}
