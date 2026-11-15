import type { UniversalMedia } from '@shared/types'

/** Быстрые варианты для видео и звука: одним нажатием выбирают формат и настройки под типичную задачу. */
export interface MediaPreset {
  id: string
  label: string
  hint: string
  /** Формат результата без вида: mp4, mp3… */
  format: string
  /** Какие настройки меняются (остальные остаются как были) */
  media: Partial<UniversalMedia>
}

export const MEDIA_PRESETS: MediaPreset[] = [
  {
    id: 'messenger',
    label: 'Для мессенджера',
    hint: 'MP4, 720p, средний размер',
    format: 'mp4',
    media: { quality: 'medium', maxHeight: 720, audioBitrate: 128, mute: false, targetMB: undefined }
  },
  {
    id: 'discord',
    label: 'Discord (до 10 МБ)',
    hint: 'MP4, размер подбирается под 9,5 МБ',
    format: 'mp4',
    media: { maxHeight: undefined, audioBitrate: 96, mute: false, targetMB: 9.5 }
  },
  {
    id: 'mail',
    label: 'Почта (до 25 МБ)',
    hint: 'MP4, размер подбирается под 24 МБ',
    format: 'mp4',
    media: { maxHeight: undefined, audioBitrate: 128, mute: false, targetMB: 24 }
  },
  {
    id: 'best',
    label: 'Лучшее качество',
    hint: 'MP4, высокое качество, размер как в оригинале',
    format: 'mp4',
    media: { quality: 'high', maxHeight: undefined, audioBitrate: 256, mute: false, targetMB: undefined }
  },
  {
    id: 'small',
    label: 'Минимальный размер',
    hint: 'MP4, 480p, сильное сжатие',
    format: 'mp4',
    media: { quality: 'low', maxHeight: 480, audioBitrate: 96, mute: false, targetMB: undefined }
  },
  {
    id: 'mp3',
    label: 'MP3 для телефона',
    hint: 'Только звук, 192 кбит/с',
    format: 'mp3',
    media: { audioBitrate: 192 }
  },
  {
    id: 'voice',
    label: 'Голос (мало места)',
    hint: 'OPUS, 64 кбит/с',
    format: 'opus',
    media: { audioBitrate: 64 }
  },
  {
    id: 'lossless',
    label: 'Без потерь',
    hint: 'FLAC',
    format: 'flac',
    media: {}
  }
]
