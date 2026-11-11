import { useCallback, useEffect, useMemo, useState } from 'react'
import { orderFrames, VIDEO_EXTENSIONS } from '@shared/types'
import type {
  GifBuildOptions,
  GifFrame,
  GifProgress,
  GifResult,
  VideoExtractResult,
  VideoInfo
} from '@shared/types'
import DropOverlay from '../components/DropOverlay'
import VideoImport from '../components/VideoImport'
import FramePlayer from '../components/FramePlayer'
import FrameStrip from '../components/FrameStrip'
import { useDropZone } from '../hooks/useDropZone'
import { formatBytes } from '../lib'

const WIDTHS: { label: string; value?: number }[] = [
  { label: 'Как у первого кадра' },
  { label: '1080 px', value: 1080 },
  { label: '800 px', value: 800 },
  { label: '640 px', value: 640 },
  { label: '480 px', value: 480 },
  { label: '320 px', value: 320 },
  { label: '240 px', value: 240 },
  { label: '160 px', value: 160 }
]

const LOOPS: { label: string; value: number }[] = [
  { label: 'Бесконечно', value: 0 },
  { label: '1 раз', value: 1 },
  { label: '2 раза', value: 2 },
  { label: '3 раза', value: 3 },
  { label: '5 раз', value: 5 },
  { label: '10 раз', value: 10 }
]

const SWATCHES = ['#ffffff', '#000000', '#f4f1ea', '#22cc88', '#4f8cff']

