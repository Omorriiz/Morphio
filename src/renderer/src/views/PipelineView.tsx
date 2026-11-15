import { useEffect, useState } from 'react'
import { IMAGE_FORMATS } from '@shared/types'
import type { BgMethod, PipelineConfig, PipelinePreset } from '@shared/types'
import { useFileJobs } from '../hooks/useFileJobs'
import FileList from '../components/FileList'
import DropOverlay from '../components/DropOverlay'
import { formatBytes } from '../lib'
import { useI18n } from '../i18n'
import { Field, Section, Segmented, Switch } from '../components/ui'

type Config = Omit<PipelineConfig, 'outputDir'>

const DEFAULT_CONFIG: Config = {
  removeBg: false,
  bgMethod: 'auto',
  bgTolerance: 0,
  bgEverywhere: true,
  bgTranslucent: true,
  fill: 'transparent',
  fillColor: '#ffffff',
  maxSize: undefined,
  format: 'webp',
  quality: 85,
  keepMetadata: false,
  nameTemplate: '{name}-morphio'
}

const BUILTIN: PipelinePreset[] = [
  {
    id: 'builtin-shop',
    name: 'Фото товара',
    builtin: true,
    config: {
      ...DEFAULT_CONFIG,
      removeBg: true,
      fill: 'color',
      fillColor: '#ffffff',
      maxSize: 1600,
      format: 'jpg',
      quality: 90,
      nameTemplate: '{name}-shop'
    }
  },
  {
    id: 'builtin-sticker',
    name: 'Стикер без фона',
    builtin: true,
    config: {
      ...DEFAULT_CONFIG,
      removeBg: true,
      maxSize: 512,
      format: 'png',
      nameTemplate: '{name}-sticker'
    }
  },
  {
    id: 'builtin-web',
    name: 'Для сайта',
    builtin: true,
    config: { ...DEFAULT_CONFIG, maxSize: 1600, format: 'webp', quality: 82, nameTemplate: '{name}' }
  },
  {
    id: 'builtin-messenger',
    name: 'Для мессенджера',
    builtin: true,
    config: {
      ...DEFAULT_CONFIG,
      maxSize: 1280,
      format: 'jpg',
      quality: 85,
      nameTemplate: '{name}-share'
    }
  },
  {
    id: 'builtin-archive',
    name: 'Архив без потерь',
    builtin: true,
    config: {
      ...DEFAULT_CONFIG,
      format: 'png',
      keepMetadata: true,
      nameTemplate: '{name}'
    }
  }
]

const STORE_KEY = 'morphio.pipelines'

