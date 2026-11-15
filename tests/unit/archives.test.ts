import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { checkArchive, isUnsafeEntry, packItem, unpackArchive } from '../../src/main/converters/archives'
import { defaultUniversalOptions } from '../../src/shared/types'
import type { UniversalOptions } from '../../src/shared/types'
import { cleanupAfterAll, exists, fileItem, tmpDir } from '../helpers'

cleanupAfterAll()

const opts = (target: string, out: string, extra: Partial<UniversalOptions> = {}): UniversalOptions => ({
  ...defaultUniversalOptions(target, out),
  ...extra
})
const pack = async (path: string, kind: string, out: string, extra: Partial<UniversalOptions> = {}) =>
  packItem(await fileItem(path), opts(`archive:${kind}`, out, extra), () => {})
const unpack = async (path: string, out: string, extra: Partial<UniversalOptions> = {}) =>
  unpackArchive(await fileItem(path), opts('archive:unpack', out, extra), () => {})

async function sampleFolder(dir: string): Promise<string> {
  const src = join(dir, 'папка с файлами')
  await fs.mkdir(join(src, 'вложенная'), { recursive: true })
  await fs.writeFile(join(src, 'a.txt'), 'привет '.repeat(1000))
  await fs.writeFile(join(src, 'вложенная', 'b.bin'), Buffer.alloc(50_000, 7))
  return src
}

describe('упаковка и распаковка', () => {
  it.each([
    ['zip', 'zip'],
    ['7z', '7z'],
    ['tar', 'tar'],
    ['targz', 'tar.gz']
  ])('папка → %s → папка: содержимое восстанавливается', async (kind, ext) => {
    const dir = await tmpDir('arc')
    const src = await sampleFolder(dir)
    const packed = await pack(src, kind, join(dir, 'out'))
    expect(packed.outputPath.endsWith(`.${ext}`)).toBe(true)
    expect(packed.outputSize).toBeGreaterThan(0)

    const unpacked = await unpack(packed.outputPath, join(dir, 'res'))
    const root = join(unpacked.outputPath, 'папка с файлами')
    expect(await fs.readFile(join(root, 'a.txt'), 'utf8')).toBe('привет '.repeat(1000))
    expect((await fs.stat(join(root, 'вложенная', 'b.bin'))).size).toBe(50_000)
  })

  it('имя папки сохраняется внутри архива', async () => {
    const dir = await tmpDir('arc')
    const src = await sampleFolder(dir)
    const packed = await pack(src, 'zip', join(dir, 'out'))
    const entries = await checkArchive(packed.outputPath)
    expect(entries.every((e) => e.path.startsWith('папка с файлами'))).toBe(true)
    expect(entries).toHaveLength(2) // только файлы, папки не считаются
  })

  it('один файл упаковывается; результат не перезаписывает существующий', async () => {
    const dir = await tmpDir('arc')
    const f = join(dir, 'заметка.txt')
    await fs.writeFile(f, 'x')
    const a = await pack(f, '7z', dir)
    const b = await pack(f, '7z', dir)
    expect(a.outputPath).not.toBe(b.outputPath)
    expect(await exists(a.outputPath)).toBe(true)
  })

  it('перепаковка: 7z → ZIP', async () => {
    const dir = await tmpDir('arc')
    const src = await sampleFolder(dir)
    const sevenZ = await pack(src, '7z', join(dir, 'a'))
    const zip = await pack(sevenZ.outputPath, 'zip', join(dir, 'b'))
    expect(zip.outputPath.endsWith('.zip')).toBe(true)
    expect(await checkArchive(zip.outputPath)).toHaveLength(2)
    // временные папки убраны
    const left = (await fs.readdir(tmpdir())).filter((n) => n.startsWith('morphio-repack-') || n.startsWith('morphio-tar-'))
    expect(left).toEqual([])
  })

  it('перепаковка не шифрует новый архив паролем исходного', async () => {
    const dir = await tmpDir('arc')
    const f = join(dir, 'секрет.txt')
    await fs.writeFile(f, 'top secret')
    const enc = await pack(f, '7z', join(dir, 'a'), { password: 'пароль123' })
    const zip = await pack(enc.outputPath, 'zip', join(dir, 'b'), { password: 'пароль123' })
    const res = await unpack(zip.outputPath, join(dir, 'c')) // без пароля
    expect(await fs.readFile(join(res.outputPath, 'секрет.txt'), 'utf8')).toBe('top secret')
  })

  it('прогресс доходит до 100', async () => {
    const dir = await tmpDir('arc')
    const src = await sampleFolder(dir)
    let last = -1
    await packItem(await fileItem(src), opts('archive:zip', join(dir, 'out')), (p) => (last = p.percent))
    expect(last).toBe(100)
  })
})

