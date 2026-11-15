import type { ModuleInfo, ModuleProgress } from '@shared/types'
import { useI18n } from '../i18n'
import { formatBytes } from '../lib'

interface Props {
  info: ModuleInfo
  progress?: ModuleProgress
  onInstall: () => void
  /** Короткая подпись над кнопкой (в баннере конвертера) */
  compact?: boolean
}

/** Кнопка «Скачать» с ходом загрузки: без нажатия ничего не скачивается. */
export default function ModuleDownload({ info, progress, onInstall, compact }: Props): React.JSX.Element {
  const { t } = useI18n()
  const busy = progress && (progress.phase === 'download' || progress.phase === 'extract')
  const pct = progress && progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : 0
  return (
    <div className={`module-dl ${compact ? 'compact' : ''}`}>
      {busy ? (
        <>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${progress.phase === 'extract' ? 100 : pct}%` }} />
          </div>
          <span className="muted small">
            {progress.phase === 'extract'
              ? t('Распаковываю…')
              : t('Скачиваю: {done} из {total}', { done: formatBytes(progress.received), total: formatBytes(progress.total) })}
          </span>
        </>
      ) : (
        <button className="btn primary" onClick={onInstall}>
          {t('Скачать {name} ({size} МБ)', { name: info.name, size: info.sizeMB })}
        </button>
      )}
      {progress?.phase === 'error' && <span className="error small">{progress.error}</span>}
    </div>
  )
}
