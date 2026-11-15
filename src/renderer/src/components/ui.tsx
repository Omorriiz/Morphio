import { forwardRef, type ReactNode } from 'react'

/** Небольшой набор общих элементов интерфейса: единый вид для всех экранов. */

interface SegmentedProps<T extends string> {
  value: T
  options: { id: T; label: string; hint?: string }[]
  onChange: (id: T) => void
  disabled?: boolean
  label?: string
}

/** Переключатель из нескольких вариантов («таблетка» с ползунком выбора). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label
}: SegmentedProps<T>): React.JSX.Element {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={value === o.id ? 'active' : ''}
          title={o.hint}
          disabled={disabled}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}

/** Выключатель с подписью. */
export function Switch({ checked, onChange, label, hint, disabled }: SwitchProps): React.JSX.Element {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`} title={hint}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden />
      <span className="switch-label">{label}</span>
    </label>
  )
}

/** Подпись над полем. */
export function Field({
  label,
  hint,
  children,
  grow
}: {
  label: string
  hint?: string
  children: ReactNode
  grow?: boolean
}): React.JSX.Element {
  return (
    <div className={`field ${grow ? 'grow' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  )
}

/** Раздел страницы с заголовком. */
export const Section = forwardRef<
  HTMLElement,
  { title: string; aside?: ReactNode; children: ReactNode }
>(function Section({ title, aside, children }, ref) {
  return (
    <section className="section" ref={ref}>
      <header className="section-head">
        <h3>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  )
})
