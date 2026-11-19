import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_HOTKEY } from '@shared/types'
import { LANGUAGES } from '@shared/i18n'
import type { LanguageSetting } from '@shared/i18n'
import type { AppSettings, FileKind, SettingsState, ThemeSetting, UniversalTarget, WatchRule, WatchStatus } from '@shared/types'
import { useI18n } from '../i18n'
import { Field, Segmented } from '../components/ui'
import ModuleDownload from '../components/ModuleDownload'
import { useModules } from '../hooks/useModules'

const KINDS: { id: FileKind; label: string }[] = [
  { id: 'image', label: 'Изображения' },
  { id: 'video', label: 'Видео' },
  { id: 'audio', label: 'Звук' },
  { id: 'table', label: 'Таблицы' },
  { id: 'archive', label: 'Архивы' }
]

/** «CommandOrControl+Shift+X» → «Ctrl+Shift+X» для показа. */
const pretty = (accel: string): string => accel.replace('CommandOrControl', 'Ctrl')

/** Нажатое сочетание → строка для Electron. Нужен хотя бы один модификатор и обычная клавиша. */
function toAccelerator(e: React.KeyboardEvent): string | null {
  if (e.metaKey) return null // сочетания с клавишей Windows Electron зарегистрировать не может
  const key = e.key
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null
  const mods = [e.ctrlKey && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[]
  if (mods.length === 0) return null
  let main: string | null = null
  if (/^[a-z0-9]$/i.test(key)) main = key.toUpperCase()
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) main = key
  else if (key === ' ') main = 'Space'
  else if (key.startsWith('Arrow')) main = key.slice(5)
  else if (['Enter', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].includes(key)) main = key
  return main ? [...mods, main].join('+') : null
}

