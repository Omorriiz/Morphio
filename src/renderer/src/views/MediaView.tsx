import { useEffect, useState } from 'react'
import { AUDIO_TARGETS, VIDEO_TARGETS } from '@shared/types'
import type { MediaCapabilities, MediaOptions, MediaTarget } from '@shared/types'
import { useFileJobs } from '../hooks/useFileJobs'
import FileList from '../components/FileList'
import DropOverlay from '../components/DropOverlay'
import { formatBytes } from '../lib'

/** Быстрые настройки под типичные задачи. */
interface Preset {
  id: string
  label: string
  hint: string
  apply: Partial<State>
}

interface State {
  target: MediaTarget
  quality: MediaOptions['quality']
  maxHeight?: number
  audioBitrate: number
  limitOn: boolean
  targetMB: number
  mute: boolean
}

const PRESETS: Preset[] = [
  {
    id: 'messenger',
    label: 'Для мессенджера',
    hint: 'MP4, 720p, средний размер',
    apply: { target: 'mp4', quality: 'medium', maxHeight: 720, audioBitrate: 128, limitOn: false, mute: false }
  },
  {
    id: 'discord',
    label: 'Discord (до 10 МБ)',
    hint: 'MP4, размер подбирается под 9,5 МБ',
    apply: { target: 'mp4', maxHeight: undefined, audioBitrate: 96, limitOn: true, targetMB: 9.5, mute: false }
  },
  {
    id: 'mail',
    label: 'Почта (до 25 МБ)',
    hint: 'MP4, размер подбирается под 24 МБ',
    apply: { target: 'mp4', maxHeight: undefined, audioBitrate: 128, limitOn: true, targetMB: 24, mute: false }
  },
  {
    id: 'best',
    label: 'Лучшее качество',
    hint: 'MP4, высокое качество, размер как в оригинале',
    apply: { target: 'mp4', quality: 'high', maxHeight: undefined, audioBitrate: 256, limitOn: false, mute: false }
  },
  {
    id: 'small',
    label: 'Минимальный размер',
    hint: 'MP4, 480p, сильное сжатие',
    apply: { target: 'mp4', quality: 'low', maxHeight: 480, audioBitrate: 96, limitOn: false, mute: false }
  },
  {
    id: 'mp3',
    label: 'MP3 для телефона',
    hint: 'Только звук, 192 кбит/с',
    apply: { target: 'mp3', audioBitrate: 192 }
  },
  {
    id: 'voice',
    label: 'Голос (мало места)',
    hint: 'OPUS, 64 кбит/с',
    apply: { target: 'opus', audioBitrate: 64 }
  },
  {
    id: 'lossless',
    label: 'Без потерь',
    hint: 'FLAC',
    apply: { target: 'flac' }
  }
]

const HEIGHTS: { label: string; value?: number }[] = [
  { label: 'Как в оригинале' },
  { label: '1080p', value: 1080 },
  { label: '720p', value: 720 },
  { label: '480p', value: 480 },
  { label: '360p', value: 360 }
]

const QUALITIES: { id: MediaOptions['quality']; label: string; hint: string }[] = [
  { id: 'high', label: 'Высокое', hint: 'Почти без потерь, файл побольше' },
  { id: 'medium', label: 'Среднее', hint: 'Хороший баланс' },
  { id: 'low', label: 'Малый размер', hint: 'Заметное сжатие, файл поменьше' }
]

