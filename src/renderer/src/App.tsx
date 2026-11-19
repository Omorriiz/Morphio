import { useEffect, useState } from 'react'
import Sidebar, { type ViewId } from './components/Sidebar'
import ConvertView from './views/ConvertView'
import PhotoView from './views/PhotoView'
import GifView from './views/GifView'
import MontageView from './views/MontageView'
import SettingsView from './views/SettingsView'
import UpdateBanner from './components/UpdateBanner'
import { readUi, writeUi } from './uiStore'

export default function App(): React.JSX.Element {
  const [view, setViewRaw] = useState<ViewId>(() => {
    const v = readUi<string>('app.view', 'convert')
    return (['convert', 'photo', 'montage', 'gif', 'settings'] as string[]).includes(v) ? (v as ViewId) : 'convert'
  })
  const setView = (v: ViewId): void => {
    setViewRaw(v)
    writeUi('app.view', v)
  }
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
        <UpdateBanner />
        <div className="view" hidden={view !== 'convert'}>
          <ConvertView active={view === 'convert'} incoming={incoming} />
        </div>
        <div className="view" hidden={view !== 'photo'}>
          <PhotoView active={view === 'photo'} />
        </div>
        <div className="view" hidden={view !== 'montage'}>
          <MontageView active={view === 'montage'} />
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
