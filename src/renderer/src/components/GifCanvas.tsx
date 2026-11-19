import { useRef } from 'react'
import type { GifCrop, GifFrame, GifLayer } from '@shared/types'
import { layerState } from '@shared/layerAnim'
import { useI18n } from '../i18n'

type Handle = 'nw' | 'ne' | 'sw' | 'se'

interface Props {
  frame: GifFrame
  /** Номер кадра в списке (по нему определяется, виден ли слой) */
  frameIndex: number
  /** Всего кадров в списке (для анимации слоёв) */
  frameCount: number
  /** Холст: соотношение сторон (ширина / высота) после обрезки */
  aspect: number
  crop?: GifCrop
  fit: 'contain' | 'cover'
  layers: GifLayer[]
  selectedLayerId: string | null
  onSelectLayer: (id: string | null) => void
  onChangeLayer: (id: string, patch: Partial<GifLayer>) => void
  /** Слой отпущен после изменения размера (текст перерисовывается чётче) */
  onLayerCommit?: (id: string) => void
  cropMode: boolean
  /** Блокировка пропорций рамки: ширина / высота в пикселях; null — свободно */
  cropRatio: number | null
  onCrop: (crop: GifCrop) => void
}

type Drag =
  | { kind: 'move'; id: string; x: number; y: number; px: number; py: number }
  | { kind: 'resize'; id: string; w: number; dist: number }
  | { kind: 'rotate'; id: string }
  | { kind: 'crop-move'; crop: GifCrop; px: number; py: number }
  | { kind: 'crop-handle'; handle: Handle; crop: GifCrop }

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))

/**
 * Холст предпросмотра: кадр с рамкой обрезки и слоями поверх. Слои двигают мышью, углом меняют размер,
 * верхней точкой поворачивают. В режиме обрезки показан весь кадр и рамка, которую можно двигать.
 */
