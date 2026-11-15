import { tr } from './i18n'

/** 75 → «1:15», 3725 → «1:02:05». */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return tr('{n} Б', { n: bytes })
  if (bytes < 1024 * 1024) return tr('{n} КБ', { n: (bytes / 1024).toFixed(0) })
  return tr('{n} МБ', { n: (bytes / 1024 / 1024).toFixed(1) })
}
