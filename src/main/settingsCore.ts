import { DEFAULT_HOTKEY } from '@shared/types'
import { UI_STORE_LIMIT } from '@shared/types'
import type { AppSettings, WatchRule, WindowState } from '@shared/types'

/** Чистая часть настроек (без Electron): значения по умолчанию и проверка файла. Её удобно тестировать. */

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  language: 'system',
  theme: 'system',
  tray: false,
  closeToTray: false,
  launchAtLogin: false,
  quickEnabled: false,
  hotkey: DEFAULT_HOTKEY,
  explorerMenu: false,
  quickLast: [],
  watchRules: [],
  ui: {},
  checkUpdates: false,
  lastUpdateCheck: 0
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

function cleanRules(v: unknown): WatchRule[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .filter((r) => typeof r.id === 'string' && typeof r.folder === 'string' && typeof r.target === 'string')
    .map((r) => ({
      id: r.id as string,
      folder: r.folder as string,
      enabled: bool(r.enabled, true),
      target: r.target as string,
      quality: typeof r.quality === 'number' ? r.quality : 85,
      outputDir: typeof r.outputDir === 'string' ? r.outputDir : undefined
    }))
}

function cleanWindow(v: unknown): WindowState | undefined {
  if (!v || typeof v !== 'object') return undefined
  const w = v as Record<string, unknown>
  const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : undefined)
  const width = num(w.width)
  const height = num(w.height)
  if (!width || !height || width < 300 || height < 300 || width > 10000 || height > 10000) return undefined
  return { width, height, x: num(w.x), y: num(w.y), maximized: w.maximized === true }
}

/** Значения экранов: обычный объект с короткими ключами, не больше лимита по размеру. */
export function cleanUi(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.length === 0 || k.length > 80 || val === undefined || typeof val === 'function') continue
    out[k] = val
  }
  try {
    return JSON.stringify(out).length <= UI_STORE_LIMIT ? out : {}
  } catch {
    return {}
  }
}

/** Проверяет настройки: неизвестные и испорченные поля заменяются значениями по умолчанию. */
export function sanitizeSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const r = raw ?? {}
  return {
    version: 1,
    language: r.language === 'ru' || r.language === 'en' ? r.language : 'system',
    theme: r.theme === 'light' || r.theme === 'dark' ? r.theme : 'system',
    tray: bool(r.tray, DEFAULT_SETTINGS.tray),
    closeToTray: bool(r.closeToTray, DEFAULT_SETTINGS.closeToTray),
    launchAtLogin: bool(r.launchAtLogin, DEFAULT_SETTINGS.launchAtLogin),
    quickEnabled: bool(r.quickEnabled, DEFAULT_SETTINGS.quickEnabled),
    hotkey: typeof r.hotkey === 'string' && r.hotkey ? r.hotkey : DEFAULT_HOTKEY,
    explorerMenu: bool(r.explorerMenu, DEFAULT_SETTINGS.explorerMenu),
    quickLast: Array.isArray(r.quickLast) ? r.quickLast.filter((x) => typeof x === 'string').slice(0, 20) : [],
    watchRules: cleanRules(r.watchRules),
    window: cleanWindow(r.window),
    ui: cleanUi(r.ui),
    checkUpdates: bool(r.checkUpdates, DEFAULT_SETTINGS.checkUpdates),
    lastUpdateCheck: typeof r.lastUpdateCheck === 'number' && Number.isFinite(r.lastUpdateCheck) ? r.lastUpdateCheck : 0
  }
}
