import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, clipboard } from 'electron'

/**
 * Откуда быстрое окно берёт файлы (по убыванию удобства):
 * 1) выделение в окне Проводника, которое было на переднем плане в момент нажатия;
 * 2) файлы, скопированные в буфер обмена (Ctrl+C в Проводнике);
 * 3) картинка в буфере обмена (скриншот Win+Shift+S): сохраняется в Изображения\Morphio.
 * Всё работает локально, без сети. Окна Проводника с повышенными правами прочитать нельзя.
 *
 * Выделение читает PowerShell через COM (Shell.Application). Запуск и компиляция занимают больше секунды,
 * поэтому, пока включено быстрое окно, один скрытый процесс PowerShell держится наготове (около 60 МБ)
 * и отвечает за 100–200 мс. Если он не запустился, каждый раз запускается отдельный (медленнее, но работает).
 */

const END = '<<END>>'

// Общая часть: определение окна на переднем плане и чтение выделения.
const HELPERS = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MorphioWin { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
$shell = New-Object -ComObject Shell.Application
function Get-MorphioSelection([int64]$hwnd) {
  if ($hwnd -eq 0) { $hwnd = [int64][MorphioWin]::GetForegroundWindow() }
  foreach ($w in $shell.Windows()) {
    if ([int64]$w.HWND -eq $hwnd) { foreach ($i in $w.Document.SelectedItems()) { $i.Path } }
  }
}
function Get-MorphioClipboard { Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName } }
`

/** Команда сервера («sel 123», «clip») → строка для PowerShell. */
function toScript(command: string): string {
  const [name, arg] = command.split(' ')
  return name === 'sel' ? `Get-MorphioSelection ${Number(arg) || 0}` : 'Get-MorphioClipboard'
}

const ONE_SHOT = (cmd: string): string => `${HELPERS}\n${toScript(cmd)}\n`

const SERVER = `${HELPERS}
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $parts = $line.Split(' ')
    if ($parts[0] -eq 'sel') { Get-MorphioSelection ([int64]$parts[1]) }
    elseif ($parts[0] -eq 'clip') { Get-MorphioClipboard }
  } catch {}
  [Console]::Out.WriteLine('${END}')
  [Console]::Out.Flush()
}
`

const encode = (script: string): string => Buffer.from(script, 'utf16le').toString('base64')
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass']

const onlyExisting = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== END && existsSync(l))

function oneShot(command: string, timeoutMs = 8000): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [...PS_ARGS, '-EncodedCommand', encode(ONE_SHOT(command))],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout) => resolve(err ? [] : onlyExisting(stdout))
    )
  })
}

// ---------- постоянный процесс ----------

let server: ChildProcess | null = null
let buffer = ''
let waiter: { resolve: (lines: string[]) => void; timer: NodeJS.Timeout } | null = null
let queue: Promise<unknown> = Promise.resolve()

/** Запускает PowerShell, который держится наготове. Безопасно вызывать повторно. */
export function startSelectionServer(): void {
  if (server) return
  const child = spawn('powershell.exe', [...PS_ARGS, '-EncodedCommand', encode(SERVER)], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  server = child
  buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    const at = buffer.indexOf(END)
    if (at >= 0 && waiter) {
      const text = buffer.slice(0, at)
      buffer = buffer.slice(at + END.length)
      clearTimeout(waiter.timer)
      const w = waiter
      waiter = null
      w.resolve(onlyExisting(text))
    }
  })
  const drop = (): void => {
    if (server === child) server = null
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve([])
      waiter = null
    }
  }
  child.on('exit', drop)
  child.on('error', drop)
}

export function stopSelectionServer(): void {
  const child = server
  server = null
  child?.kill()
}

function ask(command: string): Promise<string[] | null> {
  const run = (): Promise<string[] | null> =>
    new Promise((resolve) => {
      const child = server
      if (!child || !child.stdin?.writable) return resolve(null)
      const timer = setTimeout(() => {
        // не ответил: убираем процесс, в следующий раз запустится заново
        waiter = null
        stopSelectionServer()
        resolve(null)
      }, 6000)
      waiter = { resolve, timer }
      child.stdin.write(`${command}\n`)
    })
  const next = queue.then(run, run)
  queue = next.catch(() => null)
  return next
}

async function query(command: string): Promise<string[]> {
  if (server) {
    const answer = await ask(command)
    if (answer) return answer
  }
  return oneShot(command)
}

/** Выделенные файлы в окне Проводника. `hwnd` нужен для проверок, обычно берётся окно на переднем плане. */
export function explorerSelection(hwnd?: number): Promise<string[]> {
  return query(hwnd ? `sel ${hwnd}` : 'sel')
}

export function clipboardFiles(): Promise<string[]> {
  return query('clip')
}

/** Картинка из буфера обмена → файл PNG. Возвращает путь или null. */
export async function clipboardImageToFile(): Promise<string | null> {
  try {
    const items = await clipboard.read()
    const item = items.find((i) => i.types.includes('image/png'))
    if (!item) return null
    const blob = await item.getType('image/png')
    const dir = join(app.getPath('pictures'), 'Morphio')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const path = join(dir, `clipboard-${stamp}.png`)
    writeFileSync(path, Buffer.from(await blob.arrayBuffer()))
    return path
  } catch {
    return null
  }
}

/** Файлы для быстрого окна: сначала Проводник, потом буфер обмена (файлы, затем картинка). */
export async function gatherQuickFiles(): Promise<string[]> {
  const selected = await explorerSelection()
  if (selected.length > 0) return selected
  const copied = await clipboardFiles()
  if (copied.length > 0) return copied
  const image = await clipboardImageToFile()
  return image ? [image] : []
}
