import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { path7za } from '7zip-bin'
import { configureModules, installModule, moduleList, modulePath, moduleReady, removeModule } from '../../src/main/modules'
import type { ModuleProgress } from '../../src/shared/types'
import { cleanupAfterAll, exists, tmpDir } from '../helpers'

cleanupAfterAll()

let server: Server
let url: string
let zipBytes: Buffer
let sha: string

beforeAll(async () => {
  const dir = await tmpDir('modsrc')
  await fs.mkdir(join(dir, 'src', 'pandoc-3.14'), { recursive: true })
  await fs.writeFile(join(dir, 'src', 'pandoc-3.14', 'pandoc.exe'), 'not really a program')
  const zip = join(dir, 'pandoc.zip')
  const r = spawnSync(path7za, ['a', '-tzip', zip, join(dir, 'src', 'pandoc-3.14')], { windowsHide: true })
  if (r.status !== 0) throw new Error('7za failed')
  zipBytes = await fs.readFile(zip)
  sha = createHash('sha256').update(zipBytes).digest('hex')
  server = createServer((req, res) => {
    if (req.url === '/ok.zip') {
      res.writeHead(200, { 'content-length': zipBytes.length })
      res.end(zipBytes)
    } else if (req.url === '/tampered.zip') {
      const bad = Buffer.from(zipBytes)
      bad[bad.length - 30] ^= 0xff
      res.writeHead(200, { 'content-length': bad.length })
      res.end(bad)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const collect = (): { list: ModuleProgress[]; report: (p: ModuleProgress) => void } => {
  const list: ModuleProgress[] = []
  return { list, report: (p) => list.push(p) }
}

describe('модули по требованию', () => {
  it('в манифесте Pandoc: адрес GitHub, SHA-256 из 64 знаков, размер', () => {
    configureModules([])
    const [p] = moduleList()
    expect(p.id).toBe('pandoc')
    expect(p.installed).toBe(false)
    expect(p.sizeMB).toBeGreaterThan(10)
    expect(p.license).toMatch(/GPL/)
  })

  it('скачивает, проверяет сумму, распаковывает и отмечает установленным', async () => {
    const root = await tmpDir('mods')
    configureModules([root])
    const { list, report } = collect()
    await installModule('pandoc', report, undefined, { url: `${url}/ok.zip`, sha256: sha, size: zipBytes.length })
    expect(list.at(-1)?.phase).toBe('done')
    expect(moduleReady('pandoc')).toBe(true)
    expect(modulePath('pandoc')?.endsWith('pandoc.exe')).toBe(true)
    expect(moduleList()[0].installed).toBe(true)
    expect(await exists(join(root, 'pandoc', 'pandoc-3.14.zip'))).toBe(false) // архив после установки удалён
    await removeModule('pandoc')
    expect(moduleReady('pandoc')).toBe(false)
  })

  it('файл с неверной суммой отвергается и ничего не остаётся', async () => {
    const root = await tmpDir('mods')
    configureModules([root])
    const { list, report } = collect()
    await installModule('pandoc', report, undefined, { url: `${url}/tampered.zip`, sha256: sha, size: zipBytes.length })
    const last = list.at(-1)!
    expect(last.phase).toBe('error')
    expect(last.error).toBeTruthy()
    expect(moduleReady('pandoc')).toBe(false)
    expect(await fs.readdir(join(root, 'pandoc')).catch(() => [])).toEqual([])
  })

  it('ошибка сервера даёт сообщение, а не падение', async () => {
    const root = await tmpDir('mods')
    configureModules([root])
    const { list, report } = collect()
    await installModule('pandoc', report, undefined, { url: `${url}/missing.zip`, sha256: sha, size: 1 })
    expect(list.at(-1)?.phase).toBe('error')
  })

  it('модуль находится и в дополнительной папке (рядом с портативной версией)', async () => {
    const a = await tmpDir('mods-a')
    const b = await tmpDir('mods-b')
    configureModules([a, b])
    await fs.mkdir(join(b, 'pandoc', '3.14', 'pandoc-3.14'), { recursive: true })
    await fs.writeFile(join(b, 'pandoc', '3.14', 'pandoc-3.14', 'pandoc.exe'), 'x')
    expect(moduleReady('pandoc')).toBe(false) // без метки .ok модуль не считается готовым
    await fs.writeFile(join(b, 'pandoc', '3.14', '.ok'), 'x')
    expect(moduleReady('pandoc')).toBe(true)
  })
})
