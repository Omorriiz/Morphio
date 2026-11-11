import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { installDevMock } from './devMock'

// В обычном браузере (без Electron) подставляем заглушку API — только для разработки интерфейса.
if (import.meta.env.DEV && !window.api) installDevMock()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
