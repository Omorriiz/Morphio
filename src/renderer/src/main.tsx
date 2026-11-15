import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './ui.css'
import { installDevMock } from './devMock'
import { I18nProvider } from './i18n'

// В обычном браузере (без Electron) подставляем заглушку API — только для разработки интерфейса.
if (import.meta.env.DEV && !window.api) installDevMock()

// Окно показываем после загрузки настроек, чтобы язык не «мигал».
window.api.getSettings().then(({ settings, language }) => {
  document.documentElement.lang = language
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider language={language} setting={settings.language}>
        <App />
      </I18nProvider>
    </StrictMode>
  )
})
