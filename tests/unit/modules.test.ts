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
    await installModule('pandoc', report, undefined, { files: [{ name: 'pandoc.zip', url: `${url}/ok.zip`, sha256: sha, size: zipBytes.length, unzip: true }] })
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
    await installModule('pandoc', report, undefined, { files: [{ name: 'pandoc.zip', url: `${url}/tampered.zip`, sha256: sha, size: zipBytes.length, unzip: true }] })
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
    await installModule('pandoc', report, undefined, { files: [{ name: 'pandoc.zip', url: `${url}/missing.zip`, sha256: sha, size: 1, unzip: true }] })
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

// ---- модули с моделями: копии в релизе проекта ----
import { createReadStream, existsSync } from 'node:fs'
import { MODULES } from '../../src/main/modules'

const RELEASE = join(process.cwd(), 'models-release')

describe('манифест модулей', () => {
  it('у каждого модуля есть файлы, главный файл, лицензия, источник; идентификаторы не повторяются', () => {
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length)
    for (const m of MODULES) {
      expect(m.files.length).toBeGreaterThan(0)
      expect(m.license).toBeTruthy()
      expect(m.source).toBeTruthy()
      for (const f of m.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(f.size).toBeGreaterThan(0)
      }
      // главный файл — либо сохранённый файл, либо лежит внутри распакованного архива
      const saved = m.files.map((f) => f.saveAs ?? f.name)
      expect(saved.includes(m.main) || m.files.some((f) => f.unzip)).toBe(true)
    }
    // собственные модели берутся из релиза проекта (нет своего адреса), чужие программы — с официальных страниц
    for (const m of MODULES.filter((x) => x.group === 'model')) expect(m.files.every((f) => !f.url)).toBe(true)
  })

  it('нейросеть ищет рядом файл model.data: он сохраняется под этим именем', () => {
    const up = MODULES.find((m) => m.id === 'upscale')!
    expect(up.files.map((f) => f.saveAs)).toEqual(['model.onnx', 'model.data'])
  })

  it('все группы заданы, у моделей Whisper три размера', () => {
    expect(MODULES.filter((m) => m.id.startsWith('whisper-')).map((m) => m.id)).toEqual(['whisper-tiny', 'whisper-base', 'whisper-small'])
  })
})

describe.skipIf(!existsSync(RELEASE))('установка моделей из папки релиза (настоящие файлы через локальный сервер)', () => {
  let srv: Server
  let base: string

  beforeAll(async () => {
    srv = createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? '').slice(1))
      const file = join(RELEASE, name)
      if (!existsSync(file) || name.includes('..')) {
        res.writeHead(404)
        res.end()
        return
      }
      fs.stat(file).then((st) => {
        res.writeHead(200, { 'content-length': st.size })
        createReadStream(file).pipe(res)
      })
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    process.env['MORPHIO_MODELS_URL'] = base
  })

  afterAll(async () => {
    delete process.env['MORPHIO_MODELS_URL']
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  })

  it('upscale: два файла, имена model.onnx и model.data, контрольные суммы сходятся', async () => {
    const root = await tmpDir('mods')
    configureModules([root])
    const { list, report } = collect()
    await installModule('upscale', report)
    expect(list.at(-1)?.phase).toBe('done')
    expect(modulePath('upscale')?.endsWith('model.onnx')).toBe(true)
    expect(await exists(join(root, 'upscale', 'x4v3', 'model.data'))).toBe(true)
    expect(list.some((p) => p.phase === 'download' && p.total === 42_443 + 4_836_096)).toBe(true)
  })

  it('языки Tesseract и программа whisper.cpp (с распаковкой)', async () => {
    const root = await tmpDir('mods')
    configureModules([root])
    for (const id of ['tess-rus', 'tess-eng', 'whisper']) {
      const { list, report } = collect()
      await installModule(id, report)
      expect(list.at(-1)?.phase, id).toBe('done')
      expect(moduleReady(id)).toBe(true)
    }
    expect(modulePath('whisper')?.endsWith('whisper-cli.exe')).toBe(true)
    expect(moduleList().filter((m) => m.installed).map((m) => m.id).sort()).toEqual(['tess-eng', 'tess-rus', 'whisper'])
    await removeModule('whisper')
    expect(moduleReady('whisper')).toBe(false)
  })

  it('подменённый файл на сервере отвергается', async () => {
    const root = await tmpDir('mods')
    configureModules([root])
    const { list, report } = collect()
    process.env['MORPHIO_MODELS_URL'] = `${base}/нет-такой-папки`
    await installModule('tess-eng', report)
    process.env['MORPHIO_MODELS_URL'] = base
    expect(list.at(-1)?.phase).toBe('error')
    expect(moduleReady('tess-eng')).toBe(false)
  })
})
