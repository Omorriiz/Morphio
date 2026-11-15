import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompareResult, CompareVerdict } from '@shared/types'
import { useI18n } from '../i18n'
import { formatBytes, formatDuration } from '../lib'
import Modal from './Modal'

interface Props {
  title: string
  inputPath: string
  outputPath: string
  onClose: () => void
}

const VERDICT: Record<CompareVerdict, { text: string; tone: 'good' | 'warn' | 'bad' }> = {
  invisible: { text: 'Разницы на глаз не видно', tone: 'good' },
  small: { text: 'Небольшая потеря качества', tone: 'good' },
  noticeable: { text: 'Заметная потеря качества', tone: 'warn' },
  big: { text: 'Сильная потеря качества', tone: 'bad' }
}

const MAX_ZOOM = 8

/** Слайдер «до/после»: слева оригинал, справа результат; колесо мыши приближает, перетаскивание двигает картинку. */
export default function CompareModal({ title, inputPath, outputPath, onClose }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [data, setData] = useState<CompareResult | null>(null)
  const [error, setError] = useState('')
  const [pos, setPos] = useState(50) // положение разделителя, % ширины
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [time, setTime] = useState(0)
  const [loading, setLoading] = useState(true)
  const stage = useRef<HTMLDivElement>(null)
  const view = useRef<HTMLDivElement>(null)
  const drag = useRef<null | { kind: 'split' | 'pan'; x: number; y: number; pan: { x: number; y: number } }>(null)

  const load = useCallback(
    async (at: number) => {
      setLoading(true)
      try {
        setData(await window.api.compare(inputPath, outputPath, at))
        setError('')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [inputPath, outputPath]
  )

  useEffect(() => {
    void load(0)
  }, [load])

  const clampPan = useCallback((p: { x: number; y: number }, z: number): { x: number; y: number } => {
    const v = view.current
    if (!v) return p
    const maxX = (v.clientWidth * (z - 1)) / 2
    const maxY = (v.clientHeight * (z - 1)) / 2
    return { x: Math.min(maxX, Math.max(-maxX, p.x)), y: Math.min(maxY, Math.max(-maxY, p.y)) }
  }, [])

  const setZoomTo = (z: number): void => {
    const next = Math.min(MAX_ZOOM, Math.max(1, z))
    setZoom(next)
    setPan((p) => clampPan(p, next))
  }

  const splitFrom = (clientX: number): void => {
    const r = stage.current?.getBoundingClientRect()
    if (!r) return
    setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)))
  }

  const onPointerDown = (e: React.PointerEvent, kind: 'split' | 'pan'): void => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { kind, x: e.clientX, y: e.clientY, pan }
    if (kind === 'split') splitFrom(e.clientX)
    e.stopPropagation()
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'split') splitFrom(e.clientX)
    else setPan(clampPan({ x: d.pan.x + e.clientX - d.x, y: d.pan.y + e.clientY - d.y }, zoom))
  }

  const onPointerUp = (): void => {
    drag.current = null
  }

  const onWheel = (e: React.WheelEvent): void => {
    setZoomTo(zoom * (e.deltaY < 0 ? 1.25 : 0.8))
  }

  const pct = data && data.sizeBefore > 0 ? Math.round((1 - data.sizeAfter / data.sizeBefore) * 100) : 0
  const verdict = data ? VERDICT[data.verdict] : null

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          {data && verdict && (
            <span className={`cmp-verdict ${verdict.tone}`} title={`SSIM ${data.ssim} · PSNR ${data.psnr} ${t('дБ')}`}>
              {t(verdict.text)}
            </span>
          )}
          <div className="cmp-zoom">
            <button className="icon-btn" title={t('Отдалить')} onClick={() => setZoomTo(zoom / 1.5)} disabled={zoom <= 1}>
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M5 12h14" />
              </svg>
            </button>
            <button className="btn ghost cmp-zoom-val" onClick={() => setZoomTo(1)} title={t('Вписать в окно')}>
              {Math.round(zoom * 100)}%
            </button>
            <button className="icon-btn" title={t('Приблизить')} onClick={() => setZoomTo(zoom * 1.5)} disabled={zoom >= MAX_ZOOM}>
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          <button className="btn soft" onClick={onClose}>
            {t('Закрыть')}
          </button>
        </>
      }
    >
      <div className="cmp-top">
        <div className="cmp-side">
          <span className="cmp-tag">{t('Оригинал')}</span>
          <b>{data ? formatBytes(data.sizeBefore) : '…'}</b>
          {data && (
            <span className="muted small">
              {data.originalWidth}×{data.originalHeight}
            </span>
          )}
        </div>
        <div className="cmp-side right">
          <span className="cmp-tag accent">{t('Результат')}</span>
          <b>{data ? formatBytes(data.sizeAfter) : '…'}</b>
          {data && data.sizeBefore > 0 && (
            <span className={`small ${pct >= 0 ? 'good' : 'bad'}`}>
              {pct >= 0 ? '−' : '+'}
              {Math.abs(pct)}%
            </span>
          )}
        </div>
      </div>

      <div
        className={`cmp-view ${zoom > 1 ? 'zoomed' : ''}`}
        ref={view}
        onWheel={onWheel}
        onPointerDown={(e) => (zoom > 1 ? onPointerDown(e, 'pan') : onPointerDown(e, 'split'))}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {error && <div className="center error">{error}</div>}
        {!data && !error && (
          <div className="center">
            <span className="spinner" aria-label={t('Обработка')} />
          </div>
        )}
        {data && (
          <div
            className="cmp-stage"
            ref={stage}
            style={{
              aspectRatio: `${data.width} / ${data.height}`,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
            }}
          >
            <img className="cmp-img" src={data.before} alt={t('Оригинал')} draggable={false} />
            <img
              className="cmp-img"
              src={data.after}
              alt={t('Результат')}
              draggable={false}
              style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
            />
            <div className="cmp-line" style={{ left: `${pos}%` }}>
              <button
                className="cmp-handle"
                aria-label={t('Движок «до/после»')}
                style={{ transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
                onPointerDown={(e) => onPointerDown(e, 'split')}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft') setPos((p) => Math.max(0, p - 2))
                  if (e.key === 'ArrowRight') setPos((p) => Math.min(100, p + 2))
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
                </svg>
              </button>
            </div>
          </div>
        )}
        {loading && data && <span className="spinner cmp-busy" aria-label={t('Обработка')} />}
      </div>

      {data?.duration !== undefined && data.duration > 0 && (
        <label className="cmp-time">
          <span className="muted small">{t('Момент видео')}</span>
          <input
            type="range"
            min={0}
            max={Math.floor(data.duration * 10) / 10}
            step={0.1}
            value={time}
            onChange={(e) => setTime(Number(e.target.value))}
            onPointerUp={() => void load(time)}
            onKeyUp={() => void load(time)}
          />
          <span className="muted small">
            {formatDuration(time)} / {formatDuration(data.duration)}
          </span>
        </label>
      )}
    </Modal>
  )
}
