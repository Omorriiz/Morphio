import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './ui.css'
import { installDevMock } from './devMock'
import { I18nProvider } from './i18n'
import ErrorBoundary from './components/ErrorBoundary'
import { initUiStore } from './uiStore'

// В обычном браузере (без Electron) подставляем заглушку API — только для разработки интерфейса.
if (import.meta.env.DEV && !window.api) installDevMock()

// Ошибки окна попадают в журнал (без отправки в сеть)
window.addEventListener('error', (e) => void window.api.logRendererError(e.message, e.error?.stack))
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string; stack?: string } | string
  void window.api.logRendererError(typeof r === 'string' ? r : (r?.message ?? 'unhandledrejection'), typeof r === 'string' ? undefined : r?.stack)
})

// Окно показываем после загрузки настроек, чтобы язык не «мигал».
window.api.getSettings().then(({ settings, language }) => {
  document.documentElement.lang = language
  initUiStore(settings.ui)
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider language={language} setting={settings.language}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </I18nProvider>
    </StrictMode>
  )
})
