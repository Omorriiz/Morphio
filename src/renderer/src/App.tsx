import { useEffect, useState } from 'react'
import Sidebar, { type ViewId } from './components/Sidebar'
import ConvertView from './views/ConvertView'
import PhotoView from './views/PhotoView'
import GifView from './views/GifView'
import SettingsView from './views/SettingsView'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('convert')
  // Файлы из трея, меню Проводника или быстрого окна открываются в конвертере.
  const [incoming, setIncoming] = useState<{ paths: string[]; n: number } | null>(null)

  useEffect(() => {
    const open = (paths: string[]): void => {
      if (paths.length === 0) return
      setView('convert')
      setIncoming((prev) => ({ paths, n: (prev?.n ?? 0) + 1 }))
    }
    void window.api.takeOpenFiles().then(open)
    return window.api.onOpenFiles(open)
  }, [])

  // Экраны с файлами остаются «живыми» при переключении, чтобы не терять список и результаты.
  return (
    <div className="app">
      <div className="titlebar" />
      <Sidebar active={view} onSelect={setView} />
      <main className="content">
        <div className="view" hidden={view !== 'convert'}>
          <ConvertView active={view === 'convert'} incoming={incoming} />
        </div>
        <div className="view" hidden={view !== 'photo'}>
          <PhotoView active={view === 'photo'} />
        </div>
        <div className="view" hidden={view !== 'gif'}>
          <GifView active={view === 'gif'} />
        </div>
        <div className="view" hidden={view !== 'settings'}>
          <SettingsView active={view === 'settings'} />
        </div>
      </main>
    </div>
  )
}
