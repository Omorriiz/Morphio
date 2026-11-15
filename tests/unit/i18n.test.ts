import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { detectLanguage, resolveLanguage, translate } from '../../src/shared/i18n'
import { EN } from '../../src/shared/en'

describe('translate', () => {
  it('русский текст возвращается как есть', () => {
    expect(translate('ru', 'Нет кадров')).toBe('Нет кадров')
  })

  it('английский берётся из словаря', () => {
    expect(translate('en', 'Нет кадров')).toBe('No frames')
  })

  it('подставляет параметры в обоих языках', () => {
    expect(translate('en', 'Подбираю размер (попытка {i} из {n})…', { i: 2, n: 3 })).toBe('Fitting the size (attempt 2 of 3)…')
    expect(translate('ru', 'файлов: {n}', { n: 7 })).toBe('файлов: 7')
  })

  it('неизвестная строка не ломает интерфейс: показывается русский текст', () => {
    expect(translate('en', 'Совсем новая строка')).toBe('Совсем новая строка')
  })

  it('незаданный параметр остаётся в тексте', () => {
    expect(translate('en', 'Сервер ответил: {status}', {})).toBe('The server responded: {status}')
  })

  it('форма единственного и множественного числа по параметру n', () => {
    expect(translate('en', '{n} шт.', { n: 1 })).toBe('1 file')
    expect(translate('en', '{n} шт.', { n: 2 })).toBe('2 files')
    expect(translate('en', '{n} шт.', { n: 0 })).toBe('0 files')
  })
})

describe('язык системы', () => {
  it('русская локаль даёт русский, остальное английский', () => {
    expect(detectLanguage('ru-RU')).toBe('ru')
    expect(detectLanguage('RU')).toBe('ru')
    expect(detectLanguage('en-US')).toBe('en')
    expect(detectLanguage('de')).toBe('en')
    expect(detectLanguage(undefined)).toBe('en')
  })

  it('явный выбор сильнее языка системы', () => {
    expect(resolveLanguage('ru', 'en-US')).toBe('ru')
    expect(resolveLanguage('en', 'ru-RU')).toBe('en')
    expect(resolveLanguage('system', 'ru-RU')).toBe('ru')
  })
})

describe('словарь', () => {
  it('в английских текстах нет русских букв', () => {
    const bad = Object.entries(EN).filter(([, en]) => /[А-Яа-яЁё]/.test(en))
    expect(bad).toEqual([])
  })

  it('у каждой строки интерфейса есть перевод (npm run i18n)', () => {
    // Скрипт падает с кодом 1, если у строки из t()/tm()/tr() нет перевода или не совпадают {подстановки}.
    expect(() => execFileSync('node', ['scripts/check-i18n.mjs'], { stdio: 'pipe' })).not.toThrow()
  })
})
