import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'
import { getSettings, patchSettings } from './settings'
import { logError, logInfo } from './logger'
import { shouldAutoCheck, UpdateController } from './updateCore'
import type { UpdateEngine } from './updateCore'

/**
 * Автообновление через GitHub Releases (electron-updater, токен не нужен). Работает только у установленной версии:
 * портативная и режим разработки обновляются вручную. Ничего не скачивается и не ставится без согласия пользователя.
 */

let controller: UpdateController | null = null
let timer: NodeJS.Timeout | null = null

export function supportedHere(): boolean {
  return app.isPackaged && !process.env['PORTABLE_EXECUTABLE_DIR']
}

export function initUpdater(onState: (s: UpdateState) => void, beforeInstall: () => void): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = null
  const engine: UpdateEngine = {
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    downloadUpdate: () => autoUpdater.downloadUpdate(),
    quitAndInstall: () => {
      beforeInstall()
      autoUpdater.quitAndInstall(false, true)
    },
    on: ((event: string, cb: (...a: never[]) => void) => autoUpdater.on(event as 'error', cb as never)) as UpdateEngine['on']
  }
  controller = new UpdateController({
    engine,
    currentVersion: app.getVersion(),
    supported: supportedHere(),
    onState,
    onLastCheck: (when) => patchSettings({ lastUpdateCheck: when }),
    onError: (e) => logError('updates', e)
  })
}

export const updateState = (): UpdateState => controller?.state ?? { status: 'unsupported' }
export const checkUpdates = (): Promise<boolean> => controller?.check() ?? Promise.resolve(false)
export const downloadUpdate = (): Promise<void> => controller?.download() ?? Promise.resolve()
export const installUpdate = (): boolean => controller?.install() ?? false
export const dismissUpdate = (): void => controller?.dismiss()

/** Плановая проверка: через 15 секунд после запуска и затем раз в час проверяем, не прошли ли сутки. */
export function scheduleUpdateChecks(): void {
  if (timer) clearInterval(timer)
  const tick = (): void => {
    const s = getSettings()
    if (shouldAutoCheck(s.checkUpdates, s.lastUpdateCheck, Date.now())) {
      logInfo('updates', 'scheduled check')
      void checkUpdates()
    }
  }
  setTimeout(tick, 15_000)
  timer = setInterval(tick, 3600 * 1000)
  timer.unref()
}
