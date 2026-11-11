import { useState } from 'react'
import Sidebar, { type ViewId } from './components/Sidebar'
import ConverterView from './views/ConverterView'
import BackgroundView from './views/BackgroundView'
import PipelineView from './views/PipelineView'
import GifView from './views/GifView'
import MediaView from './views/MediaView'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('convert')

  // Экраны с файлами остаются «живыми» при переключении, чтобы не терять список и результаты.
  return (
    <div className="app">
      <div className="titlebar" />
      <Sidebar active={view} onSelect={setView} />
      <main className="content">
        <div className="view" hidden={view !== 'convert'}>
          <ConverterView active={view === 'convert'} />
        </div>
        <div className="view" hidden={view !== 'media'}>
          <MediaView active={view === 'media'} />
        </div>
        <div className="view" hidden={view !== 'background'}>
          <BackgroundView active={view === 'background'} />
        </div>
        <div className="view" hidden={view !== 'pipeline'}>
          <PipelineView active={view === 'pipeline'} />
        </div>
        <div className="view" hidden={view !== 'gif'}>
          <GifView active={view === 'gif'} />
        </div>
      </main>
    </div>
  )
}
