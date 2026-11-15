import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  describeItem,
  getTargets,
  kindOfExt,
  runUniversal,
  targetsFor,
  targetsForKind
} from '../../src/main/registry'
import { defaultUniversalOptions } from '../../src/shared/types'
import { cleanupAfterAll, exists, fileItem, makeImage, tmpDir } from '../helpers'

cleanupAfterAll()

describe('kindOfExt', () => {
  it('определяет вид файла по расширению без учёта регистра', () => {
    expect(kindOfExt('PNG')).toBe('image')
    expect(kindOfExt('heic')).toBe('image')
    expect(kindOfExt('mp4')).toBe('video')
    expect(kindOfExt('FLAC')).toBe('audio')
    expect(kindOfExt('xlsx')).toBe('table')
    expect(kindOfExt('yml')).toBe('table')
    expect(kindOfExt('7z')).toBe('archive')
    expect(kindOfExt('docx')).toBe('document')
    expect(kindOfExt('exe')).toBe('other')
    expect(kindOfExt('')).toBe('other')
  })

  it('папка всегда папка', () => {
    expect(kindOfExt('png', true)).toBe('folder')
  })
})

describe('targetsFor', () => {
  const ids = (kind: Parameters<typeof targetsForKind>[0]): string[] => targetsForKind(kind).map((t) => t.id)

  it('картинка: все форматы изображений и упаковка в архив', () => {
    expect(ids('image')).toEqual(
      expect.arrayContaining(['image:webp', 'image:jpg', 'image:png', 'image:avif', 'image:tiff', 'image:gif', 'archive:zip', 'archive:7z'])
    )
    expect(ids('image').some((id) => id.startsWith('video:'))).toBe(false)
  })

  it('«тот же формат» тоже предлагается: так можно сжать или уменьшить файл', async () => {
    const dir = await tmpDir('same')
    const jpg = await fileItem(await makeImage(join(dir, 'a.jpg'), 40, 30))
    expect(targetsFor(jpg).map((t) => t.id)).toContain('image:jpg')
    expect(targetsFor({ ...jpg, kind: 'video', ext: 'mp4' }).map((t) => t.id)).toContain('video:mp4')
  })

  it('видео: видео- и аудиоформаты; звук: только аудио', () => {
    expect(ids('video')).toEqual(expect.arrayContaining(['video:mp4', 'video:webm', 'video:mkv', 'audio:mp3', 'audio:opus']))
    expect(ids('audio').some((id) => id.startsWith('video:'))).toBe(false)
    expect(ids('audio')).toContain('audio:flac')
  })

  it('таблицы: все форматы данных', () => {
    expect(ids('table')).toEqual(
      expect.arrayContaining(['table:xlsx', 'table:csv', 'table:tsv', 'table:json', 'table:yaml', 'table:xml'])
    )
  })

  it('архив: распаковать и упаковать; обычный файл: только упаковать', () => {
    expect(ids('archive')).toContain('archive:unpack')
    expect(ids('image')).not.toContain('archive:unpack')
    expect(ids('folder')).toEqual(['archive:zip', 'archive:7z', 'archive:tar', 'archive:targz'])
    expect(ids('other')).toEqual(['archive:zip', 'archive:7z', 'archive:tar', 'archive:targz'])
  })

  it('у каждого варианта есть подпись и подсказка', () => {
    for (const kind of ['image', 'video', 'audio', 'table', 'archive', 'folder', 'other'] as const) {
      for (const t of targetsForKind(kind)) {
        expect(t.label.length, `${t.id} label`).toBeGreaterThan(0)
        expect(t.hint.length, `${t.id} hint`).toBeGreaterThan(0)
      }
    }
  })
})

