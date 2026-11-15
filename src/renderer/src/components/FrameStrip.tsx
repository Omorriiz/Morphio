import { useRef, useState } from 'react'
import type { GifFrame } from '@shared/types'
import { useI18n } from '../i18n'

interface Props {
  frames: GifFrame[]
  defaultDelay: number
  selectedId: string | null
  disabled?: boolean
  onSelect: (id: string) => void
  onMove: (from: number, to: number) => void
  onRemove: (id: string) => void
  onDuplicate: (id: string) => void
  onDelay: (id: string, delay: number | undefined) => void
}

/** Лента кадров: порядок меняется перетаскиванием, у каждого кадра своя задержка. */
export default function FrameStrip({
  frames,
  defaultDelay,
  selectedId,
  disabled,
  onSelect,
  onMove,
  onRemove,
  onDuplicate,
  onDelay
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const dragFrom = useRef<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  return (
    <ul className="strip">
      {frames.map((f, i) => (
        <li
          key={f.id}
          className={`frame ${selectedId === f.id ? 'selected' : ''} ${overIndex === i ? 'over' : ''}`}
          draggable={!disabled}
          onDragStart={(e) => {
            dragFrom.current = i
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', String(i))
          }}
          onDragOver={(e) => {
            if (dragFrom.current === null) return
            e.preventDefault()
            setOverIndex(i)
          }}
          onDragLeave={() => setOverIndex((o) => (o === i ? null : o))}
          onDrop={(e) => {
            if (dragFrom.current === null) return
            e.preventDefault()
            const from = dragFrom.current
            dragFrom.current = null
            setOverIndex(null)
            if (from !== i) onMove(from, i)
          }}
          onDragEnd={() => {
            dragFrom.current = null
            setOverIndex(null)
          }}
          onClick={() => onSelect(f.id)}
        >
          <div className="frame-thumb checker">
            <img src={f.thumbnail} alt="" draggable={false} />
            <span className="frame-num">{i + 1}</span>
            {!disabled && (
              <div className="frame-actions">
                <button
                  title={t('Дублировать кадр')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDuplicate(f.id)
                  }}
                >
                  ⧉
                </button>
                <button
                  title={t('Убрать кадр')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(f.id)
                  }}
                >
                  ×
                </button>
              </div>
            )}
          </div>
          <label className="frame-delay" onClick={(e) => e.stopPropagation()}>
            <input
              type="number"
              min={20}
              max={10000}
              step={10}
              disabled={disabled}
              placeholder={String(defaultDelay)}
              value={f.delay ?? ''}
              onChange={(e) =>
                onDelay(f.id, e.target.value === '' ? undefined : Math.max(20, Number(e.target.value)))
              }
              title={t('Задержка этого кадра, мс (пусто — общая)')}
            />
            <span>{t('мс')}</span>
          </label>
        </li>
      ))}
    </ul>
  )
}
