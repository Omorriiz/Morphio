import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import QuickApp from './views/QuickApp'
import './styles.css'
import './ui.css'
import { installDevMock } from './devMock'
import { I18nProvider } from './i18n'

// В обычном браузере (без Electron) подставляем заглушку API — только для разработки интерфейса.
if (import.meta.env.DEV && !window.api) installDevMock()

window.api.getSettings().then(({ settings, language }) => {
  document.documentElement.lang = language
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider language={language} setting={settings.language}>
        <QuickApp />
      </I18nProvider>
    </StrictMode>
  )
})