export default function SettingsView({ active }: { active: boolean }): React.JSX.Element {
  const { t, setting: languageSetting, setLanguage } = useI18n()
  const [state, setState] = useState<SettingsState | null>(null)
  const [status, setStatus] = useState<WatchStatus[]>([])
  const [catalog, setCatalog] = useState<Record<string, UniversalTarget>>({})
  const [recording, setRecording] = useState(false)
  const mods = useModules()
  const [calibre, setCalibre] = useState(false)

  // форма нового правила
  const [folder, setFolder] = useState<string | undefined>()
  const [kind, setKind] = useState<FileKind>('image')
  const [kindTargets, setKindTargets] = useState<UniversalTarget[]>([])
  const [target, setTarget] = useState('')

  useEffect(() => {
    void window.api.getSettings().then(setState)
    void window.api.calibreFound().then(setCalibre)
  }, [])

  useEffect(() => {
    void Promise.all(KINDS.map((k) => window.api.targetsForKind(k.id))).then((lists) => {
      const map: Record<string, UniversalTarget> = {}
      lists.flat().forEach((x) => (map[x.id] = x))
      setCatalog(map)
    })
  }, [])

  useEffect(() => {
    void window.api.targetsForKind(kind).then((list) => {
      setKindTargets(list)
      setTarget('')
    })
  }, [kind])

  // Состояние слежения обновляем раз в пару секунд, пока открыта эта вкладка.
  useEffect(() => {
    if (!active) return
    const tick = (): void => void window.api.watchStatus().then(setStatus)
    tick()
    const id = window.setInterval(tick, 2000)
    return () => window.clearInterval(id)
  }, [active])

  const patch = useCallback(async (p: Partial<AppSettings>): Promise<void> => {
    setState(await window.api.patchSettings(p))
  }, [])

  const s = state?.settings
  const statusOf = useMemo(() => new Map(status.map((x) => [x.id, x])), [status])
  if (!s || !state) return <div className="settings-page" />

  // Чтобы быстрое окно и следящие папки работали, приложение должно оставаться в трее.
  const needsBackground = { tray: true, closeToTray: true }

  const addRule = async (): Promise<void> => {
    if (!folder || !target) return
    const rule: WatchRule = { id: crypto.randomUUID(), folder, enabled: true, target, quality: 85 }
    await patch({ watchRules: [...s.watchRules, rule], ...needsBackground })
    setFolder(undefined)
    setTarget('')
  }

  const label = (id: string): string => catalog[id]?.label ?? id

  return (
    <div className="settings-page">
      <header className="list-head">
        <div>
          <h2>{t('Настройки')}</h2>
          <span className="muted">{t('Фоновая работа, быстрое окно, Проводник и следящие папки')}</span>
        </div>
      </header>

      <div className="settings-scroll">
        <section className="settings-card">
          <h3>{t('Оформление')}</h3>
          <div className="options">
            <Field label={t('Тема')}>
              <Segmented<ThemeSetting>
                value={s.theme}
                onChange={(theme) => void patch({ theme })}
                options={[
                  { id: 'system', label: t('Как в Windows') },
                  { id: 'light', label: t('Светлая') },
                  { id: 'dark', label: t('Тёмная') }
                ]}
              />
            </Field>
            <Field label={t('Язык')}>
              <Segmented<LanguageSetting>
                value={languageSetting}
                onChange={setLanguage}
                options={[
                  { id: 'system', label: t('Как в Windows') },
                  ...LANGUAGES.map((l) => ({ id: l.id as LanguageSetting, label: l.label }))
                ]}
              />
            </Field>
          </div>
        </section>

        <section className="settings-card">
          <h3>{t('Дополнительные модули')}</h3>
          <span className="muted small">
            {t('Тяжёлые программы не входят в установщик и скачиваются только по вашей кнопке. После скачивания они работают без интернета.')}
          </span>
          {(['tool', 'model'] as const).map((group) => (
            <div key={group} className="module-group">
              <span className="field-label">{group === 'tool' ? t('Программы') : t('Нейросети и языки')}</span>
              <ul className="rule-list">
                {mods.modules.filter((m) => m.group === group).map((m) => (
                  <li key={m.id} className="module-row">
                    <div className="rule-text">
                      <div className="file-name">
                        {t(m.name)} {m.version}
                      </div>
                      <div className="muted small">{t(m.description)}</div>
                      <div className="muted small">
                        {t('Лицензия {license}, источник {source}, {size} МБ', { license: m.license, source: m.source, size: m.sizeMB })}
                      </div>
                      {!m.installed && <ModuleDownload info={m} progress={mods.progress[m.id]} onInstall={() => void mods.install(m.id)} />}
                    </div>
                    {m.installed ? (
                      <>
                        <span className="good small">{t('Установлен')}</span>
                        <button className="btn ghost" onClick={() => void mods.remove(m.id)}>
                          {t('Удалить')}
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <ul className="rule-list">
            <li className="module-row">
              <div className="rule-text">
                <div className="file-name">Calibre</div>
                <div className="muted small">{t('Нужен только для книг MOBI и AZW3. Ставится отдельно, с calibre-ebook.com')}</div>
              </div>
              <span className={calibre ? 'good small' : 'muted small'}>{calibre ? t('Найден') : t('Не найден')}</span>
            </li>
          </ul>
        </section>

        <section className="settings-card">
          <h3>{t('Фоновый режим')}</h3>
          <label className="check">
            <input type="checkbox" checked={s.tray} onChange={(e) => void patch({ tray: e.target.checked, ...(e.target.checked ? {} : { closeToTray: false, launchAtLogin: false }) })} />
            <span>{t('Значок в области уведомлений (трей)')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={s.closeToTray} disabled={!s.tray} onChange={(e) => void patch({ closeToTray: e.target.checked })} />
            <span>{t('Закрытие окна сворачивает приложение в трей, а не завершает его')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={s.launchAtLogin} disabled={!s.tray} onChange={(e) => void patch({ launchAtLogin: e.target.checked })} />
            <span>{t('Запускать вместе с Windows (сразу в трее)')}</span>
          </label>
          <span className="muted small">
            {t('Всё это выключено, пока вы не включите. В фоне приложение занимает порядка 100–150 МБ памяти.')}
          </span>
        </section>

        <section className="settings-card">
          <h3>{t('Быстрое окно')}</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.quickEnabled}
              onChange={(e) => void patch({ quickEnabled: e.target.checked, ...(e.target.checked ? needsBackground : {}) })}
            />
            <span>{t('Открывать быстрое окно по сочетанию клавиш')}</span>
          </label>
          <div className="row">
            <input
              className={`text-input hotkey ${recording ? 'recording' : ''}`}
              readOnly
              value={recording ? t('Нажмите сочетание…') : pretty(s.hotkey)}
              disabled={!s.quickEnabled}
              onFocus={() => setRecording(true)}
              onBlur={() => setRecording(false)}
              onKeyDown={(e) => {
                e.preventDefault()
                const accel = toAccelerator(e)
                if (accel) {
                  setRecording(false)
                  ;(e.target as HTMLInputElement).blur()
                  void patch({ hotkey: accel })
                }
              }}
            />
            <button className="btn ghost" disabled={!s.quickEnabled || s.hotkey === DEFAULT_HOTKEY} onClick={() => void patch({ hotkey: DEFAULT_HOTKEY })}>
              {t('По умолчанию')}
            </button>
          </div>
          {s.quickEnabled && !state.hotkeyOk && (
            <span className="error small">
              {t('Это сочетание занято другой программой или записано неверно. Выберите другое.')}
            </span>
          )}
          <span className="muted small">
            {t('Выделите файлы в Проводнике и нажмите сочетание: поверх окон появится маленькое окно с вариантами. Подойдут и скопированные файлы, и скриншот в буфере обмена.')}
          </span>
        </section>

        <section className="settings-card">
          <h3>{t('Меню Проводника')}</h3>
          <label className="check">
            <input type="checkbox" checked={s.explorerMenu} onChange={(e) => void patch({ explorerMenu: e.target.checked })} />
            <span>{t('Добавить пункт «Конвертировать в Morphio» в меню файлов и папок')}</span>
          </label>
          {state.explorerMenuError && <span className="error small">{state.explorerMenuError}</span>}
          <span className="muted small">
            {t('В Windows 11 пункт находится в классическом меню: «Показать дополнительные параметры» (или Shift+F10). Права администратора не нужны, выключение убирает пункт полностью.')}
          </span>
        </section>

        <section className="settings-card">
          <h3>{t('Следящие папки')}</h3>
          <span className="muted small">
            {t('Всё, что появится в папке, конвертируется само. Файлы, которые уже лежат в папке, не трогаются. Результат кладётся в подпапку Morphio-out.')}
          </span>

          {s.watchRules.length > 0 && (
            <ul className="rule-list">
              {s.watchRules.map((r) => {
                const st = statusOf.get(r.id)
                return (
                  <li key={r.id} className="rule">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={(e) => void patch({ watchRules: s.watchRules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)) })}
                      />
                    </label>
                    <div className="rule-text">
                      <div className="file-name" title={r.folder}>{r.folder}</div>
                      <div className="muted small">
                        → {label(r.target)}
                        {st && r.enabled && ` · ${t('обработано: {n}', { n: st.processed })}`}
                        {st?.lastFile && ` · ${t('последний: {name}', { name: st.lastFile })}`}
                      </div>
                      {st?.lastError && r.enabled && <div className="error small">{st.lastError}</div>}
                    </div>
                    <button
                      className="icon-btn"
                      title={t('Убрать')}
                      onClick={() => void patch({ watchRules: s.watchRules.filter((x) => x.id !== r.id) })}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden>
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="rule-form">
            <strong className="small">{t('Новое правило')}</strong>
            <div className="row tight">
              <button className="btn soft" onClick={async () => setFolder((await window.api.pickFolder()) ?? folder)}>
                {folder ? folder : t('Выбрать папку…')}
              </button>
            </div>
            <div className="chips">
              {KINDS.map((k) => (
                <button key={k.id} className={`chip small ${kind === k.id ? 'active' : ''}`} onClick={() => setKind(k.id)}>
                  {t(k.label)}
                </button>
              ))}
            </div>
            <div className="chips">
              {kindTargets.map((x) => (
                <button key={x.id} className={`chip small ${target === x.id ? 'active' : ''}`} onClick={() => setTarget(x.id)} title={x.hint}>
                  {x.label}
                </button>
              ))}
            </div>
            <div className="row">
              <button className="btn primary" disabled={!folder || !target} onClick={() => void addRule()}>
                {t('Добавить правило')}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
