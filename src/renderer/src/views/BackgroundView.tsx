import { useEffect, useState } from 'react'
import ColorPicker from '../components/ColorPicker'
import MaskEditor from '../components/MaskEditor'
import type {
  FileItem,
  JobProgress,
  BgMethod,
  BgOutputFormat,
  BgRemoveOptions,
  ModelDownloadProgress,
  ModelStatus
} from '@shared/types'
import { usePersistentState } from '../uiStore'
import { useFileJobs } from '../hooks/useFileJobs'
import FileList from '../components/FileList'
import DropOverlay from '../components/DropOverlay'
import { formatBytes } from '../lib'
import { useI18n } from '../i18n'
import { Field, Section, Segmented, Switch } from '../components/ui'

const SWATCHES = ['#ffffff', '#000000', '#f4f1ea', '#22cc88', '#4f8cff', '#ff6b8a', '#ffc933']

const METHODS: { id: BgMethod; label: string; hint: string }[] = [
  {
    id: 'auto',
    label: 'Авто',
    hint: 'Однотонный фон вырежем по цвету, на фото с обычным фоном включится нейросеть'
  },
  {
    id: 'solid',
    label: 'Однотонный фон',
    hint: 'Спрайты, иконки, картинки на розовом или зелёном фоне. Нейросеть не нужна'
  },
  {
    id: 'ai',
    label: 'Нейросеть',
    hint: 'Фото людей, животных и товаров на любом фоне'
  }
]

const FORMATS: { id: BgOutputFormat; label: string; hint: string }[] = [
  { id: 'png', label: 'PNG', hint: 'Лучшее качество, прозрачность' },
  { id: 'webp', label: 'WebP', hint: 'Легче, тоже с прозрачностью' },
  { id: 'jpg', label: 'JPG', hint: 'Без прозрачности — нужен цветной фон' }
]