describe('getTargets', () => {
  const item = (ext: string, kind: Parameters<typeof targetsForKind>[0]) => ({ id: ext, path: `x.${ext}`, name: `x.${ext}`, ext, size: 1, kind })

  it('пустой выбор — нет вариантов', () => {
    expect(getTargets([])).toEqual([])
  })

  it('однотипные файлы: общие варианты те же, что у одного', () => {
    const two = getTargets([item('png', 'image'), item('jpg', 'image')]).map((t) => t.id)
    // к общим вариантам добавляется склейка в один PDF
    expect(two.filter((id) => id !== 'pdf:merge')).toEqual(targetsForKind('image').map((t) => t.id))
    expect(two).toContain('pdf:merge')
  })

  it('разные виды: остаётся только то, что подходит всем (упаковка)', () => {
    const mixed = getTargets([item('png', 'image'), item('csv', 'table')]).map((t) => t.id)
    expect(mixed).toEqual(['archive:zip', 'archive:7z', 'archive:tar', 'archive:targz'])
  })

  it('видео и звук вместе: только звуковые форматы и упаковка', () => {
    const ids = getTargets([item('mp4', 'video'), item('wav', 'audio')]).map((t) => t.id)
    expect(ids).toContain('audio:mp3')
    expect(ids.some((id) => id.startsWith('video:'))).toBe(false)
  })

  it('архив вместе с картинкой: распаковка недоступна, упаковка доступна', () => {
    const ids = getTargets([item('zip', 'archive'), item('png', 'image')]).map((t) => t.id)
    expect(ids).not.toContain('archive:unpack')
    expect(ids).toContain('archive:zip')
  })
})

describe('describeItem', () => {
  it('картинка: вид, размеры, превью', async () => {
    const dir = await tmpDir('describe')
    const p = await makeImage(join(dir, 'снимок.png'), 200, 100)
    const item = await describeItem(p)
    expect(item).toMatchObject({ name: 'снимок.png', ext: 'png', kind: 'image', width: 200, height: 100 })
    expect(item?.thumbnail?.startsWith('data:image/webp')).toBe(true)
  })

  it('без превью, если не просили', async () => {
    const dir = await tmpDir('describe')
    const p = await makeImage(join(dir, 'a.png'), 50, 50)
    expect((await describeItem(p, false))?.thumbnail).toBeUndefined()
  })

  it('папка не разворачивается и получает вид folder', async () => {
    const dir = await tmpDir('describe')
    const item = await describeItem(dir)
    expect(item?.kind).toBe('folder')
    expect(item?.size).toBe(0)
  })

  it('несуществующий путь — null', async () => {
    expect(await describeItem('C:/нет/такого/файла.png')).toBeNull()
  })

  it('неизвестное расширение — other', async () => {
    const dir = await tmpDir('describe')
    const p = join(dir, 'данные.xyz')
    await fs.writeFile(p, 'x')
    expect((await describeItem(p))?.kind).toBe('other')
  })
})

describe('runUniversal', () => {
  it('отказывает, если для файла такого варианта нет', async () => {
    const dir = await tmpDir('run')
    const p = await makeImage(join(dir, 'a.png'), 30, 30)
    const item = await fileItem(p)
    await expect(runUniversal(item, defaultUniversalOptions('table:csv', dir), { gpu: null }, () => {})).rejects.toThrow()
    expect(await exists(join(dir, 'a.csv'))).toBe(false)
  })

  it('картинка → WebP с уменьшением и удалением скрытых данных', async () => {
    const dir = await tmpDir('run')
    const out = join(dir, 'out')
    const p = await makeImage(join(dir, 'big.png'), 800, 400)
    const item = await fileItem(p)
    const r = await runUniversal(
      item,
      { ...defaultUniversalOptions('image:webp', out, 70), maxSize: 200 },
      { gpu: null },
      () => {}
    )
    expect(r.outputPath.endsWith('.webp')).toBe(true)
    const sharp = (await import('sharp')).default
    const meta = await sharp(r.outputPath).metadata()
    expect(meta.width).toBe(200)
    expect(meta.height).toBe(100)
  })
})
