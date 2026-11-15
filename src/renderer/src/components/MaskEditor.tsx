import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BgRemoveOptions,
  BrushStroke,
  FileItem,
  MaskEditSession,
  SavedResult
} from '@shared/types'
import Modal from './Modal'
import { tr, useI18n } from '../i18n'

interface Props {
  item: FileItem
  options: BgRemoveOptions
  /** Файл результата, который будет перезаписан */
  outputPath: string
  onSaved: (result: SavedResult) => void
  onClose: () => void
}

/** Мазок в координатах превью (то, что видит пользователь). */
type PStroke = BrushStroke

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(tr('Не удалось загрузить изображение')))
    img.src = src
  })

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** Один штамп кисти с мягким краем: erase убирает альфу, restore добавляет. */
function stamp(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  mode: 'erase' | 'restore'
): void {
  const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over'
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
}

/** Штампует вдоль отрезка с шагом, чтобы линия была сплошной. */
function stampSegment(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
  mode: 'erase' | 'restore'
): void {
  const step = Math.max(1, r * 0.25)
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
  for (let k = 0; k <= n; k++) {
    const t = k / n
    stamp(ctx, ax + (bx - ax) * t, ay + (by - ay) * t, r, mode)
  }
}

function replay(ctx: CanvasRenderingContext2D, s: PStroke): void {
  const p = s.points
  if (p.length === 2) stamp(ctx, p[0], p[1], s.radius, s.mode)
  for (let i = 0; i + 3 < p.length; i += 2) {
    stampSegment(ctx, p[i], p[i + 1], p[i + 2], p[i + 3], s.radius, s.mode)
  }
}

