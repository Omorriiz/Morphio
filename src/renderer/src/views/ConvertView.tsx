import { useEffect, useMemo, useRef, useState } from 'react'
import { AUDIO_TARGETS, IMAGE_FORMATS } from '@shared/types'
import type {
  FileKind,
  MediaCapabilities,
  UniversalMedia,
  UniversalOptions,
  UniversalTarget
} from '@shared/types'
import { useFileJobs } from '../hooks/useFileJobs'
import FileList from '../components/FileList'
import CompareModal from '../components/CompareModal'
import SubtitleEditor from '../components/SubtitleEditor'
import ModuleDownload from '../components/ModuleDownload'
import { useModules } from '../hooks/useModules'
import DropOverlay from '../components/DropOverlay'
import { Field, Section, Segmented, Switch } from '../components/ui'
import { useI18n } from '../i18n'
import { formatBytes } from '../lib'
import { MEDIA_PRESETS } from '@shared/mediaPresets'
import { estimateSpeechSeconds, formatEstimate, mixRatio } from '@shared/speechEstimate'

const GROUPS: { id: UniversalTarget['group']; title: string }[] = [
  { id: 'image', title: 'Изображения' },
  { id: 'video', title: 'Видео' },
  { id: 'audio', title: 'Только звук' },
  { id: 'table', title: 'Таблицы и данные' },
  { id: 'pdf', title: 'PDF' },
  { id: 'document', title: 'Документы и книги' },
  { id: 'subtitle', title: 'Субтитры' },
  { id: 'ai', title: 'Нейросети' },
  { id: 'archive', title: 'Запаковать или распаковать' }
]

const SUPPORTED: { icon: string; label: string; hint: string }[] = [
  { icon: '🖼️', label: 'Картинки', hint: 'PNG · JPG · WebP · AVIF · HEIC · TIFF · GIF' },
  { icon: '🎬', label: 'Видео', hint: 'MP4 · MOV · MKV · WebM · AVI' },
  { icon: '🎵', label: 'Звук', hint: 'MP3 · WAV · FLAC · OGG · M4A' },
  { icon: '📊', label: 'Таблицы', hint: 'CSV · XLSX · JSON · XML · YAML' },
  { icon: '📚', label: 'Документы', hint: 'DOCX · ODT · RTF · HTML · Markdown · TXT · EPUB · FB2 · PDF' },
  { icon: '📄', label: 'PDF', hint: 'PDF в текст и картинки · склейка · разделение · картинки в PDF' },
  { icon: '💬', label: 'Субтитры', hint: 'SRT · VTT · ASS · TXT · сдвиг времени · дорожка из видео' },
  { icon: '📦', label: 'Архивы', hint: 'ZIP · 7z · TAR' }
]

const SPEED_KEY = 'morphio.speechRatio.'
function readRatio(model: string): number | undefined {
  try {
    const n = Number(localStorage.getItem(SPEED_KEY + model))
    return n > 0 ? n : undefined
  } catch {
    return undefined
  }
}
function saveRatio(model: string, measured: number): void {
  try {
    localStorage.setItem(SPEED_KEY + model, String(mixRatio(readRatio(model), measured)))
  } catch {
    /* память браузера недоступна: прикидка останется средней */
  }
}

const SPEECH_LANGS: { id: string; native: string }[] = [
  { id: 'auto', native: 'Определить сам' },
  { id: 'ru', native: 'Русский' },
  { id: 'en', native: 'English' },
  { id: 'uk', native: 'Українська' },
  { id: 'de', native: 'Deutsch' },
  { id: 'fr', native: 'Français' },
  { id: 'es', native: 'Español' },
  { id: 'it', native: 'Italiano' },
  { id: 'pt', native: 'Português' },
  { id: 'pl', native: 'Polski' },
  { id: 'tr', native: 'Türkçe' },
  { id: 'zh', native: '中文' },
  { id: 'ja', native: '日本語' }
]

const IMAGE_SIZES: { label: string; value?: number }[] = [
  { label: 'Как в оригинале' },
  { label: '3840 px (4K)', value: 3840 },
  { label: '1920 px (Full HD)', value: 1920 },
  { label: '1600 px', value: 1600 },
  { label: '1280 px', value: 1280 },
  { label: '800 px', value: 800 }
]

