import { useEffect, useMemo, useState } from 'react'
import { formatStamp, parseStamp, shiftCues } from '@shared/subtitles'
import type { Cue } from '@shared/subtitles'
import { useI18n } from '../i18n'
import Modal from './Modal'

interface Props {
  title: string
  path: string
  onClose: () => void
}

interface Row {
  key: number
  start: string
  end: string
  text: string
}

const toRow = (c: Cue, key: number): Row => ({ key, start: formatStamp(c.start, ','), end: formatStamp(c.end, ','), text: c.text })

/** Проверка строки: время читается, конец позже начала. */
function rowError(r: Row): 'start' | 'end' | 'order' | null {
  const s = parseStamp(r.start)
  const e = parseStamp(r.end)
  if (s === undefined) return 'start'
  if (e === undefined) return 'end'
  return e <= s ? 'order' : null
}

/** Простой редактор субтитров: правка текста и времени реплик, добавление, удаление, общий сдвиг. */
export default function SubtitleEditor({ title, path, onClose }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [shift, setShift] = useState(0)
  const [counter, setCounter] = useState(0)

  useEffect(() => {
    let cancelled = false
    void window.api
      .subtitlesLoad(path)
      .then((cues) => {
        if (cancelled) return
        setRows(cues.map((c, i) => toRow(c, i)))
        setCounter(cues.length)
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [path])

  const bad = useMemo(() => rows.filter((r) => rowError(r) !== null).length, [rows])
  const patch = (key: number, p: Partial<Row>): void => {
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...p } : r)))
    setSaved(false)
  }

  const add = (after: number): void => {
    setRows((cur) => {
      const i = cur.findIndex((r) => r.key === after)
      const prev = cur[i]
      const end = prev ? (parseStamp(prev.end) ?? 0) : 0
      const row: Row = { key: counter, start: formatStamp(end, ','), end: formatStamp(end + 2, ','), text: '' }
      return [...cur.slice(0, i + 1), row, ...cur.slice(i + 1)]
    })
    setCounter((n) => n + 1)
    setSaved(false)
  }

  const applyShift = (): void => {
    const cues = rows
      .filter((r) => rowError(r) === null)
      .map((r) => ({ start: parseStamp(r.start)!, end: parseStamp(r.end)!, text: r.text }))
    const moved = shiftCues(cues, shift)
    setRows(moved.map((c, i) => toRow(c, counter + i)))
    setCounter((n) => n + moved.length)
    setShift(0)
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    setError('')
    try {
      const cues: Cue[] = rows
        .map((r) => ({ start: parseStamp(r.start)!, end: parseStamp(r.end)!, text: r.text.trim() }))
        .filter((c) => c.text !== '')
        .sort((a, b) => a.start - b.start)
      await window.api.subtitlesSave(path, cues)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted small subs-status">
            {error ? <span className="error">{error}</span> : saved ? `✓ ${t('Сохранено')}` : bad > 0 ? t('Исправьте время в строках: {n}', { n: bad }) : t('Реплик: {n}', { n: rows.length })}
          </span>
          <button className="btn ghost" onClick={onClose}>
            {t('Закрыть')}
          </button>
          <button className="btn primary" disabled={bad > 0 || loading || rows.length === 0} onClick={() => void save()}>
            {t('Сохранить')}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="muted">{t('Читаю субтитры…')}</p>
      ) : (
        <div className="subs-editor">
          <div className="subs-tools">
            <label className="row tight">
              <span className="muted small">{t('Сдвинуть всё, секунды')}</span>
              <input type="number" className="text-input tiny" step={0.1} value={shift} onChange={(e) => setShift(Number(e.target.value) || 0)} />
            </label>
            <button className="btn soft" disabled={shift === 0 || bad > 0} onClick={applyShift}>
              {t('Сдвинуть')}
            </button>
            <button className="btn ghost" onClick={() => add(rows[rows.length - 1]?.key ?? -1)}>
              {t('+ Реплика в конец')}
            </button>
          </div>
          <ol className="subs-list">
            {rows.map((r, i) => {
              const err = rowError(r)
              return (
                <li key={r.key} className="subs-row">
                  <span className="muted small subs-n">{i + 1}</span>
                  <div className="subs-times">
                    <input
                      className={`text-input time-input ${err === 'start' || err === 'order' ? 'invalid' : ''}`}
                      aria-label={t('Начало')}
                      value={r.start}
                      onChange={(e) => patch(r.key, { start: e.target.value })}
                    />
                    <input
                      className={`text-input time-input ${err === 'end' || err === 'order' ? 'invalid' : ''}`}
                      aria-label={t('Конец')}
                      value={r.end}
                      onChange={(e) => patch(r.key, { end: e.target.value })}
                    />
                  </div>
                  <textarea className="text-input" rows={2} value={r.text} onChange={(e) => patch(r.key, { text: e.target.value })} />
                  <button className="icon-btn" title={t('Добавить реплику после этой')} onClick={() => add(r.key)}>
                    <svg viewBox="0 0 24 24" aria-hidden>
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <button
                    className="icon-btn"
                    title={t('Убрать')}
                    onClick={() => {
                      setRows((cur) => cur.filter((x) => x.key !== r.key))
                      setSaved(false)
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden>
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </Modal>
  )
}
