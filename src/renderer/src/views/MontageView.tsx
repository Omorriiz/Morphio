import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultMontagePlan, MONTAGE_TRANSITIONS } from '@shared/types'
import type { MediaCapabilities, MontageClip, MontagePlan, MontageTransition, SavedResult } from '@shared/types'
import { cutOut, keepRanges, removedSeconds, speechRanges, splitClip } from '@shared/montageEdit'
import CropOverlay from '../components/CropOverlay'
import { Field, Section, Segmented, Switch } from '../components/ui'
import DropOverlay from '../components/DropOverlay'
import { useDropZone } from '../hooks/useDropZone'
import { useI18n } from '../i18n'
import { formatBytes, formatTime, parseTime } from '../lib'

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const HEIGHTS: { label: string; value?: number }[] = [
  { label: 'Как в оригинале' },
  { label: '1080p', value: 1080 },
  { label: '720p', value: 720 },
  { label: '480p', value: 480 },
  { label: '360p', value: 360 }
]
const LOUDNESS_TARGETS: { value: number; label: string }[] = [
  { value: -16, label: '−16 LUFS: просмотр и подкасты' },
  { value: -14, label: '−14 LUFS: YouTube и музыка' },
  { value: -23, label: '−23 LUFS: телевидение' }
]

const TRANSITION_LABELS: Record<MontageTransition, string> = {
  fade: 'Плавное затухание',
  dissolve: 'Растворение',
  wipeleft: 'Шторка влево',
  wiperight: 'Шторка вправо',
  slideleft: 'Сдвиг влево',
  slideright: 'Сдвиг вправо',
  circleopen: 'Круг',
  fadeblack: 'Через чёрный'
}
const CROP_RATIOS: { id: string; label: string; value: number | null }[] = [
  { id: 'free', label: 'Свободно', value: null },
  { id: '1:1', label: '1:1', value: 1 },
  { id: '16:9', label: '16:9', value: 16 / 9 },
  { id: '9:16', label: '9:16', value: 9 / 16 },
  { id: '4:5', label: '4:5', value: 4 / 5 }
]
const SILENCE_LEVELS: { id: string; label: string; db: number; min: number }[] = [
  { id: 'soft', label: 'Только длинные паузы', db: -40, min: 1 },
  { id: 'normal', label: 'Обычная', db: -35, min: 0.6 },
  { id: 'strict', label: 'Строгая', db: -30, min: 0.35 }
]

const newId = (): string => crypto.randomUUID()

const startOf = (c: MontageClip): number => c.start ?? 0
const endOf = (c: MontageClip): number => c.end ?? c.duration

/** Поле времени «м:сс.д»: правится текстом, применяется по Enter или при уходе из поля. */
function TimeInput({
  value,
  onCommit,
  label
}: {
  value: number
  onCommit: (seconds: number) => void
  label: string
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft !== null) {
      const s = parseTime(draft)
      if (s !== undefined) onCommit(s)
    }
    setDraft(null)
  }
  return (
    <input
      className="text-input time-input"
      aria-label={label}
      value={draft ?? formatTime(value)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(null)
      }}
    />
  )
}

