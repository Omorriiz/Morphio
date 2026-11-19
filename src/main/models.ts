import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { installModule, modulePath } from './modules'
import type { ModelDownloadProgress, ModelStatus } from '@shared/types'

/** Модель удаления фона: ISNet (general use), лицензия Apache 2.0. */
export const BG_MODEL = {
  name: 'isnet-general-use',
  file: 'isnet-general-use.onnx',
  sizeMB: 179,
  /** Файл меньше этого размера считаем повреждённым/недокачанным */
  minBytes: 150 * 1024 * 1024
}

let dirs: string[] = []

/** Папки, где ищем модели (первая — куда скачиваем). Их задаёт приложение или командная строка. */
export function configureModelDirs(list: string[]): void {
  dirs = list
}

function modelDirs(): string[] {
  return dirs
}

export function findBgModel(): string | undefined {
  const installed = modulePath('bg-isnet')
  if (installed) return installed
  for (const dir of modelDirs()) {
    const p = join(dir, BG_MODEL.file)
    try {
      if (existsSync(p) && statSync(p).size >= BG_MODEL.minBytes) return p
    } catch {
      /* пропускаем */
    }
  }
  return undefined
}

export function bgModelStatus(): ModelStatus {
  return { available: !!findBgModel(), name: BG_MODEL.name, sizeMB: BG_MODEL.sizeMB }
}

/**
 * Скачивает модель удаления фона как модуль (проверка SHA-256, копия из релиза проекта).
 * Прежняя папка models с готовым файлом по-прежнему находится и работает.
 */
export async function downloadBgModel(report: (p: ModelDownloadProgress) => void): Promise<void> {
  await installModule('bg-isnet', (p) => {
    if (p.phase === 'error') report({ received: 0, total: 0, error: p.error })
    else report({ received: p.received, total: p.total, done: p.phase === 'done' ? true : undefined })
  })
}