export default function GifCanvas(p: Props): React.JSX.Element {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const frameAspect = p.frame.width / p.frame.height
  const full: GifCrop = { x: 0, y: 0, w: 1, h: 1 }
  const crop = p.crop ?? full

  const rect = (): DOMRect => box.current!.getBoundingClientRect()
  const toNorm = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = rect()
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height }
  }

  const layerCenter = (id: string): { cx: number; cy: number } | null => {
    const el = box.current?.querySelector<HTMLElement>(`[data-layer="${id}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
  }

  const begin = (e: React.PointerEvent, d: Drag): void => {
    e.stopPropagation()
    e.preventDefault()
    box.current?.setPointerCapture(e.pointerId)
    drag.current = d
  }

  const onMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'move') {
      const n = toNorm(e.clientX, e.clientY)
      p.onChangeLayer(d.id, {
        x: clamp(d.x + (n.x - d.px), 0, 1),
        y: clamp(d.y + (n.y - d.py), 0, 1)
      })
    } else if (d.kind === 'resize') {
      const c = layerCenter(d.id)
      if (!c) return
      const dist = Math.hypot(e.clientX - c.cx, e.clientY - c.cy)
      p.onChangeLayer(d.id, { w: clamp((d.w * dist) / Math.max(d.dist, 1), 0.02, 3) })
    } else if (d.kind === 'rotate') {
      const c = layerCenter(d.id)
      if (!c) return
      let deg = (Math.atan2(e.clientY - c.cy, e.clientX - c.cx) * 180) / Math.PI + 90
      deg = ((deg + 540) % 360) - 180
      for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(deg - snap) < 4) deg = snap
      p.onChangeLayer(d.id, { rotation: Math.round(deg) })
    } else if (d.kind === 'crop-move') {
      const n = toNorm(e.clientX, e.clientY)
      p.onCrop({
        ...d.crop,
        x: clamp(d.crop.x + (n.x - d.px), 0, 1 - d.crop.w),
        y: clamp(d.crop.y + (n.y - d.py), 0, 1 - d.crop.h)
      })
    } else if (d.kind === 'crop-handle') {
      const n = toNorm(e.clientX, e.clientY)
      const c = d.crop
      // противоположный угол стоит на месте
      const ax = d.handle.includes('w') ? c.x + c.w : c.x
      const ay = d.handle.includes('n') ? c.y + c.h : c.y
      let x = clamp(n.x, 0, 1)
      let y = clamp(n.y, 0, 1)
      let w = Math.max(0.03, Math.abs(x - ax))
      let h = Math.max(0.03, Math.abs(y - ay))
      if (p.cropRatio) {
        // в пикселях ширина / высота = ratio; в долях кадра h = w · (W/H) / ratio
        h = (w * frameAspect) / p.cropRatio
        if (ay + (y < ay ? -h : h) < 0 || ay + (y < ay ? -h : h) > 1) {
          h = y < ay ? ay : 1 - ay
          w = (h * p.cropRatio) / frameAspect
        }
      }
      x = x < ax ? ax - w : ax
      y = y < ay ? ay - h : ay
      p.onCrop({ x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w, h })
    }
  }

  const end = (): void => {
    const d = drag.current
    drag.current = null
    if (d && (d.kind === 'resize' || d.kind === 'move')) p.onLayerCommit?.(d.id)
  }

  const imageStyle: React.CSSProperties = p.cropMode
    ? { inset: 0, width: '100%', height: '100%', objectFit: 'fill' }
    : p.crop
      ? {
          position: 'absolute',
          width: `${100 / crop.w}%`,
          height: `${100 / crop.h}%`,
          left: `${(-crop.x / crop.w) * 100}%`,
          top: `${(-crop.y / crop.h) * 100}%`,
          objectFit: 'fill'
        }
      : { inset: 0, width: '100%', height: '100%', objectFit: p.fit === 'cover' ? 'cover' : 'contain' }

  // Слои, видимые на этом кадре; анимация (прозрачность, выезд, бегущая строка) показана как в готовом файле
  const shown = p.layers
    .filter((l) => p.frameIndex >= (l.from ?? 0) && p.frameIndex <= (l.to ?? Infinity))
    .map((l) => {
      const from = l.from ?? 0
      const to = l.to ?? Math.max(from, p.frameCount - 1)
      const s = layerState(l.anim, p.frameIndex, from, to)
      return { l, s }
    })
    .filter(({ l, s }) => (s.visible && s.opacity > 0) || l.id === p.selectedLayerId)
  const aspect = p.cropMode ? frameAspect : p.aspect

  return (
    <div
      className="gif-canvas"
      ref={box}
      style={{ aspectRatio: String(aspect), width: aspect >= 1 ? '100%' : undefined, height: aspect < 1 ? '100%' : undefined }}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerDown={() => p.onSelectLayer(null)}
    >
      <div className="gif-canvas-clip">
        <img src={p.frame.preview} alt={p.frame.name} draggable={false} style={{ position: 'absolute', ...imageStyle }} />
      </div>

      {!p.cropMode &&
        shown.map(({ l, s }) => {
          const selected = l.id === p.selectedLayerId
          return (
            <div
              key={l.id}
              data-layer={l.id}
              className={`gif-layer ${selected ? 'selected' : ''}`}
              style={{
                left: s.run === null ? `${l.x * 100}%` : `${(1 + l.w / 2 - (1 + l.w) * s.run) * 100}%`,
                top: `${(l.y + s.dy) * 100}%`,
                width: `${l.w * 100}%`,
                transform: `translate(-50%, -50%) rotate(${l.rotation}deg)`,
                opacity: (l.opacity ?? 1) * (s.visible ? s.opacity : 0.25)
              }}
              onPointerDown={(e) => {
                p.onSelectLayer(l.id)
                const n = toNorm(e.clientX, e.clientY)
                begin(e, { kind: 'move', id: l.id, x: l.x, y: l.y, px: n.x, py: n.y })
              }}
            >
              <img src={l.png} alt="" draggable={false} />
              {selected && (
                <>
                  <span
                    className="gif-handle resize"
                    title={t('Размер')}
                    onPointerDown={(e) => {
                      const c = layerCenter(l.id)
                      begin(e, { kind: 'resize', id: l.id, w: l.w, dist: c ? Math.hypot(e.clientX - c.cx, e.clientY - c.cy) : 1 })
                    }}
                  />
                  <span className="gif-handle rotate" title={t('Поворот')} onPointerDown={(e) => begin(e, { kind: 'rotate', id: l.id })} />
                </>
              )}
            </div>
          )
        })}

      {p.cropMode && (
        <>
          <div className="crop-shade" style={{ left: 0, top: 0, right: 0, height: `${crop.y * 100}%` }} />
          <div className="crop-shade" style={{ left: 0, bottom: 0, right: 0, height: `${(1 - crop.y - crop.h) * 100}%` }} />
          <div className="crop-shade" style={{ left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.h * 100}%` }} />
          <div className="crop-shade" style={{ right: 0, top: `${crop.y * 100}%`, width: `${(1 - crop.x - crop.w) * 100}%`, height: `${crop.h * 100}%` }} />
          <div
            className="crop-frame"
            style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
            onPointerDown={(e) => {
              const n = toNorm(e.clientX, e.clientY)
              begin(e, { kind: 'crop-move', crop, px: n.x, py: n.y })
            }}
          >
            {(['nw', 'ne', 'sw', 'se'] as Handle[]).map((h) => (
              <span
                key={h}
                className={`crop-handle ${h}`}
                aria-label={t('Угол рамки')}
                onPointerDown={(e) => begin(e, { kind: 'crop-handle', handle: h, crop })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
