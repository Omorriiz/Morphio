import logoMark from '../assets/logo-mark.png'

export type ViewId = 'convert' | 'media' | 'background' | 'pipeline' | 'gif'

interface Props {
  active: ViewId
  onSelect: (view: ViewId) => void
}

const ITEMS: { id: ViewId; label: string; icon: React.JSX.Element; soon?: boolean }[] = [
  {
    id: 'convert',
    label: 'Конвертер',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M7 7h10l-3-3M17 17H7l3 3" />
      </svg>
    )
  },
  {
    id: 'media',
    label: 'Видео и аудио',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <rect x="3" y="5" width="13" height="14" rx="2.5" />
        <path d="M16 10l5-3v10l-5-3z" />
      </svg>
    )
  },
  {
    id: 'background',
    label: 'Удалить фон',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
      </svg>
    )
  },
  {
    id: 'pipeline',
    label: 'Цепочки',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <rect x="3" y="4" width="6" height="6" rx="1.5" />
        <rect x="15" y="14" width="6" height="6" rx="1.5" />
        <path d="M9 7h3a3 3 0 013 3v4" />
      </svg>
    )
  },
  {
    id: 'gif',
    label: 'GIF-студия',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M10 9.5v5l4-2.5z" />
      </svg>
    )
  }
]

export default function Sidebar({ active, onSelect }: Props): React.JSX.Element {
  return (
    <nav className="sidebar">
      <div className="brand">
        <img className="brand-mark" src={logoMark} alt="" />
        <span className="brand-name">Morphio</span>
      </div>

      <ul className="nav">
        {ITEMS.map((item) => (
          <li key={item.id}>
            <button
              className={`nav-item ${active === item.id ? 'active' : ''}`}
              onClick={() => onSelect(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.soon && <em className="badge">скоро</em>}
            </button>
          </li>
        ))}
      </ul>

      <p className="privacy">
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="5" y="11" width="14" height="9" rx="2.5" />
          <path d="M8 11V8a4 4 0 018 0v3" />
        </svg>
        Всё работает офлайн. Ваши файлы остаются на этом компьютере.
      </p>
    </nav>
  )
}
