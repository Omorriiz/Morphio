import { INPUT_IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '@shared/types'
import type { FileItem, JobProgress } from '@shared/types'
import { formatBytes, formatDuration } from '../lib'
import { useI18n } from '../i18n'

interface Props {
  files: FileItem[]
  progress: Record<string, JobProgress>
  running: boolean
  onRemove: (id: string) => void
  /** Показывать превью результата (с шахматным фоном для прозрачности) вместо исходника */
  previewResult?: boolean
  /** Плотный список: меньше места, когда ниже много настроек */
  compact?: boolean
  /** Список лежит внутри общей прокрутки и не прокручивается сам */
  flow?: boolean
  /** Если задано — у готовых файлов появляется кнопка «Править» */
  onEdit?: (file: FileItem, result: JobProgress) => void
  /** Если задано — у готовых картинок и видео появляется кнопка «Сравнить» */
  onCompare?: (file: FileItem, result: JobProgress) => void
}

/** Сравнивать можно картинку с картинкой и видео с видео. */
function comparable(f: FileItem, outputPath: string): boolean {
  const ext = outputPath.split('.').pop()?.toLowerCase() ?? ''
  if (f.kind === 'image') return INPUT_IMAGE_EXTENSIONS.includes(ext) && ext !== 'gif'
  if (f.kind === 'video') return VIDEO_EXTENSIONS.includes(ext)
  return false
}

export default function FileList({
  files,
  progress,
  running,
  onRemove,
  previewResult,
  compact,
  flow,
  onEdit,
  onCompare
}: Props): React.JSX.Element {
  const { t } = useI18n()
  return (
    <ul className={`file-list ${compact ? 'compact' : ''} ${flow ? 'flow' : ''}`}>
      {files.map((f) => {
        const p = progress[f.id]
        const showResult = previewResult && p?.status === 'done' && p.preview
        return (
          <li key={f.id} className={`file-card ${p?.status ?? ''}`}>
            <div className={`thumb ${showResult ? 'checker' : ''}`}>
              {showResult ? (
                <img src={p.preview} alt="" />
              ) : f.thumbnail ? (
                <img src={f.thumbnail} alt="" />
              ) : f.kind === 'folder' ? (
                <span className="audio-icon">📁</span>
              ) : f.kind === 'audio' ? (
                <span className="audio-icon">♪</span>
              ) : (
                <span>{f.ext}</span>
              )}
            </div>
            <div className="file-meta">
              <div className="file-name" title={f.path}>
                {f.name}
              </div>
              <div className="muted">
                {f.kind === 'folder' ? t('Папка') : `${f.ext.toUpperCase()} · ${formatBytes(f.size)}`}
                {f.width && f.height ? ` · ${f.width}×${f.height}` : ''}
                {f.duration ? ` · ${formatDuration(f.duration)}` : ''}
                {p?.status === 'done' && p.info ? ` · ${p.info}` : ''}
              </div>
              {p?.status === 'working' && p.percent !== undefined && (
                <div className="file-bar" aria-label={t('Ход работы')}>
                  <div style={{ width: `${Math.round(p.percent)}%` }} />
                </div>
              )}
            </div>

            <div className="file-status">
              {p?.status === 'working' && p.percent !== undefined && (
                <span className="muted percent">{Math.round(p.percent)}%</span>
              )}
              {p?.status === 'working' && <span className="spinner" aria-label={t('Обработка')} />}
              {p?.status === 'pending' && <span className="muted">{t('В очереди')}</span>}
              {p?.status === 'error' && (
                <span className="error error-text" title={p.error}>
                  {p.error && p.error.length <= 60 ? p.error : t('Не получилось')}
                </span>
              )}
              {p?.status === 'done' && p.outputPath && (
                <>
                  <span className="done-size">
                    {formatBytes(p.outputSize ?? 0)}
                    {!previewResult && p.outputSize !== undefined && f.size > 0 && (
                      <b className={p.outputSize <= f.size ? 'good' : 'bad'}>
                        {p.outputSize <= f.size ? '−' : '+'}
                        {Math.abs(Math.round((1 - p.outputSize / f.size) * 100))}%
                      </b>
                    )}
                    {previewResult && <b className="good">{t('Готово')}</b>}
                  </span>
                  {onCompare && comparable(f, p.outputPath) && (
                    <button className="icon-btn" title={t('Сравнить до и после')} disabled={running} onClick={() => onCompare(f, p)}>
                      <svg viewBox="0 0 24 24" aria-hidden>
                        <rect x="3" y="5" width="18" height="14" rx="3" />
                        <path d="M12 5v14M8.5 10l-2 2 2 2M15.5 10l2 2-2 2" />
                      </svg>
                    </button>
                  )}
                  {onEdit && (
                    <button
                      className="icon-btn"
                      title={t('Править кистью')}
                      disabled={running}
                      onClick={() => onEdit(f, p)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden>
                        <path d="M4 20l4-1 10-10-3-3L5 16zM14 7l3 3" />
                      </svg>
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    title={t('Показать в папке')}
                    onClick={() => window.api.revealInFolder(p.outputPath!)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden>
                      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                    </svg>
                  </button>
                </>
              )}
            </div>

            {!running && (
              <button className="icon-btn remove" title={t('Убрать')} onClick={() => onRemove(f.id)}>
                <svg viewBox="0 0 24 24" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