describe('пароли', () => {
  it('7z: русский пароль, неверный и отсутствующий пароль', async () => {
    const dir = await tmpDir('pw')
    const f = join(dir, 'секрет.txt')
    await fs.writeFile(f, 'top secret')
    const p = await pack(f, '7z', join(dir, 'a'), { password: 'пароль123' })

    await expect(unpack(p.outputPath, join(dir, 'x'))).rejects.toThrow(/парол/i)
    await expect(unpack(p.outputPath, join(dir, 'y'), { password: 'неверно' })).rejects.toThrow(/парол/i)
    const ok = await unpack(p.outputPath, join(dir, 'z'), { password: 'пароль123' })
    expect(await fs.readFile(join(ok.outputPath, 'секрет.txt'), 'utf8')).toBe('top secret')
  })

  it('ZIP: латинский пароль работает, русский отклоняется понятным сообщением', async () => {
    const dir = await tmpDir('pw')
    const f = join(dir, 'secret.txt')
    await fs.writeFile(f, 'top secret')
    await expect(pack(f, 'zip', join(dir, 'ru'), { password: 'пароль' })).rejects.toThrow(/7z/)
    expect(await exists(join(dir, 'ru', 'secret.zip'))).toBe(false)

    const p = await pack(f, 'zip', join(dir, 'a'), { password: 'secret123' })
    await expect(unpack(p.outputPath, join(dir, 'x'))).rejects.toThrow(/парол/i)
    const ok = await unpack(p.outputPath, join(dir, 'y'), { password: 'secret123' })
    expect(await fs.readFile(join(ok.outputPath, 'secret.txt'), 'utf8')).toBe('top secret')
  })

  it('после неудачной распаковки папка не остаётся', async () => {
    const dir = await tmpDir('pw')
    const f = join(dir, 'a.txt')
    await fs.writeFile(f, 'x')
    const p = await pack(f, '7z', join(dir, 'a'), { password: 'abc' })
    const out = join(dir, 'out')
    await expect(unpack(p.outputPath, out)).rejects.toThrow()
    expect(await fs.readdir(out).catch(() => [])).toEqual([])
  })
})

describe('безопасность', () => {
  it('isUnsafeEntry: выход из папки, абсолютные и диск-пути опасны', () => {
    for (const p of ['../x', '..\\x', 'a/../../x', '/etc/passwd', '\\\\server\\share', 'C:\\Windows\\x', 'C:/x']) {
      expect(isUnsafeEntry(p), p).toBe(true)
    }
    for (const p of ['a/b.txt', 'a..b/c', 'папка\\файл.txt', '...hidden']) {
      expect(isUnsafeEntry(p), p).toBe(false)
    }
  })

  it('zip-slip: архив с «../» отклоняется, за пределы ничего не пишется', async () => {
    const dir = await tmpDir('slip')
    const z = new JSZip()
    z.file('ok.txt', 'ok')
    z.file('../evil.txt', 'evil')
    const p = join(dir, 'slip.zip')
    await fs.writeFile(p, await z.generateAsync({ type: 'nodebuffer' }))
    await expect(unpack(p, join(dir, 'out'))).rejects.toThrow(/небезопас/)
    expect(await exists(join(dir, 'evil.txt'))).toBe(false)
    expect(await exists(join(dir, 'out', 'evil.txt'))).toBe(false)
  })

  it('битый архив — понятная ошибка', async () => {
    const dir = await tmpDir('bad')
    const p = join(dir, 'broken.zip')
    await fs.writeFile(p, 'это не архив')
    await expect(unpack(p, join(dir, 'out'))).rejects.toThrow()
    expect(await fs.readdir(join(dir, 'out')).catch(() => [])).toEqual([])
  })
})