const VIDEO_HEIGHTS: { label: string; value?: number }[] = [
  { label: 'Как в оригинале' },
  { label: '1080p', value: 1080 },
  { label: '720p', value: 720 },
  { label: '480p', value: 480 },
  { label: '360p', value: 360 }
]

const LEVELS: { id: UniversalOptions['archiveLevel']; label: string }[] = [
  { id: 'fast', label: 'Быстро' },
  { id: 'normal', label: 'Обычно' },
  { id: 'max', label: 'Сильнее' }
]

const DEFAULT_MEDIA: UniversalMedia = {
  quality: 'medium',
  maxHeight: undefined,
  audioBitrate: 192,
  mute: false,
  stripMetadata: true,
  useGpu: true,
  targetMB: undefined
}

/** Конвертер для всего: картинки, видео, звук, таблицы, архивы. Настройки показываются только те, что нужны выбранному результату. */
export default function ConvertView({
  active,
  incoming
}: {
  active: boolean
  incoming?: { paths: string[]; n: number } | null
}): React.JSX.Element {
  const { t } = useI18n()
  const mods = useModules()
  const job = useFileJobs(active, {
    inspect: (paths) => window.api.inspectAny(paths),
    pick: () => window.api.pickAny()
  })
  const { files, progress, running, stats, allDone } = job

  const settingsRef = useRef<HTMLElement>(null)
  const [targets, setTargets] = useState<UniversalTarget[]>([])
  const [target, setTarget] = useState('')
  const [preset, setPreset] = useState<string | null>(null)
  const [caps, setCaps] = useState<MediaCapabilities | null>(null)

  const [quality, setQuality] = useState(85)
  const [maxSize, setMaxSize] = useState<number | undefined>(undefined)
  const [strip, setStrip] = useState(true)
  const [media, setMedia] = useState<UniversalMedia>(DEFAULT_MEDIA)
  const [limitOn, setLimitOn] = useState(false)
  const [limitMB, setLimitMB] = useState(10)
  const [useGpu, setUseGpu] = useState(true)
  const [level, setLevel] = useState<UniversalOptions['archiveLevel']>('normal')
  const [password, setPassword] = useState('')
  const [delimiter, setDelimiter] = useState<UniversalOptions['csvDelimiter']>(',')
  const [bom, setBom] = useState(true)
  const [outputDir, setOutputDir] = useState<string | undefined>(undefined)
  const [ocrLang, setOcrLang] = useState('rus+eng')
  const [speechModel, setSpeechModel] = useState('base')
  const [speechLang, setSpeechLang] = useState('auto')
  const [subShift, setSubShift] = useState(0)
  const [subTrack, setSubTrack] = useState(0)
  const [comparing, setComparing] = useState<{ name: string; input: string; output: string } | null>(null)
  const [editingSubs, setEditingSubs] = useState<{ name: string; path: string } | null>(null)

  useEffect(() => {
    void window.api.mediaCapabilities().then(setCaps)
  }, [])

  // Файлы пришли снаружи (быстрое окно, меню Проводника, трей).
  useEffect(() => {
    if (incoming) void job.addPaths(incoming.paths)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming])

  // Варианты зависят от выбранных файлов: показываем только то, что подходит всем.
  useEffect(() => {
    let cancelled = false
    if (files.length === 0) {
      setTargets([])
      setTarget('')
      return
    }
    void window.api.universalTargets(files).then((list) => {
      if (cancelled) return
      setTargets(list)
      setTarget((cur) => (list.some((x) => x.id === cur) ? cur : ''))
    })
    return () => {
      cancelled = true
    }
  }, [files, mods.version])

  // Новые настройки: прежние результаты уже не актуальны.
  useEffect(() => {
    job.resetResults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, quality, maxSize, strip, media, limitOn, limitMB, useGpu, level, password, delimiter, bom, outputDir, ocrLang, speechModel, speechLang, subShift, subTrack])

  // Выбрали результат: прокручиваем к настройкам, чтобы они были на виду.
  useEffect(() => {
    if (target) settingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [target])

  const [engine, format] = target.split(':')
  const chosen = targets.find((x) => x.id === target)
  const needsCalibre = chosen?.needs === 'calibre' && !!chosen.missing
  // Какие модули нужны выбранному результату и каких ещё нет (скачиваются по кнопке)
  const required: string[] = !target
    ? []
    : engine === 'doc'
      ? chosen?.needs === 'pandoc'
        ? ['pandoc']
        : []
      : engine === 'upscale'
        ? ['upscale']
        : engine === 'ocr'
          ? ocrLang.split('+').map((l) => `tess-${l}`)
          : engine === 'speech'
            ? ['whisper', `whisper-${speechModel}`]
            : []
  const missingMods = required.map((id) => mods.modules.find((m) => m.id === id)).filter((m) => m && !m.installed) as typeof mods.modules
  const imageFormat = engine === 'image' ? IMAGE_FORMATS.find((f) => f.id === format) : undefined
  const audioFormat = engine === 'audio' ? AUDIO_TARGETS.find((a) => a.id === format) : undefined
  const isPack = engine === 'archive' && format !== 'unpack'
  const hasPassword = engine === 'archive' && (format === 'unpack' || format === 'zip' || format === '7z')
  const pdfInput = engine === 'pdf' && files.some((f) => f.kind === 'pdf')
  const repacking = isPack && files.some((f) => f.kind === 'archive')
  const gpuUsable = !!caps?.gpu && engine === 'video' && format !== 'webm'
  const hasVideoOrAudio = files.some((f) => f.kind === 'video' || f.kind === 'audio')
  const noAudioCount = engine === 'audio' ? files.filter((f) => f.kind === 'video' && f.hasAudio === false).length : 0

  const presets = useMemo(
    () =>
      MEDIA_PRESETS.filter((p) =>
        targets.some((x) => x.id === `${AUDIO_TARGETS.some((a) => a.id === p.format) ? 'audio' : 'video'}:${p.format}`)
      ),
    [targets]
  )

  const updateMedia = (patch: Partial<UniversalMedia>): void => {
    setMedia((m) => ({ ...m, ...patch }))
    setPreset(null)
  }

  const applyPreset = (id: string): void => {
    const p = MEDIA_PRESETS.find((x) => x.id === id)
    if (!p) return
    const kind = AUDIO_TARGETS.some((a) => a.id === p.format) ? 'audio' : 'video'
    setTarget(`${kind}:${p.format}`)
    setMedia((m) => ({ ...m, ...p.media }))
    if ('targetMB' in p.media) {
      setLimitOn(p.media.targetMB !== undefined)
      if (p.media.targetMB !== undefined) setLimitMB(p.media.targetMB)
    }
    setPreset(id)
  }

  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.pickFolder()
    if (dir) setOutputDir(dir)
  }

  // Скорость распознавания на этом компьютере: считаем по готовым файлам, потом прикидка точнее
  const speechMark = useRef<{ t: number; seen: Set<string> }>({ t: 0, seen: new Set() })
  useEffect(() => {
    if (engine !== 'speech') return
    for (const f of files) {
      if (progress[f.id]?.status !== 'done' || speechMark.current.seen.has(f.id)) continue
      speechMark.current.seen.add(f.id)
      const now = Date.now()
      if (speechMark.current.t && (f.duration ?? 0) >= 8) saveRatio(speechModel, (now - speechMark.current.t) / 1000 / (f.duration as number))
      speechMark.current.t = now
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress])
  const speechSeconds =
    engine === 'speech'
      ? files.reduce((s, f) => s + estimateSpeechSeconds(f.duration ?? 0, speechModel, readRatio(speechModel)), 0)
      : 0

  const start = (): Promise<void> => {
    speechMark.current = { t: Date.now(), seen: new Set() }
    return startJob()
  }
  const startJob = (): Promise<void> =>
    job.run(async (todo) => {
      await window.api.universalConvert(todo, {
        target,
        quality,
        outputDir,
        archiveLevel: level,
        password: password || undefined,
        csvDelimiter: delimiter,
        csvBom: bom,
        maxSize,
        lang: engine === 'ocr' ? ocrLang : engine === 'speech' ? speechLang : undefined,
        aiModel: engine === 'speech' ? speechModel : undefined,
        shift: engine === 'subs' ? subShift : undefined,
        subTrack: engine === 'subs' ? subTrack : undefined,
        keepMetadata: !strip,
        media: {
          ...media,
          stripMetadata: strip,
          useGpu: useGpu && gpuUsable,
          targetMB: engine === 'video' && limitOn ? limitMB : undefined
        }
      })
    })

  const groupTargets = (g: UniversalTarget['group']): UniversalTarget[] => targets.filter((x) => x.group === g)

  return (
    <div className="converter">
      {active && job.dragging && <DropOverlay />}

      {files.length === 0 ? (
        <div className="empty-state hero">
          <div className="hero-emoji">🪄</div>
          <h1>{t('Любой файл во что угодно')}</h1>
          <p>{t('Перетащите файлы или папки: приложение само предложит, во что их можно превратить')}</p>
          <div className="row">
            <button className="btn primary big" onClick={job.pick}>
              {t('Выбрать файлы')}
            </button>
            <button className="btn soft big" onClick={async () => job.addPaths(await window.api.pickAnyFolder())}>
              {t('Выбрать папку')}
            </button>
          </div>
          <ul className="kind-pills">
            {SUPPORTED.map((k) => (
              <li key={k.label} title={k.hint}>
                <span aria-hidden>{k.icon}</span> {t(k.label)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <header className="list-head">
            <div>
              <h2>{t('Ваши файлы')}</h2>
              <span className="muted">{t('{n} шт.', { n: files.length })}</span>
            </div>
            <div className="row">
              <button className="btn ghost" onClick={job.pick} disabled={running}>
                {t('+ Добавить')}
              </button>
              <button
                className="btn ghost"
                onClick={async () => job.addPaths(await window.api.pickAnyFolder())}
                disabled={running}
              >
                {t('+ Папка')}
              </button>
              <button className="btn ghost" onClick={job.clear} disabled={running}>
                {t('Очистить')}
              </button>
            </div>
          </header>

          <div className="cv-scroll">
            <FileList
              files={files}
              progress={progress}
              running={running}
              onRemove={job.remove}
              compact
              onCompare={(f, p) => setComparing({ name: f.name, input: f.path, output: p.outputPath! })}
              onEditSubs={(f, p) => setEditingSubs({ name: f.name, path: p.outputPath! })}
            />

            <Section title={t('Во что превратить')}>
              {targets.length === 0 ? (
                <p className="notice">
                  {t('У выбранных файлов нет общих действий. Уберите часть файлов или выберите однотипные.')}
                </p>
              ) : (
                <>
                  {hasVideoOrAudio && presets.length > 0 && (
                    <div className="preset-row">
                      <span className="field-label">{t('Быстрый выбор')}</span>
                      <div className="chips">
                        {presets.map((p) => (
                          <button
                            key={p.id}
                            className={`chip small ${preset === p.id ? 'active' : ''}`}
                            title={t(p.hint)}
                            disabled={running}
                            onClick={() => applyPreset(p.id)}
                          >
                            {t(p.label)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {GROUPS.filter((g) => groupTargets(g.id).length > 0).map((g) => {
                    const grid = (
                      <div className="format-grid">
                        {groupTargets(g.id).map((x) => (
                          <button
                            key={x.id}
                            className={`format-card ${target === x.id ? 'active' : ''}`}
                            disabled={running}
                            onClick={() => {
                              setTarget(x.id)
                              setPreset(null)
                            }}
                          >
                            <b>{x.label}</b>
                            <span>{x.hint}</span>
                          </button>
                        ))}
                      </div>
                    )
                    // Архивы нужны реже остального: когда есть другие варианты, прячем их под заголовком.
                    const collapsible = g.id === 'archive' && groupTargets('archive').length < targets.length
                    return collapsible ? (
                      <details key={g.id} className="more target-more" open={engine === 'archive'}>
                        <summary>{t(g.title)}</summary>
                        {grid}
                      </details>
                    ) : (
                      <div key={g.id} className="target-group">
                        <span className="field-label">{t(g.title)}</span>
                        {grid}
                      </div>
                    )
                  })}
                </>
              )}
            </Section>

            {missingMods.length > 0 && (
              <Section title={t('Нужны дополнительные модули')}>
                <p className="notice warn">
                  {t('Они скачиваются один раз по вашей кнопке, после этого всё работает без интернета.')}
                </p>
                {missingMods.map((m) => (
                  <div key={m.id} className="module-need">
                    <div>
                      <strong>{t(m.name)}</strong>
                      <div className="muted small">
                        {t('Лицензия {license}, источник {source}, {size} МБ', { license: m.license, source: m.source, size: m.sizeMB })}
                      </div>
                    </div>
                    <ModuleDownload info={m} progress={mods.progress[m.id]} onInstall={() => void mods.install(m.id)} />
                  </div>
                ))}
              </Section>
            )}
            {needsCalibre && (
              <p className="notice warn">
                {t('MOBI и AZW3 создаёт и читает только бесплатная программа Calibre. Установите её с calibre-ebook.com, и эти варианты заработают.')}
              </p>
            )}

            {target && (
              <Section title={t('Настройки')} ref={settingsRef}>
                <div className="options">
                  {imageFormat?.hasQuality && (
                    <Field label={t('Качество')} hint={`${quality}%`}>
                      <input
                        type="range"
                        min={10}
                        max={100}
                        value={quality}
                        disabled={running}
                        onChange={(e) => setQuality(Number(e.target.value))}
                      />
                    </Field>
                  )}
                  {target === 'pdf:jpg' && (
                    <Field label={t('Качество')} hint={`${quality}%`}>
                      <input type="range" min={10} max={100} value={quality} disabled={running} onChange={(e) => setQuality(Number(e.target.value))} />
                    </Field>
                  )}
                  {engine === 'image' && (
                    <Field label={t('Размер')}>
                      <select
                        value={maxSize ?? ''}
                        disabled={running}
                        onChange={(e) => setMaxSize(e.target.value ? Number(e.target.value) : undefined)}
                      >
                        {IMAGE_SIZES.map((o) => (
                          <option key={o.label} value={o.value ?? ''}>
                            {t(o.label)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}

                  {engine === 'video' && (
                    <>
                      <Field label={t('Качество')}>
                        <Segmented
                          value={media.quality}
                          disabled={running || limitOn}
                          onChange={(q) => updateMedia({ quality: q })}
                          options={[
                            { id: 'high', label: t('Высокое'), hint: t('Почти без потерь, файл побольше') },
                            { id: 'medium', label: t('Среднее'), hint: t('Хороший баланс') },
                            { id: 'low', label: t('Малый размер'), hint: t('Заметное сжатие, файл поменьше') }
                          ]}
                        />
                      </Field>
                      <Field label={t('Размер кадра')}>
                        <select
                          value={media.maxHeight ?? ''}
                          disabled={running}
                          onChange={(e) =>
                            updateMedia({ maxHeight: e.target.value ? Number(e.target.value) : undefined })
                          }
                        >
                          {VIDEO_HEIGHTS.map((h) => (
                            <option key={h.label} value={h.value ?? ''}>
                              {t(h.label)}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        label={t('Лимит размера')}
                        hint={limitOn ? t('Качество и разрешение подберём сами') : undefined}
                      >
                        <div className="row tight">
                          <Switch
                            checked={limitOn}
                            disabled={running}
                            label={t('Уложиться в размер файла')}
                            onChange={(v) => {
                              setLimitOn(v)
                              setPreset(null)
                            }}
                          />
                          {limitOn && (
                            <label className="inline-number">
                              <input
                                type="number"
                                min={0.5}
                                max={2000}
                                step={0.5}
                                value={limitMB}
                                disabled={running}
                                onChange={(e) => setLimitMB(Math.max(0.5, Number(e.target.value)))}
                              />
                              {t('МБ')}
                            </label>
                          )}
                        </div>
                      </Field>
                    </>
                  )}

                  {(engine === 'audio' || engine === 'video') &&
                    (engine === 'video' || audioFormat?.lossy) && (
                      <Field label={t('Звук')}>
                        <select
                          value={media.audioBitrate}
                          disabled={running || (engine === 'video' && media.mute)}
                          onChange={(e) => updateMedia({ audioBitrate: Number(e.target.value) })}
                        >
                          {[320, 256, 192, 128, 96, 64].map((b) => (
                            <option key={b} value={b}>
                              {t('{b} кбит/с', { b })}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}

                  {engine === 'subs' && (
                    <>
                      <Field label={t('Сдвиг, секунды')} hint={t('Минус — раньше, плюс — позже. Ноль — без сдвига')}>
                        <input
                          type="number"
                          className="text-input"
                          step={0.1}
                          value={subShift}
                          disabled={running}
                          onChange={(e) => setSubShift(Number(e.target.value) || 0)}
                        />
                      </Field>
                      {files.some((f) => (f.subtitleTracks ?? 0) > 1) && (
                        <Field label={t('Дорожка субтитров')}>
                          <select value={subTrack} disabled={running} onChange={(e) => setSubTrack(Number(e.target.value))}>
                            {Array.from({ length: Math.max(...files.map((f) => f.subtitleTracks ?? 0)) }, (_, k) => (
                              <option key={k} value={k}>
                                {t('Дорожка {n}', { n: k + 1 })}
                              </option>
                            ))}
                          </select>
                        </Field>
                      )}
                    </>
                  )}
                  {engine === 'ocr' && (
                    <Field label={t('Язык текста')} hint={t('Нужен модуль языка: он скачивается кнопкой выше')}>
                      <Segmented
                        value={ocrLang}
                        disabled={running}
                        onChange={setOcrLang}
                        options={[
                          { id: 'rus+eng', label: t('Русский и English') },
                          { id: 'rus', label: t('Русский') },
                          { id: 'eng', label: 'English' }
                        ]}
                      />
                    </Field>
                  )}
                  {engine === 'speech' && (
                    <>
                      <Field label={t('Модель')} hint={t('Чем точнее модель, тем дольше работа и больше файл модели')}>
                        <Segmented
                          value={speechModel}
                          disabled={running}
                          onChange={setSpeechModel}
                          options={[
                            { id: 'tiny', label: t('Быстрая'), hint: t('78 МБ, с ошибками в сложной речи') },
                            { id: 'base', label: t('Обычная'), hint: t('148 МБ, хороший баланс') },
                            { id: 'small', label: t('Точная'), hint: t('488 МБ, лучше для русского') }
                          ]}
                        />
                      </Field>
                      {speechSeconds > 0 && (
                        <Field label={t('Сколько займёт')} hint={readRatio(speechModel) ? t('По скорости вашего компьютера') : t('Грубая прикидка: после первого запуска станет точнее')}>
                          <span>
                            {(() => {
                              const e = formatEstimate(speechSeconds)
                              return e.unit === 's' ? t('около {n} с', { n: e.a }) : e.unit === 'm' ? t('около {n} мин', { n: e.a }) : t('около {h} ч {m} мин', { h: e.a, m: e.b ?? 0 })
                            })()}
                          </span>
                        </Field>
                      )}
                      <Field label={t('Язык речи')}>
                        <select value={speechLang} disabled={running} onChange={(e) => setSpeechLang(e.target.value)}>
                          {SPEECH_LANGS.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.id === 'auto' ? t('Определить сам') : l.native}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </>
                  )}
                  {target === 'table:csv' && (
                    <>
                      <Field label={t('Разделитель')}>
                        <Segmented
                          value={delimiter === ';' ? ';' : ','}
                          disabled={running}
                          onChange={(d) => setDelimiter(d)}
                          options={[
                            { id: ',', label: t('Запятая ,') },
                            { id: ';', label: t('Точка с запятой ;') }
                          ]}
                        />
                      </Field>
                      <Field label={t('Кодировка')}>
                        <Switch
                          checked={bom}
                          disabled={running}
                          label={t('Для Excel (UTF-8 с меткой)')}
                          hint={t('Так русские буквы правильно открываются в Excel. Для других программ можно выключить')}
                          onChange={setBom}
                        />
                      </Field>
                    </>
                  )}

                  {isPack && (format === 'zip' || format === '7z') && (
                    <Field label={t('Сжатие')}>
                      <Segmented
                        value={level}
                        disabled={running}
                        onChange={setLevel}
                        options={LEVELS.map((l) => ({ id: l.id, label: t(l.label) }))}
                      />
                    </Field>
                  )}
                  {pdfInput && (
                    <Field label={t('Пароль PDF (если он есть)')} grow>
                      <input
                        className="text-input"
                        type="password"
                        autoComplete="off"
                        value={password}
                        disabled={running}
                        placeholder={t('Без пароля')}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </Field>
                  )}
                  {hasPassword && (
                    <Field
                      label={format === 'unpack' || repacking ? t('Пароль архива (если он есть)') : t('Пароль (необязательно)')}
                      hint={
                        format === 'zip' && !repacking
                          ? t('В пароле ZIP только латинские буквы, цифры и знаки. Для русского пароля выберите 7z.')
                          : undefined
                      }
                      grow
                    >
                      <input
                        className="text-input"
                        type="password"
                        autoComplete="off"
                        value={password}
                        disabled={running}
                        placeholder={t('Без пароля')}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </Field>
                  )}
                </div>

                {(engine === 'image' || engine === 'video' || engine === 'audio') && (
                  <details className="more">
                    <summary>{t('Дополнительно')}</summary>
                    <div className="options">
                      <Field label={t('Конфиденциальность')}>
                        <Switch
                          checked={strip}
                          disabled={running}
                          label={t('Удалить скрытые данные (место съёмки, камера, теги)')}
                          onChange={setStrip}
                        />
                      </Field>
                      {engine === 'video' && (
                        <>
                          <Field label={t('Звуковая дорожка')}>
                            <Switch
                              checked={media.mute}
                              disabled={running}
                              label={t('Убрать звук')}
                              onChange={(v) => updateMedia({ mute: v })}
                            />
                          </Field>
                          <Field label={t('Скорость')}>
                            <Switch
                              checked={useGpu && gpuUsable}
                              disabled={running || !gpuUsable}
                              label={
                                caps?.gpu
                                  ? format === 'webm'
                                    ? t('Видеокарта (для WebM не используется)')
                                    : t('Видеокарта: {gpu}', { gpu: caps.gpuLabel ?? '' })
                                  : caps
                                    ? t('Видеокарта не найдена, работает процессор')
                                    : t('Проверяю видеокарту…')
                              }
                              hint={caps?.gpu ? undefined : t('Видеокарта с поддержкой H.264 не найдена')}
                              onChange={setUseGpu}
                            />
                          </Field>
                        </>
                      )}
                    </div>
                  </details>
                )}
                {noAudioCount > 0 && (
                  <p className="notice warn">
                    {t('Файлов без звука: {n}, они будут пропущены', { n: noAudioCount })}
                  </p>
                )}
              </Section>
            )}
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
              <span className="muted small">
                {allDone ? (
                  <>
                    🎉 {t('Готово! Файлов:')} <b>{stats.done}</b>
                    {stats.before > stats.after && stats.after > 0 && (
                      <> · {t('сэкономлено {size}', { size: formatBytes(stats.before - stats.after) })}</>
                    )}
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
            ) : (
              <button className="btn primary" onClick={start} disabled={allDone || !target || missingMods.length > 0 || needsCalibre}>
                {allDone
                  ? t('Готово')
                  : !target
                    ? t('Выберите, во что превратить')
                    : `${t('Конвертировать')}${files.length > 1 ? ` (${files.length})` : ''}`}
              </button>
            )}
          </footer>
        </>
      )}
      {editingSubs && <SubtitleEditor title={`${t('Субтитры')}: ${editingSubs.name}`} path={editingSubs.path} onClose={() => setEditingSubs(null)} />}
      {comparing && (
        <CompareModal
          title={`${t('До и после')}: ${comparing.name}`}
          inputPath={comparing.input}
          outputPath={comparing.output}
          onClose={() => setComparing(null)}
        />
      )}
    </div>
  )
}
