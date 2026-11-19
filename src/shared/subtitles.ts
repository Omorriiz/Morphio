/**
 * Субтитры: разбор и запись SRT и VTT, сдвиг времени, простой текст.
 * Формат ASS читает и пишет FFmpeg; здесь он не нужен.
 */

export interface Cue {
  /** Секунды */
  start: number
  end: number
  text: string
}

export const SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa']

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/

/** «01:02:03,450» или «02:03.450» → секунды. */
export function parseStamp(s: string): number | undefined {
  const m = TIME.exec(s)
  if (!m) return undefined
  const ms = Number(m[4].padEnd(3, '0'))
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

/** Секунды → «чч:мм:сс,ммм» (SRT) или «чч:мм:сс.ммм» (VTT). */
export function formatStamp(sec: number, sep: ',' | '.'): string {
  const total = Math.max(0, Math.round(sec * 1000))
  const ms = total % 1000
  const s = Math.floor(total / 1000) % 60
  const m = Math.floor(total / 60000) % 60
  const h = Math.floor(total / 3600000)
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`
}

/** Читает SRT и VTT (оба разбираются одним способом: блок = строка времени + текст). */
export function parseCues(text: string): Cue[] {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const cues: Cue[] = []
  let i = 0
  while (i < lines.length) {
    const arrow = lines[i].indexOf('-->')
    if (arrow < 0) {
      i++
      continue
    }
    const start = parseStamp(lines[i].slice(0, arrow))
    const end = parseStamp(lines[i].slice(arrow + 3))
    i++
    const body: string[] = []
    while (i < lines.length && lines[i].trim() !== '') {
      body.push(lines[i])
      i++
    }
    if (start !== undefined && end !== undefined) cues.push({ start, end, text: body.join('\n') })
  }
  return cues
}

export function writeSrt(cues: Cue[]): string {
  return (
    cues.map((c, i) => `${i + 1}\r\n${formatStamp(c.start, ',')} --> ${formatStamp(c.end, ',')}\r\n${c.text}`).join('\r\n\r\n') +
    '\r\n'
  )
}

export function writeVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${formatStamp(c.start, '.')} --> ${formatStamp(c.end, '.')}\n${c.text}`).join('\n\n')}\n`
}

/** Только текст: без времени и разметки, реплика на строку. */
export function writeText(cues: Cue[]): string {
  return cues.map((c) => stripMarkup(c.text).replace(/\n+/g, ' ').trim()).filter(Boolean).join('\n') + '\n'
}

/** Убирает теги <i>, {\an8} и подобное. */
export function stripMarkup(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '')
}

/** Сдвигает все реплики; реплики, ушедшие в минус целиком, пропадают. */
export function shiftCues(cues: Cue[], seconds: number): Cue[] {
  return cues
    .map((c) => ({ ...c, start: c.start + seconds, end: c.end + seconds }))
    .filter((c) => c.end > 0)
    .map((c) => ({ ...c, start: Math.max(0, c.start) }))
}
