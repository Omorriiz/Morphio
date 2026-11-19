import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { cleanupAfterAll, tmpDir } from '../helpers'

cleanupAfterAll()

const req = createRequire(import.meta.url)
const { build, sha256 } = req('../../scripts/make-manifests.cjs') as {
  build: (o: Record<string, unknown>) => { winget: Record<string, string>; scoop: Record<string, unknown> }
  sha256: (f: string) => string
}

describe('манифесты winget и scoop', () => {
  const m = build({ version: '1.2.3', url: 'https://example.test/Morphio-Setup-1.2.3.exe', hash: 'abcdef0123', size: 100 * 1048576, license: 'MIT', date: '2026-01-02' })

  it('winget: три файла, версия и хеш в верхнем регистре на месте', () => {
    expect(Object.keys(m.winget).sort()).toEqual([
      'Omorriiz.Morphio.installer.yaml',
      'Omorriiz.Morphio.locale.en-US.yaml',
      'Omorriiz.Morphio.yaml'
    ])
    const installer = m.winget['Omorriiz.Morphio.installer.yaml']
    expect(installer).toContain('PackageVersion: 1.2.3')
    expect(installer).toContain('InstallerSha256: ABCDEF0123')
    expect(installer).toContain('InstallerUrl: https://example.test/Morphio-Setup-1.2.3.exe')
    expect(installer).toContain('InstallerType: nullsoft')
    expect(m.winget['Omorriiz.Morphio.locale.en-US.yaml']).toContain('License: MIT')
  })

  it('scoop: ссылка, хеш, консольная команда и автообновление', () => {
    const s = m.scoop as { version: string; bin: string; architecture: { '64bit': { url: string; hash: string } }; autoupdate: unknown }
    expect(s.version).toBe('1.2.3')
    expect(s.bin).toBe('morphio.cmd')
    expect(s.architecture['64bit'].hash).toBe('abcdef0123')
    expect(JSON.stringify(s.autoupdate)).toContain('$version')
  })

  it('хеш файла считается верно', async () => {
    const dir = await tmpDir('man')
    const f = join(dir, 'a.bin')
    await fs.writeFile(f, 'morphio')
    expect(sha256(f)).toBe(createHash('sha256').update('morphio').digest('hex'))
  })
})
