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

/** 75.4 → «1:15.4» (десятые секунды нужны для точной обрезки). */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`
}

/** «1:15.4», «75,4», «1:02:03» → секунды; пустое или непонятное → undefined. */
export function parseTime(text: string): number | undefined {
  const t = text.trim().replace(',', '.')
  if (!t) return undefined
  const parts = t.split(':').map(Number)
  if (parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return undefined
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}
