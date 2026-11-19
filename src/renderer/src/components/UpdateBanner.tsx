import { useState } from 'react'
import { useUpdates } from '../hooks/useUpdates'
import { useI18n } from '../i18n'
import Modal from './Modal'

/** Предложение обновиться: ничего не скачивается и не ставится без нажатия кнопок. */
export default function UpdateBanner(): React.JSX.Element | null {
  const { t } = useI18n()
  const u = useUpdates()
  const [notes, setNotes] = useState(false)
  if (u.status !== 'available' && u.status !== 'downloading' && u.status !== 'ready') return null
  return (
    <div className="update-banner" role="status">
      <span>
        {u.status === 'available' && t('Доступна версия {v}', { v: u.version ?? '' })}
        {u.status === 'downloading' && t('Скачиваю версию {v}: {p}%', { v: u.version ?? '', p: u.percent ?? 0 })}
        {u.status === 'ready' && t('Версия {v} скачана и готова к установке', { v: u.version ?? '' })}
      </span>
      <div className="row tight">
        {u.status === 'available' && (
          <>
            {u.notes && (
              <button className="btn ghost" onClick={() => setNotes(true)}>
                {t('Что нового')}
              </button>
            )}
            <button className="btn primary" onClick={() => void window.api.updatesDownload()}>
              {t('Обновить')}
            </button>
            <button className="btn ghost" onClick={() => void window.api.updatesDismiss()}>
              {t('Позже')}
            </button>
          </>
        )}
        {u.status === 'ready' && (
          <button className="btn primary" onClick={() => void window.api.updatesInstall()}>
            {t('Перезапустить и установить')}
          </button>
        )}
      </div>
      {notes && (
        <Modal title={t('Что нового в версии {v}', { v: u.version ?? '' })} onClose={() => setNotes(false)}>
          <pre className="crash-text">{u.notes}</pre>
        </Modal>
      )}
    </div>
  )
}
