import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { WatchManager } from '../../src/main/watcher'
import { runUniversal } from '../../src/main/registry'
import { defaultUniversalOptions } from '../../src/shared/types'
import type { FileItem, WatchRule } from '../../src/shared/types'
import { cleanupAfterAll, exists, tmpDir } from '../helpers'

cleanupAfterAll()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Ждёт, пока условие станет истинным (слежение асинхронно). */
async function until(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await sleep(100)
  }
  return false
}

const runner = async (item: FileItem, rule: WatchRule, out: string) =>
  runUniversal(item, defaultUniversalOptions(rule.target, out, rule.quality), { gpu: null }, () => {})

function manager(notes: string[] = []): WatchManager {
  return new WatchManager(runner, (_t, body) => notes.push(body), 300, 400)
}

const rule = (folder: string, extra: Partial<WatchRule> = {}): WatchRule => ({
  id: 'r1',
  folder,
  enabled: true,
  target: 'table:json',
  quality: 85,
  ...extra
})

describe('следящие папки', () => {
  it('конвертирует только новые подходящие файлы в Morphio-out', async () => {
    const dir = await tmpDir('watch')
    await fs.mkdir(join(dir, 'вложенная'))
    await fs.writeFile(join(dir, 'старый.csv'), 'a,b\n1,2\n') // лежал до правила
    const notes: string[] = []
    const wm = manager(notes)
    await wm.sync([rule(dir)])
    expect(await until(() => wm.status()[0]?.active === true)).toBe(true)

    await fs.writeFile(join(dir, 'новый.csv'), 'имя,возраст\nАнна,30\n')
    await fs.writeFile(join(dir, 'заметка.txt'), 'text') // не подходит под правило
    await fs.writeFile(join(dir, 'скачивается.csv.part'), 'x') // недокачанный файл
    await fs.writeFile(join(dir, 'вложенная', 'глубоко.csv'), 'a\n1\n') // вложенные не отслеживаются

    const out = join(dir, 'Morphio-out')
    expect(await until(() => exists(join(out, 'новый.json')))).toBe(true)
    await sleep(1500)
    expect(await fs.readdir(out)).toEqual(['новый.json'])
    expect(JSON.parse(await fs.readFile(join(out, 'новый.json'), 'utf8'))[0]['имя']).toBe('Анна')

    expect(wm.status()[0]).toMatchObject({ processed: 1, lastFile: 'новый.csv' })
    expect(wm.status()[0].lastError).toBeUndefined()
    expect(await until(() => notes.length === 1)).toBe(true) // одно итоговое уведомление на партию
    expect(notes[0]).toContain('1')
    await wm.close()
  })

  it('результаты не обрабатываются повторно', async () => {
    const dir = await tmpDir('watch')
    const wm = manager()
    await wm.sync([rule(dir)])
    await until(() => wm.status()[0]?.active === true)
    await fs.writeFile(join(dir, 'a.csv'), 'a\n1\n')
    await until(() => exists(join(dir, 'Morphio-out', 'a.json')))
    await sleep(2000)
    expect(await fs.readdir(join(dir, 'Morphio-out'))).toEqual(['a.json'])
    expect(wm.status()[0].processed).toBe(1)
    await wm.close()
  })

  it('отключённое правило перестаёт следить', async () => {
    const dir = await tmpDir('watch')
    const wm = manager()
    await wm.sync([rule(dir)])
    await until(() => wm.status()[0]?.active === true)
    await wm.sync([rule(dir, { enabled: false })])
    expect(wm.status()).toEqual([])
    expect(wm.active).toBe(false)
    await fs.writeFile(join(dir, 'после.csv'), 'a\n1\n')
    await sleep(1500)
    expect(await exists(join(dir, 'Morphio-out'))).toBe(false)
    await wm.close()
  })

  it('смена цели правила перезапускает слежение', async () => {
    const dir = await tmpDir('watch')
    const wm = manager()
    await wm.sync([rule(dir)])
    await until(() => wm.status()[0]?.active === true)
    await wm.sync([rule(dir, { target: 'table:yaml' })])
    await until(() => wm.status()[0]?.active === true)
    await fs.writeFile(join(dir, 'a.csv'), 'a\n1\n')
    expect(await until(() => exists(join(dir, 'Morphio-out', 'a.yaml')))).toBe(true)
    await wm.close()
  })

  it('свой каталог результатов', async () => {
    const dir = await tmpDir('watch')
    const out = await tmpDir('watch-out')
    const wm = manager()
    await wm.sync([rule(dir, { outputDir: out })])
    await until(() => wm.status()[0]?.active === true)
    await fs.writeFile(join(dir, 'a.csv'), 'a\n1\n')
    expect(await until(() => exists(join(out, 'a.json')))).toBe(true)
    await wm.close()
  })

  it('результаты в той же папке отклоняются (иначе цикл)', async () => {
    const dir = await tmpDir('watch')
    const wm = manager()
    await wm.sync([rule(dir, { outputDir: dir })])
    expect(wm.status()[0]?.lastError).toMatch(/совпада/)
    expect(wm.status()[0]?.active).toBe(false)
    await wm.close()
  })

  it('несуществующая папка сообщает об ошибке, остальные правила работают', async () => {
    const dir = await tmpDir('watch')
    const wm = manager()
    await wm.sync([rule(join(dir, 'нет-такой'), { id: 'bad' }), rule(dir, { id: 'good' })])
    expect(wm.status().find((s) => s.id === 'bad')?.lastError).toBeTruthy()
    expect(await until(() => wm.status().find((s) => s.id === 'good')?.active === true)).toBe(true)
    await wm.close()
  })

  it('ошибка обработки попадает в статус и в итоговое сообщение, слежение продолжается', async () => {
    const dir = await tmpDir('watch')
    const notes: string[] = []
    const wm = manager(notes)
    await wm.sync([rule(dir)])
    await until(() => wm.status()[0]?.active === true)
    await fs.writeFile(join(dir, 'битый.json.csv'), '"unterminated\n')
    await fs.writeFile(join(dir, 'нормальный.csv'), 'a\n1\n')
    expect(await until(() => exists(join(dir, 'Morphio-out', 'нормальный.json')))).toBe(true)
    await wm.close()
  })
})