export default function GifView({ active }: { active: boolean }): React.JSX.Element {
  const [frames, setFrames] = useState<GifFrame[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [videoPath, setVideoPath] = useState<string | null>(null)

  const [format, setFormat] = useState<'gif' | 'webp'>('gif')
  const [width, setWidth] = useState<number | undefined>(undefined)
  const [fit, setFit] = useState<'contain' | 'cover'>('contain')
  const [background, setBackground] = useState('transparent')
  const [defaultDelay, setDefaultDelay] = useState(100)
  const [loop, setLoop] = useState(0)
  const [order, setOrder] = useState<'normal' | 'reverse' | 'pingpong'>('normal')
  const [colours, setColours] = useState(256)
  const [dither, setDither] = useState(true)
  const [quality, setQuality] = useState(80)
  const [limitSize, setLimitSize] = useState(false)
  const [targetMB, setTargetMB] = useState(2)
  const [name, setName] = useState('animation')
  const [outputDir, setOutputDir] = useState<string | undefined>(undefined)

  const [building, setBuilding] = useState(false)
  const [progress, setProgress] = useState<GifProgress | null>(null)
  const [result, setResult] = useState<GifResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const addPaths = useCallback(async (allPaths: string[]) => {
    // Видео открываем в окне выбора отрезка, остальное — обычные картинки.
    const isVideo = (p: string): boolean =>
      VIDEO_EXTENSIONS.includes(p.split('.').pop()?.toLowerCase() ?? '')
    const video = allPaths.find(isVideo)
    if (video) setVideoPath(video)
    const paths = allPaths.filter((p) => !isVideo(p))
    if (paths.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const added = await window.api.inspectFrames(paths)
      if (added.length === 0) setError('В этих файлах не нашлось картинок')
      setFrames((prev) => [...prev, ...added])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const dragging = useDropZone(active && !building, addPaths)
  const pick = async (): Promise<void> => addPaths(await window.api.pickFiles())
  const pickVideo = async (): Promise<void> => {
    const p = await window.api.pickVideo()
    if (p) setVideoPath(p)
  }

  const onVideoImported = (r: VideoExtractResult, info: VideoInfo): void => {
    setFrames((prev) => [...prev, ...r.frames])
    // Скорость берём из частоты кадров, выбранной при импорте.
    setDefaultDelay(Math.min(1000, Math.max(20, r.delay)))
    setName(info.name.replace(/\.[^.]+$/, ''))
    setVideoPath(null)
  }

  useEffect(() => window.api.onGifProgress(setProgress), [])

  // Любое изменение кадров или настроек делает прежний результат неактуальным.
  useEffect(() => {
    setResult(null)
    setNotice(null)
  }, [frames, format, width, fit, background, defaultDelay, loop, order, colours, dither, quality, limitSize, targetMB])

  const played = useMemo(() => orderFrames(frames, order), [frames, order])
  const totalMs = useMemo(
    () => played.reduce((s, f) => s + (f.delay ?? defaultDelay), 0),
    [played, defaultDelay]
  )

  const move = (from: number, to: number): void =>
    setFrames((prev) => {
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  const remove = (id: string): void => setFrames((prev) => prev.filter((f) => f.id !== id))
  const duplicate = (id: string): void =>
    setFrames((prev) => {
      const i = prev.findIndex((f) => f.id === id)
      if (i < 0) return prev
      const copy = { ...prev[i], id: crypto.randomUUID() }
      const next = [...prev]
      next.splice(i + 1, 0, copy)
      return next
    })
  const setDelay = (id: string, delay: number | undefined): void =>
    setFrames((prev) => prev.map((f) => (f.id === id ? { ...f, delay } : f)))
  const resetDelays = (): void => setFrames((prev) => prev.map((f) => ({ ...f, delay: undefined })))

  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.pickFolder()
    if (dir) setOutputDir(dir)
  }

  const build = async (): Promise<void> => {
    setBuilding(true)
    setError(null)
    setNotice(null)
    setProgress({ text: 'Начинаю…', done: 0, total: 1 })
    try {
      const options: GifBuildOptions = {
        format,
        width,
        fit,
        background,
        defaultDelay,
        loop,
        order,
        colours,
        dither,
        quality,
        targetKB: limitSize ? Math.round(targetMB * 1024) : undefined,
        name: name.trim() || 'animation',
        outputDir
      }
      setResult(await window.api.buildGif(frames, options))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBuilding(false)
      setProgress(null)
    }
  }

  const exportPng = async (): Promise<void> => {
    const dir = outputDir ?? (await window.api.pickFolder())
    if (!dir) return
    setBuilding(true)
    setError(null)
    try {
      const r = await window.api.exportFrames(frames, dir)
      setNotice(`Сохранено кадров: ${r.count}. Папка: ${r.dir}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBuilding(false)
      setProgress(null)
    }
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  const fps = Math.round(1000 / defaultDelay)

  return (
    <div className="converter gif">
      {active && dragging && <DropOverlay />}

      {videoPath && (
        <VideoImport
          path={videoPath}
          onClose={() => setVideoPath(null)}
          onImport={onVideoImported}
        />
      )}

      <header className="list-head">
        <div>
          <h2>GIF-студия</h2>
          <span className="muted">
            {frames.length > 0
              ? `${frames.length} кадр. · ${(totalMs / 1000).toFixed(1)} с`
              : 'анимация из картинок'}
          </span>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={pick} disabled={building || loading}>
            + Картинки
          </button>
          <button className="btn ghost" onClick={pickVideo} disabled={building || loading}>
            + Видео
          </button>
          {frames.length > 0 && (
            <>
              <button className="btn ghost" onClick={exportPng} disabled={building}>
                Кадры в PNG
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  setFrames([])
                  setSelectedId(null)
                }}
                disabled={building}
              >
                Очистить
              </button>
            </>
          )}
        </div>
      </header>

      {frames.length === 0 ? (
        <div className="empty-state">
          <div className="hero-emoji">🎞️</div>
          <h1>Соберём анимацию</h1>
          <p>
            Перетащите картинки, папку с кадрами, готовый GIF или видео: из ролика можно вырезать любой
            момент
          </p>
          <div className="row">
            <button className="btn primary big" onClick={pick} disabled={loading}>
              {loading ? 'Загружаю…' : 'Выбрать картинки'}
            </button>
            <button className="btn soft big" onClick={pickVideo} disabled={loading}>
              Из видео
            </button>
          </div>
          <span className="hint">
            Картинки, папка с кадрами, GIF или видео (MP4, MOV, MKV, WebM). Кадры из папки идут по порядку имён
          </span>
          {error && <span className="error small">{error}</span>}
        </div>
      ) : (
        <div className="gif-scroll">
          <FrameStrip
            frames={frames}
            defaultDelay={defaultDelay}
            selectedId={selectedId}
            disabled={building}
            onSelect={setSelectedId}
            onMove={move}
            onRemove={remove}
            onDuplicate={duplicate}
            onDelay={setDelay}
          />
          <p className="muted small strip-hint">
            Перетаскивайте кадры, чтобы поменять порядок. Число под кадром — его задержка в миллисекундах.
          </p>

          <div className="gif-grid">
            <div className="gif-left">
              <FramePlayer
                frames={played}
                defaultDelay={defaultDelay}
                selectedId={selectedId}
                resultUrl={result?.previewUrl}
                background={background}
              />
              {result && (
                <div className="result-card">
                  <div>
                    <strong>{formatBytes(result.outputSize)}</strong>
                    <span className="muted">
                      {' '}
                      · {result.width}×{result.height} · {result.frames} кадр.
                    </span>
                  </div>
                  {result.note && <div className="muted small">{result.note}</div>}
                  {result.reachedTarget === false && (
                    <div className="error small">
                      Уложиться в {targetMB} МБ не удалось даже с минимальным качеством
                    </div>
                  )}
                  {!result.previewUrl && (
                    <div className="muted small">Файл большой, превью не показываю</div>
                  )}
                  <button
                    className="btn soft"
                    onClick={() => window.api.revealInFolder(result.outputPath)}
                  >
                    Показать в папке
                  </button>
                </div>
              )}
            </div>

            <section className="settings">
              <div className="steps">
                <div className="step">
                  <strong>Формат</strong>
                  <div className="chips">
                    <button
                      className={`chip small ${format === 'gif' ? 'active' : ''}`}
                      onClick={() => setFormat('gif')}
                      disabled={building}
                    >
                      GIF
                    </button>
                    <button
                      className={`chip small ${format === 'webp' ? 'active' : ''}`}
                      onClick={() => setFormat('webp')}
                      disabled={building}
                      title="Легче и красивее GIF, открывается в браузерах и мессенджерах"
                    >
                      WebP
                    </button>
                  </div>
                  <select
                    value={loop}
                    disabled={building}
                    onChange={(e) => setLoop(Number(e.target.value))}
                  >
                    {LOOPS.map((l) => (
                      <option key={l.value} value={l.value}>
                        Повтор: {l.label.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="step">
                  <strong>Скорость</strong>
                  <label className="mini-range">
                    <span>
                      Задержка <b>{defaultDelay} мс</b> · {fps} кадр/с
                    </span>
                    <input
                      type="range"
                      min={20}
                      max={1000}
                      step={10}
                      value={defaultDelay}
                      disabled={building}
                      onChange={(e) => setDefaultDelay(Number(e.target.value))}
                    />
                  </label>
                  <button className="btn soft" onClick={resetDelays} disabled={building}>
                    Сбросить задержки кадров
                  </button>
                </div>

                <div className="step">
                  <strong>Порядок</strong>
                  <div className="chips">
                    {(
                      [
                        ['normal', 'Обычный'],
                        ['reverse', 'Обратный'],
                        ['pingpong', 'Туда-обратно']
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        className={`chip small ${order === id ? 'active' : ''}`}
                        onClick={() => setOrder(id)}
                        disabled={building}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="step">
                  <strong>Размер</strong>
                  <select
                    value={width ?? ''}
                    disabled={building}
                    onChange={(e) => setWidth(e.target.value ? Number(e.target.value) : undefined)}
                  >
                    {WIDTHS.map((w) => (
                      <option key={w.label} value={w.value ?? ''}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                  <div className="chips">
                    <button
                      className={`chip small ${fit === 'contain' ? 'active' : ''}`}
                      onClick={() => setFit('contain')}
                      disabled={building}
                      title="Кадр целиком, по краям поля"
                    >
                      Вписать
                    </button>
                    <button
                      className={`chip small ${fit === 'cover' ? 'active' : ''}`}
                      onClick={() => setFit('cover')}
                      disabled={building}
                      title="Кадр заполняет всё, лишнее обрезается"
                    >
                      Заполнить
                    </button>
                  </div>
                  <div className="swatches">
                    <button
                      className={`chip small ${background === 'transparent' ? 'active' : ''}`}
                      onClick={() => setBackground('transparent')}
                      disabled={building}
                      title="Фон полей"
                    >
                      Прозр.
                    </button>
                    {SWATCHES.map((c) => (
                      <button
                        key={c}
                        className={`swatch ${background === c ? 'active' : ''}`}
                        style={{ background: c }}
                        onClick={() => setBackground(c)}
                        disabled={building}
                        aria-label={c}
                      />
                    ))}
                  </div>
                </div>

                <div className="step">
                  <strong>Качество</strong>
                  {format === 'gif' ? (
                    <>
                      <select
                        value={colours}
                        disabled={building}
                        onChange={(e) => setColours(Number(e.target.value))}
                      >
                        {[256, 128, 64, 32, 16].map((c) => (
                          <option key={c} value={c}>
                            Цветов: {c}
                          </option>
                        ))}
                      </select>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={dither}
                          disabled={building}
                          onChange={(e) => setDither(e.target.checked)}
                        />
                        <span>Сглаживать градиенты</span>
                      </label>
                    </>
                  ) : (
                    <label className="mini-range">
                      <span>
                        Качество <b>{quality}%</b>
                      </span>
                      <input
                        type="range"
                        min={10}
                        max={100}
                        value={quality}
                        disabled={building}
                        onChange={(e) => setQuality(Number(e.target.value))}
                      />
                    </label>
                  )}
                </div>

                <div className="step">
                  <strong>Размер файла</strong>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={limitSize}
                      disabled={building}
                      onChange={(e) => setLimitSize(e.target.checked)}
                    />
                    <span>Уложиться в лимит</span>
                  </label>
                  {limitSize && (
                    <label className="inline-number">
                      не больше
                      <input
                        type="number"
                        min={0.1}
                        max={100}
                        step={0.1}
                        value={targetMB}
                        disabled={building}
                        onChange={(e) => setTargetMB(Math.max(0.1, Number(e.target.value)))}
                      />
                      МБ
                    </label>
                  )}
                  <span className="muted small">
                    Подберём размер и цвета сами (например, для Discord или почты)
                  </span>
                </div>

                <div className="step">
                  <strong>Файл</strong>
                  <input
                    className="text-input"
                    value={name}
                    disabled={building}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="animation"
                  />
                  <div className="row tight">
                    <button className="btn soft" onClick={pickFolder} disabled={building}>
                      {outputDir ? 'Другая папка…' : 'Рядом с первым кадром'}
                    </button>
                    {outputDir && (
                      <button className="icon-btn" title="Сбросить" onClick={() => setOutputDir(undefined)}>
                        <svg viewBox="0 0 24 24" aria-hidden>
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}

      {frames.length > 0 && (
        <footer className="gif-actions">
          <div className="gif-status">
            {building && progress ? (
              <>
                <span className="muted small">{progress.text}</span>
                <div className="progress">
                  <div className="progress-bar" style={{ width: `${pct}%` }} />
                </div>
              </>
            ) : error ? (
              <span className="error small">{error}</span>
            ) : notice ? (
              <span className="muted small">{notice}</span>
            ) : result ? (
              <span className="muted small">🎉 Готово! Файл сохранён.</span>
            ) : (
              <span className="muted small">
                Оригиналы не изменяются. Результат: {format.toUpperCase()} · {(totalMs / 1000).toFixed(1)} с
              </span>
            )}
          </div>
          <button className="btn primary" onClick={build} disabled={building || loading}>
            {building ? 'Собираю…' : `Создать ${format === 'gif' ? 'GIF' : 'WebP'}`}
          </button>
        </footer>
      )}
    </div>
  )
}
