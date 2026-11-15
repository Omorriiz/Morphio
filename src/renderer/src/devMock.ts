import { detectLanguage, translate } from '@shared/i18n'
import type { Language } from '@shared/i18n'
import { AUDIO_TARGETS, IMAGE_FORMATS, VIDEO_TARGETS } from '@shared/types'
import type {
  UniversalTarget,
  AppSettings,
  SettingsState,
  MorphioApi,
  FileItem,
  GifProgress,
  JobProgress,
  ModelDownloadProgress
} from '@shared/types'

/** Демо-«спрайт» на розовом фоне и маска к нему (с небольшим дефектом — остатком фона). */
function demoSprite(): { image: HTMLCanvasElement; mask: HTMLCanvasElement } {
  const W = 640
  const H = 480
  const image = document.createElement('canvas')
  image.width = W
  image.height = H
  const c = image.getContext('2d')!
  c.fillStyle = '#ff00ff'
  c.fillRect(0, 0, W, H)
  c.fillStyle = '#9a6a3a'
  c.beginPath()
  c.roundRect(120, 140, 400, 220, 28)
  c.fill()
  c.fillStyle = '#6b4423'
  c.fillRect(140, 300, 360, 40)
  c.fillStyle = '#7b5cf0'
  c.beginPath()
  c.arc(320, 150, 70, 0, Math.PI * 2)
  c.fill()

  const mask = document.createElement('canvas')
  mask.width = W
  mask.height = H
  const m = mask.getContext('2d')!
  m.fillStyle = '#000'
  m.fillRect(0, 0, W, H)
  m.fillStyle = '#fff'
  m.beginPath()
  m.roundRect(100, 120, 440, 260, 40) // маска с запасом: захватывает розовую кайму
  m.fill()
  m.beginPath()
  m.arc(320, 150, 70, 0, Math.PI * 2)
  m.fill()
  return { image, mask }
}

/**
 * Заглушка window.api — нужна только чтобы открывать интерфейс в обычном браузере
 * во время разработки (без Electron). В сборке приложения не используется.
 */
let mockSettings: AppSettings = {
  version: 1,
  language: 'system',
  theme: 'system',
  tray: false,
  closeToTray: false,
  launchAtLogin: false,
  quickEnabled: false,
  hotkey: 'CommandOrControl+Shift+X',
  explorerMenu: false,
  quickLast: [],
  watchRules: []
}
try {
  const saved = localStorage.getItem('morphio-mock-settings')
  if (saved) mockSettings = { ...mockSettings, ...JSON.parse(saved) }
} catch {
  /* хранилище недоступно */
}
function settingsState(): SettingsState {
  const language: Language =
    mockSettings.language === 'system'
      ? detectLanguage(navigator.language)
      : mockSettings.language
  return { settings: mockSettings, language, hotkeyOk: true }
}

/** Какие файлы подставляет заглушка: ?files=image|video|table|archive|mixed (по умолчанию video). */
function mockFiles(): FileItem[] {
  const kind = new URLSearchParams(location.search).get('files') ?? 'video'
  const mk = (name: string, size: number, k: FileItem['kind'], extra: Partial<FileItem> = {}): FileItem => ({
    id: crypto.randomUUID(),
    path: 'C:/Demo/' + name,
    name,
    ext: name.split('.').pop() ?? '',
    size,
    kind: k,
    ...extra
  })
  if (kind === 'image') {
    return [mk('IMG_2041.heic', 4_820_000, 'image', { width: 4032, height: 3024 }), mk('holiday-beach.jpg', 3_210_000, 'image', { width: 4000, height: 3000 })]
  }
  if (kind === 'table') return [mk('продажи.csv', 48_200, 'table'), mk('склад.xlsx', 91_500, 'table')]
  if (kind === 'archive') return [mk('backup.zip', 12_400_000, 'archive'), mk('Документы', 0, 'folder')]
  return [
    mk('holiday-clip.mov', 184_000_000, 'video', { duration: 94, width: 1920, height: 1080, hasAudio: true }),
    mk('lecture.mp4', 96_000_000, 'video', { duration: 612, width: 1280, height: 720, hasAudio: true })
  ]
}

