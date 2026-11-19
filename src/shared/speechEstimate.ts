/**
 * Прикидка времени распознавания речи. Whisper работает на процессоре, скорость сильно зависит от компьютера,
 * поэтому до первого запуска берутся средние значения, а потом — скорость, измеренная на этом компьютере.
 */

/** Секунд работы на секунду записи для среднего ноутбука (8 потоков). */
export const DEFAULT_SPEECH_RATIO: Record<string, number> = { tiny: 0.12, base: 0.25, small: 0.8 }

/** Прикидка в секундах; записи короче секунды и мусорные значения не считаются. */
export function estimateSpeechSeconds(durationSec: number, model: string, measuredRatio?: number): number {
  if (!(durationSec > 0)) return 0
  const ratio = measuredRatio && measuredRatio > 0.01 && measuredRatio < 20 ? measuredRatio : (DEFAULT_SPEECH_RATIO[model] ?? 0.3)
  return durationSec * ratio + 4 // четыре секунды на запуск программы и подготовку звука
}

/** «около 40 с», «около 3 мин», «около 1 ч 20 мин». */
export function formatEstimate(sec: number): { unit: 's' | 'm' | 'h'; a: number; b?: number } {
  if (sec < 90) return { unit: 's', a: Math.max(5, Math.round(sec / 5) * 5) }
  if (sec < 3600) return { unit: 'm', a: Math.round(sec / 60) }
  const h = Math.floor(sec / 3600)
  return { unit: 'h', a: h, b: Math.round((sec - h * 3600) / 600) * 10 }
}

/** Новое значение скорости: плавное среднее, чтобы один неудачный запуск не ломал прикидку. */
export function mixRatio(previous: number | undefined, measured: number): number {
  if (!(measured > 0.01 && measured < 20)) return previous ?? measured
  return previous ? previous * 0.5 + measured * 0.5 : measured
}
