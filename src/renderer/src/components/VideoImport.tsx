import { useEffect, useState } from 'react'
import type { GifProgress, VideoExtractResult, VideoInfo } from '@shared/types'
import Modal from './Modal'

interface Props {
  path: string
  onClose: () => void
  onImport: (result: VideoExtractResult, info: VideoInfo) => void
}

const MAX_FRAMES = 400
const WIDTHS = [720, 480, 320, 240]

const fmt = (s: number): string => `${s.toFixed(1)} с`

/** Выбор отрезка видео: начало, длина, частота кадров и ширина. */
export default function VideoImport({ path, onClose, onImport }: Props): React.JSX.Element {
  const [info, setInfo] = useState<VideoInfo | null>(null)
  const [poster, setPoster] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<GifProgress | null>(null)

  const [start, setStart] = useState(0)
  const [length, setLength] = useState(3)
  const [fps, setFps] = useState(12)
  const [width, setWidth] = useState<number | undefined>(480)

  useEffect(() => {
    let cancelled = false
    window.api
      .videoInfo(path)
      .then((i) => {
        if (cancelled) return
        setInfo(i)
        setLength(Math.min(3, Math.max(0.5, i.duration || 3)))
        setFps(Math.min(12, Math.max(5, Math.round(i.fps))))
        setWidth(i.width > 480 ? 480 : undefined)
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [path])

  useEffect(() => window.api.onGifProgress(setProgress), [])

  // Кадр-превью в выбранный момент (с небольшой задержкой, пока двигают ползунок).
  useEffect(() => {
    if (!info) return
    let cancelled = false
    const t = window.setTimeout(() => {
      window.api
        .videoPoster(path, start, 520)
        .then((url) => !cancelled && setPoster(url))
        .catch(() => undefined)
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [info, path, start])

  const duration = info?.duration ?? 0
  const maxLength = Math.max(0.5, duration - start)
  const safeLength = Math.min(length, maxLength)
  const frames = Math.round(safeLength * fps)
  const tooMany = frames > MAX_FRAMES
  const usedLength = tooMany ? MAX_FRAMES / fps : safeLength

  const extract = async (): Promise<void> => {
    if (!info) return
    setBusy(true)
    setError(null)
    setProgress({ text: 'Начинаю…', done: 0, total: 1 })
    try {
      const result = await window.api.extractVideoFrames({
        path,
        start,
        duration: usedLength,
        fps,
        width
      })
      onImport(result, info)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <Modal
      title="GIF из видео"
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <span className="muted small">
            {info ? `≈ ${Math.min(frames, MAX_FRAMES)} кадров из ${fmt(usedLength)}` : ''}
          </span>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="btn primary" onClick={extract} disabled={!info || busy}>
            {busy ? 'Извлекаю…' : 'Извлечь кадры'}
          </button>
        </>
      }
    >
      {error && !info ? (
        <div className="error">{error}</div>
      ) : !info ? (
        <div className="muted">Читаю видео…</div>
      ) : (
        <div className="video-import">
          <div className="video-poster">
            {poster ? <img src={poster} alt="Кадр видео" /> : <span className="muted">Загружаю кадр…</span>}
          </div>
          <div className="muted small video-meta">
            {info.name} · {fmt(info.duration)} · {info.width}×{info.height} · {Math.round(info.fps)} кадр/с
          </div>

          <label className="video-field">
            <span>
              Начало <b>{fmt(start)}</b>
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0, duration - 0.5)}
              step={0.1}
              value={Math.min(start, Math.max(0, duration - 0.5))}
              disabled={busy}
              onChange={(e) => setStart(Number(e.target.value))}
            />
          </label>

          <label className="video-field">
            <span>
              Длина отрезка <b>{fmt(safeLength)}</b>
            </span>
            <input
              type="range"
              min={0.5}
              max={maxLength}
              step={0.1}
              value={safeLength}
              disabled={busy}
              onChange={(e) => setLength(Number(e.target.value))}
            />
          </label>

          <label className="video-field">
            <span>
              Частота <b>{fps} кадр/с</b>
            </span>
            <input
              type="range"
              min={5}
              max={30}
              step={1}
              value={fps}
              disabled={busy}
              onChange={(e) => setFps(Number(e.target.value))}
            />
          </label>

          <div className="video-field">
            <span>Ширина кадров</span>
            <div className="chips">
              {WIDTHS.filter((w) => w < info.width).map((w) => (
                <button
                  key={w}
                  className={`chip small ${width === w ? 'active' : ''}`}
                  onClick={() => setWidth(w)}
                  disabled={busy}
                >
                  {w} px
                </button>
              ))}
              <button
                className={`chip small ${width === undefined ? 'active' : ''}`}
                onClick={() => setWidth(undefined)}
                disabled={busy}
              >
                Как в видео
              </button>
            </div>
          </div>

          {tooMany && (
            <div className="muted small warn">
              Слишком много кадров (больше {MAX_FRAMES}): отрезок обрежется до {fmt(usedLength)}. Уменьшите
              частоту или длину.
            </div>
          )}
          {busy && progress && (
            <div className="video-progress">
              <span className="muted small">{progress.text}</span>
              <div className="progress">
                <div className="progress-bar" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
          {error && <div className="error small">{error}</div>}
        </div>
      )}
    </Modal>
  )
}
