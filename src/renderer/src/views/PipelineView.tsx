import { useEffect, useState } from 'react'
import { AUDIO_TARGETS, IMAGE_FORMATS } from '@shared/types'
import type { BgMethod, FileKind } from '@shared/types'
import { AUDIO_TAG_KEYS, defaultAudioBranch, defaultChain, defaultVideoBranch, migratePresets } from '@shared/chains'
import type { AudioBranch, ChainPreset, ImageBranch, VideoBranch } from '@shared/chains'
import { BUILTIN_CHAINS as BUILTIN } from '@shared/chainPresets'
import { useFileJobs } from '../hooks/useFileJobs'
import FileList from '../components/FileList'
import DropOverlay from '../components/DropOverlay'
import { formatBytes } from '../lib'
import { useI18n } from '../i18n'
import { Field, Section, Segmented, Switch } from '../components/ui'

const STORE_KEY = 'morphio.chains'
const OLD_STORE_KEY = 'morphio.pipelines'

/** Свои цепочки лежат в хранилище окна; цепочки старого формата (только картинки) открываются как раньше. */
function loadUserPresets(): ChainPreset[] {
  try {
    const raw = localStorage.getItem(STORE_KEY) ?? localStorage.getItem(OLD_STORE_KEY)
    return raw ? migratePresets(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

function saveUserPresets(list: ChainPreset[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list))
  } catch {
    /* хранилище недоступно — цепочки просто не сохранятся */
  }
}

const SIZES: { label: string; value?: number }[] = [
  { label: 'Как в оригинале' },
  { label: '3840 px (4K)', value: 3840 },
  { label: '1920 px (Full HD)', value: 1920 },
  { label: '1600 px', value: 1600 },
  { label: '1280 px', value: 1280 },
  { label: '800 px', value: 800 },
  { label: '512 px', value: 512 }
]

const HEIGHTS: { label: string; value?: number }[] = [
  { label: 'Как в оригинале' },
  { label: '1080p', value: 1080 },
  { label: '720p', value: 720 },
  { label: '480p', value: 480 },
  { label: '360p', value: 360 }
]

const METHODS: { id: BgMethod; label: string }[] = [
  { id: 'auto', label: 'Авто' },
  { id: 'solid', label: 'Однотонный' },
  { id: 'ai', label: 'Нейросеть' }
]

const LUFS: { value: number; label: string }[] = [
  { value: -16, label: '−16 LUFS: просмотр и подкасты' },
  { value: -14, label: '−14 LUFS: YouTube и музыка' },
  { value: -23, label: '−23 LUFS: телевидение' }
]

const SWATCHES = ['#ffffff', '#000000', '#f4f1ea', '#22cc88', '#4f8cff']

const NAME_HELP = '{name} · {n} · {date} · {format}'
const TAG_LABELS = { artist: 'Исполнитель', album: 'Альбом', genre: 'Жанр', year: 'Год' } as const

export default function PipelineView({ active }: { active: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const job = useFileJobs(active, {
    inspect: (paths) => window.api.inspectAny(paths),
    pick: () => window.api.pickAny()
  })
  const { files, progress, running, stats, allDone } = job

  const [img, setImg] = useState<ImageBranch>(defaultChain().image)
  const [video, setVideo] = useState<VideoBranch>(defaultVideoBranch)
  const [audio, setAudio] = useState<AudioBranch>(defaultAudioBranch)
  const [outputDir, setOutputDir] = useState<string | undefined>(undefined)
  const [userPresets, setUserPresets] = useState<ChainPreset[]>(loadUserPresets)
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [presetName, setPresetName] = useState('')

  const updImg = (patch: Partial<ImageBranch>): void => {
    setImg((c) => ({ ...c, ...patch }))
    setActivePreset(null)
  }
  const updVideo = (patch: Partial<VideoBranch>): void => {
    setVideo((c) => ({ ...c, ...patch }))
    setActivePreset(null)
  }
  const updAudio = (patch: Partial<AudioBranch>): void => {
    setAudio((c) => ({ ...c, ...patch }))
    setActivePreset(null)
  }

  // Новые настройки — старые результаты уже не актуальны.
  useEffect(() => {
    job.resetResults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, video, audio, outputDir])

  const applyPreset = (p: ChainPreset): void => {
    setImg(p.config.image)
    setVideo(p.config.video)
    setAudio(p.config.audio)
    setActivePreset(p.id)
  }

  const savePreset = (): void => {
    const name = presetName.trim()
    if (!name) return
    const preset: ChainPreset = { id: `user-${Date.now()}`, name, config: { version: 2, image: img, video, audio } }
    const next = [...userPresets, preset]
    setUserPresets(next)
    saveUserPresets(next)
    setActivePreset(preset.id)
    setNaming(false)
    setPresetName('')
  }

  const deletePreset = (id: string): void => {
    const next = userPresets.filter((p) => p.id !== id)
    setUserPresets(next)
    saveUserPresets(next)
    if (activePreset === id) setActivePreset(null)
  }

  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.pickFolder()
    if (dir) setOutputDir(dir)
  }

  const start = (): Promise<void> =>
    job.run(async (todo) => {
      await window.api.runChain(todo, { version: 2, image: img, video, audio, outputDir })
    })

  const imgFormat = IMAGE_FORMATS.find((f) => f.id === img.format)!
  const audioFormat = AUDIO_TARGETS.find((a) => a.id === audio.format)!
  const kinds = new Set<FileKind>(files.map((f) => f.kind ?? 'other'))
  // Какие ветки показывать в подписи внизу: по файлам в списке, а без файлов — все включённые
  const shows = (k: FileKind): boolean => (files.length === 0 ? true : kinds.has(k))
  const steps = [
    shows('image') && img.enabled && [img.removeBg && t('убрать фон'), img.maxSize && `${img.maxSize} px`, imgFormat.label].filter(Boolean).join(' → '),
    shows('video') &&
      video.enabled &&
      [
        (video.trimStart > 0 || video.trimEnd > 0) && t('обрезать края'),
        video.subtitles !== 'off' && t('субтитры'),
        video.fit && video.fit.aspect,
        video.targetMB && t('до {mb} МБ', { mb: video.targetMB }),
        video.target.toUpperCase()
      ]
        .filter(Boolean)
        .join(' → '),
    shows('audio') &&
      audio.enabled &&
      [audio.trimSilence && t('без тишины'), audio.loudness.mode === 'loudnorm' && `${audio.loudness.target} LUFS`, audio.format.toUpperCase()]
        .filter(Boolean)
        .join(' → ')
  ].filter(Boolean) as string[]

  const resultPreview = img.enabled && img.removeBg && files.every((f) => f.kind === 'image')

  return (
    <div className="converter">
      {active && job.dragging && <DropOverlay />}

      <header className="list-head">
        <div>
          <h2>{t('Цепочки')}</h2>
          <span className="muted">{t('несколько действий за один проход')}</span>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={job.pick} disabled={running}>
            {t('+ Добавить файлы')}
          </button>
          {files.length > 0 && (
            <button className="btn ghost" onClick={job.clear} disabled={running}>
              {t('Очистить')}
            </button>
          )}
        </div>
      </header>

      <div className="cv-scroll">
        {files.length === 0 ? (
          <div className="drop-hint">
            <span className="hero-emoji">⛓️</span>
            <div>
              <strong>{t('Перетащите файлы сюда')}</strong>
              <span className="muted small">{t('Картинки, видео и звук пройдут через свои шаги выбранной цепочки')}</span>
            </div>
            <button className="btn primary" onClick={job.pick}>
              {t('Выбрать файлы')}
            </button>
          </div>
        ) : (
          <FileList files={files} progress={progress} running={running} onRemove={job.remove} previewResult={resultPreview} compact flow />
        )}

        <Section title={t('Готовые цепочки')}>
          <div className="chips">
            {[...BUILTIN, ...userPresets].map((p) => (
              <span key={p.id} className="preset">
                <button className={`chip ${activePreset === p.id ? 'active' : ''}`} onClick={() => applyPreset(p)} disabled={running}>
                  {t(p.name)}
                </button>
                {!p.builtin && (
                  <button className="preset-x" title={t('Удалить цепочку')} onClick={() => deletePreset(p.id)} disabled={running}>
                    ×
                  </button>
                )}
              </span>
            ))}
            {naming ? (
              <span className="preset-name">
                <input
                  autoFocus
                  value={presetName}
                  placeholder={t('Название цепочки')}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') savePreset()
                    if (e.key === 'Escape') setNaming(false)
                  }}
                />
                <button className="btn soft" onClick={savePreset} disabled={!presetName.trim()}>
                  {t('Сохранить')}
                </button>
              </span>
            ) : (
              <button className="chip dashed" onClick={() => setNaming(true)} disabled={running}>
                {t('+ Сохранить текущую')}
              </button>
            )}
          </div>
        </Section>

        <Section
          title={t('Картинки')}
          aside={<Switch checked={img.enabled} disabled={running} onChange={(v) => updImg({ enabled: v })} label={t('Обрабатывать')} />}
        >
          {img.enabled && (
            <ol className="pipe-steps">
              <li className="pipe-step">
                <span className="step-num">1</span>
                <div className="pipe-body">
                  <Switch checked={img.removeBg} disabled={running} onChange={(v) => updImg({ removeBg: v })} label={t('Убрать фон')} />
                  {img.removeBg && (
                    <div className="options">
                      <Field label={t('Что за фон на картинке')}>
                        <Segmented
                          value={img.bgMethod}
                          disabled={running}
                          onChange={(m) => updImg({ bgMethod: m })}
                          options={METHODS.map((m) => ({ id: m.id, label: t(m.label) }))}
                        />
                      </Field>
                      <Field label={t('Фон результата')}>
                        <Segmented
                          value={img.fill}
                          disabled={running}
                          onChange={(f) => updImg({ fill: f })}
                          options={[
                            { id: 'transparent', label: t('Прозрачный') },
                            { id: 'color', label: t('Цвет') }
                          ]}
                        />
                      </Field>
                      {img.fill === 'color' && (
                        <Field label={t('Цвет')}>
                          <div className="swatches">
                            {SWATCHES.map((c) => (
                              <button
                                key={c}
                                className={`swatch ${img.fillColor === c ? 'active' : ''}`}
                                style={{ background: c }}
                                onClick={() => updImg({ fillColor: c })}
                                disabled={running}
                                aria-label={c}
                              />
                            ))}
                            <label className="swatch custom" title={t('Свой цвет')}>
                              <input type="color" value={img.fillColor} disabled={running} onChange={(e) => updImg({ fillColor: e.target.value })} />
                            </label>
                          </div>
                        </Field>
                      )}
                    </div>
                  )}
                </div>
              </li>

              <li className="pipe-step">
                <span className="step-num">2</span>
                <div className="pipe-body">
                  <Field label={t('Размер')}>
                    <select
                      value={img.maxSize ?? ''}
                      disabled={running}
                      onChange={(e) => updImg({ maxSize: e.target.value ? Number(e.target.value) : undefined })}
                    >
                      {SIZES.map((o) => (
                        <option key={o.label} value={o.value ?? ''}>
                          {t(o.label)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              </li>

              <li className="pipe-step">
                <span className="step-num">3</span>
                <div className="pipe-body">
                  <div className="options">
                    <Field label={t('Формат')}>
                      <Segmented
                        value={img.format}
                        disabled={running}
                        onChange={(f) => updImg({ format: f })}
                        options={IMAGE_FORMATS.map((f) => ({ id: f.id, label: f.label, hint: t(f.hint) }))}
                      />
                    </Field>
                    {imgFormat.hasQuality && (
                      <Field label={t('Качество')} hint={`${img.quality}%`}>
                        <input type="range" min={10} max={100} value={img.quality} disabled={running} onChange={(e) => updImg({ quality: Number(e.target.value) })} />
                      </Field>
                    )}
                  </div>
                </div>
              </li>

              <li className="pipe-step">
                <span className="step-num">4</span>
                <div className="pipe-body">
                  <div className="options">
                    <Field label={t('Имя файла')} hint={NAME_HELP}>
                      <input
                        className="text-input"
                        value={img.nameTemplate}
                        disabled={running}
                        onChange={(e) => updImg({ nameTemplate: e.target.value })}
                        placeholder="{name}"
                        title={t('Доступно: {name} — имя файла, {n} — номер, {date} — дата, {format} — формат')}
                      />
                    </Field>
                    <Field label={t('Конфиденциальность')}>
                      <Switch checked={!img.keepMetadata} disabled={running} onChange={(v) => updImg({ keepMetadata: !v })} label={t('Удалить GPS и данные камеры')} />
                    </Field>
                  </div>
                </div>
              </li>
            </ol>
          )}
        </Section>

        <Section
          title={t('Видео')}
          aside={<Switch checked={video.enabled} disabled={running} onChange={(v) => updVideo({ enabled: v })} label={t('Обрабатывать')} />}
        >
          {video.enabled && (
            <div className="options">
              <Field label={t('Срезать с начала, с')}>
                <input type="number" className="text-input" min={0} step={0.5} value={video.trimStart} disabled={running} onChange={(e) => updVideo({ trimStart: Math.max(0, Number(e.target.value) || 0) })} />
              </Field>
              <Field label={t('Срезать с конца, с')}>
                <input type="number" className="text-input" min={0} step={0.5} value={video.trimEnd} disabled={running} onChange={(e) => updVideo({ trimEnd: Math.max(0, Number(e.target.value) || 0) })} />
              </Field>
              <Field label={t('Поворот')}>
                <Segmented
                  value={String(video.rotate)}
                  disabled={running}
                  onChange={(v) => updVideo({ rotate: Number(v) as VideoBranch['rotate'] })}
                  options={[
                    { id: '0', label: '0°' },
                    { id: '90', label: '90°' },
                    { id: '180', label: '180°' },
                    { id: '270', label: '270°' }
                  ]}
                />
              </Field>
              <Field label={t('Кадр')}>
                <Segmented
                  value={video.fit?.aspect ?? 'none'}
                  disabled={running}
                  onChange={(a) => updVideo({ fit: a === 'none' ? undefined : { aspect: a, mode: video.fit?.mode ?? 'crop' } })}
                  options={[
                    { id: 'none', label: t('Как есть') },
                    { id: '9:16', label: '9:16' },
                    { id: '1:1', label: '1:1' },
                    { id: '4:5', label: '4:5' },
                    { id: '16:9', label: '16:9' }
                  ]}
                />
              </Field>
              {video.fit && (
                <Field label={t('Если не совпадает')}>
                  <Segmented
                    value={video.fit.mode}
                    disabled={running}
                    onChange={(mode) => updVideo({ fit: { aspect: video.fit!.aspect, mode } })}
                    options={[
                      { id: 'crop', label: t('Обрезать лишнее') },
                      { id: 'pad', label: t('Добавить поля') }
                    ]}
                  />
                </Field>
              )}
              <Field label={t('Субтитры')} hint={t('Берутся из файла рядом с роликом: у «фильм.mp4» это «фильм.srt» или «фильм.ru.srt». Нет файла — ролик сохраняется без них')}>
                <Segmented
                  value={video.subtitles}
                  disabled={running}
                  onChange={(subtitles) => updVideo({ subtitles })}
                  options={[
                    { id: 'off', label: t('Не добавлять') },
                    { id: 'soft', label: t('Дорожкой'), hint: t('Включаются и выключаются в плеере') },
                    { id: 'burn', label: t('В картинку'), hint: t('Видны везде, их нельзя выключить') }
                  ]}
                />
              </Field>
              <Field label={t('Звук')}>
                <Switch checked={video.mute} disabled={running} onChange={(v) => updVideo({ mute: v })} label={t('Убрать звук')} />
              </Field>
              {!video.mute && (
                <Field label={t('Громкость')}>
                  <Segmented
                    value={video.loudness.mode === 'loudnorm' ? 'loudnorm' : 'off'}
                    disabled={running}
                    onChange={(mode) => updVideo({ loudness: { ...video.loudness, mode } })}
                    options={[
                      { id: 'off', label: t('Как есть') },
                      { id: 'loudnorm', label: t('По стандарту') }
                    ]}
                  />
                </Field>
              )}
              {!video.mute && video.loudness.mode === 'loudnorm' && (
                <Field label={t('Целевой уровень')}>
                  <select value={video.loudness.target} disabled={running} onChange={(e) => updVideo({ loudness: { ...video.loudness, target: Number(e.target.value) } })}>
                    {LUFS.map((x) => (
                      <option key={x.value} value={x.value}>
                        {t(x.label)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label={t('Формат')}>
                <Segmented
                  value={video.target}
                  disabled={running}
                  onChange={(target) => updVideo({ target })}
                  options={[
                    { id: 'mp4', label: 'MP4' },
                    { id: 'mkv', label: 'MKV' },
                    { id: 'webm', label: 'WebM' }
                  ]}
                />
              </Field>
              <Field label={t('Размер кадра')}>
                <select value={video.maxHeight ?? ''} disabled={running} onChange={(e) => updVideo({ maxHeight: e.target.value ? Number(e.target.value) : undefined })}>
                  {HEIGHTS.map((h) => (
                    <option key={h.label} value={h.value ?? ''}>
                      {t(h.label)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('Лимит размера')} hint={video.targetMB ? t('Качество и разрешение подберём сами') : undefined}>
                <div className="row tight">
                  <Switch
                    checked={!!video.targetMB}
                    disabled={running}
                    label={t('Уложиться в размер файла')}
                    onChange={(v) => updVideo({ targetMB: v ? 30 : undefined })}
                  />
                  {video.targetMB && (
                    <label className="inline-number">
                      <input type="number" min={0.5} max={2000} step={0.5} value={video.targetMB} disabled={running} onChange={(e) => updVideo({ targetMB: Math.max(0.5, Number(e.target.value)) })} />
                      {t('МБ')}
                    </label>
                  )}
                </div>
              </Field>
              {!video.targetMB && (
                <Field label={t('Качество')}>
                  <Segmented
                    value={video.quality}
                    disabled={running}
                    onChange={(quality) => updVideo({ quality })}
                    options={[
                      { id: 'high', label: t('Высокое') },
                      { id: 'medium', label: t('Среднее') },
                      { id: 'low', label: t('Малый размер') }
                    ]}
                  />
                </Field>
              )}
              <Field label={t('Имя файла')} hint={NAME_HELP}>
                <input className="text-input" value={video.nameTemplate} disabled={running} onChange={(e) => updVideo({ nameTemplate: e.target.value })} placeholder="{name}" />
              </Field>
            </div>
          )}
        </Section>

        <Section
          title={t('Звук')}
          aside={<Switch checked={audio.enabled} disabled={running} onChange={(v) => updAudio({ enabled: v })} label={t('Обрабатывать')} />}
        >
          {audio.enabled && (
            <div className="options">
              <Field label={t('Тишина')}>
                <Switch checked={audio.trimSilence} disabled={running} onChange={(v) => updAudio({ trimSilence: v })} label={t('Убрать тишину в начале и в конце')} />
              </Field>
              <Field label={t('Громкость')}>
                <Segmented
                  value={audio.loudness.mode}
                  disabled={running}
                  onChange={(mode) => updAudio({ loudness: { ...audio.loudness, mode } })}
                  options={[
                    { id: 'off', label: t('Как есть') },
                    { id: 'loudnorm', label: t('По стандарту') }
                  ]}
                />
              </Field>
              {audio.loudness.mode === 'loudnorm' && (
                <Field label={t('Целевой уровень')}>
                  <select value={audio.loudness.target} disabled={running} onChange={(e) => updAudio({ loudness: { ...audio.loudness, target: Number(e.target.value) } })}>
                    {LUFS.map((x) => (
                      <option key={x.value} value={x.value}>
                        {t(x.label)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label={t('Формат')}>
                <Segmented
                  value={audio.format}
                  disabled={running}
                  onChange={(format) => updAudio({ format })}
                  options={AUDIO_TARGETS.map((a) => ({ id: a.id, label: a.label, hint: t(a.hint) }))}
                />
              </Field>
              {audioFormat.lossy && (
                <Field label={t('Битрейт')}>
                  <select value={audio.bitrate} disabled={running} onChange={(e) => updAudio({ bitrate: Number(e.target.value) })}>
                    {[320, 256, 192, 128, 96, 64].map((b) => (
                      <option key={b} value={b}>
                        {t('{b} кбит/с', { b })}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label={t('Теги')}>
                <Switch checked={audio.keepTags} disabled={running} onChange={(v) => updAudio({ keepTags: v })} label={t('Оставить исполнителя, название и обложку')} />
              </Field>
              <Field label={t('Записать теги')} hint={t('Одинаково для всех файлов, например исполнитель и альбом. Пустое поле ничего не меняет')}>
                <div className="tag-grid">
                  {AUDIO_TAG_KEYS.map((k) => (
                    <input
                      key={k}
                      className="text-input"
                      value={audio.tags[k]}
                      disabled={running}
                      placeholder={t(TAG_LABELS[k])}
                      onChange={(e) => updAudio({ tags: { ...audio.tags, [k]: e.target.value } })}
                    />
                  ))}
                </div>
              </Field>
              <Field label={t('Имя файла')} hint={NAME_HELP}>
                <input className="text-input" value={audio.nameTemplate} disabled={running} onChange={(e) => updAudio({ nameTemplate: e.target.value })} placeholder="{name}" />
              </Field>
            </div>
          )}
        </Section>
      </div>

      <footer className="action-bar cv-footer">
        <div className="cv-dest">
          <button className="btn soft" onClick={pickFolder} disabled={running} title={outputDir}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
            {outputDir ? outputDir.split(/[\\/]/).filter(Boolean).pop() : t('Рядом с оригиналом')}
          </button>
          {outputDir && (
            <button className="icon-btn" title={t('Сбросить')} onClick={() => setOutputDir(undefined)}>
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
          <span className="muted small chain-summary">
            {allDone ? (
              <>
                🎉 {t('Готово! Обработано файлов:')} <b>{stats.done}</b>
                {stats.before > stats.after && stats.after > 0 && <> · {t('экономия {size}', { size: formatBytes(stats.before - stats.after) })}</>}
              </>
            ) : (
              <>
                {t('Цепочка:')} {steps.join(' · ') || t('нет включённых шагов')}
              </>
            )}
          </span>
        </div>
        {running ? (
          <button className="btn danger" onClick={() => window.api.cancel()}>
            {t('Остановить')}
          </button>
        ) : (
          <button className="btn primary" onClick={start} disabled={allDone || files.length === 0}>
            {allDone ? t('Готово') : `${t('Запустить')}${files.length > 1 ? ` (${files.length})` : ''}`}
          </button>
        )}
      </footer>
    </div>
  )
}