/** Лента кадров с выделенным отрезком: ручки «от» и «до», клик ставит текущий кадр. */
function TrimStrip({
  clip,
  strip,
  time,
  onSeek,
  onRange
}: {
  clip: MontageClip
  strip?: string
  time: number
  onSeek: (t: number) => void
  onRange: (start: number, end: number) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<'start' | 'end' | 'seek' | null>(null)
  const d = clip.duration
  const s = startOf(clip)
  const e = endOf(clip)

  const at = (clientX: number): number => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return 0
    return Math.min(d, Math.max(0, ((clientX - r.left) / r.width) * d))
  }
  const round = (x: number): number => Math.round(x * 10) / 10

  const move = (clientX: number): void => {
    const x = round(at(clientX))
    if (drag.current === 'seek') onSeek(x)
    if (drag.current === 'start') {
      const ns = Math.min(x, e - 0.2)
      onRange(Math.max(0, ns), e)
      onSeek(Math.max(0, ns))
    }
    if (drag.current === 'end') {
      const ne = Math.max(x, s + 0.2)
      onRange(s, Math.min(d, ne))
      onSeek(Math.min(d, ne))
    }
  }

  return (
    <div
      className="trim-strip"
      ref={box}
      onPointerDown={(ev) => {
        ev.currentTarget.setPointerCapture(ev.pointerId)
        drag.current = 'seek'
        move(ev.clientX)
      }}
      onPointerMove={(ev) => drag.current && move(ev.clientX)}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      {strip ? <img src={strip} alt="" draggable={false} /> : <div className="trim-strip-empty" />}
      <div className="trim-shade" style={{ left: 0, width: `${(s / d) * 100}%` }} />
      <div className="trim-shade" style={{ left: `${(e / d) * 100}%`, right: 0 }} />
      <div className="trim-sel" style={{ left: `${(s / d) * 100}%`, width: `${((e - s) / d) * 100}%` }} />
      <div className="trim-head" style={{ left: `${(time / d) * 100}%` }} />
      <button
        className="trim-handle start"
        aria-label={t('Начало отрезка')}
        style={{ left: `${(s / d) * 100}%` }}
        onPointerDown={(ev) => {
          ev.stopPropagation()
          ev.currentTarget.parentElement?.setPointerCapture(ev.pointerId)
          drag.current = 'start'
        }}
      />
      <button
        className="trim-handle end"
        aria-label={t('Конец отрезка')}
        style={{ left: `${(e / d) * 100}%` }}
        onPointerDown={(ev) => {
          ev.stopPropagation()
          ev.currentTarget.parentElement?.setPointerCapture(ev.pointerId)
          drag.current = 'end'
        }}
      />
    </div>
  )
}

