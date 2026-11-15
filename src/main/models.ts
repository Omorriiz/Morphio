import { createWriteStream, existsSync, statSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import { tm } from './tm'
import type { ModelDownloadProgress, ModelStatus } from '@shared/types'

/** Модель удаления фона: ISNet (general use), лицензия Apache 2.0. */
export const BG_MODEL = {
  name: 'isnet-general-use',
  file: 'isnet-general-use.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
  sizeMB: 179,
  /** Файл меньше этого размера считаем повреждённым/недокачанным */
  minBytes: 150 * 1024 * 1024
}

/** Папки, где ищем модели (по порядку). */
function modelDirs(): string[] {
  const dirs = [join(app.getPath('userData'), 'models')]
  // Рядом с портативным exe (папка models).
  if (process.env['PORTABLE_EXECUTABLE_DIR']) {
    dirs.push(join(process.env['PORTABLE_EXECUTABLE_DIR'], 'models'))
  }
  // В режиме разработки — папка models в корне проекта.
  dirs.push(join(app.getAppPath(), 'models'))
  return dirs
}

export function findBgModel(): string | undefined {
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

let downloading = false

/** Скачивает модель в папку данных приложения (один раз, потом работает офлайн). */
export async function downloadBgModel(
  report: (p: ModelDownloadProgress) => void
): Promise<void> {
  if (downloading) return
  downloading = true
  const dir = join(app.getPath('userData'), 'models')
  const target = join(dir, BG_MODEL.file)
  const temp = `${target}.part`
  try {
    await fs.mkdir(dir, { recursive: true })
    const res = await fetch(BG_MODEL.url, { redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(tm('Сервер ответил: {status}', { status: res.status }))
    const total = Number(res.headers.get('content-length')) || BG_MODEL.sizeMB * 1024 * 1024
    let received = 0
    let lastReport = 0
    const source = Readable.fromWeb(res.body as never)
    source.on('data', (chunk: Buffer) => {
      received += chunk.length
      const now = Date.now()
      if (now - lastReport > 150) {
        lastReport = now
        report({ received, total })
      }
    })
    await pipeline(source, createWriteStream(temp))
    if (received < BG_MODEL.minBytes) throw new Error(tm('Файл скачался не полностью'))
    await fs.rename(temp, target)
    report({ received, total, done: true })
  } catch (e) {
    await fs.rm(temp, { force: true })
    report({
      received: 0,
      total: 0,
      error: e instanceof Error ? e.message : String(e)
    })
  } finally {
    downloading = false
  }
}
