import type {
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
export function installDevMock(): void {
  const listeners = new Set<(p: JobProgress) => void>()
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
    pickFiles: async () => ['demo'],
    pickFolder: async () => 'C:\\Converted',
    inspectFiles: async () => [
      demo('IMG_2041.heic.png', 4_820_000, 250),
      demo('holiday-beach.jpg', 3_210_000, 30),
      demo('logo-final.png', 640_000, 160)
    ],
    convert: async (items) => {
      for (const item of items) {
        listeners.forEach((l) => l({ id: item.id, status: 'working' }))
        await new Promise((r) => setTimeout(r, 700))
        listeners.forEach((l) =>
          l({
            id: item.id,
            status: 'done',
            outputPath: item.path + '.webp',
            outputSize: Math.round(item.size * 0.34)
          })
        )
      }
    },
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
    pickMedia: async () => ['demo'],
    inspectMedia: async () => [
      {
        id: crypto.randomUUID(),
        path: 'C:\\Videos\\holiday-clip.mov',
        name: 'holiday-clip.mov',
        ext: 'mov',
        size: 184_000_000,
        kind: 'video' as const,
        duration: 94,
        width: 1920,
        height: 1080,
        hasAudio: true,
        thumbnail: demo('x', 1, 210).thumbnail
      },
      {
        id: crypto.randomUUID(),
        path: 'C:\\Music\\song.wav',
        name: 'song.wav',
        ext: 'wav',
        size: 41_000_000,
        kind: 'audio' as const,
        duration: 232,
        hasAudio: true
      }
    ],
    mediaCapabilities: async () => ({ gpu: 'nvenc' as const, gpuLabel: 'NVIDIA NVENC' }),
    convertMedia: async (items) => {
      for (const item of items) {
        for (let p = 0; p <= 100; p += 20) {
          listeners.forEach((l) => l({ id: item.id, status: 'working', percent: p }))
          await new Promise((r) => setTimeout(r, 150))
        }
        const bad = item.kind === 'audio' && Math.random() < 0 // заглушка: ошибок нет
        listeners.forEach((l) =>
          l(
            bad
              ? { id: item.id, status: 'error', error: 'Из звукового файла нельзя сделать видео' }
              : {
                  id: item.id,
                  status: 'done',
                  outputPath: item.path + '.out',
                  outputSize: Math.round(item.size * 0.12),
                  info: 'H.264 · видеокарта NVIDIA'
                }
          )
        )
      }
    },
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
            outputPath: item.path + '.out',
            outputSize: Math.round(item.size * 0.2),
            preview: item.thumbnail
          })
        )
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
    revealInFolder: async () => {}
  }
  window.api = api
}
