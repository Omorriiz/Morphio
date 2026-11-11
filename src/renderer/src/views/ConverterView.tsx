import { useEffect, useState } from 'react'
import { IMAGE_FORMATS } from '@shared/types'
import type { ConvertOptions, ImageFormat } from '@shared/types'
import { useFileJobs } from '../hooks/useFileJobs'
import FileList from '../components/FileList'
import DropOverlay from '../components/DropOverlay'
import { formatBytes } from '../lib'

const SIZE_OPTIONS: { label: string; value?: number }[] = [
  { label: 'Как в оригинале' },
  { label: '3840 px (4K)', value: 3840 },
  { label: '1920 px (Full HD)', value: 1920 },
  { label: '1280 px', value: 1280 },
  { label: '800 px', value: 800 }
]

export default function ConverterView({ active }: { active: boolean }): React.JSX.Element {
  const job = useFileJobs(active)
  const { files, progress, running, stats, allDone } = job

  const [format, setFormat] = useState<ImageFormat>('webp')
  const [quality, setQuality] = useState(85)
  const [maxSize, setMaxSize] = useState<number | undefined>(undefined)
  const [outputDir, setOutputDir] = useState<string | undefined>(undefined)
  const [stripMeta, setStripMeta] = useState(true)

  const formatInfo = IMAGE_FORMATS.find((f) => f.id === format)!

  // Если пользователь поменял настройки, прежние результаты больше не актуальны.
  useEffect(() => {
    job.resetResults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, quality, maxSize, outputDir, stripMeta])

  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.pickFolder()
    if (dir) setOutputDir(dir)
  }

  const start = (): Promise<void> =>
    job.run(async (todo) => {
      const options: ConvertOptions = {
        format,
        quality,
        maxSize,
        outputDir,
        keepMetadata: !stripMeta
      }
      await window.api.convert(todo, options)
    })

  return (
    <div className="converter">
      {active && job.dragging && <DropOverlay />}

      {files.length === 0 ? (
        <div className="empty-state">
          <div className="hero-emoji">🪄</div>
          <h1>Во что превратим ваши файлы?</h1>
          <p>Перетащите изображения или целые папки в это окно</p>
          <button className="btn primary big" onClick={job.pick}>
            Выбрать файлы
          </button>
          <span className="hint">PNG · JPG · WebP · AVIF · HEIC · TIFF · GIF · BMP · SVG</span>
        </div>
      ) : (
        <>
          <header className="list-head">
            <div>
              <h2>Ваши файлы</h2>
              <span className="muted">{files.length} шт.</span>
            </div>
            <div className="row">
              <button className="btn ghost" onClick={job.pick} disabled={running}>
                + Добавить
              </button>
              <button className="btn ghost" onClick={job.clear} disabled={running}>
                Очистить
              </button>
            </div>
          </header>

          <FileList files={files} progress={progress} running={running} onRemove={job.remove} />

          <section className="settings">
            <div className="setting">
              <label>Конвертировать в</label>
              <div className="chips">
                {IMAGE_FORMATS.map((f) => (
                  <button
                    key={f.id}
                    className={`chip ${format === f.id ? 'active' : ''}`}
                    onClick={() => setFormat(f.id)}
                    title={f.hint}
                    disabled={running}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <span className="muted small">{formatInfo.hint}</span>
            </div>

            <div className="setting-row">
              <div className="setting grow">
                <label>
                  Качество
                  <b>{formatInfo.hasQuality ? `${quality}%` : '—'}</b>
                </label>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={quality}
                  disabled={!formatInfo.hasQuality || running}
                  onChange={(e) => setQuality(Number(e.target.value))}
                />
              </div>

              <div className="setting">
                <label>Размер</label>
                <select
                  value={maxSize ?? ''}
                  disabled={running}
                  onChange={(e) => setMaxSize(e.target.value ? Number(e.target.value) : undefined)}
                >
                  {SIZE_OPTIONS.map((o) => (
                    <option key={o.label} value={o.value ?? ''}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="setting">
                <label>Сохранить</label>
                <div className="row tight">
                  <button className="btn soft" onClick={pickFolder} disabled={running}>
                    {outputDir ? 'Другая папка…' : 'Рядом с оригиналом'}
                  </button>
                  {outputDir && (
                    <button
                      className="icon-btn"
                      title="Сбросить"
                      onClick={() => setOutputDir(undefined)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden>
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="setting-row checks">
              <label
                className="check"
                title="Удаляет из файла GPS-координаты, модель камеры, дату съёмки и другие скрытые данные"
              >
                <input
                  type="checkbox"
                  checked={stripMeta}
                  disabled={running}
                  onChange={(e) => setStripMeta(e.target.checked)}
                />
                <span>Удалить скрытые данные (GPS, камера, дата съёмки)</span>
              </label>
            </div>

            <footer className="action-bar">
              <div className="muted">
                {allDone ? (
                  <>
                    🎉 Готово! Сэкономлено{' '}
                    <b>{formatBytes(Math.max(0, stats.before - stats.after))}</b>
                  </>
                ) : outputDir ? (
                  <>Результат: {outputDir}</>
                ) : (
                  <>Оригиналы не изменяются — рядом появятся новые файлы</>
                )}
              </div>
              {running ? (
                <button className="btn danger" onClick={() => window.api.cancel()}>
                  Остановить
                </button>
              ) : (
                <button className="btn primary" onClick={start} disabled={allDone}>
                  {allDone ? 'Готово' : `Конвертировать${files.length > 1 ? ` (${files.length})` : ''}`}
                </button>
              )}
            </footer>
          </section>
        </>
      )}
    </div>
  )
}
