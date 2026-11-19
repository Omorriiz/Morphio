import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { cliArgs, cliRequested, expandInputs, findPreset, parseClock, parseCli, parseSizeMB, parseTrim, resolveTarget } from '../../src/main/cli'
import { getTargets } from '../../src/main/registry'
import { BUILTIN_CHAINS, chainShortId } from '../../src/shared/chainPresets'
import { cleanupAfterAll, fileItem, makeImage, tmpDir } from '../helpers'

cleanupAfterAll()

describe('разбор аргументов', () => {
  it('команда, файлы, параметры со значением и без', () => {
    const p = parseCli(['convert', 'a.jpg', 'b.jpg', '--to', 'webp', '--quality=70', '--dry-run', '-o', 'out', '-q'])
    expect(p.errors).toEqual([])
    expect(p.positionals).toEqual(['convert', 'a.jpg', 'b.jpg'])
    expect(p.flags).toEqual({ to: 'webp', quality: '70', 'dry-run': true, out: 'out', quiet: true })
  })

  it('отрицательное число — значение, а не параметр', () => {
    expect(parseCli(['media', 'v.mp4', '--normalize', '-16']).flags['normalize']).toBe('-16')
  })

  it('«--» заканчивает параметры: дальше всё файлы (в том числе с дефисом)', () => {
    const p = parseCli(['convert', '--to', 'png', '--', '--странный.jpg', '-x.png'])
    expect(p.errors).toEqual([])
    expect(p.positionals).toEqual(['convert', '--странный.jpg', '-x.png'])
  })

  it('ошибки: неизвестный параметр, нет значения', () => {
    expect(parseCli(['--nope']).errors).toHaveLength(1)
    expect(parseCli(['-z']).errors).toHaveLength(1)
    expect(parseCli(['convert', '--to']).errors).toHaveLength(1)
    expect(parseCli(['convert', '--to', '--json']).errors).toHaveLength(1)
  })

  it('--cli находится среди аргументов процесса', () => {
    const argv = ['electron.exe', 'C:\\app', '--user-data-dir=x', '--cli', 'convert', 'a.jpg']
    expect(cliRequested(argv)).toBe(true)
    expect(cliArgs(argv)).toEqual(['convert', 'a.jpg'])
    expect(cliRequested(['Morphio.exe'])).toBe(false)
    expect(cliArgs(['Morphio.exe'])).toEqual([])
  })
})

describe('размеры и время', () => {
  it('размер в мегабайтах', () => {
    expect(parseSizeMB('10MB')).toBe(10)
    expect(parseSizeMB('10')).toBe(10)
    expect(parseSizeMB('512kb')).toBe(0.5)
    expect(parseSizeMB('1,5 GB')).toBe(1536)
    expect(parseSizeMB('abc')).toBeUndefined()
    expect(parseSizeMB('0')).toBeUndefined()
  })

  it('время и отрезок', () => {
    expect(parseClock('90')).toBe(90)
    expect(parseClock('1:30')).toBe(90)
    expect(parseClock('0:01:30.5')).toBe(90.5)
    expect(parseClock('x')).toBeUndefined()
    expect(parseTrim('00:10-00:25')).toEqual({ start: 10, end: 25 })
    expect(parseTrim('10-')).toEqual({ start: 10, end: undefined })
    expect(parseTrim('-25')).toEqual({ start: undefined, end: 25 })
    expect(parseTrim('25-10')).toBeUndefined()
    expect(parseTrim('-')).toBeUndefined()
    expect(parseTrim('abc')).toBeUndefined()
  })
})

describe('входные файлы', () => {
  it('файлы, маски, папки без и с --recursive, несуществующие', async () => {
    const dir = await tmpDir('cli')
    await fs.mkdir(join(dir, 'sub'), { recursive: true })
    for (const f of ['a.jpg', 'b.JPG', 'c.png', join('sub', 'd.jpg')]) await fs.writeFile(join(dir, f), 'x')
    const masks = await expandInputs(['*.jpg'], false, dir)
    expect(masks.paths.map((p) => p.split(/[\\/]/).pop())).toEqual(['a.jpg', 'b.JPG'])
    const plain = await expandInputs(['a.jpg', 'sub', 'нет.png'], false, dir)
    expect(plain.paths).toHaveLength(2) // файл и папка как есть
    expect(plain.missing).toEqual(['нет.png'])
    const rec = await expandInputs(['sub', 'c.png'], true, dir)
    expect(rec.paths.map((p) => p.split(/[\\/]/).pop())).toEqual(['d.jpg', 'c.png'])
    const none = await expandInputs(['*.gif'], false, dir)
    expect(none.paths).toEqual([])
    expect(none.missing).toEqual(['*.gif'])
    // повторы убираются
    expect((await expandInputs(['a.jpg', 'a.jpg'], false, dir)).paths).toHaveLength(1)
  })
})

describe('выбор варианта и цепочки', () => {
  it('вариант находится по короткому имени, полному id и названию', async () => {
    const dir = await tmpDir('cli')
    const item = await fileItem(await makeImage(join(dir, 'a.png'), 50, 50))
    const targets = getTargets([item])
    expect(resolveTarget('webp', targets)?.id).toBe('image:webp')
    expect(resolveTarget('WebP', targets)?.id).toBe('image:webp')
    expect(resolveTarget('image:jpg', targets)?.id).toBe('image:jpg')
    expect(resolveTarget('pdf', targets)?.id).toBe('pdf:each')
    expect(resolveTarget('docx', targets)).toBeUndefined()
  })

  it('цепочки: короткий id, полный id и русское название', () => {
    expect(findPreset('shop')?.id).toBe('builtin-shop')
    expect(findPreset('builtin-podcast')?.id).toBe('builtin-podcast')
    expect(findPreset('Фото товара')?.id).toBe('builtin-shop')
    expect(findPreset('нет такой')).toBeUndefined()
    expect(new Set(BUILTIN_CHAINS.map(chainShortId)).size).toBe(BUILTIN_CHAINS.length)
  })
})
