import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration } from '../../src/renderer/src/lib'
import { MEDIA_PRESETS } from '../../src/renderer/src/mediaPresets'
import { AUDIO_TARGETS, VIDEO_TARGETS } from '../../src/shared/types'
import { translate } from '../../src/shared/i18n'

describe('formatDuration', () => {
  it('минуты и секунды', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(75)).toBe('1:15')
    expect(formatDuration(59.6)).toBe('1:00')
  })

  it('часы', () => {
    expect(formatDuration(3725)).toBe('1:02:05')
  })
})

describe('formatBytes', () => {
  it('единицы по размеру (русский по умолчанию)', () => {
    expect(formatBytes(512)).toBe('512 Б')
    expect(formatBytes(2048)).toBe('2 КБ')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 МБ')
  })
})

describe('быстрые варианты для видео и звука', () => {
  const known = new Set<string>([...VIDEO_TARGETS.map((t) => t.id), ...AUDIO_TARGETS.map((t) => t.id)])

  it('идентификаторы уникальны, форматы существуют', () => {
    const ids = MEDIA_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of MEDIA_PRESETS) expect(known.has(p.format), p.id).toBe(true)
  })

  it('у каждого есть английский перевод подписи и подсказки', () => {
    for (const p of MEDIA_PRESETS) {
      expect(translate('en', p.label), p.id).not.toBe(p.label)
      if (/[А-Яа-яЁё]/.test(p.hint)) expect(translate('en', p.hint), p.id).not.toBe(p.hint)
    }
  })

  it('лимиты размера положительные', () => {
    for (const p of MEDIA_PRESETS) {
      if (p.media.targetMB !== undefined) expect(p.media.targetMB).toBeGreaterThan(0)
    }
  })
})
