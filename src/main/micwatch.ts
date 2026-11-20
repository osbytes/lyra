import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { log } from './log'

/**
 * Watches for other apps starting to use the microphone.
 *
 * - Windows: the privacy "capability access" registry, which records per app
 *   when it last started and stopped using the mic (stop = 0 means "right now").
 * - macOS: a tiny CoreAudio helper (native/mac/micwatch.swift) that reports
 *   whether the default input is running. It can't say which app.
 * - Linux: PulseAudio/PipeWire source outputs via `pactl`, best effort.
 */

/** Apps currently using the microphone; `UNKNOWN_APP` when the platform can't say which. */
export type MicUsers = Set<string>
export const UNKNOWN_APP = ''

type Listener = (users: MicUsers) => void

const POLL_MS = 2000
const CONSENT_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`${command} failed: ${error.message}`))
      else resolve(stdout)
    })
  })
}

/** "C:#Program Files#Zoom#Zoom.exe" → "Zoom"; "MSTeams_8wekyb3d8bbwe" → "MSTeams". */
export function appNameFromConsentKey(key: string): string {
  const leaf = key.split('\\').at(-1) ?? key
  if (leaf.includes('#')) {
    const exe = leaf.split('#').at(-1) ?? leaf
    return exe.replace(/\.exe$/i, '')
  }
  return leaf.replace(/_[a-z0-9]{13}$/i, '')
}

/** Parses `reg query <CONSENT_KEY> /s` into the apps whose mic use hasn't stopped. */
export function parseConsentStore(output: string, ownExe: string): MicUsers {
  const users: MicUsers = new Set()
  const ownKey = ownExe.replace(/\\/g, '#').toLowerCase()
  let key = ''
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      key = line.trim()
      continue
    }
    const match = /^\s+LastUsedTimeStop\s+REG_QWORD\s+0x0+\s*$/.exec(line)
    if (!match || !key) continue
    if (key.toLowerCase().endsWith(ownKey)) continue
    users.add(appNameFromConsentKey(key))
  }
  return users
}

async function pollWindows(): Promise<MicUsers> {
  const output = await run('reg', ['query', CONSENT_KEY, '/s'])
  return parseConsentStore(output, process.execPath)
}

async function pollLinux(): Promise<MicUsers> {
  const output = await run('pactl', ['list', 'source-outputs'])
  const users: MicUsers = new Set()
  for (const match of output.matchAll(/application\.name = "([^"]+)"/g)) {
    const name = match[1]
    if (name) users.add(name)
  }
  return users
}

function macHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'micwatch')
    : join(__dirname, '../../build/helpers/micwatch')
}

export class MicWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private helper: ChildProcess | null = null
  private polling = false
  private failures = 0

  constructor(private readonly onChange: Listener) {}

  start(): void {
    if (this.timer || this.helper) return
    if (process.platform === 'darwin') {
      this.startMacHelper()
      return
    }
    const poll = process.platform === 'win32' ? pollWindows : pollLinux
    const tick = async (): Promise<void> => {
      if (this.polling) return
      this.polling = true
      try {
        this.onChange(await poll())
        this.failures = 0
      } catch (error) {
        // Logged once per streak so a missing `pactl` doesn't flood the log.
        if (this.failures++ === 0) log('micwatch', 'poll failed', String(error))
      } finally {
        this.polling = false
      }
    }
    void tick()
    this.timer = setInterval(() => void tick(), POLL_MS)
    log('micwatch', 'started', { platform: process.platform })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.helper?.kill()
    this.helper = null
    log('micwatch', 'stopped')
  }

  private startMacHelper(): void {
    const path = macHelperPath()
    if (!existsSync(path)) {
      log('micwatch', 'macOS helper missing; mic prompts unavailable', { path })
      return
    }
    const child = spawn(path, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    this.helper = child
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.onChange(line.trim() === '1' ? new Set([UNKNOWN_APP]) : new Set())
    })
    child.on('exit', (code) => {
      if (this.helper === child) this.helper = null
      log('micwatch', 'helper exited', { code, helper: basename(path) })
    })
    log('micwatch', 'started', { platform: 'darwin' })
  }
}
