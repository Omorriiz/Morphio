import { useState } from 'react'
import BackgroundView from './BackgroundView'
import PipelineView from './PipelineView'
import { Segmented } from '../components/ui'
import { useI18n } from '../i18n'

/** «Фото и фон»: удаление фона и цепочки действий для фотографий — две части одного раздела. */
export default function PhotoView({ active }: { active: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const [mode, setMode] = useState<'background' | 'chains'>('background')

  return (
    <div className="converter">
      <div className="subtabs">
        <Segmented
          value={mode}
          onChange={setMode}
          label={t('Режим')}
          options={[
            { id: 'background', label: t('Удалить фон'), hint: t('Вырезать объект и сделать фон прозрачным или цветным') },
            { id: 'chains', label: t('Цепочки'), hint: t('Несколько действий за один проход: фон, размер, формат, имя') }
          ]}
        />
      </div>
      <div className="subview" hidden={mode !== 'background'}>
        <BackgroundView active={active && mode === 'background'} />
      </div>
      <div className="subview" hidden={mode !== 'chains'}>
        <PipelineView active={active && mode === 'chains'} />
      </div>
    </div>
  )
}
