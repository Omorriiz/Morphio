import { useCallback, useEffect, useRef, useState } from 'react'
import { defaultUniversalOptions } from '@shared/types'
import type { FileItem, FileKind, JobProgress, UniversalTarget } from '@shared/types'
import { useI18n } from '../i18n'
import { formatBytes } from '../lib'
import logoMark from '../assets/logo-mark.png'

type Phase = 'idle' | 'ready' | 'running' | 'done'

const KIND_LABEL: Record<FileKind, string> = {
  image: 'Изображения',
  video: 'Видео',
  audio: 'Звук',
  table: 'Таблицы',
  archive: 'Архивы',
  pdf: 'PDF',
  document: 'Документы',
  subtitle: 'Субтитры',
  folder: 'Папки',
  other: 'Файлы'
}

/** Быстрое окно: появляется по сочетанию клавиш или из меню Проводника, предлагает варианты и сразу работает. */
export default function QuickApp(): React.JSX.Element {
  const { t } = useI18n()
  const [phase, setPhase] = useState<Phase>('idle')
  const [items, setItems] = useState<FileItem[]>([])
  const [targets, setTargets] = useState<UniversalTarget[]>([])
  const [progress, setProgress] = useState<Record<string, JobProgress>>({})
  const [hint, setHint] = useState('')
  const [dragging, setDragging] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const stateRef = useRef({ phase, targets, items })
  stateRef.current = { phase, targets, items }

  const load = useCallback(async (paths: string[]) => {
    setProgress({})
    setHint('')
    if (paths.length === 0) {
      setItems([])
      setTargets([])
      setPhase('idle')
      return
    }
    const found = await window.api.inspectAny(paths)
    const [list, { settings }] = await Promise.all([
      window.api.universalTargets(found),
      window.api.getSettings()
    ])
    // Последние выбранные варианты стоят первыми: «сочетание → 1» повторяет прошлое действие.
    const rank = (id: string): number => {
      const i = settings.quickLast.indexOf(id)
      return i < 0 ? 1000 : i
    }
    const sorted = [...list].sort((a, b) => rank(a.id) - rank(b.id))
    setItems(found)
    setTargets(sorted)
    setPhase(found.length > 0 ? 'ready' : 'idle')
  }, [])

  useEffect(() => {
    const off = window.api.onQuickFiles((paths) => void load(paths))
    void window.api.quickReady()
    return off
  }, [load])

  useEffect(() => window.api.onProgress((p) => setProgress((prev) => ({ ...prev, [p.id]: p }))), [])

  const close = useCallback(() => void window.api.quickClose(), [])

  const run = useCallback(
    async (target: UniversalTarget) => {
      const todo = stateRef.current.items
      setPhase('running')
      void window.api.quickRemember(target.id)
      await window.api.universalConvert(todo, defaultUniversalOptions(target.id))
      setPhase('done')
    },
    []
  )

  // Клавиши: Esc закрывает, цифры 1–9 запускают вариант.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      if (e.key === 'Escape') return close()
      const s = stateRef.current
      if (s.phase === 'done' && e.key === 'Enter') return close()
      if (s.phase !== 'ready') return
      const n = Number(e.key)
      if (n >= 1 && n <= 9 && s.targets[n - 1]) void run(s.targets[n - 1])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, run])

  // После успешной работы окно само закрывается через несколько секунд, если им не пользуются.
  useEffect(() => {
    if (phase !== 'done') return
    const finished = items.map((i) => progress[i.id]).filter(Boolean)
    const fine = finished.length > 0 && finished.every((p) => p.status === 'done')
    if (document.hidden) {
      const ok = finished.filter((p) => p.status === 'done').length
      if (Notification.permission !== 'denied') {
        new Notification('Morphio', { body: t('Готово! Файлов:') + ' ' + ok })
      }
    }
    if (fine) closeTimer.current = window.setTimeout(close, 7000)
    return () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragging(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => window.api.getPathForFile(f)).filter(Boolean)
    await load(paths)
  }

  const totalSize = items.reduce((s, i) => s + i.size, 0)
  const kinds = [...new Set(items.map((i) => i.kind ?? 'other'))].map((k) => t(KIND_LABEL[k])).join(', ')
  const done = items.filter((i) => progress[i.id]?.status === 'done')
  const failed = items.filter((i) => progress[i.id]?.status === 'error')
  const percent = items.length
    ? items.reduce((s, i) => {
        const p = progress[i.id]
        return s + (p?.status === 'done' || p?.status === 'error' ? 100 : (p?.percent ?? 0))
      }, 0) / items.length
    : 0
  const before = done.reduce((s, i) => s + i.size, 0)
  const after = done.reduce((s, i) => s + (progress[i.id]?.outputSize ?? 0), 0)
  const firstOut = done.map((i) => progress[i.id]?.outputPath).find(Boolean)

  return (
    <div
      className={`quick ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onMouseMove={() => closeTimer.current && window.clearTimeout(closeTimer.current)}
    >
      <header className="quick-head">
        <div className="quick-title">
          <img src={logoMark} alt="" />
          <strong>{t('Быстрая конвертация')}</strong>
        </div>
        <button className="icon-btn" onClick={close} title={t('Закрыть')}>
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      {phase === 'idle' && (
        <div className="quick-empty">
          <div className="quick-drop">
            <div className="quick-drop-icon">
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" />
              </svg>
            </div>
            <p>{t('Перетащите файлы сюда')}</p>
          </div>
          <span className="muted small">
            {t('Или выделите файлы в Проводнике и нажмите сочетание клавиш ещё раз. Подойдут и скопированные файлы (Ctrl+C), и скриншот в буфере.')}
          </span>
        </div>
      )}

      {phase !== 'idle' && (
        <div className="quick-body">
          <div className="quick-summary">
            <div className="quick-thumbs">
              {items.slice(0, 6).map((i) => (
                <div key={i.id} className="quick-thumb" title={i.name}>
                  {i.thumbnail ? <img src={i.thumbnail} alt="" /> : <span>{i.kind === 'folder' ? '📁' : i.ext}</span>}
                </div>
              ))}
              {items.length > 6 && <div className="quick-thumb more">+{items.length - 6}</div>}
            </div>
            <span className="quick-meta">
              {t('{n} шт. · {size} · {kinds}', { n: items.length, size: formatBytes(totalSize), kinds })}
            </span>
          </div>

          {phase === 'ready' &&
            (targets.length === 0 ? (
              <span className="muted small">
                {t('У выбранных файлов нет общих действий. Выберите однотипные файлы.')}
              </span>
            ) : (
              <>
                <div className="quick-ask">{t('Во что превратить?')}</div>
                <div className="quick-targets">
                  {targets.map((x, i) => (
                    <button
                      key={x.id}
                      className="chip quick-chip"
                      onClick={() => void run(x)}
                      onMouseEnter={() => setHint(x.hint)}
                      onMouseLeave={() => setHint('')}
                    >
                      {i < 9 && <kbd>{i + 1}</kbd>}
                      {x.label}
                    </button>
                  ))}
                </div>
                <span className="muted small quick-hint">{hint || t('Нажмите цифру или выберите вариант')}</span>
              </>
            ))}

          {(phase === 'running' || phase === 'done') && (
            <div className="quick-progress">
              <div className="progress">
                <div className="progress-bar" style={{ width: `${Math.round(percent)}%` }} />
              </div>
              {phase === 'running' ? (
                <span className="muted small">
                  {t('Работаю… {done} из {n}', { done: done.length + failed.length, n: items.length })}
                </span>
              ) : (
                <div className="quick-result">
                  <b>{failed.length === 0 ? '🎉' : '⚠️'} {t('Готово! Файлов:')} {done.length}</b>
                  {before > after && after > 0 && (
                    <span className="good">−{Math.round((1 - after / before) * 100)}%</span>
                  )}
                  {failed.length > 0 && (
                    <span className="error small" title={progress[failed[0].id]?.error}>
                      {t('Ошибок: {n}', { n: failed.length })}: {progress[failed[0].id]?.error}
                    </span>
                  )}
                  <div className="row">
                    {firstOut && (
                      <button className="btn soft" onClick={() => void window.api.revealInFolder(firstOut)}>
                        {t('Показать в папке')}
                      </button>
                    )}
                    <button className="btn ghost" onClick={close}>
                      {t('Закрыть')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <footer className="quick-foot">
        <button
          className="btn soft"
          disabled={items.length === 0 || phase === 'running'}
          onClick={() => void window.api.quickOpenMain(items.map((i) => i.path))}
        >
          {t('Больше настроек')}
        </button>
        <span className="quick-esc">
          <kbd>Esc</kbd> {t('закрыть')}
        </span>
      </footer>
    </div>
  )
}