/** Упрощённая копия реестра форматов: те же варианты и подписи, что в основном процессе. */
function mockTargets(items: FileItem[]): UniversalTarget[] {
  const lang = settingsState().language
  const tr = (x: string): string => translate(lang, x)
  const per = (item: FileItem, same = true): UniversalTarget[] => {
    const k = item.kind
    const out: UniversalTarget[] = []
    if (k === 'image') IMAGE_FORMATS.filter((f) => same || f.id !== item.ext).forEach((f) => out.push({ id: 'image:' + f.id, label: f.label, group: 'image', hint: tr(f.hint) }))
    if (k === 'video') VIDEO_TARGETS.filter((f) => same || f.id !== item.ext).forEach((f) => out.push({ id: 'video:' + f.id, label: f.label, group: 'video', hint: tr(f.hint) }))
    if (k === 'video' || k === 'audio') AUDIO_TARGETS.filter((f) => same || f.id !== item.ext).forEach((f) => out.push({ id: 'audio:' + f.id, label: f.label, group: 'audio', hint: tr(f.hint) }))
    if (k === 'table') ['xlsx', 'csv', 'tsv', 'json', 'yaml', 'xml'].filter((f) => same || f !== item.ext).forEach((f) => out.push({ id: 'table:' + f, label: f.toUpperCase(), group: 'table', hint: tr('Таблица') }))
    if (k === 'archive') out.push({ id: 'archive:unpack', label: tr('Распаковать'), group: 'archive', hint: tr('В папку с именем архива') })
    ;['zip', '7z', 'tar', 'targz'].filter((f) => f !== item.ext).forEach((f) => out.push({ id: 'archive:' + f, label: translate(lang, 'В {fmt}', { fmt: f === 'targz' ? 'TAR.GZ' : f.toUpperCase() }), group: 'archive', hint: tr('Открывается везде, можно с паролем') }))
    return out
  }
  if (items.length === 0) return []
  const [first, ...rest] = items.map((i) => per(i, true))
  return first.filter((t) => rest.every((l) => l.some((x) => x.id === t.id)) && items.some((i) => per(i).some((x) => x.id === t.id)))
}

