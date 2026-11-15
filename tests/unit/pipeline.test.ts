import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import sharp from 'sharp'
import { resolveName, runPipelineItem } from '../../src/main/pipeline'
import type { PipelineConfig } from '../../src/shared/types'
import { cleanupAfterAll, fileItem, makeImage, tmpDir } from '../helpers'

cleanupAfterAll()

const config = (extra: Partial<PipelineConfig> = {}): PipelineConfig => ({
  removeBg: false,
  bgMethod: 'auto',
  bgTolerance: 0,
  bgEverywhere: true,
  bgTranslucent: true,
  fill: 'transparent',
  fillColor: '#ffffff',
  format: 'webp',
  quality: 80,
  keepMetadata: false,
  nameTemplate: '{name}',
  ...extra
})

describe('resolveName', () => {
  it('подставляет имя, номер, дату и формат', () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(resolveName('{name}-{n}', { name: 'фото', n: 7, format: 'webp' })).toBe('фото-007')
    expect(resolveName('{date}_{name}.{format}', { name: 'a', n: 1, format: 'png' })).toBe(`${today}_a.png`)
  })

  it('запрещённые символы Windows заменяются', () => {
    expect(resolveName('a/b:c*d?"e<f>g|h', { name: 'x', n: 1, format: 'png' })).toBe('a_b_c_d__e_f_g_h')
  })

  it('пустой шаблон — исходное имя', () => {
    expect(resolveName('   ', { name: 'исходное', n: 1, format: 'png' })).toBe('исходное')
  })
})

describe('runPipelineItem без удаления фона', () => {
  it('размер, формат, имя по шаблону', async () => {
    const dir = await tmpDir('pipe')
    const src = await makeImage(join(dir, 'снимок.png'), 800, 400)
    const out = join(dir, 'out')
    const r = await runPipelineItem(await fileItem(src), 4, config({ maxSize: 200, nameTemplate: '{name}-{n}', outputDir: out }))
    expect(r.outputPath).toBe(join(out, 'снимок-005.webp'))
    expect(await sharp(r.outputPath).metadata()).toMatchObject({ width: 200, height: 100, format: 'webp' })
  })

  it('рядом с оригиналом и без перезаписи', async () => {
    const dir = await tmpDir('pipe')
    const src = await makeImage(join(dir, 'a.png'), 50, 50)
    const item = await fileItem(src)
    const a = await runPipelineItem(item, 0, config({ format: 'jpg' }))
    const b = await runPipelineItem(item, 0, config({ format: 'jpg' }))
    expect(a.outputPath).not.toBe(b.outputPath)
    expect(a.outputPath.endsWith('.jpg')).toBe(true)
  })
})
