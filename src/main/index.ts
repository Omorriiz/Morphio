import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { AUDIO_EXTENSIONS, INPUT_IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '@shared/types'
import type {
  BgOutputFormat,
  BgRemoveOptions,
  BrushStroke,
  ConvertOptions,
  FileItem,
  GifBuildOptions,
  GifFrame,
  ImagePreview,
  JobProgress,
  MaskEditSession,
  MediaOptions,
  ModelDownloadProgress,
  PipelineConfig,
  SavedResult,
  VideoExtractOptions
} from '@shared/types'
import sharp from 'sharp'
import { convertImage, makeThumbnail } from './converters/image'
import {
  computeCutout,
  removeBackground,
  writeCutout,
  type Cutout
} from './converters/background'
import { buildGif, exportFrames, inspectFrames } from './converters/gif'
import {
  cancelFfmpeg,
  cleanupFrameDirs,
  detectGpu,
  extractVideoFrames,
  videoInfo,
  videoPoster
} from './ffmpeg'
import { convertMedia, inspectMedia } from './converters/media'
import { bgModelStatus, downloadBgModel, findBgModel } from './models'
import { openImage } from './imageInput'
import { applyStrokes } from './maskEdit'
import { runPipelineItem } from './pipeline'
import { JobQueue } from './queue'

const queue = new JobQueue(3)
// Нейросеть тяжёлая, обрабатываем по одному файлу за раз.
const bgQueue = new JobQueue(1)
// Видео и звук: по одному файлу за раз (кодирование само нагружает процессор или видеокарту).
const mediaQueue = new JobQueue(1)
let pipelineQueue: JobQueue | null = null
let mainWindow: BrowserWindow | null = null

// Кэш последних вычисленных масок: редактору и сохранению не нужно искать объект заново.
const cutoutCache = new Map<string, Cutout>()
async function getCutout(item: FileItem, options: BgRemoveOptions): Promise<Cutout> {
  const key = `${item.path}::${options.method}:${options.tolerance}:${options.everywhere}:${options.translucent}:${options.bgColor ?? ''}`
  const hit = cutoutCache.get(key)
  if (hit) return hit
  const cutout = await computeCutout(item, options, findBgModel())
  cutoutCache.set(key, cutout)
  if (cutoutCache.size > 3) cutoutCache.delete(cutoutCache.keys().next().value as string)
  return cutout
}

function overlayFor(dark: boolean): Electron.TitleBarOverlayOptions {
  return { color: '#00000000', symbolColor: dark ? '#e8e8f0' : '#3a3a4a', height: 44 }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Morphio',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14141b' : '#f7f7fb',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayFor(nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Внешние ссылки открываем в браузере, а не внутри приложения.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Разворачиваем папки в список файлов-изображений. */
async function collectPaths(
  paths: string[],
  extensions: string[] = INPUT_IMAGE_EXTENSIONS
): Promise<string[]> {
  const result: string[] = []
  for (const p of paths) {
    try {
      const stat = await fs.stat(p)
      if (stat.isDirectory()) {
        // Естественный порядок: frame2 раньше frame10.
        const entries = (await fs.readdir(p)).sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true })
        )
        result.push(...(await collectPaths(entries.map((e) => join(p, e)), extensions)))
      } else if (extensions.includes(extname(p).slice(1).toLowerCase())) {
        result.push(p)
      }
    } catch {
      /* пропускаем недоступные файлы */
    }
  }
  return result
}