export function installDevMock(): void {
  const listeners = new Set<(p: JobProgress) => void>()
  const moduleListeners = new Set<(p: import('@shared/types').ModuleProgress) => void>()
  let mockPandoc = false
  const dlListeners = new Set<(p: ModelDownloadProgress) => void>()
  const gifListeners = new Set<(p: GifProgress) => void>()
  let modelReady = false
  const demo = (name: string, size: number, hue: number): FileItem => ({
    id: crypto.randomUUID(),
    path: `C:\\Photos\\${name}`,
    name,
    ext: name.split('.').pop()!,
    size,
    width: 4032,
    height: 3024,
    thumbnail:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},80%,70%)"/><stop offset="1" stop-color="hsl(${hue + 60},80%,60%)"/></linearGradient></defs><rect width="160" height="160" fill="url(#g)"/></svg>`
      )
  })

  const api: MorphioApi = {
    getPathForFile: (f) => f.name,
    watchStatus: async () => [],
    targetsForKind: async (kind) => [
      { id: 'image:webp', label: 'WebP', group: 'image' as const, hint: 'Лёгкий' },
      { id: 'table:xlsx', label: 'XLSX', group: 'table' as const, hint: 'Excel' },
      { id: 'archive:zip', label: kind + ' ZIP', group: 'archive' as const, hint: 'Архив' }
    ],
    onOpenFiles: () => () => {},
    onQuickFiles: (cb) => {
      // В браузере быстрое окно показывает демо-файлы через секунду после открытия страницы quick.html.
      const id = window.setTimeout(() => cb(['demo']), 400)
      return () => window.clearTimeout(id)
    },
    quickClose: async () => {},
    quickOpenMain: async () => {},
    quickReady: async () => {},
    quickRemember: async () => {},
    takeOpenFiles: async () => [],
    pickAny: async () => ['demo'],
    pickAnyFolder: async () => ['demo-folder'],
    inspectAny: async () => mockFiles(),
    universalTargets: async (items) => mockTargets(items),
    universalConvert: async (items) => {
      for (const item of items) {
        for (let p = 0; p <= 100; p += 25) {
          listeners.forEach((l) => l({ id: item.id, status: 'working', percent: p }))
          await new Promise((r) => setTimeout(r, 120))
        }
        listeners.forEach((l) => l({ id: item.id, status: 'done', outputPath: item.path + '-out.' + item.ext, outputSize: Math.round(item.size * 0.8), info: 'строк: 120' }))
      }
    },
    pickFiles: async () => ['demo'],
    pickFolder: async () => 'C:\\Converted',
    inspectFiles: async () => [
      demo('IMG_2041.heic.png', 4_820_000, 250),
      demo('holiday-beach.jpg', 3_210_000, 30),
      demo('logo-final.png', 640_000, 160)
    ],
    removeBackground: async (items) => {
      for (const item of items) {
        listeners.forEach((l) => l({ id: item.id, status: 'working' }))
        await new Promise((r) => setTimeout(r, 700))
        listeners.forEach((l) =>
          l({
            id: item.id,
            status: 'done',
            outputPath: item.path + '.png',
            outputSize: Math.round(item.size * 0.4),
            preview: item.thumbnail
          })
        )
      }
    },
    mediaCapabilities: async () => ({ gpu: 'nvenc' as const, gpuLabel: 'NVIDIA NVENC' }),
    pickVideo: async () => 'C:\\Videos\\holiday-clip.mp4',
    videoInfo: async (path) => ({
      path,
      name: path.split('\\').pop() ?? 'video.mp4',
      duration: 12.4,
      width: 1920,
      height: 1080,
      fps: 30
    }),
    videoPoster: async (_p, time) => {
      const c = document.createElement('canvas')
      c.width = 520
      c.height = 292
      const g = c.getContext('2d')!
      g.fillStyle = `hsl(${(time * 40) % 360},60%,40%)`
      g.fillRect(0, 0, 520, 292)
      g.fillStyle = '#fff'
      g.font = 'bold 48px sans-serif'
      g.textAlign = 'center'
      g.fillText(`t = ${time.toFixed(1)} с`, 260, 160)
      return c.toDataURL('image/jpeg', 0.85)
    },
    extractVideoFrames: async (o) => {
      for (let i = 0; i < 5; i++) {
        gifListeners.forEach((l) => l({ text: 'Вынимаю кадры из видео…', done: i, total: 5 }))
        await new Promise((r) => setTimeout(r, 200))
      }
      const count = Math.round(o.duration * o.fps)
      const mocks = await api.inspectFrames(Array.from({ length: count }, (_, i) => `v${i}`))
      return { frames: mocks.slice(0, count), delay: Math.round(1000 / o.fps) }
    },
    inspectFrames: async (paths) => {
      // Демо-кадры: цветные квадраты с номером, чтобы проверять ленту, порядок и проигрыватель.
      const count = paths.length > 1 ? paths.length : 6
      return Array.from({ length: count }, (_, i) => {
        const c = document.createElement('canvas')
        c.width = 320
        c.height = 240
        const g = c.getContext('2d')!
        g.fillStyle = `hsl(${(i * 55) % 360},75%,58%)`
        g.fillRect(0, 0, 320, 240)
        g.fillStyle = 'rgba(255,255,255,0.9)'
        g.font = 'bold 110px sans-serif'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(String(i + 1), 160, 128)
        const url = c.toDataURL('image/png')
        return {
          id: crypto.randomUUID(),
          path: `C:\\Frames\\frame${i + 1}.png`,
          name: `frame${i + 1}.png`,
          width: 320,
          height: 240,
          thumbnail: url,
          preview: url
        }
      })
    },
    buildGif: async (frames, options) => {
      for (let i = 0; i < 4; i++) {
        gifListeners.forEach((l) => l({ text: 'Собираю анимацию…', done: i, total: 4 }))
        await new Promise((r) => setTimeout(r, 250))
      }
      const first = frames[0]
      return {
        outputPath: `C:\\Frames\\${options.name}.${options.format}`,
        outputSize: options.targetKB ? options.targetKB * 900 : 1_480_000,
        width: options.width ?? first.width,
        height: Math.round(((options.width ?? first.width) * first.height) / first.width),
        frames: frames.length,
        note: options.targetKB ? 'Чтобы уложиться в размер: 70% размера, 64 цветов' : undefined,
        reachedTarget: options.targetKB ? true : undefined,
        previewUrl: first.preview
      }
    },
    exportFrames: async (frames) => ({ dir: 'C:\\Frames\\frames', count: frames.length }),
    onGifProgress: (cb) => {
      gifListeners.add(cb)
      return () => gifListeners.delete(cb)
    },
    runPipeline: async (items) => {
      for (const item of items) {
        listeners.forEach((l) => l({ id: item.id, status: 'working' }))
        await new Promise((r) => setTimeout(r, 500))
        listeners.forEach((l) =>
          l({
            id: item.id,
            status: 'done',
            outputPath: item.path + '-out.' + item.ext,
            outputSize: Math.round(item.size * 0.2),
            preview: item.thumbnail
          })
        )
      }
    },
    modulesList: async () => [
      {
        id: 'pandoc',
        name: 'Pandoc',
        version: '3.14',
        description: 'Документы и книги: DOCX, ODT, RTF, HTML, Markdown, EPUB, FB2 и PDF',
        license: 'GPL-2.0-or-later',
        source: 'github.com/jgm/pandoc',
        sizeMB: 41.6,
        installed: mockPandoc
      }
    ],
    modulesInstall: async () => {
      for (let i = 0; i <= 100; i += 20) {
        moduleListeners.forEach((l) => l({ id: 'pandoc', phase: 'download', received: i * 400000, total: 40_000_000 }))
        await new Promise((r) => setTimeout(r, 150))
      }
      mockPandoc = true
      moduleListeners.forEach((l) => l({ id: 'pandoc', phase: 'done', received: 1, total: 1 }))
    },
    modulesRemove: async () => {
      mockPandoc = false
    },
    calibreFound: async () => false,
    onModuleProgress: (cb) => {
      moduleListeners.add(cb)
      return () => moduleListeners.delete(cb)
    },
    compare: async () => {
      const { image } = demoSprite()
      const url = image.toDataURL('image/jpeg', 0.9)
      const lo = document.createElement('canvas')
      lo.width = Math.round(image.width / 6)
      lo.height = Math.round(image.height / 6)
      lo.getContext('2d')!.drawImage(image, 0, 0, lo.width, lo.height)
      return {
        before: url,
        after: lo.toDataURL('image/jpeg', 0.3),
        width: image.width,
        height: image.height,
        originalWidth: image.width,
        originalHeight: image.height,
        sizeBefore: 4_200_000,
        sizeAfter: 900_000,
        psnr: 31.2,
        ssim: 0.91,
        verdict: 'noticeable' as const
      }
    },
    previewImage: async () => {
      const { image } = demoSprite()
      return { dataUrl: image.toDataURL('image/jpeg', 0.9), width: image.width, height: image.height }
    },
    openMaskEditor: async () => {
      const { image, mask } = demoSprite()
      return {
        width: image.width,
        height: image.height,
        previewWidth: image.width,
        previewHeight: image.height,
        imageUrl: image.toDataURL('image/jpeg', 0.9),
        maskUrl: mask.toDataURL('image/png')
      }
    },
    saveMaskEdit: async (item, _o, strokes) => {
      await new Promise((r) => setTimeout(r, 400))
      console.info('[mock] saved strokes:', strokes.length)
      return {
        outputPath: item.path + '.png',
        outputSize: 123_456,
        preview: item.thumbnail,
        info: 'Однотонный фон #ff00ff, правка кистью'
      }
    },
    modelStatus: async () => ({ available: modelReady, name: 'isnet-general-use', sizeMB: 179 }),
    downloadModel: async () => {
      for (let i = 1; i <= 10; i++) {
        await new Promise((r) => setTimeout(r, 250))
        dlListeners.forEach((l) => l({ received: i * 17_900_000, total: 179_000_000 }))
      }
      modelReady = true
      dlListeners.forEach((l) => l({ received: 179_000_000, total: 179_000_000, done: true }))
    },
    onModelDownload: (cb) => {
      dlListeners.add(cb)
      return () => dlListeners.delete(cb)
    },
    cancel: async () => {},
    onProgress: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getSettings: async () => settingsState(),
    patchSettings: async (patch) => {
      mockSettings = { ...mockSettings, ...patch }
      try {
        localStorage.setItem('morphio-mock-settings', JSON.stringify(mockSettings))
      } catch {
        /* хранилище недоступно */
      }
      return settingsState()
    },
    revealInFolder: async () => {}
  }
  window.api = api
}
