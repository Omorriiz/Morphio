import { EN } from './en'

export type Language = 'ru' | 'en'
export type LanguageSetting = Language | 'system'

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'ru', label: 'Русский' },
  { id: 'en', label: 'English' }
]

/** Подставляет {имя} из params в шаблон. */
function fill(text: string, params?: Record<string, string | number>): string {
  if (!params) return text
  // «{n} file|{n} files»: вариант для единственного и множественного числа по параметру n
  if (text.includes('|') && typeof params.n === 'number') {
    const [one, many] = text.split('|')
    text = params.n === 1 ? one : many
  }
  return text.replace(/\{(\w+)\}/g, (m, key: string) => (key in params ? String(params[key]) : m))
}

/**
 * Перевод строки. Ключ — русский текст (он же русский вариант), английский берётся из словаря.
 * Если перевода нет, показывается русский текст: приложение не ломается, а тест `i18n`
 * проверяет, что в словаре есть все строки.
 */
export function translate(lang: Language, text: string, params?: Record<string, string | number>): string {
  const base = lang === 'en' ? (EN[text] ?? text) : text
  return fill(base, params)
}

/** Язык системы → поддерживаемый язык интерфейса. */
export function detectLanguage(locale: string | undefined): Language {
  return (locale ?? '').toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

export function resolveLanguage(setting: LanguageSetting, locale: string | undefined): Language {
  return setting === 'system' ? detectLanguage(locale) : setting
}
