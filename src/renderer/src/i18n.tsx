import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { translate } from '@shared/i18n'
import type { Language, LanguageSetting } from '@shared/i18n'

type Params = Record<string, string | number>

// Текущий язык нужен и вне компонентов (форматирование размеров, подписи в константах).
let current: Language = 'ru'

/** Перевод вне React-компонентов. Внутри компонентов используйте `useI18n().t`. */
export function tr(text: string, params?: Params): string {
  return translate(current, text, params)
}

interface I18n {
  lang: Language
  setting: LanguageSetting
  t: (text: string, params?: Params) => string
  setLanguage: (setting: LanguageSetting) => void
}

const Ctx = createContext<I18n>({
  lang: 'ru',
  setting: 'system',
  t: (text, params) => translate('ru', text, params),
  setLanguage: () => {}
})

export function I18nProvider({
  language,
  setting: initialSetting,
  children
}: {
  language: Language
  setting: LanguageSetting
  children: React.ReactNode
}): React.JSX.Element {
  const [lang, setLang] = useState<Language>(language)
  const [setting, setSetting] = useState<LanguageSetting>(initialSetting)
  current = lang

  const setLanguage = useCallback((next: LanguageSetting) => {
    setSetting(next)
    void window.api.patchSettings({ language: next }).then((state) => {
      current = state.language
      setLang(state.language)
      document.documentElement.lang = state.language
    })
  }, [])

  const value = useMemo<I18n>(
    () => ({ lang, setting, setLanguage, t: (text, params) => translate(lang, text, params) }),
    [lang, setting, setLanguage]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18n {
  return useContext(Ctx)
}