export default function MaskEditor({
  item,
  options,
  outputPath,
  onSaved,
  onClose
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const [session, setSession] = useState<MaskEditSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tool, setTool] = useState<'erase' | 'restore'>('erase')
  const [radius, setRadius] = useState(24)
  const [ghost, setGhost] = useState(true)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [history, setHistory] = useState({ undo: 0, redo: 0 })

  const stageRef = useRef<HTMLDivElement>(null)
  const viewCanvas = useRef<HTMLCanvasElement>(null)
  const imgCanvas = useRef<HTMLCanvasElement | null>(null)
  const maskCanvas = useRef<HTMLCanvasElement | null>(null)
  const initialMask = useRef<HTMLCanvasElement | null>(null)
  const tmpCanvas = useRef<HTMLCanvasElement | null>(null)
  const strokes = useRef<PStroke[]>([])
  const redoStack = useRef<PStroke[]>([])
  const current = useRef<PStroke | null>(null)
  const panning = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)
  const spaceDown = useRef(false)
  const rafId = useRef(0)
  const ghostRef = useRef(ghost)
  ghostRef.current = ghost
  const viewRef = useRef(view)
  viewRef.current = view

  const syncHistory = (): void =>
    setHistory({ undo: strokes.current.length, redo: redoStack.current.length })

  // Перерисовка: полупрозрачный «призрак» стёртого + объект с текущей маской.
  const render = useCallback(() => {
    cancelAnimationFrame(rafId.current)
    rafId.current = requestAnimationFrame(() => {
      const v = viewCanvas.current
      const img = imgCanvas.current
      const mask = maskCanvas.current
      const tmp = tmpCanvas.current
      if (!v || !img || !mask || !tmp) return
      const t = tmp.getContext('2d')!
      t.clearRect(0, 0, tmp.width, tmp.height)
      t.globalCompositeOperation = 'source-over'
      t.drawImage(img, 0, 0)
      t.globalCompositeOperation = 'destination-in'
      t.drawImage(mask, 0, 0)
      t.globalCompositeOperation = 'source-over'

      const ctx = v.getContext('2d')!
      ctx.clearRect(0, 0, v.width, v.height)
      if (ghostRef.current) {
        ctx.globalAlpha = 0.3
        ctx.drawImage(img, 0, 0)
        ctx.globalAlpha = 1
      }
      ctx.drawImage(tmp, 0, 0)
    })
  }, [])

  // Загрузка: цвета объекта и текущая маска.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await window.api.openMaskEditor(item, options)
        const [img, maskImg] = await Promise.all([loadImage(s.imageUrl), loadImage(s.maskUrl)])
        if (cancelled) return
        const { previewWidth: w, previewHeight: h } = s

        const ic = makeCanvas(w, h)
        ic.getContext('2d')!.drawImage(img, 0, 0, w, h)

        // Маска приходит серой картинкой — переносим яркость в альфа-канал.
        const gray = makeCanvas(w, h)
        const gctx = gray.getContext('2d', { willReadFrequently: true })!
        gctx.drawImage(maskImg, 0, 0, w, h)
        const px = gctx.getImageData(0, 0, w, h)
        for (let i = 0; i < px.data.length; i += 4) {
          px.data[i + 3] = px.data[i]
          px.data[i] = 255
          px.data[i + 1] = 255
          px.data[i + 2] = 255
        }
        const mc = makeCanvas(w, h)
        mc.getContext('2d')!.putImageData(px, 0, 0)
        const init = makeCanvas(w, h)
        init.getContext('2d')!.drawImage(mc, 0, 0)

        imgCanvas.current = ic
        maskCanvas.current = mc
        initialMask.current = init
        tmpCanvas.current = makeCanvas(w, h)
        if (viewCanvas.current) {
          viewCanvas.current.width = w
          viewCanvas.current.height = h
        }
        setSession(s)

        const stage = stageRef.current
        if (stage) {
          const scale = Math.min(stage.clientWidth / w, stage.clientHeight / h) * 0.96
          setView({
            scale,
            x: (stage.clientWidth - w * scale) / 2,
            y: (stage.clientHeight - h * scale) / 2
          })
        }
        render()
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(render, [ghost, render])

  const rebuildMask = (): void => {
    const mc = maskCanvas.current
    const init = initialMask.current
    if (!mc || !init) return
    const ctx = mc.getContext('2d')!
    ctx.clearRect(0, 0, mc.width, mc.height)
    ctx.drawImage(init, 0, 0)
    strokes.current.forEach((s) => replay(ctx, s))
    render()
  }

  const undo = (): void => {
    const s = strokes.current.pop()
    if (!s) return
    redoStack.current.push(s)
    rebuildMask()
    syncHistory()
  }

  const redo = (): void => {
    const s = redoStack.current.pop()
    if (!s) return
    strokes.current.push(s)
    const mc = maskCanvas.current
    if (mc) replay(mc.getContext('2d')!, s)
    render()
    syncHistory()
  }

  const fit = (): void => {
    const stage = stageRef.current
    if (!stage || !session) return
    const { previewWidth: w, previewHeight: h } = session
    const scale = Math.min(stage.clientWidth / w, stage.clientHeight / h) * 0.96
    setView({
      scale,
      x: (stage.clientWidth - w * scale) / 2,
      y: (stage.clientHeight - h * scale) / 2
    })
  }

  // Горячие клавиши: E/R — инструмент, [ ] — размер, Ctrl+Z / Ctrl+Y — отмена, пробел — рука.
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (e.code === 'Space') {
        spaceDown.current = true
        if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault()
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
      } else if (!mod && e.key.toLowerCase() === 'e') setTool('erase')
      else if (!mod && e.key.toLowerCase() === 'r') setTool('restore')
      else if (e.key === '[') setRadius((r) => Math.max(3, Math.round(r * 0.8)))
      else if (e.key === ']') setRadius((r) => Math.min(150, Math.round(r * 1.25)))
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') spaceDown.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  const toImage = (e: React.PointerEvent | React.WheelEvent): { x: number; y: number } => {
    const rect = stageRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (e.clientX - rect.left - v.x) / v.scale, y: (e.clientY - rect.top - v.y) / v.scale }
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!session) return
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* захват указателя необязателен */
    }
    if (e.button === 1 || e.button === 2 || spaceDown.current) {
      panning.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
      return
    }
    if (e.button !== 0) return
    const { x, y } = toImage(e)
    current.current = { mode: tool, radius, points: [x, y] }
    const mc = maskCanvas.current
    if (mc) stamp(mc.getContext('2d')!, x, y, radius, tool)
    render()
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const rect = stageRef.current!.getBoundingClientRect()
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    if (panning.current) {
      const p = panning.current
      setView((v) => ({ ...v, x: p.vx + e.clientX - p.sx, y: p.vy + e.clientY - p.sy }))
      return
    }
    const s = current.current
    if (!s) return
    const { x, y } = toImage(e)
    const n = s.points.length
    const px = s.points[n - 2]
    const py = s.points[n - 1]
    if (Math.hypot(x - px, y - py) < 1) return
    s.points.push(x, y)
    const mc = maskCanvas.current
    if (mc) stampSegment(mc.getContext('2d')!, px, py, x, y, s.radius, s.mode)
    render()
  }

  const onPointerUp = (): void => {
    panning.current = null
    const s = current.current
    if (s) {
      strokes.current.push(s)
      redoStack.current = []
      current.current = null
      syncHistory()
    }
  }

  const onWheel = (e: React.WheelEvent): void => {
    const rect = stageRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setView((v) => {
      const ns = Math.min(24, Math.max(0.05, v.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      const k = ns / v.scale
      return { scale: ns, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k }
    })
  }

  const save = async (): Promise<void> => {
    if (!session) return
    setSaving(true)
    try {
      // Мазки переводим из координат превью в координаты исходного изображения.
      const ratio = session.width / session.previewWidth
      const full: BrushStroke[] = strokes.current.map((s) => ({
        mode: s.mode,
        radius: s.radius * ratio,
        points: s.points.map((v) => v * ratio)
      }))
      const result = await window.api.saveMaskEdit(item, options, full, outputPath)
      onSaved(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  const changed = history.undo > 0

  return (
    <Modal
      title={t('Правка маски — {name}', { name: item.name })}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted small">
            {t('E — стереть · R — вернуть · [ ] — размер кисти · колесо — масштаб · пробел или правая кнопка — двигать')}
          </span>
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            {t('Отмена')}
          </button>
          <button className="btn primary" onClick={save} disabled={!changed || saving}>
            {saving ? t('Сохраняю…') : t('Сохранить')}
          </button>
        </>
      }
    >
      <div className="editor-toolbar">
        <div className="chips">
          <button
            className={`chip ${tool === 'erase' ? 'active' : ''}`}
            onClick={() => setTool('erase')}
          >
            {t('Стереть')}
          </button>
          <button
            className={`chip ${tool === 'restore' ? 'active' : ''}`}
            onClick={() => setTool('restore')}
          >
            {t('Вернуть')}
          </button>
        </div>
        <label className="editor-size">
          {t('Кисть')}
          <input
            type="range"
            min={3}
            max={150}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
          />
          <b>{radius}</b>
        </label>
        <label className="check">
          <input type="checkbox" checked={ghost} onChange={(e) => setGhost(e.target.checked)} />
          <span>{t('Показывать стёртое')}</span>
        </label>
        <div className="row tight">
          <button className="btn soft" onClick={undo} disabled={history.undo === 0}>
            {t('↶ Отменить')}
          </button>
          <button className="btn soft" onClick={redo} disabled={history.redo === 0}>
            {t('↷ Повторить')}
          </button>
          <button className="btn soft" onClick={fit}>
            {t('По размеру')}
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="editor-stage checker"
        style={{ cursor: spaceDown.current ? 'grab' : 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={onWheel}
      >
        {!session && !error && <div className="muted center">{t('Ищу объект…')}</div>}
        {error && <div className="error center">{error}</div>}
        <canvas
          ref={viewCanvas}
          className="editor-canvas"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            visibility: session ? 'visible' : 'hidden'
          }}
        />
        {cursor && session && (
          <div
            className={`brush-cursor ${tool}`}
            style={{
              width: radius * 2 * view.scale,
              height: radius * 2 * view.scale,
              left: cursor.x - radius * view.scale,
              top: cursor.y - radius * view.scale
            }}
          />
        )}
      </div>
    </Modal>
  )
}
