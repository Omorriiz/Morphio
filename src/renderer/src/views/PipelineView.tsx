import { useEffect, useState } from 'react'
import { IMAGE_FORMATS } from '@shared/types'
import type { BgMethod, PipelineConfig, PipelinePreset } from '@shared/types'
import { useFileJobs } from '../hooks/useFileJobs'
import FileList from '../components/FileList'
import DropOverlay from '../components/DropOverlay'
import { formatBytes } from '../lib'

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
    cfg.removeBg && 'убрать фон',
    cfg.maxSize && `${cfg.maxSize} px`,
    formatInfo.label
  ].filter(Boolean)

  return (
    <div className="converter">
      {active && job.dragging && <DropOverlay />}

      <header className="list-head">
        <div>
          <h2>Цепочки</h2>
          <span className="muted">несколько действий за один проход</span>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={job.pick} disabled={running}>
            + Добавить файлы
          </button>
          {files.length > 0 && (
            <button className="btn ghost" onClick={job.clear} disabled={running}>
              Очистить
            </button>
          )}
        </div>
      </header>

      {files.length === 0 ? (
        <div className="empty-state compact">
          <div className="hero-emoji">⛓️</div>
          <p>Перетащите изображения сюда. Все они пройдут через выбранную цепочку действий</p>
          <button className="btn primary" onClick={job.pick}>
            Выбрать файлы
          </button>
        </div>
      ) : (
        <FileList
          files={files}
          progress={progress}
          running={running}
          onRemove={job.remove}
          previewResult={cfg.removeBg}
        />
      )}

      <section className="settings scroll">
        <div className="setting">
          <label>Готовые цепочки</label>
          <div className="chips">
            {[...BUILTIN, ...userPresets].map((p) => (
              <span key={p.id} className="preset">
                <button
                  className={`chip ${activePreset === p.id ? 'active' : ''}`}
                  onClick={() => applyPreset(p)}
                  disabled={running}
                >
                  {p.name}
                </button>
                {!p.builtin && (
                  <button
                    className="preset-x"
                    title="Удалить цепочку"
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
                  placeholder="Название цепочки"
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') savePreset()
                    if (e.key === 'Escape') setNaming(false)
                  }}
                />
                <button className="btn soft" onClick={savePreset} disabled={!presetName.trim()}>
                  Сохранить
                </button>
              </span>
            ) : (
              <button className="chip dashed" onClick={() => setNaming(true)} disabled={running}>
                + Сохранить текущую
              </button>
            )}
          </div>
        </div>

        <div className="steps">
          <div className="step">
            <div className="step-head">
              <span className="step-num">1</span>
              <label className="check">
                <input
                  type="checkbox"
                  checked={cfg.removeBg}
                  disabled={running}
                  onChange={(e) => update({ removeBg: e.target.checked })}
                />
                <span>Убрать фон</span>
              </label>
            </div>
            {cfg.removeBg && (
              <>
                <div className="chips">
                  {METHODS.map((m) => (
                    <button
                      key={m.id}
                      className={`chip small ${cfg.bgMethod === m.id ? 'active' : ''}`}
                      onClick={() => update({ bgMethod: m.id })}
                      disabled={running}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="chips">
                  <button
                    className={`chip small ${cfg.fill === 'transparent' ? 'active' : ''}`}
                    onClick={() => update({ fill: 'transparent' })}
                    disabled={running}
                  >
                    Прозрачный
                  </button>
                  <button
                    className={`chip small ${cfg.fill === 'color' ? 'active' : ''}`}
                    onClick={() => update({ fill: 'color' })}
                    disabled={running}
                  >
                    Цвет
                  </button>
                </div>
                {cfg.fill === 'color' && (
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
                    <label className="swatch custom" title="Свой цвет">
                      <input
                        type="color"
                        value={cfg.fillColor}
                        disabled={running}
                        onChange={(e) => update({ fillColor: e.target.value })}
                      />
                    </label>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="step">
            <div className="step-head">
              <span className="step-num">2</span>
              <strong>Размер</strong>
            </div>
            <select
              value={cfg.maxSize ?? ''}
              disabled={running}
              onChange={(e) => update({ maxSize: e.target.value ? Number(e.target.value) : undefined })}
            >
              {SIZES.map((o) => (
                <option key={o.label} value={o.value ?? ''}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="step">
            <div className="step-head">
              <span className="step-num">3</span>
              <strong>Формат</strong>
            </div>
            <div className="chips">
              {IMAGE_FORMATS.map((f) => (
                <button
                  key={f.id}
                  className={`chip small ${cfg.format === f.id ? 'active' : ''}`}
                  onClick={() => update({ format: f.id })}
                  title={f.hint}
                  disabled={running}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <label className="mini-range">
              Качество <b>{formatInfo.hasQuality ? `${cfg.quality}%` : '—'}</b>
              <input
                type="range"
                min={10}
                max={100}
                value={cfg.quality}
                disabled={!formatInfo.hasQuality || running}
                onChange={(e) => update({ quality: Number(e.target.value) })}
              />
            </label>
          </div>

          <div className="step">
            <div className="step-head">
              <span className="step-num">4</span>
              <strong>Файл</strong>
            </div>
            <input
              className="text-input"
              value={cfg.nameTemplate}
              disabled={running}
              onChange={(e) => update({ nameTemplate: e.target.value })}
              placeholder="{name}"
              title="Доступно: {name} — имя файла, {n} — номер, {date} — дата, {format} — формат"
            />
            <span className="muted small">{'{name} · {n} · {date} · {format}'}</span>
            <label className="check">
              <input
                type="checkbox"
                checked={!cfg.keepMetadata}
                disabled={running}
                onChange={(e) => update({ keepMetadata: !e.target.checked })}
              />
              <span>Удалить GPS и данные камеры</span>
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
                🎉 Готово! Обработано файлов: <b>{stats.done}</b>
                {stats.before > stats.after && <> · экономия {formatBytes(stats.before - stats.after)}</>}
              </>
            ) : (
              <>Цепочка: {steps.join(' → ')}</>
            )}
          </div>
          {running ? (
            <button className="btn danger" onClick={() => window.api.cancel()}>
              Остановить
            </button>
          ) : (
            <button className="btn primary" onClick={start} disabled={allDone || files.length === 0}>
              {allDone ? 'Готово' : `Запустить${files.length > 1 ? ` (${files.length})` : ''}`}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
