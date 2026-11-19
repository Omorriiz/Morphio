import { useEffect, useState } from 'react'
import type { GifFrame } from '@shared/types'
import { useI18n } from '../i18n'

interface Props {
  /** Кадры в том порядке, в котором они будут проигрываться */
  frames: GifFrame[]
  defaultDelay: number
  /** Подсвеченный кадр (выбран в ленте) */
  selectedId?: string | null
  /** Готовый результат — показываем вместо покадрового просмотра */
  resultUrl?: string | null
  background?: string
  /** Сообщает номер показанного кадра (в порядке проигрывания) */
  onIndex?: (index: number) => void
  /** Своё содержимое сцены вместо картинки кадра (редактор слоёв) */
  renderFrame?: (frame: GifFrame, index: number) => React.ReactNode
}

/** Проигрыватель: показывает анимацию так, как она будет выглядеть, с задержками каждого кадра. */
export default function FramePlayer({
  frames,
  defaultDelay,
  selectedId,
  resultUrl,
  background,
  onIndex,
  renderFrame
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const [playing, setPlaying] = useState(true)
  const [index, setIndex] = useState(0)

  // Выбор кадра в ленте ставит проигрыватель на паузу на этом кадре.
  useEffect(() => {
    if (!selectedId) return
    const i = frames.findIndex((f) => f.id === selectedId)
    if (i >= 0) {
      setIndex(i)
      setPlaying(false)
    }
  }, [selectedId, frames])

  useEffect(() => {
    if (index >= frames.length) setIndex(0)
  }, [frames.length, index])

  useEffect(() => {
    if (!playing || frames.length < 2 || resultUrl) return
    const f = frames[index % frames.length]
    const t = window.setTimeout(
      () => setIndex((i) => (i + 1) % frames.length),
      Math.max(20, f?.delay ?? defaultDelay)
    )
    return () => window.clearTimeout(t)
  }, [playing, index, frames, defaultDelay, resultUrl])

  const current = frames[Math.min(index, frames.length - 1)]
  const shownIndex = Math.min(index, Math.max(0, frames.length - 1))
  useEffect(() => {
    onIndex?.(shownIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownIndex])

  return (
    <div className="player">
      <div
        className={`player-stage ${background && background !== 'transparent' ? '' : 'checker'}`}
        style={background && background !== 'transparent' ? { background } : undefined}
      >
        {resultUrl ? (
          <img src={resultUrl} alt={t('Результат')} />
        ) : current ? (
          (renderFrame?.(current, shownIndex) ?? <img src={current.preview} alt={current.name} />)
        ) : (
          <span className="muted">{t('Нет кадров')}</span>
        )}
      </div>
      {!resultUrl && frames.length > 0 && (
        <div className="player-bar">
          <button
            className="icon-btn"
            onClick={() => setPlaying((p) => !p)}
            title={playing ? t('Пауза') : t('Играть')}
          >
            {playing ? (
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M9 6v12M15 6v12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M8 5l11 7-11 7z" />
              </svg>
            )}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            value={Math.min(index, frames.length - 1)}
            onChange={(e) => {
              setPlaying(false)
              setIndex(Number(e.target.value))
            }}
            aria-label={t('Кадр')}
          />
          <span className="muted small">
            {Math.min(index, frames.length - 1) + 1} / {frames.length}
          </span>
        </div>
      )}
    </div>
  )
}
