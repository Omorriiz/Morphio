import type { MontageClip } from './types'

/**
 * Правка отрезков одного ролика: разрезать, вырезать середину, оставить только нужные куски.
 * Каждый кусок — отдельный клип плана с тем же файлом; склеиваются они в порядке списка.
 */

export interface Range {
  start: number
  end: number
}

export const MIN_PIECE = 0.2

const startOf = (c: MontageClip): number => c.start ?? 0
const endOf = (c: MontageClip): number => c.end ?? c.duration

/** Клип с новым отрезком; границы, совпавшие с краями файла, не записываются. */
function piece(c: MontageClip, id: string, start: number, end: number): MontageClip {
  return { ...c, id, start: start <= 0.001 ? undefined : start, end: end >= c.duration - 0.001 ? undefined : end }
}

/** Режет клип на два в момент `at` (в секундах файла). */
export function splitClip(c: MontageClip, at: number, ids: [string, string]): MontageClip[] {
  const s = startOf(c)
  const e = endOf(c)
  if (at <= s + MIN_PIECE || at >= e - MIN_PIECE) return [c]
  return [piece(c, ids[0], s, at), piece(c, ids[1], at, e)]
}

/** Вырезает середину [from, to]: остаются начало и конец. Пустые куски пропадают. */
export function cutOut(c: MontageClip, from: number, to: number, ids: [string, string]): MontageClip[] {
  const s = startOf(c)
  const e = endOf(c)
  const a = Math.max(s, Math.min(from, to))
  const b = Math.min(e, Math.max(from, to))
  if (b - a < 0.05) return [c]
  const out: MontageClip[] = []
  if (a - s >= MIN_PIECE) out.push(piece(c, ids[0], s, a))
  if (e - b >= MIN_PIECE) out.push(piece(c, ids[1], b, e))
  return out
}

/** Оставляет только указанные куски (границы подрезаются по отрезку клипа). */
export function keepRanges(c: MontageClip, ranges: Range[], makeId: () => string): MontageClip[] {
  const s = startOf(c)
  const e = endOf(c)
  const out: MontageClip[] = []
  for (const r of ranges) {
    const a = Math.max(s, r.start)
    const b = Math.min(e, r.end)
    if (b - a >= MIN_PIECE) out.push(piece(c, makeId(), a, b))
  }
  return out
}

/** Разбирает вывод `silencedetect`: паузы в виде отрезков. */
export function parseSilences(stderr: string, duration: number): Range[] {
  const out: Range[] = []
  let open: number | undefined
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (s) open = Math.max(0, Number(s[1]))
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (e && open !== undefined) {
      out.push({ start: open, end: Number(e[1]) })
      open = undefined
    }
  }
  // пауза до самого конца файла
  if (open !== undefined && duration > open) out.push({ start: open, end: duration })
  return out
}

/**
 * Куски с речью: всё, что не пауза. К каждому куску добавляется запас `pad` с обеих сторон, чтобы не обрезать слова;
 * куски, оказавшиеся рядом, сливаются, слишком короткие отбрасываются.
 */
export function speechRanges(silences: Range[], from: number, to: number, opts: { pad?: number; minKeep?: number } = {}): Range[] {
  const pad = opts.pad ?? 0.12
  const minKeep = opts.minKeep ?? 0.3
  const gaps = silences
    .map((s) => ({ start: Math.max(from, s.start), end: Math.min(to, s.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
  const kept: Range[] = []
  let cursor = from
  for (const g of gaps) {
    if (g.start > cursor) kept.push({ start: cursor, end: g.start })
    cursor = Math.max(cursor, g.end)
  }
  if (cursor < to) kept.push({ start: cursor, end: to })
  const padded = kept.map((k) => ({ start: Math.max(from, k.start - pad), end: Math.min(to, k.end + pad) }))
  const merged: Range[] = []
  for (const r of padded) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 0.001) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged.filter((r) => r.end - r.start >= minKeep)
}

/** Сколько секунд уберёт «вырезать тишину». */
export const removedSeconds = (c: MontageClip, ranges: Range[]): number =>
  Math.max(0, endOf(c) - startOf(c) - ranges.reduce((s, r) => s + (r.end - r.start), 0))
