import { useEffect, useState } from 'react'
import ColorPicker from '../components/ColorPicker'
import MaskEditor from '../components/MaskEditor'
import type {
  FileItem,
  JobProgress,
  BgMethod,
  BgOutputFormat,
  BgRemoveOptions,
  ModelDownloadProgress,
  ModelStatus
} from '@shared/types'
import { useFileJobs } from '../hooks/useFileJobs'
import FileList from '../components/FileList'
import DropOverlay from '../components/DropOverlay'
import { formatBytes } from '../lib'

const SWATCHES = ['#ffffff', '#000000', '#f4f1ea', '#22cc88', '#4f8cff', '#ff6b8a', '#ffc933']

const METHODS: { id: BgMethod; label: string; hint: string }[] = [
  {
    id: 'auto',
    label: 'Авто',
    hint: 'Однотонный фон вырежем по цвету, на фото с обычным фоном включится нейросеть'
  },
  {
    id: 'solid',
    label: 'Однотонный фон',
    hint: 'Спрайты, иконки, картинки на розовом или зелёном фоне. Нейросеть не нужна'
  },
  {
    id: 'ai',
    label: 'Нейросеть',
    hint: 'Фото людей, животных и товаров на любом фоне'
  }
]

const FORMATS: { id: BgOutputFormat; label: string; hint: string }[] = [
  { id: 'png', label: 'PNG', hint: 'Лучшее качество, прозрачность' },
  { id: 'webp', label: 'WebP', hint: 'Легче, тоже с прозрачностью' },
  { id: 'jpg', label: 'JPG', hint: 'Без прозрачности — нужен цветной фон' }
]

