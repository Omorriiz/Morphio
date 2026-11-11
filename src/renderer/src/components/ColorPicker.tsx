import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'

interface Props {
  /** Файл, на котором выбирается цвет фона */
  path: string
  onPick: (hex: string) => void
  onClose: () => void
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

/** Пипетка: показывает картинку, по клику берёт цвет пикселя как цвет фона. */
export default function ColorPicker({ path, onPick, onClose }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .previewImage(path, 1400)
      .then((p) => {
        if (cancelled) return
        const img = new Image()
        img.onload = () => {
          const c = canvasRef.current
          if (!c) return
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          c.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0)
          setLoading(false)
        }
        img.src = p.dataUrl
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)))
    return () => {
      cancelled = true
    }
  }, [path])

  const colorAt = (e: React.MouseEvent<HTMLCanvasElement>): string | null => {
    const c = canvasRef.current
    if (!c) return null
    const r = c.getBoundingClientRect()
    const x = Math.floor(((e.clientX - r.left) / r.width) * c.width)
    const y = Math.floor(((e.clientY - r.top) / r.height) * c.height)
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null
    const [R, G, B] = c.getContext('2d')!.getImageData(x, y, 1, 1).data
    return `#${hex2(R)}${hex2(G)}${hex2(B)}`
  }

  return (
    <Modal
      title="Пипетка: кликните по цвету фона"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="picker-hover">
            {hover ? (
              <>
                <i style={{ background: hover }} /> {hover}
              </>
            ) : (
              <span className="muted">Наведите курсор на фон</span>
            )}
          </span>
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
        </>
      }
    >
      <div className="picker-stage">
        {loading && !error && <div className="muted center">Загружаю…</div>}
        {error && <div className="error center">Не удалось открыть изображение: {error}</div>}
        <canvas
          ref={canvasRef}
          className="picker-canvas"
          style={{ visibility: loading ? 'hidden' : 'visible' }}
          onMouseMove={(e) => setHover(colorAt(e))}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const color = colorAt(e)
            if (color) onPick(color)
          }}
        />
      </div>
    </Modal>
  )
}
