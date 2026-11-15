import { execFile } from 'node:child_process'
import { tm } from './tm'

/**
 * Пункт «Конвертировать в Morphio» в меню Проводника.
 * Пишется в HKCU (на пользователя, права администратора не нужны). Это классическое меню Windows;
 * в Windows 11 оно открывается через «Показать дополнительные параметры» (Shift+F10).
 */

const KEYS = ['Software\\Classes\\*\\shell\\Morphio', 'Software\\Classes\\Directory\\shell\\Morphio']

function reg(args: string[]): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, encoding: 'utf8' }, (err, _out, stderr) =>
      resolve({ ok: !err, message: (stderr || err?.message || '').trim() })
    )
  })
}

/** Добавляет или убирает пункт. Возвращает текст ошибки или undefined. `keys` можно подменить для тестов. */
export async function setExplorerMenu(
  enabled: boolean,
  exePath: string,
  keys: string[] = KEYS
): Promise<string | undefined> {
  for (const key of keys) {
    const full = `HKCU\\${key}`
    if (!enabled) {
      // «Ключа нет» — не ошибка
      await reg(['delete', full, '/f'])
      continue
    }
    const steps: string[][] = [
      ['add', full, '/ve', '/d', tm('Конвертировать в Morphio'), '/f'],
      ['add', full, '/v', 'Icon', '/d', `"${exePath}",0`, '/f'],
      ['add', `${full}\\command`, '/ve', '/d', `"${exePath}" --quick "%1"`, '/f']
    ]
    for (const args of steps) {
      const r = await reg(args)
      if (!r.ok) return tm('Не удалось записать пункт меню: {msg}', { msg: r.message })
    }
  }
  return undefined
}

/** Есть ли сейчас пункт в реестре. */
export async function hasExplorerMenu(keys: string[] = KEYS): Promise<boolean> {
  const r = await reg(['query', `HKCU\\${keys[0]}\\command`])
  return r.ok
}
