import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, Tray } from 'electron'
import { defaultUniversalOptions } from '@shared/types'
import type { AppSettings, FileItem, JobProgress, SettingsState, WatchRule } from '@shared/types'
import trayIconPath from '../../build/icon.ico?asset'
import { setExplorerMenu } from './explorerMenu'
import { runUniversal } from './registry'
import { gatherQuickFiles, startSelectionServer, stopSelectionServer } from './selection'
import { getSettings, patchSettings } from './settings'
import { tm } from './tm'
import { WatchManager } from './watcher'
import type { JobResult } from './queue'

/**
 * Фоновый режим: значок в трее, горячая клавиша с быстрым окном, пункт меню Проводника, следящие папки,
 * запуск с Windows, единственный экземпляр приложения. Всё это выключено, пока пользователь не включит.
 */

export interface BackgroundDeps {
  getMain: () => BrowserWindow | null
  showMain: () => BrowserWindow
  gpu: () => Promise<import('@shared/types').GpuKind | null>
  jobsRunning: () => number
}

/** Отладочный вывод: включается переменной окружения MORPHIO_DEBUG=1. */
const debug = (...a: unknown[]): void => {
  if (process.env['MORPHIO_DEBUG']) console.log('[morphio]', ...a)
}

let deps: BackgroundDeps
let tray: Tray | null = null
let quickWin: BrowserWindow | null = null
let quickReady = false
let quickFocused = false
let quickPending: string[] | null = null
let hotkeyOk = true
let explorerError: string | undefined
let quitting = false
let pendingOpen: string[] = []
let watcher: WatchManager | null = null

export const isQuitting = (): boolean => quitting
export const hasTray = (): boolean => tray !== null

/** exe, который надо записывать в реестр и в автозапуск: для портативной версии это сам файл, а не распакованная копия. */
export function exePath(): string {
  return process.env['PORTABLE_EXECUTABLE_FILE'] ?? process.execPath
}

// ---------- аргументы запуска ----------

export interface LaunchArgs {
  quick: boolean
  hidden: boolean
  paths: string[]
}

/** `Morphio.exe --quick файл1 файл2`, `--hidden` (запуск сразу в трей). */
export function parseArgs(argv: string[]): LaunchArgs {
  // В режиме разработки в аргументах есть путь к самому приложению (electron .): это не файл пользователя.
  const appPath = resolve(app.getAppPath())
  const rest = argv.slice(1)
  return {
    quick: rest.includes('--quick'),
    hidden: rest.includes('--hidden'),
    paths: rest.filter((a) => !a.startsWith('--') && resolve(a) !== appPath && existsSync(a))
  }
}

let batch: string[] = []
let batchTimer: NodeJS.Timeout | null = null

/**
 * Проводник запускает отдельный процесс на каждый выделенный файл. Все они передают файлы первому
 * экземпляру; мы собираем их 300 мс и показываем быстрое окно один раз.
 */
export function collectQuick(paths: string[]): void {
  batch.push(...paths)
  if (batchTimer) clearTimeout(batchTimer)
  batchTimer = setTimeout(() => {
    const files = [...new Set(batch)]
    batch = []
    batchTimer = null
    showQuick(files)
  }, 300)
}

// ---------- окно быстрой конвертации ----------

function quickUrl(): { url?: string; file?: string } {
  const dev = process.env['ELECTRON_RENDERER_URL']
  return dev ? { url: `${dev}/quick.html` } : { file: join(__dirname, '../renderer/quick.html') }
}

