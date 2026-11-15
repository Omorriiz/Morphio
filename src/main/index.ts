import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { INPUT_IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '@shared/types'
import type {
  AppSettings,
  BgOutputFormat,
  BgRemoveOptions,
  BrushStroke,
  FileItem,
  FileKind,
  GifBuildOptions,
  GifFrame,
  ImagePreview,
  JobProgress,
  MaskEditSession,
  ModelDownloadProgress,
  PipelineConfig,
  SavedResult,
  UniversalOptions,
  VideoExtractOptions
} from '@shared/types'
import sharp from 'sharp'
import { makeThumbnail } from './converters/image'
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
import { bgModelStatus, downloadBgModel, findBgModel } from './models'
import { openImage } from './imageInput'
import { comparePair } from './compare'
import { calibreBinary, cancelDocuments } from './converters/documents'
import { configureModules, installModule, moduleList, removeModule } from './modules'
import { applyStrokes } from './maskEdit'
import { runPipelineItem } from './pipeline'
import { JobQueue } from './queue'
import { describeItem, getTargets, MERGE_TARGET, runMerge, runUniversal, targetsForKind } from './registry'
import { cancelArchives } from './converters/archives'
import { flushSettings, getSettings, loadSettings, patchSettings, settingsState } from './settings'
import { tm } from './tm'
import {
  applySettings,
  backgroundState,
  collectQuick,
  hasTray,
  initBackground,
  isQuitting,
  maybeQuitIdle,
  openInMain,
  parseArgs,
  watchStatus
} from './background'

// Нейросеть тяжёлая, обрабатываем по одному файлу за раз.
const bgQueue = new JobQueue(1)
// Любые файлы (таблицы, архивы и т. д.): архивы читают диск, поэтому по два за раз.
const universalQueue = new JobQueue(2)
let universalJobs = 0
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

function createWindow(show = true): BrowserWindow {
  const win = new BrowserWindow({
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

  mainWindow = win
  if (show) win.once('ready-to-show', () => win.show())

  // Закрытие окна прячет его в трей, если это включено; иначе приложение закрывается.
  win.on('close', (e) => {
    if (!isQuitting() && hasTray() && getSettings().closeToTray) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    maybeQuitIdle()
  })

  // Внешние ссылки открываем в браузере, а не внутри приложения.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** Показывает основное окно (создаёт, если его нет, и выводит из трея). */
function showMain(): BrowserWindow {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow(false)
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
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
  ipcMain.handle('settings:get', () => settingsState(backgroundState()))
  ipcMain.handle('settings:patch', async (_e, patch: Partial<AppSettings>) => {
    patchSettings(patch)
    await applySettings()
    return settingsState(backgroundState())
  })
  ipcMain.handle('watch:status', () => watchStatus())
  ipcMain.handle('any:targets-for-kind', (_e, kind: FileKind) => targetsForKind(kind))

  ipcMain.handle('files:pick', async () => {
    if (!mainWindow) return []
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: tm('Выберите изображения'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: tm('Изображения'), extensions: INPUT_IMAGE_EXTENSIONS },
        { name: tm('Все файлы'), extensions: ['*'] }
      ]
    })
    return filePaths
  })

  ipcMain.handle('folder:pick', async () => {
    if (!mainWindow) return undefined
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: tm('Куда сохранять результат'),
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

  ipcMain.handle('bg:start', async (e, items: FileItem[], options: BgRemoveOptions) => {
    // Для режима «однотонный фон» нейросеть не нужна.
    const modelPath = findBgModel()
    if (!modelPath && options.method === 'ai') {
      items.forEach((i) =>
        e.sender.send('convert:progress', {
          id: i.id,
          status: 'error',
          error: tm('Модель не найдена. Скачайте её на вкладке «Удалить фон».')
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

  ipcMain.handle('media:caps', () => detectGpu())

  ipcMain.handle('video:pick', async () => {
    if (!mainWindow) return undefined
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: tm('Выберите видео'),
      properties: ['openFile'],
      filters: [
        { name: tm('Видео'), extensions: VIDEO_EXTENSIONS },
        { name: tm('Все файлы'), extensions: ['*'] }
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

  ipcMain.handle('any:pick', async () => {
    if (!mainWindow) return []
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: tm('Выберите файлы'),
      properties: ['openFile', 'multiSelections']
    })
    return filePaths
  })

  ipcMain.handle('any:pick-folder', async () => {
    if (!mainWindow) return []
    const { filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: tm('Выберите папку'),
      properties: ['openDirectory', 'multiSelections']
    })
    return filePaths
  })

  // Любые файлы и папки: вид определяет реестр форматов. Папки не разворачиваются (их можно запаковать).
  ipcMain.handle('any:inspect', async (_e, paths: string[]): Promise<FileItem[]> => {
    const items: FileItem[] = []
    for (const path of paths) {
      const item = await describeItem(path)
      if (item) items.push(item)
    }
    return items
  })

  ipcMain.handle('any:targets', (_e, items: FileItem[]) => getTargets(items))

  ipcMain.handle('any:convert', async (e, items: FileItem[], options: UniversalOptions) => {
    const caps = await detectGpu()
    universalJobs++
    try {
      const report = (progress: JobProgress): void => e.sender.send('convert:progress', progress)
      if (options.target === MERGE_TARGET && items.length > 0) {
        // Один результат на все файлы: работает первый, остальные получают тот же итог
        let merged: Awaited<ReturnType<typeof runMerge>> | undefined
        await universalQueue.run(
          [items[0]],
          async (_item, update) => (merged = await runMerge(items, options, update)),
          report
        )
        if (merged) {
          for (const rest of items.slice(1)) report({ id: rest.id, status: 'done', ...merged })
        } else {
          for (const rest of items.slice(1)) report({ id: rest.id, status: 'error', error: tm('Склейка не удалась') })
        }
      } else {
        await universalQueue.run(items, (item, update) => runUniversal(item, options, { gpu: caps.gpu }, update), report)
      }
    } finally {
      universalJobs--
      maybeQuitIdle()
    }
  })

  ipcMain.handle('convert:cancel', () => {
    bgQueue.cancel()
    pipelineQueue?.cancel()
    universalQueue.cancel()
    cancelFfmpeg()
    cancelArchives()
    cancelDocuments()
  })

  ipcMain.handle('compare:pair', (_e, inputPath: string, outputPath: string, time?: number) =>
    comparePair(inputPath, outputPath, time)
  )

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
      const edited = { ...cutout, mask, note: `${cutout.note}, ${tm('правка кистью')}` }
      return writeCutout(item, edited, { ...options, format }, outputPath)
    }
  )

  ipcMain.handle('model:status', () => bgModelStatus())

  ipcMain.handle('model:download', async (e) => {
    await downloadBgModel((p: ModelDownloadProgress) => e.sender.send('model:progress', p))
  })

  ipcMain.handle('modules:list', () => moduleList())
  ipcMain.handle('modules:calibre', () => !!calibreBinary())
  ipcMain.handle('modules:install', async (e, id: string) => {
    await installModule(id, (p) => e.sender.send('modules:progress', p))
  })
  ipcMain.handle('modules:remove', async (_e, id: string) => removeModule(id))

  ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path))
}

// Один экземпляр: горячая клавиша и трей принадлежат запущенной копии, повторный запуск (например,
// из меню Проводника) просто передаёт ей файлы.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const args = parseArgs(argv)
    if (args.quick) collectQuick(args.paths)
    else if (args.paths.length > 0) openInMain(args.paths)
    else showMain()
  })
}

app.whenReady().then(async () => {
  void cleanupFrameDirs() // остатки кадров от прошлого запуска
  await loadSettings()
  // Модули (Pandoc): ставятся в папку данных; рядом с портативным exe и в корне проекта (разработка) тоже ищем
  configureModules([
    join(app.getPath('userData'), 'modules'),
    ...(process.env['PORTABLE_EXECUTABLE_DIR'] ? [join(process.env['PORTABLE_EXECUTABLE_DIR'], 'modules')] : []),
    join(app.getAppPath(), 'modules')
  ])
  registerIpc()
  initBackground({
    getMain: () => mainWindow,
    showMain,
    gpu: async () => (await detectGpu()).gpu,
    jobsRunning: () => universalJobs
  })
  await applySettings()

  // --quick: только быстрое окно, без главного (запуск из меню Проводника);
  // --hidden: запуск вместе с Windows сразу в трей.
  const launch = parseArgs(process.argv)
  if (launch.quick) collectQuick(launch.paths)
  else if (launch.hidden && hasTray()) {
    /* остаёмся в трее */
  } else {
    createWindow()
    if (launch.paths.length > 0) openInMain(launch.paths)
  }

  nativeTheme.on('updated', () => {
    mainWindow?.setTitleBarOverlay(overlayFor(nativeTheme.shouldUseDarkColors))
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  flushSettings()
  void cleanupFrameDirs()
})

// Закрытие окон не завершает приложение само: за это отвечают трей и maybeQuitIdle().
