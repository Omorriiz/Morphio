import { useI18n } from '../i18n'
export default function DropOverlay(): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="drop-overlay">
      <div className="drop-overlay-card">
        <div className="hero-emoji">📥</div>
        <strong>{t('Отпустите, чтобы добавить')}</strong>
      </div>
    </div>
  )
}