function ensureQuick(): BrowserWindow {
  if (quickWin && !quickWin.isDestroyed()) return quickWin
  quickReady = false
  const win = new BrowserWindow({
    width: 500,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    title: 'Morphio',
    backgroundColor: '#14141b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  quickWin = win
  const { url, file } = quickUrl()
  if (url) void win.loadURL(url)
  else if (file) void win.loadFile(file)
  // Окно закрывается при потере фокуса: оно «всплывает» и уходит, как Spotlight.
  // Если Windows не отдала окну фокус (так бывает при запуске из фона), закрываться по blur рано: окно остаётся, пока им не займутся.
  win.on('focus', () => (quickFocused = true))
  win.on('blur', () => {
    if (!quickFocused || process.env['MORPHIO_KEEP_QUICK']) return // MORPHIO_KEEP_QUICK=1: для автотестов
    quickFocused = false
    hideQuick()
  })
  win.on('closed', () => {
    if (quickWin === win) quickWin = null
    quickReady = false
  })
  return win
}

function placeNearCursor(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(cursor).workArea
  const [w, h] = win.getSize()
  const x = Math.min(Math.max(cursor.x - Math.round(w / 2), area.x + 8), area.x + area.width - w - 8)
  const y = Math.min(Math.max(cursor.y - 60, area.y + 8), area.y + area.height - h - 8)
  win.setPosition(x, y)
}

export function showQuick(paths: string[]): void {
  debug('showQuick', paths.length)
  const win = ensureQuick()
  quickPending = paths
  quickFocused = false
  placeNearCursor(win)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.show()
  win.focus()
  if (quickReady) flushQuick()
}

function flushQuick(): void {
  if (!quickWin || quickWin.isDestroyed() || quickPending === null) return
  quickWin.webContents.send('quick:files', quickPending)
  quickPending = null
}

function hideQuick(): void {
  debug('hideQuick')
  if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible()) quickWin.hide()
  setTimeout(maybeQuitIdle, 1500)
}

/** Приложение запущено только ради быстрого окна (из меню Проводника): когда работа кончилась, закрываем его. */
export function maybeQuitIdle(): void {
  const s = getSettings()
  const main = deps.getMain()
  const mainOpen = main !== null && !main.isDestroyed()
  const quickVisible = quickWin !== null && !quickWin.isDestroyed() && quickWin.isVisible()
  debug('maybeQuitIdle', { mainOpen, quickVisible, tray: !!tray, quick: s.quickEnabled, watch: watcher?.active, jobs: deps.jobsRunning() })
  if (mainOpen || quickVisible || tray || s.quickEnabled || watcher?.active || deps.jobsRunning() > 0) return
  app.quit()
}

// ---------- открыть файлы в основном окне ----------

export function openInMain(paths: string[]): void {
  pendingOpen = paths
  const main = deps.showMain()
  if (main.webContents.isLoading()) return // окно заберёт файлы само, когда загрузится
  pendingOpen = []
  main.webContents.send('app:open-files', paths)
}

// ---------- трей ----------

function buildTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(trayIconPath)
  tray = new Tray(icon)
  tray.setToolTip('Morphio')
  tray.on('click', () => deps.showMain().focus())
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: tm('Открыть Morphio'), click: () => deps.showMain().focus() },
      { label: tm('Быстрая конвертация'), click: () => void gatherQuickFiles().then(showQuick) },
      { type: 'separator' },
      {
        label: tm('Выход'),
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function destroyTray(): void {
  tray?.destroy()
  tray = null
}

// ---------- горячая клавиша ----------

function registerHotkey(s: AppSettings): void {
  globalShortcut.unregisterAll()
  hotkeyOk = true
  if (!s.quickEnabled) return
  try {
    hotkeyOk = globalShortcut.register(s.hotkey, () => {
      void gatherQuickFiles().then(showQuick)
    })
  } catch {
    hotkeyOk = false // сочетание записано неверно
  }
}

// ---------- применение настроек ----------

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

async function runForRule(item: FileItem, rule: WatchRule, outputDir: string): Promise<JobResult> {
  const gpu = await deps.gpu()
  return runUniversal(item, defaultUniversalOptions(rule.target, outputDir, rule.quality), { gpu }, () => {})
}

let previous: AppSettings | null = null

/** Приводит систему в соответствие с настройками: трей, клавиша, автозапуск, меню, слежение. */
export async function applySettings(): Promise<void> {
  const s = getSettings()
  const before = previous
  previous = s

  // Тема окон: themeSource меняет и prefers-color-scheme в интерфейсе, отдельных стилей не нужно
  nativeTheme.themeSource = s.theme

  if (s.tray) buildTray()
  else destroyTray()
  refreshTrayMenu()

  if (!before || before.quickEnabled !== s.quickEnabled || before.hotkey !== s.hotkey) {
    registerHotkey(s)
    if (s.quickEnabled) {
      startSelectionServer() // PowerShell наготове: выделение читается за доли секунды
      ensureQuick() // окно создаётся заранее скрытым и появляется мгновенно
    } else {
      stopSelectionServer()
    }
  }

  if (!before || before.launchAtLogin !== s.launchAtLogin) {
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, path: exePath(), args: ['--hidden'] })
    }
  }

  if (!before || before.explorerMenu !== s.explorerMenu || (s.explorerMenu && before.language !== s.language)) {
    if (!app.isPackaged && s.explorerMenu) {
      explorerError = tm('Пункт меню добавляется только в собранном приложении (Morphio.exe)')
    } else {
      explorerError = await setExplorerMenu(s.explorerMenu, exePath())
    }
  }

  watcher ??= new WatchManager(
    runForRule,
    notify
  )
  await watcher.sync(s.watchRules)
}

export function backgroundState(): Pick<SettingsState, 'hotkeyOk' | 'explorerMenuError'> {
  return { hotkeyOk, explorerMenuError: explorerError }
}

export function watchStatus(): ReturnType<WatchManager['status']> {
  return watcher?.status() ?? []
}

// ---------- запуск ----------

export function initBackground(d: BackgroundDeps): void {
  deps = d

  ipcMain.handle('app:take-open-files', () => {
    const files = pendingOpen
    pendingOpen = []
    return files
  })

  // Быстрое окно
  ipcMain.handle('quick:ready', () => {
    quickReady = true
    flushQuick()
  })
  ipcMain.handle('quick:close', () => hideQuick())
  ipcMain.handle('quick:open-main', (_e, paths: string[]) => {
    hideQuick()
    openInMain(paths)
  })
  ipcMain.handle('quick:remember', (_e, target: string) => {
    const last = [target, ...getSettings().quickLast.filter((t) => t !== target)].slice(0, 20)
    patchSettings({ quickLast: last })
  })

  app.on('before-quit', () => {
    quitting = true
    globalShortcut.unregisterAll()
    stopSelectionServer()
    void watcher?.close()
  })
}