/** Монтаж: обрезка, склейка, поворот, скорость, субтитры и громкость в одном проходе. */
export default function MontageView({ active }: { active: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const [plan, setPlan] = useState<MontagePlan>(defaultMontagePlan)
  const [selected, setSelected] = useState<string | null>(null)
  const [time, setTime] = useState(0)
  const [poster, setPoster] = useState<string | undefined>()
  const [strips, setStrips] = useState<Record<string, string>>({})
  const [caps, setCaps] = useState<MediaCapabilities | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; text?: string }>({ percent: 0 })
  const [result, setResult] = useState<SavedResult | null>(null)
  const [error, setError] = useState('')
  const [cropMode, setCropMode] = useState(false)
  const [cropRatio, setCropRatio] = useState('free')
  const [cutFrom, setCutFrom] = useState(0)
  const [cutTo, setCutTo] = useState(0)
  const [silenceLevel, setSilenceLevel] = useState('normal')
  const [busy, setBusy] = useState(false)
  const [editNote, setEditNote] = useState('')

  useEffect(() => {
    void window.api.mediaCapabilities().then(setCaps)
  }, [])
  useEffect(() => window.api.onMontageProgress(setProgress), [])

  const clip = plan.clips.find((c) => c.id === selected) ?? null
  const patch = (p: Partial<MontagePlan>): void => {
    setPlan((cur) => ({ ...cur, ...p }))
    setResult(null)
    setError('')
  }
  const patchClip = (id: string, p: Partial<MontageClip>): void =>
    patch({ clips: plan.clips.map((c) => (c.id === id ? { ...c, ...p } : c)) })

  const addPaths = useCallback(async (paths: string[]): Promise<void> => {
    const found = await window.api.montageInspect(paths)
    if (found.length === 0) return
    setPlan((cur) => ({ ...cur, clips: [...cur.clips, ...found] }))
    setSelected((cur) => cur ?? found[0].id)
    setResult(null)
    setError('')
  }, [])
  const dragging = useDropZone(active, (p) => void addPaths(p))

  // лента кадров выбранного клипа
  useEffect(() => {
    if (!clip || strips[clip.id]) return
    let cancelled = false
    void window.api.montageStrip(clip.path, 16, 56).then((s) => {
      if (!cancelled) setStrips((cur) => ({ ...cur, [clip.id]: s }))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id])

  // кадр под ползунком времени (с небольшой задержкой, пока ползунок двигается)
  useEffect(() => {
    if (!clip) {
      setPoster(undefined)
      return
    }
    let cancelled = false
    const id = window.setTimeout(() => {
      void window.api.videoPoster(clip.path, time, 720).then((p) => {
        if (!cancelled) setPoster(p)
      })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(id)
    }
  }, [clip?.path, time]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (clip) setTime(Math.min(startOf(clip), clip.duration))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.id])

  const remove = (id: string): void => {
    const rest = plan.clips.filter((c) => c.id !== id)
    patch({ clips: rest })
    if (selected === id) setSelected(rest[0]?.id ?? null)
  }
  const move = (id: string, dir: -1 | 1): void => {
    const i = plan.clips.findIndex((c) => c.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= plan.clips.length) return
    const next = [...plan.clips]
    ;[next[i], next[j]] = [next[j], next[i]]
    patch({ clips: next })
  }

  /** Заменяет клип несколькими кусками (на то же место списка). */
  const replaceClip = (id: string, pieces: MontageClip[]): void => {
    const i = plan.clips.findIndex((c) => c.id === id)
    if (i < 0) return
    const next = [...plan.clips.slice(0, i), ...pieces, ...plan.clips.slice(i + 1)]
    patch({ clips: next })
    setSelected(pieces[0]?.id ?? next[0]?.id ?? null)
  }
  const doSplit = (c: MontageClip): void => {
    const pieces = splitClip(c, time, [newId(), newId()])
    if (pieces.length < 2) {
      setEditNote(t('Здесь нельзя разрезать: слишком близко к краю отрезка'))
      return
    }
    setEditNote('')
    replaceClip(c.id, pieces)
  }
  const doCut = (c: MontageClip): void => {
    const pieces = cutOut(c, cutFrom, cutTo, [newId(), newId()])
    if (pieces.length === 1 && pieces[0] === c) {
      setEditNote(t('Укажите отрезок, который нужно убрать: «от» и «до»'))
      return
    }
    if (pieces.length === 0) {
      setEditNote(t('Так уберётся весь клип. Удалите его кнопкой ×'))
      return
    }
    setEditNote(t('Вырезано {sec} с', { sec: Math.round(Math.abs(cutTo - cutFrom) * 10) / 10 }))
    replaceClip(c.id, pieces)
  }
  const doSilence = async (c: MontageClip): Promise<void> => {
    const level = SILENCE_LEVELS.find((l) => l.id === silenceLevel) ?? SILENCE_LEVELS[1]
    setBusy(true)
    setEditNote('')
    try {
      const silences = await window.api.montageSilence(c.path, level.db, level.min)
      const keep = speechRanges(silences, startOf(c), endOf(c))
      const pieces = keepRanges(c, keep, newId)
      if (silences.length === 0 || pieces.length === 0) {
        setEditNote(pieces.length === 0 && silences.length > 0 ? t('В клипе одна тишина') : t('Пауз не найдено'))
        return
      }
      const cut = removedSeconds(c, keep)
      setEditNote(cut < 0.2 ? t('Пауз не найдено') : t('Убрано {sec} с тишины, кусков: {n}', { sec: Math.round(cut * 10) / 10, n: pieces.length }))
      if (cut >= 0.2) replaceClip(c.id, pieces)
    } catch (e) {
      setEditNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const total = useMemo(
    () =>
      Math.max(
        0,
        plan.clips.reduce((s, c) => s + Math.max(0, endOf(c) - startOf(c)), 0) -
          (plan.transition && plan.clips.length > 1 ? (plan.clips.length - 1) * plan.transition.duration : 0)
      ) / plan.speed,
    [plan.clips, plan.speed, plan.transition]
  )
  const maxTracks = Math.max(1, ...plan.clips.map((c) => c.audioTracks))
  const anyAudio = plan.clips.some((c) => c.hasAudio)
  const multi = plan.clips.length > 1

  const save = async (): Promise<void> => {
    setRunning(true)
    setError('')
    setResult(null)
    setProgress({ percent: 0 })
    try {
      setResult(await window.api.montageRun(plan))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const pickOutput = async (): Promise<void> => {
    const dir = await window.api.pickFolder()
    if (dir) patch({ outputDir: dir })
  }

  const pickSubs = async (): Promise<void> => {
    const path = await window.api.montagePickSubtitles()
    if (path) patch({ subtitles: { ...plan.subtitles, path, mode: plan.subtitles.mode === 'none' ? 'soft' : plan.subtitles.mode } })
  }

  const fmtTotal = (s: number): string => formatTime(s)
  const subName = plan.subtitles.path?.split(/[\\/]/).pop()

  return (
    <div className="converter montage">
      {active && dragging && <DropOverlay />}

      {plan.clips.length === 0 ? (
        <div className="empty-state hero">
          <div className="hero-emoji">✂️</div>
          <h1>{t('Монтаж видео')}</h1>
          <p>{t('Обрежьте, склейте, поверните, ускорьте, добавьте субтитры или выровняйте громкость. Все правки сохраняются за один проход.')}</p>
          <div className="row">
            <button
              className="btn primary big"
              onClick={async () => void addPaths(await window.api.montagePickVideos())}
            >
              {t('Выбрать видео')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <header className="list-head">
            <div>
              <h2>{t('Монтаж')}</h2>
              <span className="muted">
                {t('Клипов: {n}', { n: plan.clips.length })} · {t('Итог: {time}', { time: fmtTotal(total) })}
              </span>
            </div>
            <div className="row">
              <button className="btn ghost" disabled={running} onClick={async () => void addPaths(await window.api.montagePickVideos())}>
                {t('+ Добавить видео')}
              </button>
              <button
                className="btn ghost"
                disabled={running}
                onClick={() => {
                  setPlan(defaultMontagePlan())
                  setSelected(null)
                  setResult(null)
                }}
              >
                {t('Очистить')}
              </button>
            </div>
          </header>

          <div className="cv-scroll">
            <Section title={t('Клипы')}>
              <ul className="clip-list">
                {plan.clips.map((c, i) => (
                  <li
                    key={c.id}
                    className={`clip-row ${c.id === selected ? 'active' : ''}`}
                    onClick={() => setSelected(c.id)}
                  >
                    <div className="clip-thumb">{c.thumbnail ? <img src={c.thumbnail} alt="" /> : <span>🎬</span>}</div>
                    <div className="clip-meta">
                      <div className="file-name" title={c.path}>
                        {c.name}
                      </div>
                      <div className="muted small">
                        {c.width}×{c.height} · {formatTime(endOf(c) - startOf(c))}
                        {(c.start !== undefined || c.end !== undefined) && ` ${t('из')} ${formatTime(c.duration)}`}
                      </div>
                    </div>
                    {multi && (
                      <>
                        <button className="icon-btn" title={t('Выше')} disabled={i === 0 || running} onClick={(e) => { e.stopPropagation(); move(c.id, -1) }}>
                          <svg viewBox="0 0 24 24" aria-hidden><path d="M6 14l6-6 6 6" /></svg>
                        </button>
                        <button className="icon-btn" title={t('Ниже')} disabled={i === plan.clips.length - 1 || running} onClick={(e) => { e.stopPropagation(); move(c.id, 1) }}>
                          <svg viewBox="0 0 24 24" aria-hidden><path d="M6 10l6 6 6-6" /></svg>
                        </button>
                      </>
                    )}
                    <button className="icon-btn" title={t('Убрать')} disabled={running} onClick={(e) => { e.stopPropagation(); remove(c.id) }}>
                      <svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </li>
                ))}
              </ul>
              {multi && (
                <div className="options">
                  <Field label={t('Переход между клипами')} hint={t('Вместо резкой склейки: клипы плавно перетекают друг в друга, ролик становится короче на время переходов')}>
                    <div className="row tight">
                      <select
                        value={plan.transition?.kind ?? ''}
                        disabled={running}
                        onChange={(e) =>
                          patch({
                            transition: e.target.value
                              ? { kind: e.target.value as MontageTransition, duration: plan.transition?.duration ?? 0.5 }
                              : undefined
                          })
                        }
                      >
                        <option value="">{t('Без перехода')}</option>
                        {MONTAGE_TRANSITIONS.map((k) => (
                          <option key={k} value={k}>
                            {t(TRANSITION_LABELS[k])}
                          </option>
                        ))}
                      </select>
                      {plan.transition && (
                        <select
                          value={plan.transition.duration}
                          disabled={running}
                          onChange={(e) => patch({ transition: { ...plan.transition!, duration: Number(e.target.value) } })}
                        >
                          {[0.3, 0.5, 1, 1.5, 2].map((d) => (
                            <option key={d} value={d}>
                              {t('{sec} с', { sec: d })}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </Field>
                </div>
              )}
              {multi && (
                <p className="notice">
                  {t('Клипы склеятся в порядке списка. Если у них разный размер, всё приведётся к размеру первого, с чёрными полями.')}
                </p>
              )}
            </Section>

            {clip && (
              <Section title={t('Обрезка: {name}', { name: clip.name })}>
                <div className="trim-preview">
                  {poster ? (
                    <div className="crop-wrap">
                      <img src={poster} alt="" draggable={false} />
                      {cropMode && (
                        <CropOverlay
                          crop={plan.crop ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }}
                          ratio={CROP_RATIOS.find((r) => r.id === cropRatio)?.value ?? null}
                          frameAspect={plan.clips[0].width / plan.clips[0].height}
                          onCrop={(crop) => patch({ crop })}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="trim-preview-empty" />
                  )}
                </div>
                <TrimStrip
                  clip={clip}
                  strip={strips[clip.id]}
                  time={time}
                  onSeek={setTime}
                  onRange={(s, e) => patchClip(clip.id, { start: s <= 0 ? undefined : s, end: e >= clip.duration ? undefined : e })}
                />
                <input
                  className="trim-time"
                  type="range"
                  min={0}
                  max={clip.duration}
                  step={0.1}
                  value={time}
                  aria-label={t('Момент видео')}
                  onChange={(e) => setTime(Number(e.target.value))}
                />
                <div className="trim-controls">
                  <label className="trim-field">
                    <span className="muted small">{t('Начало')}</span>
                    <TimeInput
                      label={t('Начало')}
                      value={startOf(clip)}
                      onCommit={(v) => patchClip(clip.id, { start: v <= 0 ? undefined : Math.min(v, endOf(clip) - 0.2) })}
                    />
                  </label>
                  <button className="btn soft" disabled={running} onClick={() => patchClip(clip.id, { start: time <= 0 ? undefined : Math.min(time, endOf(clip) - 0.2) })}>
                    {t('Начало здесь')}
                  </button>
                  <span className="muted">{formatTime(time)}</span>
                  <button className="btn soft" disabled={running} onClick={() => patchClip(clip.id, { end: time >= clip.duration ? undefined : Math.max(time, startOf(clip) + 0.2) })}>
                    {t('Конец здесь')}
                  </button>
                  <label className="trim-field">
                    <span className="muted small">{t('Конец')}</span>
                    <TimeInput
                      label={t('Конец')}
                      value={endOf(clip)}
                      onCommit={(v) => patchClip(clip.id, { end: v >= clip.duration ? undefined : Math.max(v, startOf(clip) + 0.2) })}
                    />
                  </label>
                  <button
                    className="btn ghost"
                    disabled={running || (clip.start === undefined && clip.end === undefined)}
                    onClick={() => patchClip(clip.id, { start: undefined, end: undefined })}
                  >
                    {t('Весь клип')}
                  </button>
                </div>
              </Section>
            )}

            {clip && (
              <Section title={t('Куски и тишина')}>
                <div className="options">
                  <Field label={t('Разрезать')} hint={t('Клип делится на два в выбранный момент. Куски можно менять местами и удалять')}>
                    <div className="row tight">
                      <button className="btn soft" disabled={running || busy} onClick={() => doSplit(clip)}>
                        {t('Разрезать здесь')}
                      </button>
                      <span className="muted small">{formatTime(time)}</span>
                    </div>
                  </Field>
                  <Field label={t('Вырезать середину')} hint={t('Убирает отрезок «от» — «до», остальное склеивается')}>
                    <div className="trim-controls">
                      <button className="btn ghost" disabled={running || busy} onClick={() => setCutFrom(time)}>
                        {t('От: {time}', { time: formatTime(cutFrom) })}
                      </button>
                      <button className="btn ghost" disabled={running || busy} onClick={() => setCutTo(time)}>
                        {t('До: {time}', { time: formatTime(cutTo) })}
                      </button>
                      <button className="btn soft" disabled={running || busy} onClick={() => doCut(clip)}>
                        {t('Вырезать')}
                      </button>
                    </div>
                  </Field>
                  {clip.hasAudio && (
                    <Field label={t('Тишина')} hint={t('Паузы в звуке вырезаются, речь и звуки остаются. Кусков может стать много, их можно поправить')}>
                      <div className="row tight">
                        <select value={silenceLevel} disabled={running || busy} onChange={(e) => setSilenceLevel(e.target.value)}>
                          {SILENCE_LEVELS.map((l) => (
                            <option key={l.id} value={l.id}>
                              {t(l.label)}
                            </option>
                          ))}
                        </select>
                        <button className="btn soft" disabled={running || busy} onClick={() => void doSilence(clip)}>
                          {busy ? t('Слушаю…') : t('Убрать тишину')}
                        </button>
                      </div>
                    </Field>
                  )}
                </div>
                {editNote && <p className="notice">{editNote}</p>}
              </Section>
            )}

            <Section title={t('Кадр')}>
              <div className="options">
                <Field label={t('Кадрирование')} hint={t('Рамка по кадру первого клипа. Всё, что вне рамки, обрезается у всех клипов')}>
                  <div className="row tight">
                    <Segmented
                      value={cropRatio}
                      disabled={running}
                      onChange={(id) => {
                        setCropRatio(id)
                        const r = CROP_RATIOS.find((x) => x.id === id)?.value
                        const first = plan.clips[0]
                        if (r && first) {
                          const k = r / (first.width / first.height)
                          let w = 1
                          let h = 1 / k
                          if (h > 1) {
                            h = 1
                            w = k
                          }
                          patch({ crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } })
                        }
                        setSelected(first?.id ?? null)
                        setCropMode(true)
                      }}
                      options={CROP_RATIOS.map((r) => ({ id: r.id, label: t(r.label) }))}
                    />
                  </div>
                </Field>
                <Field label=" ">
                  <div className="row tight">
                    <button
                      className={`btn soft ${cropMode ? 'active' : ''}`}
                      disabled={running}
                      onClick={() => {
                        if (!cropMode) {
                          setSelected(plan.clips[0]?.id ?? null)
                          if (!plan.crop) patch({ crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } })
                        }
                        setCropMode(!cropMode)
                      }}
                    >
                      {cropMode ? t('Готово') : plan.crop ? t('Править рамку') : t('Выбрать рамку')}
                    </button>
                    <button
                      className="btn ghost"
                      disabled={running || !plan.crop}
                      onClick={() => {
                        patch({ crop: undefined })
                        setCropMode(false)
                        setCropRatio('free')
                      }}
                    >
                      {t('Убрать рамку')}
                    </button>
                    {plan.crop && (
                      <span className="muted small">
                        {t('{w}×{h} % кадра', { w: Math.round(plan.crop.w * 100), h: Math.round(plan.crop.h * 100) })}
                      </span>
                    )}
                  </div>
                </Field>
              </div>
            </Section>

            <Section title={t('Поворот и скорость')}>
              <div className="options">
                <Field label={t('Поворот')}>
                  <Segmented
                    value={String(plan.rotate)}
                    disabled={running}
                    onChange={(v) => patch({ rotate: Number(v) as MontagePlan['rotate'] })}
                    options={[
                      { id: '0', label: '0°' },
                      { id: '90', label: '90°' },
                      { id: '180', label: '180°' },
                      { id: '270', label: '270°' }
                    ]}
                  />
                </Field>
                <Field label={t('Отражение')}>
                  <div className="row tight">
                    <Switch checked={plan.flipH} disabled={running} label={t('По горизонтали')} onChange={(v) => patch({ flipH: v })} />
                    <Switch checked={plan.flipV} disabled={running} label={t('По вертикали')} onChange={(v) => patch({ flipV: v })} />
                  </div>
                </Field>
                <Field label={t('Скорость')}>
                  <select value={plan.speed} disabled={running} onChange={(e) => patch({ speed: Number(e.target.value) })}>
                    {SPEEDS.map((s) => (
                      <option key={s} value={s}>
                        {s === 1 ? t('Обычная') : `${s}×`}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </Section>

            {anyAudio && (
              <Section title={t('Звук')}>
                <div className="options">
                  <Field label={t('Звуковая дорожка')}>
                    <Switch checked={plan.mute} disabled={running} label={t('Убрать звук')} onChange={(v) => patch({ mute: v })} />
                  </Field>
                  {maxTracks > 1 && !plan.mute && (
                    <Field label={t('Дорожка')}>
                      <select value={plan.audioTrack} disabled={running} onChange={(e) => patch({ audioTrack: Number(e.target.value) })}>
                        {Array.from({ length: maxTracks }, (_, k) => (
                          <option key={k} value={k}>
                            {t('Дорожка {n}', { n: k + 1 })}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  {!plan.mute && (
                    <>
                      <Field label={t('Громкость')} hint={plan.loudness.mode === 'loudnorm' ? t('Измеряем и подгоняем в два прохода') : undefined}>
                        <Segmented
                          value={plan.loudness.mode}
                          disabled={running}
                          onChange={(mode) => patch({ loudness: { ...plan.loudness, mode } })}
                          options={[
                            { id: 'off', label: t('Как есть') },
                            { id: 'loudnorm', label: t('По стандарту'), hint: t('EBU R128: ровная громкость для разных роликов') },
                            { id: 'dynaudnorm', label: t('По ходу'), hint: t('Подтягивает тихие места, хорошо для речи') }
                          ]}
                        />
                      </Field>
                      {plan.loudness.mode === 'loudnorm' && (
                        <Field label={t('Целевой уровень')}>
                          <select
                            value={plan.loudness.target}
                            disabled={running}
                            onChange={(e) => patch({ loudness: { ...plan.loudness, target: Number(e.target.value) } })}
                          >
                            {LOUDNESS_TARGETS.map((x) => (
                              <option key={x.value} value={x.value}>
                                {t(x.label)}
                              </option>
                            ))}
                          </select>
                        </Field>
                      )}
                    </>
                  )}
                </div>
              </Section>
            )}

            <Section title={t('Субтитры')}>
              <div className="options">
                <Field label={t('Как добавить')}>
                  <Segmented
                    value={plan.subtitles.mode}
                    disabled={running}
                    onChange={(mode) => patch({ subtitles: { ...plan.subtitles, mode } })}
                    options={[
                      { id: 'none', label: t('Без субтитров') },
                      { id: 'soft', label: t('Дорожкой'), hint: t('Включаются и выключаются в плеере') },
                      { id: 'burn', label: t('В картинку'), hint: t('Видны везде, их нельзя выключить') }
                    ]}
                  />
                </Field>
                {plan.subtitles.mode !== 'none' && (
                  <>
                    <Field label={t('Файл субтитров')}>
                      <div className="row tight">
                        <button className="btn soft" disabled={running} onClick={() => void pickSubs()}>
                          {subName ?? t('Выбрать файл…')}
                        </button>
                        <span className="muted small">SRT · VTT · ASS</span>
                      </div>
                    </Field>
                    <Field label={t('Сдвиг, секунды')} hint={t('Минус — раньше, плюс — позже')}>
                      <input
                        type="number"
                        className="text-input"
                        step={0.1}
                        value={plan.subtitles.shift}
                        disabled={running}
                        onChange={(e) => patch({ subtitles: { ...plan.subtitles, shift: Number(e.target.value) || 0 } })}
                      />
                    </Field>
                  </>
                )}
                {plan.subtitles.mode === 'burn' && (
                  <>
                    <Field label={t('Размер шрифта')}>
                      <select
                        value={plan.subtitles.fontSize}
                        disabled={running}
                        onChange={(e) => patch({ subtitles: { ...plan.subtitles, fontSize: Number(e.target.value) } })}
                      >
                        {[16, 20, 24, 28, 32, 40, 48].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('Цвет текста')}>
                      <input
                        type="color"
                        value={plan.subtitles.color}
                        disabled={running}
                        onChange={(e) => patch({ subtitles: { ...plan.subtitles, color: e.target.value } })}
                      />
                    </Field>
                    <Field label={t('Обводка')}>
                      <Switch
                        checked={plan.subtitles.outline}
                        disabled={running}
                        label={t('Чёрная обводка (читается на любом фоне)')}
                        onChange={(v) => patch({ subtitles: { ...plan.subtitles, outline: v } })}
                      />
                    </Field>
                  </>
                )}
              </div>
              {plan.subtitles.mode !== 'none' && multi && (
                <p className="notice">{t('При склейке время субтитров считается от начала общего ролика.')}</p>
              )}
            </Section>

            <Section title={t('Результат')}>
              <div className="options">
                <Field label={t('Формат')}>
                  <Segmented
                    value={plan.target}
                    disabled={running}
                    onChange={(target) => patch({ target })}
                    options={[
                      { id: 'mp4', label: 'MP4' },
                      { id: 'mkv', label: 'MKV' },
                      { id: 'webm', label: 'WebM' }
                    ]}
                  />
                </Field>
                <Field
                  label={t('Обрезка')}
                  hint={
                    plan.trimMode === 'fast'
                      ? t('Без перекодирования: мгновенно, но граница может сместиться на секунду-две. Работает, если больше ничего не меняется (скорость, громкость, рамка, переходы, субтитры в картинку), для видео H.264. Поворот на 90° — только меткой в MP4, у одного клипа.')
                      : t('Кадр в кадр, видео перекодируется')
                  }
                >
                  <Segmented
                    value={plan.trimMode}
                    disabled={running}
                    onChange={(trimMode) => patch({ trimMode })}
                    options={[
                      { id: 'accurate', label: t('Точно') },
                      { id: 'fast', label: t('Быстро') }
                    ]}
                  />
                </Field>
                {plan.trimMode === 'accurate' && (
                  <>
                    <Field label={t('Качество')}>
                      <Segmented
                        value={plan.quality}
                        disabled={running}
                        onChange={(quality) => patch({ quality })}
                        options={[
                          { id: 'high', label: t('Высокое') },
                          { id: 'medium', label: t('Среднее') },
                          { id: 'low', label: t('Малый размер') }
                        ]}
                      />
                    </Field>
                    <Field label={t('Размер кадра')}>
                      <select
                        value={plan.maxHeight ?? ''}
                        disabled={running}
                        onChange={(e) => patch({ maxHeight: e.target.value ? Number(e.target.value) : undefined })}
                      >
                        {HEIGHTS.map((h) => (
                          <option key={h.label} value={h.value ?? ''}>
                            {t(h.label)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {caps?.gpu && plan.target !== 'webm' && (
                      <Field label={t('Скорость')}>
                        <Switch
                          checked={plan.useGpu}
                          disabled={running}
                          label={t('Видеокарта: {gpu}', { gpu: caps.gpuLabel ?? '' })}
                          onChange={(useGpu) => patch({ useGpu })}
                        />
                      </Field>
                    )}
                  </>
                )}
              </div>
            </Section>
          </div>

          <footer className="action-bar cv-footer">
            <div className="cv-dest">
              <button className="btn soft" onClick={pickOutput} disabled={running} title={plan.outputDir}>
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                </svg>
                {plan.outputDir ? plan.outputDir.split(/[\\/]/).filter(Boolean).pop() : t('Рядом с оригиналом')}
              </button>
              {plan.outputDir && (
                <button className="icon-btn" title={t('Сбросить')} onClick={() => patch({ outputDir: undefined })}>
                  <svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              )}
              <span className="muted small montage-status">
                {running ? (
                  <>
                    {progress.text ?? t('Сохраняю…')} {Math.round(progress.percent)}%
                  </>
                ) : error ? (
                  <span className="error" title={error}>{error.length > 90 ? t('Не получилось') : error}</span>
                ) : result ? (
                  <>
                    🎉 {t('Готово!')} {formatBytes(result.outputSize)}
                    {result.info ? ` · ${result.info}` : ''}
                  </>
                ) : (
                  t('Оригиналы не изменяются')
                )}
              </span>
            </div>
            {running ? (
              <button className="btn danger" onClick={() => window.api.cancel()}>
                {t('Остановить')}
              </button>
            ) : result ? (
              <div className="row">
                <button className="btn soft" onClick={() => void window.api.revealInFolder(result.outputPath)}>
                  {t('Показать в папке')}
                </button>
                <button className="btn primary" onClick={() => setResult(null)}>
                  {t('Ещё раз')}
                </button>
              </div>
            ) : (
              <button className="btn primary" onClick={() => void save()}>
                {t('Сохранить')}
              </button>
            )}
          </footer>
          {running && (
            <div className="progress montage-progress">
              <div className="progress-bar" style={{ width: `${Math.round(progress.percent)}%` }} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
