import { useState } from 'react'
import type { GifBgRemoval, GifCrop, GifLayer } from '@shared/types'
import { LAYER_ANIMS, LAYER_ANIM_LABELS } from '@shared/layerAnim'
import type { LayerAnim } from '@shared/layerAnim'
import { Field, Segmented, Switch } from './ui'
import { useI18n } from '../i18n'
import { DEFAULT_TEXT, EMOJIS, FONTS, restyleText } from '../gifLayers'
import type { TextStyle } from '../gifLayers'

/** Панели GIF-студии: текст и стикеры, обрезка рамкой, удаление фона. */

interface LayerPanelProps {
  layers: GifLayer[]
  selectedId: string | null
  frameCount: number
  /** Номер текущего кадра (с нуля): удобно задавать им диапазон */
  currentFrame: number
  disabled?: boolean
  onSelect: (id: string | null) => void
  onAddText: () => void
  onAddEmoji: (emoji: string) => void
  onAddFile: () => void
  onChange: (id: string, patch: Partial<GifLayer>) => void
  onRemove: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
}

export function LayerPanel(p: LayerPanelProps): React.JSX.Element {
  const { t } = useI18n()
  const [emojiOpen, setEmojiOpen] = useState(false)
  const sel = p.layers.find((l) => l.id === p.selectedId) ?? null
  const style = sel?.kind === 'text' ? ({ ...DEFAULT_TEXT, ...(sel.edit as Partial<TextStyle>) } as TextStyle) : null

  const restyle = async (patch: Partial<TextStyle>): Promise<void> => {
    if (!sel || !style) return
    p.onChange(sel.id, await restyleText(sel, { ...style, ...patch }))
  }

  const label = (l: GifLayer): string => (l.kind === 'text' ? String((l.edit as Partial<TextStyle> | undefined)?.text ?? t('Текст')).split('\n')[0] : String(l.edit?.['label'] ?? t('Стикер')))
  const from = sel?.from ?? 0
  const to = sel?.to ?? p.frameCount - 1

  return (
    <div className="step layers">
      <strong>{t('Текст и стикеры')}</strong>
      <div className="row tight">
        <button className="btn soft" disabled={p.disabled} onClick={p.onAddText}>
          {t('+ Текст')}
        </button>
        <button className={`btn soft ${emojiOpen ? 'active' : ''}`} disabled={p.disabled} onClick={() => setEmojiOpen((v) => !v)}>
          {t('+ Эмодзи')}
        </button>
        <button className="btn soft" disabled={p.disabled} onClick={p.onAddFile}>
          {t('+ Свой стикер')}
        </button>
      </div>
      {emojiOpen && (
        <div className="emoji-grid">
          {EMOJIS.map((e) => (
            <button
              key={e}
              className="emoji"
              onClick={() => {
                p.onAddEmoji(e)
                setEmojiOpen(false)
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}

      {p.layers.length > 0 && (
        <ul className="layer-list">
          {[...p.layers].reverse().map((l) => (
            <li key={l.id} className={`layer-row ${l.id === p.selectedId ? 'active' : ''}`} onClick={() => p.onSelect(l.id)}>
              <span className="layer-thumb">
                <img src={l.png} alt="" />
              </span>
              <span className="layer-name">{label(l)}</span>
              <button className="icon-btn" title={t('Выше')} disabled={p.disabled} onClick={(e) => { e.stopPropagation(); p.onMove(l.id, 1) }}>
                <svg viewBox="0 0 24 24" aria-hidden><path d="M6 14l6-6 6 6" /></svg>
              </button>
              <button className="icon-btn" title={t('Ниже')} disabled={p.disabled} onClick={(e) => { e.stopPropagation(); p.onMove(l.id, -1) }}>
                <svg viewBox="0 0 24 24" aria-hidden><path d="M6 10l6 6 6-6" /></svg>
              </button>
              <button className="icon-btn" title={t('Убрать')} disabled={p.disabled} onClick={(e) => { e.stopPropagation(); p.onRemove(l.id) }}>
                <svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      {p.layers.length === 0 && <span className="muted small">{t('Слои двигаются мышью прямо на кадре: за угол меняется размер, за верхнюю точку поворот.')}</span>}

      {sel && (
        <div className="layer-props">
          {style && (
            <>
              <textarea
                className="text-input"
                rows={2}
                value={style.text}
                disabled={p.disabled}
                placeholder={t('Текст')}
                onChange={(e) => void restyle({ text: e.target.value })}
              />
              <div className="row tight">
                <select value={style.font} disabled={p.disabled} onChange={(e) => void restyle({ font: e.target.value })}>
                  {FONTS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <input type="color" value={style.color} disabled={p.disabled} onChange={(e) => void restyle({ color: e.target.value })} title={t('Цвет текста')} />
                <button className={`chip small ${style.bold ? 'active' : ''}`} disabled={p.disabled} onClick={() => void restyle({ bold: !style.bold })}>
                  <b>B</b>
                </button>
                <button className={`chip small ${style.italic ? 'active' : ''}`} disabled={p.disabled} onClick={() => void restyle({ italic: !style.italic })}>
                  <i>I</i>
                </button>
              </div>
              <label className="mini-range">
                <span>{t('Кегль')} <b>{Math.round(style.size)}</b></span>
                <input type="range" min={20} max={300} value={style.size} disabled={p.disabled} onChange={(e) => void restyle({ size: Number(e.target.value) })} />
              </label>
              <label className="mini-range">
                <span>{t('Обводка')} <b>{style.outline}</b></span>
                <input type="range" min={0} max={24} value={style.outline} disabled={p.disabled} onChange={(e) => void restyle({ outline: Number(e.target.value) })} />
              </label>
              <div className="row tight">
                <input type="color" value={style.outlineColor} disabled={p.disabled} onChange={(e) => void restyle({ outlineColor: e.target.value })} title={t('Цвет обводки')} />
                <Switch checked={style.shadow} disabled={p.disabled} label={t('Тень')} onChange={(v) => void restyle({ shadow: v })} />
              </div>
            </>
          )}
          <label className="mini-range">
            <span>{t('Непрозрачность')} <b>{Math.round((sel.opacity ?? 1) * 100)}%</b></span>
            <input type="range" min={10} max={100} value={Math.round((sel.opacity ?? 1) * 100)} disabled={p.disabled} onChange={(e) => p.onChange(sel.id, { opacity: Number(e.target.value) / 100 })} />
          </label>
          <label className="mini-range">
            <span>{t('Поворот')} <b>{sel.rotation}°</b></span>
            <input type="range" min={-180} max={180} value={sel.rotation} disabled={p.disabled} onChange={(e) => p.onChange(sel.id, { rotation: Number(e.target.value) })} />
          </label>
          <label className="mini-range">
            <span>{t('Анимация')}</span>
            <select
              value={sel.anim ?? 'none'}
              disabled={p.disabled}
              onChange={(e) => p.onChange(sel.id, { anim: e.target.value === 'none' ? undefined : (e.target.value as LayerAnim) })}
            >
              {LAYER_ANIMS.map((a) => (
                <option key={a} value={a}>
                  {t(LAYER_ANIM_LABELS[a])}
                </option>
              ))}
            </select>
          </label>
          {sel.anim && sel.anim !== 'none' && (
            <span className="muted small">{t('Анимация идёт за время показа слоя: на кадрах «с … по …»')}</span>
          )}
          <div className="range-row">
            <span className="muted small">{t('Показывать с кадра')}</span>
            <input
              type="number"
              className="text-input tiny"
              min={1}
              max={p.frameCount}
              value={from + 1}
              disabled={p.disabled}
              onChange={(e) => p.onChange(sel.id, { from: Math.min(to, Math.max(0, Number(e.target.value) - 1)) })}
            />
            <span className="muted small">{t('по')}</span>
            <input
              type="number"
              className="text-input tiny"
              min={1}
              max={p.frameCount}
              value={to + 1}
              disabled={p.disabled}
              onChange={(e) => p.onChange(sel.id, { to: Math.max(from, Math.min(p.frameCount - 1, Number(e.target.value) - 1)) })}
            />
          </div>
          <div className="row tight">
            <button className="btn ghost" disabled={p.disabled} onClick={() => p.onChange(sel.id, { from: Math.min(p.currentFrame, to) })}>
              {t('С текущего кадра')}
            </button>
            <button className="btn ghost" disabled={p.disabled} onClick={() => p.onChange(sel.id, { to: Math.max(p.currentFrame, from) })}>
              {t('По текущий кадр')}
            </button>
            <button className="btn ghost" disabled={p.disabled || (sel.from === undefined && sel.to === undefined)} onClick={() => p.onChange(sel.id, { from: undefined, to: undefined })}>
              {t('На всех')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export type CropAspect = 'free' | '1:1' | '16:9' | '9:16' | '4:3'

/** Соотношение сторон пресета как число (ширина / высота); null — свободно. */
export const ratioOf = (a: CropAspect): number | null => {
  if (a === 'free') return null
  const [w, h] = a.split(':').map(Number)
  return w / h
}

/** Самая большая рамка нужных пропорций по центру кадра (в долях кадра). */
export function centeredCrop(ratio: number, frameAspect: number): GifCrop {
  // в долях: w / h = ratio / frameAspect
  const k = ratio / frameAspect
  let w = 1
  let h = w / k
  if (h > 1) {
    h = 1
    w = h * k
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

interface CropPanelProps {
  crop?: GifCrop
  mode: boolean
  aspect: CropAspect
  frameAspect: number
  disabled?: boolean
  onMode: (on: boolean) => void
  onAspect: (a: CropAspect) => void
  onCrop: (c: GifCrop | undefined) => void
}

export function CropPanel(p: CropPanelProps): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="step">
      <strong>{t('Обрезка кадра')}</strong>
      <Segmented
        value={p.aspect}
        disabled={p.disabled}
        onChange={(a) => {
          p.onAspect(a)
          const r = ratioOf(a)
          if (r) {
            p.onCrop(centeredCrop(r, p.frameAspect))
            p.onMode(true)
          }
        }}
        options={[
          { id: 'free', label: t('Свободно') },
          { id: '1:1', label: '1:1' },
          { id: '16:9', label: '16:9' },
          { id: '9:16', label: '9:16' },
          { id: '4:3', label: '4:3' }
        ]}
      />
      <div className="row tight">
        <button className={`btn soft ${p.mode ? 'active' : ''}`} disabled={p.disabled} onClick={() => p.onMode(!p.mode)}>
          {p.mode ? t('Готово') : p.crop ? t('Править рамку') : t('Выбрать рамку')}
        </button>
        <button
          className="btn ghost"
          disabled={p.disabled || !p.crop}
          onClick={() => {
            p.onCrop(undefined)
            p.onMode(false)
            p.onAspect('free')
          }}
        >
          {t('Убрать обрезку')}
        </button>
      </div>
      <span className="muted small">
        {p.crop
          ? t('Рамка одна для всех кадров: {w}×{h} % кадра', { w: Math.round(p.crop.w * 100), h: Math.round(p.crop.h * 100) })
          : t('Рамка применяется ко всем кадрам сразу.')}
      </span>
    </div>
  )
}

interface BgPanelProps {
  value: GifBgRemoval | null
  format: 'gif' | 'webp' | 'apng'
  frameCount: number
  disabled?: boolean
  onChange: (v: GifBgRemoval | null) => void
}

export function BackgroundPanel(p: BgPanelProps): React.JSX.Element {
  const { t } = useI18n()
  const v = p.value
  const seconds = Math.max(1, Math.round(p.frameCount * 0.4))
  return (
    <div className="step">
      <strong>{t('Фон')}</strong>
      <Switch
        checked={!!v}
        disabled={p.disabled}
        label={t('Убрать фон у всех кадров')}
        onChange={(on) => p.onChange(on ? { method: 'auto', matte: '#ffffff', smooth: true } : null)}
      />
      {v && (
        <>
          <Field label={t('Что за фон')}>
            <Segmented
              value={v.method}
              disabled={p.disabled}
              onChange={(method) => p.onChange({ ...v, method })}
              options={[
                { id: 'auto', label: t('Авто') },
                { id: 'solid', label: t('Однотонный'), hint: t('Быстро: цвет определяется по первому кадру и не меняется') },
                { id: 'ai', label: t('Нейросеть'), hint: t('Для любых фонов, но медленнее') }
              ]}
            />
          </Field>
          {v.method !== 'solid' && (
            <Switch
              checked={v.smooth}
              disabled={p.disabled}
              label={t('Сгладить края по времени')}
              hint={t('Маска усредняется с соседними кадрами, края не мерцают')}
              onChange={(smooth) => p.onChange({ ...v, smooth })}
            />
          )}
          {p.format === 'gif' && (
            <label className="row tight">
              <input type="color" value={v.matte} disabled={p.disabled} onChange={(e) => p.onChange({ ...v, matte: e.target.value })} />
              <span className="muted small">{t('Цвет, под который подгоняются края (цвет будущего фона)')}</span>
            </label>
          )}
          {p.format === 'gif' ? (
            <span className="muted small">{t('В GIF прозрачность только «есть или нет», края получаются рваными. Для мягких краёв выберите WebP или APNG.')}</span>
          ) : (
            v.method !== 'solid' && <span className="muted small">{t('Нейросеть: около {s} с на этот ролик.', { s: seconds })}</span>
          )}
        </>
      )}
    </div>
  )
}