export default function BackgroundView({ active }: { active: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const job = useFileJobs(active)
  const { files, progress, running, stats, allDone } = job

  const [model, setModel] = useState<ModelStatus | null>(null)
  const [download, setDownload] = useState<ModelDownloadProgress | null>(null)
  const [downloading, setDownloading] = useState(false)

  const [method, setMethod] = usePersistentState<BgMethod>('photo.method', 'auto')
  const [tolerance, setTolerance] = usePersistentState('photo.tolerance', 0) // 0 = подобрать автоматически
  const [everywhere, setEverywhere] = usePersistentState('photo.everywhere', true)
  const [translucent, setTranslucent] = usePersistentState('photo.translucent', true)
  const [bgColor, setBgColor] = useState<string | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<{ file: FileItem; result: JobProgress } | null>(null)
  const [mode, setMode] = usePersistentState<'transparent' | 'color'>('photo.mode', 'transparent')
  const [color, setColor] = usePersistentState('photo.color', '#ffffff')
  const [format, setFormat] = usePersistentState<BgOutputFormat>('photo.format', 'png')
  const [outputDir, setOutputDir] = usePersistentState<string | undefined>('photo.outputDir', undefined)

  const refreshModel = (): void => {
    void window.api.modelStatus().then(setModel)
  }
  useEffect(refreshModel, [])

  useEffect(
    () =>
      window.api.onModelDownload((p) => {
        setDownload(p)
        if (p.done || p.error) {
          setDownloading(false)
          if (p.done) refreshModel()
        }
      }),
    []
  )

  // JPG не поддерживает прозрачность — при прозрачном фоне переключаем на PNG.
  useEffect(() => {
    if (mode === 'transparent' && format === 'jpg') setFormat('png')
  }, [mode, format])

  useEffect(() => {
    job.resetResults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, tolerance, everywhere, translucent, bgColor, mode, color, format, outputDir])

  const startDownload = (): void => {
    setDownloading(true)
    setDownload({ received: 0, total: 0 })
    void window.api.downloadModel()
  }

  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.pickFolder()
    if (dir) setOutputDir(dir)
  }

  const buildOptions = (): BgRemoveOptions => ({
    method,
    tolerance,
    everywhere,
    translucent,
    bgColor,
    background: mode,
    color,
    format,
    outputDir
  })

  const start = (): Promise<void> =>
    job.run(async (todo) => {
      await window.api.removeBackground(todo, buildOptions())
    })

  const ready = model?.available ?? false
  // Нейросеть нужна только в режиме «Нейросеть»; в «Авто» она подключается, если фон не однотонный.
  const canStart = method === 'solid' || method === 'auto' || ready
  const showSolidOptions = method !== 'ai'
  const pct =
    download && download.total > 0 ? Math.min(100, Math.round((download.received / download.total) * 100)) : 0

  const modelCard = model && !ready && (
    <div className="banner">
      <div className="banner-icon">🧠</div>
      <div className="banner-text">
        <strong>{t('Нужна нейросеть для удаления фона')}</strong>
        <span className="muted">
          {t('Скачивается один раз ({mb} МБ) и дальше работает полностью офлайн.', { mb: model.sizeMB })}
        </span>
        {downloading && (
          <div className="progress" aria-label={t('Загрузка')}>
            <div className="progress-bar" style={{ width: `${pct}%` }} />
          </div>
        )}
        {download?.error && <span className="error small">{t('Не удалось скачать:')} {download.error}</span>}
      </div>
      <button className="btn primary" onClick={startDownload} disabled={downloading}>
        {downloading
          ? `${pct}% · ${formatBytes(download?.received ?? 0)}`
          : download?.error
            ? t('Повторить')
            : t('Скачать')}
      </button>
    </div>
  )

  return (
    <div className="converter">
      {active && job.dragging && <DropOverlay />}

      {picking && files[0] && (
        <ColorPicker
          path={files[0].path}
          onClose={() => setPicking(false)}
          onPick={(hex) => {
            setBgColor(hex)
            setPicking(false)
            // Цвет задан вручную — значит, фон однотонный.
            if (method === 'ai') setMethod('solid')
          }}
        />
      )}

      {editing && editing.result.outputPath && (
        <MaskEditor
          item={editing.file}
          options={buildOptions()}
          outputPath={editing.result.outputPath}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            job.patchProgress(editing.file.id, r)
            setEditing(null)
          }}
        />
      )}

      {files.length === 0 ? (
        <div className="empty-state">
          <div className="hero-emoji">✨</div>
          <h1>{t('Уберём фон одним кликом')}</h1>
          <p>{t('Перетащите фото людей, товаров или животных — нейросеть вырежет объект сама')}</p>
          <button className="btn primary big" onClick={job.pick}>
            {t('Выбрать фото')}
          </button>
          <span className="hint">{t('Работает на вашем компьютере, ничего не отправляется в интернет')}</span>
          {modelCard && <div className="banner-wrap">{modelCard}</div>}
        </div>
      ) : (
        <>
          <header className="list-head">
            <div>
              <h2>{t('Ваши фото')}</h2>
              <span className="muted">{t('{n} шт.', { n: files.length })}</span>
            </div>
            <div className="row">
              <button className="btn ghost" onClick={job.pick} disabled={running}>
                {t('+ Добавить')}
              </button>
              <button className="btn ghost" onClick={job.clear} disabled={running}>
                {t('Очистить')}
              </button>
            </div>
          </header>

          <div className="cv-scroll">
            {modelCard && <div className="banner-wrap tight">{modelCard}</div>}

            <FileList
              files={files}
              progress={progress}
              running={running}
              onRemove={job.remove}
              previewResult
              compact={files.length > 3}
              flow
              onEdit={(file, result) => setEditing({ file, result })}
            />

            <Section title={t('Что за фон на картинке')}>
              <Segmented
                value={method}
                disabled={running}
                onChange={setMethod}
                options={METHODS.map((m) => ({ id: m.id, label: t(m.label), hint: t(m.hint) }))}
              />
              <span className="field-hint">{t(METHODS.find((m) => m.id === method)!.hint)}</span>

              {showSolidOptions && (
                <>
                  <div className="options">
                    <Field label={t('Допуск по цвету')} hint={tolerance === 0 ? t('авто') : String(tolerance)}>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={tolerance}
                        disabled={running}
                        onChange={(e) => setTolerance(Number(e.target.value))}
                      />
                    </Field>
                    <Field label={t('Цвет фона')}>
                      <div className="row tight">
                        <button
                          className="btn soft eyedropper"
                          onClick={() => setPicking(true)}
                          disabled={running}
                          title={t('Выбрать цвет фона прямо на картинке')}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden>
                            <path d="M14 6l4 4M5 19l1-4 8-8 3 3-8 8zM16 4l4 4" />
                          </svg>
                          {bgColor ? (
                            <>
                              <i className="dot" style={{ background: bgColor }} /> {bgColor}
                            </>
                          ) : (
                            t('Пипетка (сейчас авто)')
                          )}
                        </button>
                        {bgColor && (
                          <button
                            className="icon-btn"
                            title={t('Вернуть автоопределение')}
                            onClick={() => setBgColor(undefined)}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden>
                              <path d="M6 6l12 12M18 6L6 18" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </Field>
                  </div>
                  <div className="options">
                    <Switch
                      checked={everywhere}
                      disabled={running}
                      onChange={setEverywhere}
                      label={t('Убирать фон и внутри предметов')}
                      hint={t('Убирает фон в щелях и отверстиях внутри предметов. Выключите, если на предмете есть свечение такого же цвета, как фон')}
                    />
                    <Switch
                      checked={translucent}
                      disabled={running}
                      onChange={setTranslucent}
                      label={t('Сохранять полупрозрачность (паутина, дымка)')}
                      hint={t('Паутина, дымка и свечение остаются полупрозрачными, без розовой пелены')}
                    />
                  </div>
                </>
              )}
            </Section>

            <Section title={t('Результат')}>
              <div className="options">
                <Field label={t('Фон результата')}>
                  <Segmented
                    value={mode}
                    disabled={running}
                    onChange={setMode}
                    options={[
                      { id: 'transparent', label: t('Прозрачный') },
                      { id: 'color', label: t('Цвет') }
                    ]}
                  />
                </Field>

                {mode === 'color' && (
                  <Field label={t('Цвет')}>
                    <div className="swatches">
                      {SWATCHES.map((c) => (
                        <button
                          key={c}
                          className={`swatch ${color === c ? 'active' : ''}`}
                          style={{ background: c }}
                          onClick={() => setColor(c)}
                          disabled={running}
                          aria-label={c}
                        />
                      ))}
                      <label className="swatch custom" title={t('Свой цвет')}>
                        <input
                          type="color"
                          value={color}
                          disabled={running}
                          onChange={(e) => setColor(e.target.value)}
                        />
                      </label>
                    </div>
                  </Field>
                )}

                <Field label={t('Формат')}>
                  <Segmented
                    value={format}
                    disabled={running}
                    onChange={setFormat}
                    options={FORMATS.filter((f) => !(f.id === 'jpg' && mode === 'transparent')).map((f) => ({
                      id: f.id,
                      label: f.label,
                      hint: t(f.hint)
                    }))}
                  />
                </Field>
              </div>
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
                    🎉 {t('Готово! Обработано фото:')} <b>{stats.done}</b>
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
              <button className="btn primary" onClick={start} disabled={allDone || !canStart}>
                {allDone
                  ? t('Готово')
                  : !canStart
                    ? t('Сначала скачайте модель')
                    : `${t('Убрать фон')}${files.length > 1 ? ` (${files.length})` : ''}`}
              </button>
            )}
          </footer>
        </>
      )}
    </div>
  )
}
