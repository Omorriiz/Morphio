import logoMark from '../assets/logo-mark.png'
import { useI18n } from '../i18n'

export type ViewId = 'convert' | 'photo' | 'gif' | 'settings'

interface Props {
  active: ViewId
  onSelect: (view: ViewId) => void
}

interface Item {
  id: ViewId
  label: string
  hint: string
  icon: React.JSX.Element
}

const MAIN: Item[] = [
  {
    id: 'convert',
    label: 'Конвертер',
    hint: 'Картинки, видео, звук, таблицы и архивы',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M7 7h10l-3-3M17 17H7l3 3" />
      </svg>
    )
  },
  {
    id: 'photo',
    label: 'Фото и фон',
    hint: 'Удаление фона и цепочки действий',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
      </svg>
    )
  },
  {
    id: 'gif',
    label: 'GIF-студия',
    hint: 'Анимация из картинок или видео',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M10 9.5v5l4-2.5z" />
      </svg>
    )
  }
]

const SETTINGS: Item = {
  id: 'settings',
  label: 'Настройки',
  hint: 'Фоновый режим, быстрое окно, Проводник, следящие папки',
  icon: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </svg>
  )
}

export default function Sidebar({ active, onSelect }: Props): React.JSX.Element {
  const { t } = useI18n()

  return (
    <nav className="sidebar" aria-label={t('Разделы')}>
      <div className="brand">
        <img className="brand-mark" src={logoMark} alt="" />
        <span className="brand-name">Morphio</span>
        <button
          className={`settings-btn ${active === SETTINGS.id ? 'active' : ''}`}
          aria-current={active === SETTINGS.id ? 'page' : undefined}
          aria-label={t(SETTINGS.label)}
          title={t(SETTINGS.label)}
          onClick={() => onSelect(SETTINGS.id)}
        >
          {SETTINGS.icon}
        </button>
      </div>

      <ul className="nav">
        {MAIN.map((item) => (
          <li key={item.id}>
            <button
              className={`nav-item ${active === item.id ? 'active' : ''}`}
              aria-current={active === item.id ? 'page' : undefined}
              title={t(item.hint)}
              onClick={() => onSelect(item.id)}
            >
              {item.icon}
              <span>{t(item.label)}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="privacy">
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="5" y="11" width="14" height="9" rx="2.5" />
          <path d="M8 11V8a4 4 0 018 0v3" />
        </svg>
        {t('Всё работает офлайн. Ваши файлы остаются на этом компьютере.')}
      </p>
    </nav>
  )
}