export default function MediaView({ active }: { active: boolean }): React.JSX.Element {
  const job = useFileJobs(active, {
    inspect: (paths) => window.api.inspectMedia(paths),
    pick: () => window.api.pickMedia()
  })
  const { files, progress, running, stats, allDone } = job

  const [st, setSt] = useState<State>({
    target: 'mp4',
    quality: 'medium',
    maxHeight: undefined,
    audioBitrate: 192,
    limitOn: false,
    targetMB: 10,
    mute: false
  })
  const [stripMeta, setStripMeta] = useState(true)
  const [useGpu, setUseGpu] = useState(true)
  const [outputDir, setOutputDir] = useState<string | undefined>(undefined)
  const [caps, setCaps] = useState<MediaCapabilities | null>(null)
  const [activePreset, setActivePreset] = useState<string | null>(null)

  useEffect(() => {
    void window.api.mediaCapabilities().then(setCaps)
  }, [])

  const update = (patch: Partial<State>): void => {
    setSt((s) => ({ ...s, ...patch }))
    setActivePreset(null)
  }

  const applyPreset = (p: Preset): void => {
    setSt((s) => ({ ...s, ...p.apply }))
    setActivePreset(p.id)
  }

  // Новые настройки: прежние результаты уже не актуальны.
  useEffect(() => {
    job.resetResults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st, stripMeta, useGpu, outputDir])

  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.pickFolder()
    if (dir) setOutputDir(dir)
  }

  const isAudioTarget = AUDIO_TARGETS.some((a) => a.id === st.target)
  const audioInfo = AUDIO_TARGETS.find((a) => a.id === st.target)
  const lossy = !isAudioTarget || !!audioInfo?.lossy
  const incompatible = isAudioTarget
    ? files.filter((f) => f.kind === 'video' && f.hasAudio === false).length
    : files.filter((f) => f.kind === 'audio').length
  const gpuUsable = !!caps?.gpu && st.target !== 'webm' && !isAudioTarget

  const start = (): Promise<void> =>
    job.run(async (todo) => {
      const options: MediaOptions = {
        target: st.target,
        quality: st.quality,
        maxHeight: st.maxHeight,
        audioBitrate: st.audioBitrate,
        mute: st.mute,
        stripMetadata: stripMeta,
        useGpu: useGpu && gpuUsable,
        targetMB: !isAudioTarget && st.limitOn ? st.targetMB : undefined,
        outputDir
      }
      await window.api.convertMedia(todo, options)
    })

  return (
    <div className="converter">
      {active && job.dragging && <DropOverlay />}

      {files.length === 0 ? (
        <div className="empty-state">
          <div className="hero-emoji">🎬</div>
          <h1>Видео и звук в любой формат</h1>
          <p>Перетащите ролики, песни или целую папку. Можно вытащить звук из видео или ужать файл под лимит</p>
          <button className="btn primary big" onClick={job.pick}>
            Выбрать файлы
          </button>
          <span className="hint">MP4 · MOV · MKV · WebM · AVI · MP3 · WAV · FLAC · OGG · M4A и другие</span>
          {caps?.gpu && (
            <span className="pill">Ускорение на видеокарте: {caps.gpuLabel}</span>
          )}
        </div>
      ) : (
        <>
          <header className="list-head">
            <div>
              <h2>Ваши файлы</h2>
              <span className="muted">{files.length} шт.</span>
            </div>
            <div className="row">
              <button className="btn ghost" onClick={job.pick} disabled={running}>
                + Добавить
              </button>
              <button className="btn ghost" onClick={job.clear} disabled={running}>
                Очистить
              </button>
            </div>
          </header>

          <FileList files={files} progress={progress} running={running} onRemove={job.remove} />

          <section className="settings scroll">
            <div className="setting">
              <label>Быстрый выбор</label>
              <div className="chips">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className={`chip small ${activePreset === p.id ? 'active' : ''}`}
                    onClick={() => applyPreset(p)}
                    title={p.hint}
                    disabled={running}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="steps">
              <div className="step">
                <strong>Видео</strong>
                <div className="chips">
                  {VIDEO_TARGETS.map((t) => (
                    <button
                      key={t.id}
                      className={`chip small ${st.target === t.id ? 'active' : ''}`}
                      onClick={() => update({ target: t.id })}
                      title={t.hint}
                      disabled={running}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <strong>Только звук</strong>
                <div className="chips">
                  {AUDIO_TARGETS.map((t) => (
                    <button
                      key={t.id}
                      className={`chip small ${st.target === t.id ? 'active' : ''}`}
                      onClick={() => update({ target: t.id })}
                      title={t.hint}
                      disabled={running}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {!isAudioTarget && (
                <div className="step">
                  <strong>Качество и размер</strong>
                  <div className="chips">
                    {QUALITIES.map((q) => (
                      <button
                        key={q.id}
                        className={`chip small ${st.quality === q.id ? 'active' : ''}`}
                        onClick={() => update({ quality: q.id })}
                        title={q.hint}
                        disabled={running || st.limitOn}
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                  <select
                    value={st.maxHeight ?? ''}
                    disabled={running}
                    onChange={(e) => update({ maxHeight: e.target.value ? Number(e.target.value) : undefined })}
                  >
                    {HEIGHTS.map((h) => (
                      <option key={h.label} value={h.value ?? ''}>
                        {h.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {!isAudioTarget && (
                <div className="step">
                  <strong>Лимит размера</strong>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={st.limitOn}
                      disabled={running}
                      onChange={(e) => update({ limitOn: e.target.checked })}
                    />
                    <span>Уложиться в размер файла</span>
                  </label>
                  {st.limitOn && (
                    <label className="inline-number">
                      не больше
                      <input
                        type="number"
                        min={0.5}
                        max={2000}
                        step={0.5}
                        value={st.targetMB}
                        disabled={running}
                        onChange={(e) => update({ targetMB: Math.max(0.5, Number(e.target.value)) })}
                      />
                      МБ
                    </label>
                  )}
                  <span className="muted small">
                    Качество и разрешение подберём сами (Discord, почта, мессенджеры)
                  </span>
                </div>
              )}

              {lossy && (
                <div className="step">
                  <strong>Звук</strong>
                  <select
                    value={st.audioBitrate}
                    disabled={running || (!isAudioTarget && st.mute)}
                    onChange={(e) => update({ audioBitrate: Number(e.target.value) })}
                  >
                    {[320, 256, 192, 128, 96, 64].map((b) => (
                      <option key={b} value={b}>
                        {b} кбит/с
                      </option>
                    ))}
                  </select>
                  {!isAudioTarget && (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={st.mute}
                        disabled={running}
                        onChange={(e) => update({ mute: e.target.checked })}
                      />
                      <span>Убрать звук</span>
                    </label>
                  )}
                </div>
              )}

              <div className="step">
                <strong>Скорость и файл</strong>
                {!isAudioTarget && (
                  <label className="check" title={caps?.gpu ? undefined : 'Видеокарта с поддержкой H.264 не найдена'}>
                    <input
                      type="checkbox"
                      checked={useGpu && gpuUsable}
                      disabled={running || !gpuUsable}
                      onChange={(e) => setUseGpu(e.target.checked)}
                    />
                    <span>
                      {caps?.gpu
                        ? st.target === 'webm'
                          ? 'Видеокарта (для WebM не используется)'
                          : `Видеокарта: ${caps.gpuLabel}`
                        : caps
                          ? 'Видеокарта не найдена, работает процессор'
                          : 'Проверяю видеокарту…'}
                    </span>
                  </label>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={stripMeta}
                    disabled={running}
                    onChange={(e) => setStripMeta(e.target.checked)}
                  />
                  <span>Удалить скрытые данные (место съёмки, теги)</span>
                </label>
                <div className="row tight">
                  <button className="btn soft" onClick={pickFolder} disabled={running}>
                    {outputDir ? 'Другая папка…' : 'Рядом с оригиналом'}
                  </button>
                  {outputDir && (
                    <button className="icon-btn" title="Сбросить" onClick={() => setOutputDir(undefined)}>
                      <svg viewBox="0 0 24 24" aria-hidden>
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>

            <footer className="action-bar">
              <div className="muted">
                {allDone ? (
                  <>
                    🎉 Готово! Файлов: <b>{stats.done}</b>
                    {stats.before > stats.after && <> · сэкономлено {formatBytes(stats.before - stats.after)}</>}
                  </>
                ) : incompatible > 0 ? (
                  <span className="warn">
                    {isAudioTarget
                      ? `Файлов без звука: ${incompatible}, они будут пропущены`
                      : `Звуковых файлов: ${incompatible}, из них видео не получится`}
                  </span>
                ) : (
                  <>Оригиналы не изменяются, рядом появятся новые файлы</>
                )}
              </div>
              {running ? (
                <button className="btn danger" onClick={() => window.api.cancel()}>
                  Остановить
                </button>
              ) : (
                <button className="btn primary" onClick={start} disabled={allDone}>
                  {allDone ? 'Готово' : `Конвертировать${files.length > 1 ? ` (${files.length})` : ''}`}
                </button>
              )}
            </footer>
          </section>
        </>
      )}
    </div>
  )
}
