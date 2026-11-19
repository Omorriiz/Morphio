import { mkdirSync, promises as fs, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { resolveLanguage } from '@shared/i18n'
import type { Language } from '@shared/i18n'
import type { AppSettings, SettingsState } from '@shared/types'
import { DEFAULT_SETTINGS, sanitizeSettings } from './settingsCore'
import { setMainLanguage } from './tm'

let current: AppSettings = { ...DEFAULT_SETTINGS }
let saveTimer: NodeJS.Timeout | null = null

const file = (): string => join(app.getPath('userData'), 'settings.json')

/** Читает настройки при запуске. Повреждённый файл не мешает: берутся значения по умолчанию. */
export async function loadSettings(): Promise<void> {
  try {
    current = sanitizeSettings(JSON.parse(await fs.readFile(file(), 'utf8')) as Partial<AppSettings>)
  } catch {
    current = { ...DEFAULT_SETTINGS }
  }
  setMainLanguage(language())
}

/** Запись не чаще раза в секунду: во временный файл, затем переименование (без «половинных» файлов). */
async function writeNow(): Promise<void> {
  const target = file()
  const tmp = `${target}.tmp`
  await fs.mkdir(join(target, '..'), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(current, null, 2), 'utf8')
  await fs.rename(tmp, target)
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void writeNow().catch(() => {})
  }, 1000)
}

export function language(): Language {
  return resolveLanguage(current.language, app.getLocale())
}

export function getSettings(): AppSettings {
  return current
}

export function settingsState(extra: Partial<SettingsState> = {}): SettingsState {
  setMainLanguage(language())
  return { settings: current, language: language(), hotkeyOk: true, ...extra }
}

/** Применяет изменения. Возвращает прежние настройки, чтобы вызывающий мог понять, что именно изменилось. */
export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  const before = current
  current = sanitizeSettings({ ...current, ...patch })
  scheduleSave()
  return before
}

/** Сброс: все настройки по умолчанию (файл перезаписывается). */
export function resetSettings(): void {
  current = { ...DEFAULT_SETTINGS, ui: {} }
  scheduleSave()
}

/** Сохраняет настройки сразу и синхронно (при выходе: приложение не ждёт асинхронную запись). */
export function flushSettings(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  try {
    const target = file()
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(`${target}.tmp`, JSON.stringify(current, null, 2), 'utf8')
    renameSync(`${target}.tmp`, target)
  } catch {
    /* настройки не критичны */
  }
}