function loadUserPresets(): PipelinePreset[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const parsed = raw ? (JSON.parse(raw) as PipelinePreset[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveUserPresets(list: PipelinePreset[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list))
  } catch {
    /* хранилище недоступно — пресеты просто не сохранятся */
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

const METHODS: { id: BgMethod; label: string }[] = [
  { id: 'auto', label: 'Авто' },
  { id: 'solid', label: 'Однотонный' },
  { id: 'ai', label: 'Нейросеть' }
]

const SWATCHES = ['#ffffff', '#000000', '#f4f1ea', '#22cc88', '#4f8cff']

export default function PipelineView({ active }: { active: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const job = useFileJobs(active)
  const { files, progress, running, stats, allDone } = job

  const [cfg, setCfg] = useState<Config>(DEFAULT_CONFIG)
  const [outputDir, setOutputDir] = useState<string | undefined>(undefined)
  const [userPresets, setUserPresets] = useState<PipelinePreset[]>(loadUserPresets)
  const [activePreset, setActivePreset] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [presetName, setPresetName] = useState('')

  const update = (patch: Partial<Config>): void => {
    setCfg((c) => ({ ...c, ...patch }))
    setActivePreset(null)
  }

  // Новые настройки — старые результаты уже не актуальны.
  useEffect(() => {
    job.resetResults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, outputDir])

  const applyPreset = (p: PipelinePreset): void => {
    setCfg({ ...DEFAULT_CONFIG, ...p.config })
    setActivePreset(p.id)
  }

  const savePreset = (): void => {
    const name = presetName.trim()
    if (!name) return
    const preset: PipelinePreset = { id: `user-${Date.now()}`, name, config: cfg }
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
      await window.api.runPipeline(todo, { ...cfg, outputDir })
    })

  const formatInfo = IMAGE_FORMATS.find((f) => f.id === cfg.format)!
  const steps = [
    cfg.removeBg && t('убрать фон'),
    cfg.maxSize && `${cfg.maxSize} px`,
    formatInfo.label
  ].filter(Boolean)

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
              <strong>{t('Перетащите изображения сюда')}</strong>
              <span className="muted small">{t('Все они пройдут через выбранную цепочку действий')}</span>
            </div>
            <button className="btn primary" onClick={job.pick}>
              {t('Выбрать файлы')}
            </button>
          </div>
        ) : (
          <FileList
            files={files}
            progress={progress}
            running={running}
            onRemove={job.remove}
            previewResult={cfg.removeBg}
            compact
            flow
          />
        )}

        <Section title={t('Готовые цепочки')}>
          <div className="chips">
            {[...BUILTIN, ...userPresets].map((p) => (
              <span key={p.id} className="preset">
                <button
                  className={`chip ${activePreset === p.id ? 'active' : ''}`}
                  onClick={() => applyPreset(p)}
                  disabled={running}
                >
                  {t(p.name)}
                </button>
                {!p.builtin && (
                  <button
                    className="preset-x"
                    title={t('Удалить цепочку')}
                    onClick={() => deletePreset(p.id)}
                    disabled={running}
                  >
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

        <Section title={t('Что сделать с каждым файлом')}>
          <ol className="pipe-steps">
            <li className="pipe-step">
              <span className="step-num">1</span>
              <div className="pipe-body">
                <Switch
                  checked={cfg.removeBg}
                  disabled={running}
                  onChange={(v) => update({ removeBg: v })}
                  label={t('Убрать фон')}
                />
                {cfg.removeBg && (
                  <div className="options">
                    <Field label={t('Что за фон на картинке')}>
                      <Segmented
                        value={cfg.bgMethod}
                        disabled={running}
                        onChange={(m) => update({ bgMethod: m })}
                        options={METHODS.map((m) => ({ id: m.id, label: t(m.label) }))}
                      />
                    </Field>
                    <Field label={t('Фон результата')}>
                      <Segmented
                        value={cfg.fill}
                        disabled={running}
                        onChange={(f) => update({ fill: f })}
                        options={[
                          { id: 'transparent', label: t('Прозрачный') },
                          { id: 'color', label: t('Цвет') }
                        ]}
                      />
                    </Field>
                    {cfg.fill === 'color' && (
                      <Field label={t('Цвет')}>
                        <div className="swatches">
                          {SWATCHES.map((c) => (
                            <button
                              key={c}
                              className={`swatch ${cfg.fillColor === c ? 'active' : ''}`}
                              style={{ background: c }}
                              onClick={() => update({ fillColor: c })}
                              disabled={running}
                              aria-label={c}
                            />
                          ))}
                          <label className="swatch custom" title={t('Свой цвет')}>
                            <input
                              type="color"
                              value={cfg.fillColor}
                              disabled={running}
                              onChange={(e) => update({ fillColor: e.target.value })}
                            />
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
                    value={cfg.maxSize ?? ''}
                    disabled={running}
                    onChange={(e) => update({ maxSize: e.target.value ? Number(e.target.value) : undefined })}
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
                      value={cfg.format}
                      disabled={running}
                      onChange={(f) => update({ format: f })}
                      options={IMAGE_FORMATS.map((f) => ({ id: f.id, label: f.label, hint: t(f.hint) }))}
                    />
                  </Field>
                  {formatInfo.hasQuality && (
                    <Field label={t('Качество')} hint={`${cfg.quality}%`}>
                      <input
                        type="range"
                        min={10}
                        max={100}
                        value={cfg.quality}
                        disabled={running}
                        onChange={(e) => update({ quality: Number(e.target.value) })}
                      />
                    </Field>
                  )}
                </div>
              </div>
            </li>

            <li className="pipe-step">
              <span className="step-num">4</span>
              <div className="pipe-body">
                <div className="options">
                  <Field label={t('Имя файла')} hint={'{name} · {n} · {date} · {format}'}>
                    <input
                      className="text-input"
                      value={cfg.nameTemplate}
                      disabled={running}
                      onChange={(e) => update({ nameTemplate: e.target.value })}
                      placeholder="{name}"
                      title={t('Доступно: {name} — имя файла, {n} — номер, {date} — дата, {format} — формат')}
                    />
                  </Field>
                  <Field label={t('Конфиденциальность')}>
                    <Switch
                      checked={!cfg.keepMetadata}
                      disabled={running}
                      onChange={(v) => update({ keepMetadata: !v })}
                      label={t('Удалить GPS и данные камеры')}
                    />
                  </Field>
                </div>
              </div>
            </li>
          </ol>
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
          <span className="muted small">
            {allDone ? (
              <>
                🎉 {t('Готово! Обработано файлов:')} <b>{stats.done}</b>
                {stats.before > stats.after && (
                  <> · {t('экономия {size}', { size: formatBytes(stats.before - stats.after) })}</>
                )}
              </>
            ) : (
              <>
                {t('Цепочка:')} {steps.join(' → ')}
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