function registerIpc(): void {
  ipcMain.handle('files:pick', async () => {
    if (!mainWindow) return []
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите изображения',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Изображения', extensions: INPUT_IMAGE_EXTENSIONS },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    return filePaths
  })

  ipcMain.handle('folder:pick', async () => {
    if (!mainWindow) return undefined
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Куда сохранять результат',
      properties: ['openDirectory', 'createDirectory']
    })
    return filePaths[0]
  })

  ipcMain.handle('files:inspect', async (_e, paths: string[]): Promise<FileItem[]> => {
    const files = await collectPaths(paths)
    return Promise.all(
      files.map(async (path) => {
        const stat = await fs.stat(path)
        const thumb = await makeThumbnail(path)
        return {
          id: randomUUID(),
          path,
          name: basename(path),
          ext: extname(path).slice(1).toLowerCase(),
          size: stat.size,
          ...thumb
        }
      })
    )
  })

  ipcMain.handle('convert:start', async (e, items: FileItem[], options: ConvertOptions) => {
    await queue.run(
      items,
      (item) => convertImage(item, options),
      (progress: JobProgress) => e.sender.send('convert:progress', progress)
    )
  })

  ipcMain.handle('bg:start', async (e, items: FileItem[], options: BgRemoveOptions) => {
    // Для режима «однотонный фон» нейросеть не нужна.
    const modelPath = findBgModel()
    if (!modelPath && options.method === 'ai') {
      items.forEach((i) =>
        e.sender.send('convert:progress', {
          id: i.id,
          status: 'error',
          error: 'Модель не найдена. Скачайте её на вкладке «Удалить фон».'
        } satisfies JobProgress)
      )
      return
    }
    await bgQueue.run(
      items,
      (item) => removeBackground(item, options, modelPath),
      (progress: JobProgress) => e.sender.send('convert:progress', progress)
    )
  })

  ipcMain.handle('media:pick', async () => {
    if (!mainWindow) return []
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите видео или звук',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Видео и звук', extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    return filePaths
  })

  ipcMain.handle('media:inspect', async (_e, paths: string[]) =>
    inspectMedia(await collectPaths(paths, [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]))
  )

  ipcMain.handle('media:caps', () => detectGpu())

  ipcMain.handle('media:convert', async (e, items: FileItem[], options: MediaOptions) => {
    const caps = await detectGpu()
    await mediaQueue.run(
      items,
      (item, update) => convertMedia(item, options, caps.gpu, (percent) => update({ percent })),
      (progress: JobProgress) => e.sender.send('convert:progress', progress)
    )
  })

  ipcMain.handle('video:pick', async () => {
    if (!mainWindow) return undefined
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите видео',
      properties: ['openFile'],
      filters: [
        { name: 'Видео', extensions: VIDEO_EXTENSIONS },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    })
    return filePaths[0]
  })
  ipcMain.handle('video:info', (_e, path: string) => videoInfo(path))
  ipcMain.handle('video:poster', (_e, path: string, time: number, maxSide: number) =>
    videoPoster(path, time, maxSide)
  )
  ipcMain.handle('video:extract', (e, options: VideoExtractOptions) =>
    extractVideoFrames(options, (p) => e.sender.send('gif:progress', p))
  )

  // Файлы и целые папки (кадры из папки идут в естественном порядке имён).
  ipcMain.handle('gif:inspect', async (_e, paths: string[]) =>
    inspectFrames(await collectPaths(paths))
  )

  ipcMain.handle('gif:build', (e, frames: GifFrame[], options: GifBuildOptions) =>
    buildGif(frames, options, (p) => e.sender.send('gif:progress', p))
  )

  ipcMain.handle('gif:export', (e, frames: GifFrame[], outputDir: string) =>
    exportFrames(frames, outputDir, (p) => e.sender.send('gif:progress', p))
  )

  ipcMain.handle('pipeline:start', async (e, items: FileItem[], config: PipelineConfig) => {
    const modelPath = findBgModel()
    const q = new JobQueue(config.removeBg ? 1 : 3)
    pipelineQueue = q
    const index = new Map(items.map((it, i) => [it.id, i]))
    await q.run(
      items,
      (item) => runPipelineItem(item, index.get(item.id) ?? 0, config, modelPath),
      (progress: JobProgress) => e.sender.send('convert:progress', progress)
    )
  })

  ipcMain.handle('convert:cancel', () => {
    queue.cancel()
    bgQueue.cancel()
    mediaQueue.cancel()
    pipelineQueue?.cancel()
    cancelFfmpeg()
  })

  // Увеличенное превью (для пипетки): JPEG до maxSide по длинной стороне.
  ipcMain.handle('files:preview', async (_e, path: string, maxSide: number): Promise<ImagePreview> => {
    const img = await openImage(path)
    const buf = await img
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true })
    return {
      dataUrl: `data:image/jpeg;base64,${buf.data.toString('base64')}`,
      width: buf.info.width,
      height: buf.info.height
    }
  })

  // Редактор маски: отдаём цвета объекта и текущую маску в уменьшенном виде.
  ipcMain.handle(
    'bg:edit-open',
    async (_e, item: FileItem, options: BgRemoveOptions): Promise<MaskEditSession> => {
      const cutout = await getCutout(item, options)
      const scale = Math.min(1, 1600 / Math.max(cutout.width, cutout.height))
      const pw = Math.max(1, Math.round(cutout.width * scale))
      const ph = Math.max(1, Math.round(cutout.height * scale))
      const image = await sharp(cutout.colors, {
        raw: { width: cutout.width, height: cutout.height, channels: 3 }
      })
        .resize(pw, ph)
        .jpeg({ quality: 90 })
        .toBuffer()
      const maskPng = await sharp(cutout.mask, {
        raw: { width: cutout.width, height: cutout.height, channels: 1 }
      })
        .resize(pw, ph)
        .png()
        .toBuffer()
      return {
        width: cutout.width,
        height: cutout.height,
        previewWidth: pw,
        previewHeight: ph,
        imageUrl: `data:image/jpeg;base64,${image.toString('base64')}`,
        maskUrl: `data:image/png;base64,${maskPng.toString('base64')}`
      }
    }
  )

  // Сохранение: мазки применяются к маске в полном разрешении, файл перезаписывается.
  ipcMain.handle(
    'bg:edit-save',
    async (
      _e,
      item: FileItem,
      options: BgRemoveOptions,
      strokes: BrushStroke[],
      outputPath: string
    ): Promise<SavedResult> => {
      const cutout = await getCutout(item, options)
      const mask = Buffer.from(cutout.mask)
      applyStrokes(mask, cutout.width, cutout.height, strokes)
      const ext = extname(outputPath).slice(1).toLowerCase()
      const format = (ext === 'jpg' || ext === 'webp' ? ext : 'png') as BgOutputFormat
      const edited = { ...cutout, mask, note: `${cutout.note}, правка кистью` }
      return writeCutout(item, edited, { ...options, format }, outputPath)
    }
  )

  ipcMain.handle('model:status', () => bgModelStatus())

  ipcMain.handle('model:download', async (e) => {
    await downloadBgModel((p: ModelDownloadProgress) => e.sender.send('model:progress', p))
  })

  ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path))
}

app.whenReady().then(() => {
  void cleanupFrameDirs() // остатки кадров от прошлого запуска
  registerIpc()
  createWindow()

  nativeTheme.on('updated', () => {
    mainWindow?.setTitleBarOverlay(overlayFor(nativeTheme.shouldUseDarkColors))
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  void cleanupFrameDirs()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
