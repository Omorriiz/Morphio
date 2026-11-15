import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEY } from '../../src/shared/types'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/main/settingsCore'

describe('sanitizeSettings', () => {
  it('пустой или отсутствующий файл даёт значения по умолчанию', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('по умолчанию всё фоновое выключено', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      tray: false,
      closeToTray: false,
      launchAtLogin: false,
      quickEnabled: false,
      explorerMenu: false,
      watchRules: []
    })
    expect(DEFAULT_SETTINGS.hotkey).toBe(DEFAULT_HOTKEY)
    expect(DEFAULT_HOTKEY).toBe('CommandOrControl+Shift+X') // Ctrl+Shift+X
  })

  it('тема: по умолчанию «как в Windows», допустимы светлая и тёмная, остальное отбрасывается', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system')
    expect(sanitizeSettings({ theme: 'dark' }).theme).toBe('dark')
    expect(sanitizeSettings({ theme: 'light' }).theme).toBe('light')
    expect(sanitizeSettings({ theme: 'blue' as never }).theme).toBe('system')
  })

  it('сохраняет корректные значения', () => {
    const s = sanitizeSettings({ language: 'ru', tray: true, hotkey: 'Alt+Shift+K', quickLast: ['image:webp'] })
    expect(s).toMatchObject({ language: 'ru', tray: true, hotkey: 'Alt+Shift+K', quickLast: ['image:webp'] })
  })

  it('неверные типы заменяются значениями по умолчанию', () => {
    const s = sanitizeSettings({
      language: 'fr' as never,
      tray: 'yes' as never,
      hotkey: 42 as never,
      quickLast: 'x' as never
    })
    expect(s.language).toBe('system')
    expect(s.tray).toBe(false)
    expect(s.hotkey).toBe(DEFAULT_HOTKEY)
    expect(s.quickLast).toEqual([])
  })

  it('ограничивает список последних выборов двадцатью строками', () => {
    const many = Array.from({ length: 50 }, (_, i) => `image:${i}`)
    const s = sanitizeSettings({ quickLast: [...many, 5 as never] })
    expect(s.quickLast).toHaveLength(20)
    expect(s.quickLast.every((x) => typeof x === 'string')).toBe(true)
  })

  it('правила слежения: лишнее отбрасывается, недостающее достраивается', () => {
    const s = sanitizeSettings({
      watchRules: [
        { id: 'a', folder: 'C:/in', target: 'image:webp' } as never,
        { id: 'b', folder: 'C:/x', target: 'table:csv', enabled: false, quality: 60, outputDir: 'C:/out' },
        { folder: 'no-id', target: 'x' } as never,
        'мусор' as never,
        null as never
      ]
    })
    expect(s.watchRules).toHaveLength(2)
    expect(s.watchRules[0]).toEqual({ id: 'a', folder: 'C:/in', enabled: true, target: 'image:webp', quality: 85, outputDir: undefined })
    expect(s.watchRules[1]).toMatchObject({ id: 'b', enabled: false, quality: 60, outputDir: 'C:/out' })
  })

  it('не зависит от лишних полей и версии', () => {
    const s = sanitizeSettings({ version: 99, secret: 'x' } as never)
    expect(s.version).toBe(1)
    expect(s).not.toHaveProperty('secret')
  })
})