export default function BackgroundView({ active }: { active: boolean }): React.JSX.Element {
  const job = useFileJobs(active)
  const { files, progress, running, stats, allDone } = job

  const [model, setModel] = useState<ModelStatus | null>(null)
  const [download, setDownload] = useState<ModelDownloadProgress | null>(null)
  const [downloading, setDownloading] = useState(false)

  const [method, setMethod] = useState<BgMethod>('auto')
  const [tolerance, setTolerance] = useState(0) // 0 = подобрать автоматически
  const [everywhere, setEverywhere] = useState(true)
  const [translucent, setTranslucent] = useState(true)
  const [bgColor, setBgColor] = useState<string | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<{ file: FileItem; result: JobProgress } | null>(null)
  const [mode, setMode] = useState<'transparent' | 'color'>('transparent')
  const [color, setColor] = useState('#ffffff')
  const [format, setFormat] = useState<BgOutputFormat>('png')
  const [outputDir, setOutputDir] = useState<string | undefined>(undefined)

  const refreshModel = (): void => {
    void window.api.modelStatus().then(setModel)
  }
  useEffect(refreshModel, [])

  useEffect(
    () =>
      window.api.onModelDownload((p) => {
        setDownload(p)
        if (p.done || p.error) {
          setDownloading(false)
          if (p.done) refreshModel()
        }
      }),
    []
  )

  // JPG не поддерживает прозрачность — при прозрачном фоне переключаем на PNG.
  useEffect(() => {
    if (mode === 'transparent' && format === 'jpg') setFormat('png')
  }, [mode, format])

  useEffect(() => {
    job.resetResults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, tolerance, everywhere, translucent, bgColor, mode, color, format, outputDir])

  const startDownload = (): void => {
    setDownloading(true)
    setDownload({ received: 0, total: 0 })
    void window.api.downloadModel()
  }

  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.pickFolder()
    if (dir) setOutputDir(dir)
  }

  const buildOptions = (): BgRemoveOptions => ({
    method,
    tolerance,
    everywhere,
    translucent,
    bgColor,
    background: mode,
    color,
    format,
    outputDir
  })

  const start = (): Promise<void> =>
    job.run(async (todo) => {
      await window.api.removeBackground(todo, buildOptions())
    })

  const ready = model?.available ?? false
  // Нейросеть нужна только в режиме «Нейросеть»; в «Авто» она подключается, если фон не однотонный.
  const canStart = method === 'solid' || method === 'auto' || ready
  const showSolidOptions = method !== 'ai'
  const pct =
    download && download.total > 0 ? Math.min(100, Math.round((download.received / download.total) * 100)) : 0

  const modelCard = model && !ready && (
    <div className="banner">
      <div className="banner-icon">🧠</div>
      <div className="banner-text">
        <strong>Нужна нейросеть для удаления фона</strong>
        <span className="muted">
          Скачивается один раз ({model.sizeMB} МБ) и дальше работает полностью офлайн.
        </span>
        {downloading && (
          <div className="progress" aria-label="Загрузка">
            <div className="progress-bar" style={{ width: `${pct}%` }} />
          </div>
        )}
        {download?.error && <span className="error small">Не удалось скачать: {download.error}</span>}
      </div>
      <button className="btn primary" onClick={startDownload} disabled={downloading}>
        {downloading
          ? `${pct}% · ${formatBytes(download?.received ?? 0)}`
          : download?.error
            ? 'Повторить'
            : 'Скачать'}
      </button>
    </div>
  )

  return (
    <div className="converter">
      {active && job.dragging && <DropOverlay />}

      {picking && files[0] && (
        <ColorPicker
          path={files[0].path}
          onClose={() => setPicking(false)}
          onPick={(hex) => {
            setBgColor(hex)
            setPicking(false)
            // Цвет задан вручную — значит, фон однотонный.
            if (method === 'ai') setMethod('solid')
          }}
        />
      )}

      {editing && editing.result.outputPath && (
        <MaskEditor
          item={editing.file}
          options={buildOptions()}
          outputPath={editing.result.outputPath}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            job.patchProgress(editing.file.id, r)
            setEditing(null)
          }}
        />
      )}

      {files.length === 0 ? (
        <div className="empty-state">
          <div className="hero-emoji">✨</div>
          <h1>Уберём фон одним кликом</h1>
          <p>Перетащите фото людей, товаров или животных — нейросеть вырежет объект сама</p>
          <button className="btn primary big" onClick={job.pick}>
            Выбрать фото
          </button>
          <span className="hint">Работает на вашем компьютере, ничего не отправляется в интернет</span>
          {modelCard && <div className="banner-wrap">{modelCard}</div>}
        </div>
      ) : (
        <>
          <header className="list-head">
            <div>
              <h2>Ваши фото</h2>
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

          {modelCard && <div className="banner-wrap tight">{modelCard}</div>}

          <FileList
            files={files}
            progress={progress}
            running={running}
            onRemove={job.remove}
            previewResult
            onEdit={(file, result) => setEditing({ file, result })}
          />

          <section className="settings">
            <div className="setting">
              <label>Что за фон на картинке</label>
              <div className="chips">
                {METHODS.map((m) => (
                  <button
                    key={m.id}
                    className={`chip ${method === m.id ? 'active' : ''}`}
                    onClick={() => setMethod(m.id)}
                    title={m.hint}
                    disabled={running}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <span className="muted small">{METHODS.find((m) => m.id === method)!.hint}</span>
            </div>

            {showSolidOptions && (
              <div className="setting-row">
                <div className="setting grow">
                  <label>
                    Допуск по цвету
                    <b>{tolerance === 0 ? 'авто' : tolerance}</b>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={tolerance}
                    disabled={running}
                    onChange={(e) => setTolerance(Number(e.target.value))}
                  />
                </div>
                <div className="setting">
                  <label>Цвет фона</label>
                  <div className="row tight">
                    <button
                      className="btn soft eyedropper"
                      onClick={() => setPicking(true)}
                      disabled={running}
                      title="Выбрать цвет фона прямо на картинке"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden>
                        <path d="M14 6l4 4M5 19l1-4 8-8 3 3-8 8zM16 4l4 4" />
                      </svg>
                      {bgColor ? (
                        <>
                          <i className="dot" style={{ background: bgColor }} /> {bgColor}
                        </>
                      ) : (
                        'Пипетка (сейчас авто)'
                      )}
                    </button>
                    {bgColor && (
                      <button
                        className="icon-btn"
                        title="Вернуть автоопределение"
                        onClick={() => setBgColor(undefined)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden>
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {showSolidOptions && (
              <div className="setting-row checks">
                <label
                  className="check"
                  title="Убирает фон в щелях и отверстиях внутри предметов. Выключите, если на предмете есть свечение такого же цвета, как фон"
                >
                  <input
                    type="checkbox"
                    checked={everywhere}
                    disabled={running}
                    onChange={(e) => setEverywhere(e.target.checked)}
                  />
                  <span>Убирать фон и внутри предметов</span>
                </label>
                <label
                  className="check"
                  title="Паутина, дымка и свечение остаются полупрозрачными, без розовой пелены"
                >
                  <input
                    type="checkbox"
                    checked={translucent}
                    disabled={running}
                    onChange={(e) => setTranslucent(e.target.checked)}
                  />
                  <span>Сохранять полупрозрачность (паутина, дымка)</span>
                </label>
              </div>
            )}

            <div className="setting-row">
              <div className="setting">
                <label>Результат</label>
                <div className="chips">
                  <button
                    className={`chip ${mode === 'transparent' ? 'active' : ''}`}
                    onClick={() => setMode('transparent')}
                    disabled={running}
                  >
                    Прозрачный
                  </button>
                  <button
                    className={`chip ${mode === 'color' ? 'active' : ''}`}
                    onClick={() => setMode('color')}
                    disabled={running}
                  >
                    Цвет
                  </button>
                </div>
              </div>

              {mode === 'color' && (
                <div className="setting">
                  <label>Цвет</label>
                  <div className="swatches">
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        className={`swatch ${color === c ? 'active' : ''}`}
                        style={{ background: c }}
                        onClick={() => setColor(c)}
                        disabled={running}
                        aria-label={c}
                      />
                    ))}
                    <label className="swatch custom" title="Свой цвет">
                      <input
                        type="color"
                        value={color}
                        disabled={running}
                        onChange={(e) => setColor(e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              )}

              <div className="setting">
                <label>Формат</label>
                <div className="chips">
                  {FORMATS.map((f) => (
                    <button
                      key={f.id}
                      className={`chip ${format === f.id ? 'active' : ''}`}
                      onClick={() => setFormat(f.id)}
                      title={f.hint}
                      disabled={running || (f.id === 'jpg' && mode === 'transparent')}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
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

            <footer className="action-bar">
              <div className="muted">
                {allDone ? (
                  <>🎉 Готово! Обработано фото: <b>{stats.done}</b></>
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
                <button className="btn primary" onClick={start} disabled={allDone || !canStart}>
                  {allDone
                    ? 'Готово'
                    : !canStart
                      ? 'Сначала скачайте модель'
                      : `Убрать фон${files.length > 1 ? ` (${files.length})` : ''}`}
                </button>
              )}
            </footer>
          </section>
        </>
      )}
    </div>
  )
}
