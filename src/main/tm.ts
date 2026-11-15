import { translate } from '@shared/i18n'
import type { Language } from '@shared/i18n'

let lang: Language = 'ru'

export function setMainLanguage(l: Language): void {
  lang = l
}

/** Перевод сообщений основного процесса на текущий язык интерфейса. */
export function tm(text: string, params?: Record<string, string | number>): string {
  return translate(lang, text, params)
}
