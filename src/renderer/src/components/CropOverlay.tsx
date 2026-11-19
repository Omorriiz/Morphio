import { useRef } from 'react'
import { useI18n } from '../i18n'

export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

type Handle = 'nw' | 'ne' | 'sw' | 'se'
type Drag = { kind: 'move'; crop: CropRect; px: number; py: number } | { kind: 'handle'; handle: Handle; crop: CropRect }

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))

/**
 * Рамка кадрирования поверх картинки: двигается мышью, углы меняют размер.
 * `ratio` — нужное отношение ширины к высоте в пикселях (null — свободно), `frameAspect` — ширина / высота кадра.
 * Родитель должен быть position: relative и ровно по размеру картинки.
 */
export default function CropOverlay({
  crop,
  ratio,
  frameAspect,
  onCrop
}: {
  crop: CropRect
  ratio: number | null
  frameAspect: number
  onCrop: (c: CropRect) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)

  const toNorm = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = box.current!.getBoundingClientRect()
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height }
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
    const n = toNorm(e.clientX, e.clientY)
    if (d.kind === 'move') {
      onCrop({
        ...d.crop,
        x: clamp(d.crop.x + (n.x - d.px), 0, 1 - d.crop.w),
        y: clamp(d.crop.y + (n.y - d.py), 0, 1 - d.crop.h)
      })
      return
    }
    const c = d.crop
    // противоположный угол стоит на месте
    const ax = d.handle.includes('w') ? c.x + c.w : c.x
    const ay = d.handle.includes('n') ? c.y + c.h : c.y
    let x = clamp(n.x, 0, 1)
    let y = clamp(n.y, 0, 1)
    let w = Math.max(0.05, Math.abs(x - ax))
    let h = Math.max(0.05, Math.abs(y - ay))
    if (ratio) {
      h = (w * frameAspect) / ratio
      const edge = ay + (y < ay ? -h : h)
      if (edge < 0 || edge > 1) {
        h = y < ay ? ay : 1 - ay
        w = (h * ratio) / frameAspect
      }
    }
    x = x < ax ? ax - w : ax
    y = y < ay ? ay - h : ay
    onCrop({ x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w, h })
  }

  return (
    <div
      className="crop-overlay"
      ref={box}
      onPointerMove={onMove}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <div className="crop-shade" style={{ left: 0, top: 0, right: 0, height: `${crop.y * 100}%` }} />
      <div className="crop-shade" style={{ left: 0, bottom: 0, right: 0, height: `${(1 - crop.y - crop.h) * 100}%` }} />
      <div className="crop-shade" style={{ left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.h * 100}%` }} />
      <div className="crop-shade" style={{ right: 0, top: `${crop.y * 100}%`, width: `${(1 - crop.x - crop.w) * 100}%`, height: `${crop.h * 100}%` }} />
      <div
        className="crop-frame"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
        onPointerDown={(e) => {
          const n = toNorm(e.clientX, e.clientY)
          begin(e, { kind: 'move', crop, px: n.x, py: n.y })
        }}
      >
        {(['nw', 'ne', 'sw', 'se'] as Handle[]).map((h) => (
          <span key={h} className={`crop-handle ${h}`} aria-label={t('Угол рамки')} onPointerDown={(e) => begin(e, { kind: 'handle', handle: h, crop })} />
        ))}
      </div>
    </div>
  )
}
