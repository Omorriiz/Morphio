import { describe, expect, it } from 'vitest'
import { cleanNotes, CHECK_INTERVAL_MS, isNewer, shouldAutoCheck, UpdateController } from '../../src/main/updateCore'
import type { UpdateEngine } from '../../src/main/updateCore'
import type { UpdateState } from '../../src/shared/types'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../../src/main/settingsCore'

describe('обновления: правила', () => {
  it('по умолчанию проверка выключена', () => {
    expect(DEFAULT_SETTINGS.checkUpdates).toBe(false)
    expect(sanitizeSettings({}).checkUpdates).toBe(false)
    expect(sanitizeSettings({ checkUpdates: true, lastUpdateCheck: 5 }).lastUpdateCheck).toBe(5)
    expect(sanitizeSettings({ lastUpdateCheck: NaN as never }).lastUpdateCheck).toBe(0)
  })

  it('плановая проверка: выключена — никогда; включена — раз в сутки', () => {
    const now = 10 * CHECK_INTERVAL_MS
    expect(shouldAutoCheck(false, 0, now)).toBe(false)
    expect(shouldAutoCheck(true, 0, now)).toBe(true)
    expect(shouldAutoCheck(true, now - 3600_000, now)).toBe(false)
    expect(shouldAutoCheck(true, now - CHECK_INTERVAL_MS, now)).toBe(true)
    expect(shouldAutoCheck(true, now + 1000, now)).toBe(true) // часы переведены назад
  })

  it('сравнение версий', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true)
    expect(isNewer('1.10.0', '1.9.9')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('0.9.9', '1.0.0')).toBe(false)
    expect(isNewer('2', '1.9')).toBe(true)
  })

  it('описание версии без тегов и не длиннее предела', () => {
    expect(cleanNotes('<p>Новое &amp; важное</p>\n\n\n\n<ul><li>раз</li></ul>')).toBe('Новое & важное\n\nраз')
    expect(cleanNotes([{ note: 'один' }, { note: 'два' }])).toBe('один\nдва')
    expect(cleanNotes(undefined)).toBe('')
    expect(cleanNotes('я'.repeat(5000)).length).toBe(2001)
  })
})

/** Поддельный движок обновлений: записывает вызовы и позволяет «прислать» события. */
function fake(): { engine: UpdateEngine; calls: string[]; emit: (e: string, arg?: unknown) => void } {
  const handlers = new Map<string, (arg?: never) => void>()
  const calls: string[] = []
  const engine = {
    checkForUpdates: async () => void calls.push('check'),
    downloadUpdate: async () => void calls.push('download'),
    quitAndInstall: () => void calls.push('install'),
    on: (e: string, cb: (arg?: never) => void) => void handlers.set(e, cb)
  } as unknown as UpdateEngine
  return { engine, calls, emit: (e, arg) => handlers.get(e)?.(arg as never) }
}

function make(supported = true, current = '1.0.0') {
  const f = fake()
  const states: UpdateState[] = []
  const errors: unknown[] = []
  let last = 0
  const c = new UpdateController({
    engine: f.engine,
    currentVersion: current,
    supported,
    onState: (s) => states.push(s),
    onLastCheck: (t) => (last = t),
    onError: (e) => errors.push(e),
    now: () => 777
  })
  return { c, f, states, errors, last: () => last }
}

describe('обновления: ход работы', () => {
  it('портативная версия и разработка: ничего не делается', async () => {
    const { c, f } = make(false)
    expect(c.state.status).toBe('unsupported')
    expect(await c.check()).toBe(false)
    expect(f.calls).toEqual([])
  })

  it('проверка → есть версия → скачивание только по команде → установка только после скачивания', async () => {
    const { c, f, last } = make()
    expect(c.install()).toBe(false) // нечего ставить
    await c.download() // пока нечего скачивать
    expect(f.calls).toEqual([])

    const checking = c.check()
    f.emit('update-available', { version: '1.1.0', releaseNotes: '<b>Новое</b>' })
    await checking
    expect(c.state).toEqual({ status: 'available', version: '1.1.0', notes: 'Новое' })
    expect(last()).toBe(777)
    expect(f.calls).toEqual(['check']) // сама по себе проверка ничего не скачивает

    expect(c.install()).toBe(false)
    const dl = c.download()
    f.emit('download-progress', { percent: 41.6 })
    expect(c.state).toMatchObject({ status: 'downloading', version: '1.1.0', percent: 42 })
    await dl
    expect(f.calls).toEqual(['check', 'download'])
    f.emit('update-downloaded')
    expect(c.state).toMatchObject({ status: 'ready', percent: 100 })
    expect(c.install()).toBe(true)
    expect(f.calls.at(-1)).toBe('install')
  })

  it('версия не новее установленной и «нет обновлений»', async () => {
    const a = make(true, '1.1.0')
    const p = a.c.check()
    a.f.emit('update-available', { version: '1.1.0' })
    await p
    expect(a.c.state.status).toBe('none')
    const b = make()
    await b.c.check()
    expect(b.c.state.status).toBe('none') // движок ничего не сообщил: не зависаем в «проверяю»
  })

  it('«Позже» прячет предложение; ошибка попадает в журнал и в состояние', async () => {
    const { c, f, errors } = make()
    const p = c.check()
    f.emit('update-available', { version: '2.0.0' })
    await p
    c.dismiss()
    expect(c.state.status).toBe('idle')
    f.emit('error', new Error('сеть недоступна'))
    expect(c.state).toEqual({ status: 'error', error: 'сеть недоступна' })
    expect(errors).toHaveLength(1)
    c.dismiss()
    expect(c.state.status).toBe('idle')
  })

  it('идущая проверка не запускается повторно, во время скачивания проверки нет', async () => {
    const { c, f } = make()
    let release: () => void = () => {}
    ;(f.engine as { checkForUpdates: () => Promise<void> }).checkForUpdates = () => new Promise<void>((r) => (release = r))
    const first = c.check()
    expect(await c.check()).toBe(false)
    release()
    await first
    f.emit('update-available', { version: '1.5.0' })
    void c.download()
    expect(await c.check()).toBe(false)
  })
})
