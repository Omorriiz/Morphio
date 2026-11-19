import { describe, expect, it } from 'vitest'
import { buildIssueUrl, errorText, formatLine, LOG_MAX_BYTES, logFileName, logsToDelete, parseLogDate, redact, reportBody } from '../../src/main/loggerCore'
import { cleanUi, DEFAULT_SETTINGS, sanitizeSettings } from '../../src/main/settingsCore'
import { initUiStore, readUi } from '../../src/renderer/src/uiStore'
import { UI_STORE_LIMIT } from '../../src/shared/types'

describe('журнал: приватность', () => {
  it('профиль и имя пользователя скрываются во всех видах записи пути', () => {
    const home = 'C:\\Users\\Иван'
    expect(redact('ошибка в C:\\Users\\Иван\\Видео\\a.mp4', home, 'Иван')).toBe('ошибка в %USERPROFILE%\\Видео\\a.mp4')
    expect(redact('C:/Users/Иван/x', home, 'Иван')).toBe('%USERPROFILE%/x')
    expect(redact('C:\\\\Users\\\\Иван\\\\x', home, 'Иван')).toBe('%USERPROFILE%\\\\x')
    expect(redact('чужой D:\\Users\\Мария\\f', home, 'Иван')).toBe('чужой D:\\Users\\<user>\\f')
    expect(redact('владелец Иван вошёл', home, 'Иван')).toBe('владелец <user> вошёл')
    expect(redact('короткое имя Jo', home, 'Jo')).toBe('короткое имя Jo') // слишком короткое имя не режем: испортит текст
  })
})

describe('журнал: файлы и строки', () => {
  it('имя файла и разбор даты', () => {
    expect(logFileName(new Date(2026, 10, 9))).toBe('morphio-2026-11-09.log')
    expect(parseLogDate('morphio-2026-11-09.log')).toEqual(new Date(2026, 10, 9))
    expect(parseLogDate('другое.txt')).toBeUndefined()
  })

  it('удаляются файлы старше недели и самые старые сверх предела размера', () => {
    const now = new Date(2026, 10, 19, 12)
    const f = (d: number, size = 1000): { name: string; size: number } => ({ name: logFileName(new Date(2026, 10, d)), size })
    expect(logsToDelete([f(10), f(11), f(12), f(18), f(19)], now).sort()).toEqual([10, 11, 12].map((d) => logFileName(new Date(2026, 10, d))).sort())
    const big = [f(15, LOG_MAX_BYTES * 0.6), f(16, LOG_MAX_BYTES * 0.6), f(19, 100)]
    expect(logsToDelete(big, now)).toEqual([logFileName(new Date(2026, 10, 15))])
    expect(logsToDelete([{ name: 'readme.txt', size: 1e9 }], now)).toEqual([])
  })

  it('строка: время, уровень, источник; многострочный текст с отступом', () => {
    const line = formatLine('ERROR', 'convert', 'первая\nвторая\nтретья', new Date('2026-11-19T10:00:00Z'))
    expect(line).toBe('2026-11-19T10:00:00.000Z ERROR [convert] первая\n    вторая\n    третья\n')
    expect(errorText(new Error('x')).startsWith('Error: x')).toBe(true)
    expect(errorText('строка')).toBe('строка')
    expect(errorText({ a: 1 })).toBe('{"a":1}')
  })
})

describe('сообщить о проблеме', () => {
  const info = { version: '1.0.0', windows: '10.0.26200', electron: '45', gpu: 'NVIDIA', logTail: 'ERROR строка' }

  it('короткий отчёт целиком в адресе', () => {
    const r = buildIssueUrl('Omorriiz/Morphio', { ...info, note: 'не конвертирует' })
    expect(r.copied).toBe(false)
    expect(r.url.startsWith('https://github.com/Omorriiz/Morphio/issues/new?')).toBe(true)
    expect(decodeURIComponent(r.url)).toContain('не конвертирует')
    expect(decodeURIComponent(r.url)).toContain('ERROR строка')
  })

  it('длинный отчёт: в адресе только окружение, полный текст для буфера обмена', () => {
    const r = buildIssueUrl('Omorriiz/Morphio', { ...info, logTail: 'x'.repeat(9000) })
    expect(r.copied).toBe(true)
    expect(r.url.length).toBeLessThan(6000)
    expect(decodeURIComponent(r.url)).toContain('clipboard')
    expect(decodeURIComponent(r.url)).not.toContain('xxxxx')
    expect(r.full).toContain('x'.repeat(9000))
  })

  it('в тексте есть версия, система и видеокарта', () => {
    const b = reportBody(info)
    expect(b).toContain('Morphio: 1.0.0')
    expect(b).toContain('GPU: NVIDIA')
  })
})

describe('настройки: окно и значения экранов', () => {
  it('по умолчанию пусто и без окна', () => {
    expect(DEFAULT_SETTINGS.ui).toEqual({})
    expect(sanitizeSettings({}).window).toBeUndefined()
  })

  it('положение окна проверяется', () => {
    const ok = sanitizeSettings({ window: { width: 1200, height: 800, x: 10.4, y: 20, maximized: true } })
    expect(ok.window).toEqual({ width: 1200, height: 800, x: 10, y: 20, maximized: true })
    expect(sanitizeSettings({ window: { width: 50, height: 800, maximized: false } }).window).toBeUndefined()
    expect(sanitizeSettings({ window: 'мусор' as never }).window).toBeUndefined()
  })

  it('значения экранов: объект с короткими ключами, не больше лимита', () => {
    expect(cleanUi({ 'convert.quality': 70, '': 1, ['k'.repeat(81)]: 2 })).toEqual({ 'convert.quality': 70 })
    expect(cleanUi([1, 2])).toEqual({})
    expect(cleanUi('x')).toEqual({})
    expect(cleanUi({ big: 'x'.repeat(UI_STORE_LIMIT + 1) })).toEqual({})
    const kept = sanitizeSettings({ ui: { 'gif.format': 'webp' } })
    expect(kept.ui).toEqual({ 'gif.format': 'webp' })
  })

  it('чтение значения экрана: тип должен совпасть со значением по умолчанию', () => {
    initUiStore({ 'a.num': 5, 'a.str': 'x', 'a.list': [1], 'a.bad': 'строка вместо числа' })
    expect(readUi('a.num', 1)).toBe(5)
    expect(readUi('a.missing', 7)).toBe(7)
    expect(readUi('a.bad', 3)).toBe(3)
    expect(readUi('a.list', [] as number[])).toEqual([1])
    expect(readUi('a.num', [] as number[])).toEqual([])
    expect(readUi<number | undefined>('a.num', undefined)).toBe(5)
  })
})
