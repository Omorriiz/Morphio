import { defaultChain } from './chains'
import type { ChainBranches, ChainPreset } from './chains'

/** Готовые цепочки: их показывает окно и запускает командная строка (`morphio run shop ...`). */

const off = (b: ChainBranches, which: 'image' | 'video' | 'audio'): ChainBranches => ({
  ...b,
  image: { ...b.image, enabled: which === 'image' },
  video: { ...b.video, enabled: which === 'video' },
  audio: { ...b.audio, enabled: which === 'audio' }
})

const base = defaultChain()

export const BUILTIN_CHAINS: ChainPreset[] = [
  {
    id: 'builtin-shop',
    name: 'Фото товара',
    builtin: true,
    config: off(
      {
        ...base,
        image: { ...base.image, removeBg: true, fill: 'color', fillColor: '#ffffff', maxSize: 1600, format: 'jpg', quality: 90, nameTemplate: '{name}-shop' }
      },
      'image'
    )
  },
  {
    id: 'builtin-sticker',
    name: 'Стикер без фона',
    builtin: true,
    config: off({ ...base, image: { ...base.image, removeBg: true, maxSize: 512, format: 'png', nameTemplate: '{name}-sticker' } }, 'image')
  },
  {
    id: 'builtin-web',
    name: 'Для сайта',
    builtin: true,
    config: off({ ...base, image: { ...base.image, maxSize: 1600, format: 'webp', quality: 82, nameTemplate: '{name}' } }, 'image')
  },
  {
    id: 'builtin-messenger',
    name: 'Для мессенджера',
    builtin: true,
    config: off({ ...base, image: { ...base.image, maxSize: 1280, format: 'jpg', quality: 85, nameTemplate: '{name}-share' } }, 'image')
  },
  {
    id: 'builtin-archive',
    name: 'Архив без потерь',
    builtin: true,
    config: off({ ...base, image: { ...base.image, format: 'png', keepMetadata: true, nameTemplate: '{name}' } }, 'image')
  },
  {
    id: 'builtin-story',
    name: 'Видео для сторис 9:16 до 30 МБ',
    builtin: true,
    config: off(
      {
        ...base,
        video: { ...base.video, fit: { aspect: '9:16', mode: 'crop' }, maxHeight: 1080, targetMB: 30, nameTemplate: '{name}-story' }
      },
      'video'
    )
  },
  {
    id: 'builtin-telegram',
    name: 'Видео для Telegram до 50 МБ',
    builtin: true,
    config: off({ ...base, video: { ...base.video, maxHeight: 720, targetMB: 50, nameTemplate: '{name}-tg' } }, 'video')
  },
  {
    id: 'builtin-screencast',
    name: 'Скринкаст: обрезать и ужать',
    builtin: true,
    config: off(
      { ...base, video: { ...base.video, trimStart: 1, trimEnd: 1, quality: 'low', maxHeight: 1080, nameTemplate: '{name}-small' } },
      'video'
    )
  },
  {
    id: 'builtin-podcast',
    name: 'Подкаст: −16 LUFS → MP3 128',
    builtin: true,
    config: off(
      { ...base, audio: { ...base.audio, loudness: { mode: 'loudnorm', target: -16 }, format: 'mp3', bitrate: 128, trimSilence: true, nameTemplate: '{name}-podcast' } },
      'audio'
    )
  },
  {
    id: 'builtin-library',
    name: 'Фонотека: FLAC с тегами',
    builtin: true,
    config: off({ ...base, audio: { ...base.audio, format: 'flac', keepTags: true, nameTemplate: '{name}' } }, 'audio')
  }
]


/** Короткое имя цепочки для командной строки: «builtin-shop» → «shop». */
export const chainShortId = (p: ChainPreset): string => p.id.replace(/^builtin-/, '')
