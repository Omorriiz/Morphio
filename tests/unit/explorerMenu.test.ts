import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { hasExplorerMenu, setExplorerMenu } from '../../src/main/explorerMenu'

// Пишет в реестр, но только во временные ключи MorphioTest, которые тут же удаляются.
const B = String.fromCharCode(92)
const KEYS = [['Software', 'Classes', '*', 'shell', 'MorphioTest'].join(B), ['Software', 'Classes', 'Directory', 'shell', 'MorphioTest'].join(B)]
const EXE = ['C:', 'Program Files', 'Morphio Test', 'Morphio.exe'].join(B)

const query = (key: string): string => {
  try {
    return execFileSync('reg.exe', ['query', `HKCU${B}${key}${B}command`, '/ve'], { encoding: 'latin1', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

describe.skipIf(process.platform !== 'win32')('пункт меню Проводника', () => {
  it('добавляется для файлов и папок, команда с --quick и «%1»', async () => {
    try {
      expect(await setExplorerMenu(true, EXE, KEYS)).toBeUndefined()
      expect(await hasExplorerMenu(KEYS)).toBe(true)
      for (const key of KEYS) {
        const line = query(key).trim().split('\n').pop() ?? ''
        expect(line).toContain(`"${EXE}" --quick "%1"`)
      }
    } finally {
      await setExplorerMenu(false, EXE, KEYS)
    }
  })

  it('убирается полностью; повторное удаление — не ошибка', async () => {
    await setExplorerMenu(true, EXE, KEYS)
    expect(await setExplorerMenu(false, EXE, KEYS)).toBeUndefined()
    expect(await hasExplorerMenu(KEYS)).toBe(false)
    expect(KEYS.every((k) => query(k) === '')).toBe(true)
    expect(await setExplorerMenu(false, EXE, KEYS)).toBeUndefined()
  })

  it('путь с пробелами и кириллицей записывается в кавычках', async () => {
    const exe = ['C:', 'Мои программы', 'Morphio Test', 'Morphio.exe'].join(B)
    try {
      expect(await setExplorerMenu(true, exe, KEYS)).toBeUndefined()
      expect(query(KEYS[0])).toContain('--quick "%1"')
    } finally {
      await setExplorerMenu(false, exe, KEYS)
    }
  })
})
