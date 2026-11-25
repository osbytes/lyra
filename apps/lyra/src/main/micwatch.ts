import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { log } from './log'
import {
  bundleIdFromPlist,
  helperRestartDelay,
  ownBundleId,
  parseHelperLine,
  type AudioUsers,
  type MicUsers,
  type OwnName
} from './micHelperLine'
import { micSessionsScript } from './micSessionsWin'

export { parseHelperLine, UNKNOWN_APP, type AudioUsers, type MicUsers } from './micHelperLine'

/**
 * Watches for other apps starting to use the microphone.
 *
 * - Windows: WASAPI capture sessions, through a PowerShell helper (micSessionsWin.ts). If the
 *   helper can't run, the privacy "capability access" registry, which records per app when it
 *   last started and stopped using the mic (stop = 0 means "right now"); recent Windows 11 builds
 *   no longer keep that up to date.
 * - macOS: a tiny CoreAudio helper (native/mac/micwatch.swift). On macOS 14+ it names the
 *   apps capturing input by bundle id; before that it can only say the default input is busy.
 * - Linux: PulseAudio/PipeWire source outputs via `pactl`, best effort.
 */

type Listener = (users: AudioUsers) => void

const POLL_MS = 2000
/** A helper that ran this long before exiting starts a fresh round of restarts. */
const HELPER_STABLE_MS = 10 * 60_000
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

/**
 * Lyra's own bundle id, read from the running app's Info.plist (`com.github.Electron` in
 * development), so its own capture isn't reported as another app on the mic.
 */
function macOwnName(): OwnName {
  try {
    const id = bundleIdFromPlist(readFileSync(join(process.execPath, '../../Info.plist'), 'utf8'))
    if (id) return ownBundleId(id)
  } catch {
    // Not in a bundle (an unusual dev setup): nothing to drop.
  }
  return ''
}

export class MicWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private helper: ChildProcess | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  /** Restarts of the Windows helper since it last ran for a good while. */
  private restarts = 0
  private polling = false
  private failures = 0

  constructor(private readonly onChange: Listener) {}

  start(): void {
    if (this.timer || this.helper || this.restartTimer) return
    if (process.platform === 'darwin') {
      this.startMacHelper()
      return
    }
    if (process.platform === 'win32') {
      this.restarts = 0
      this.startWindowsHelper()
      return
    }
    this.startPolling(pollLinux)
  }

  private startPolling(poll: () => Promise<MicUsers>): void {
    const tick = async (): Promise<void> => {
      if (this.polling) return
      this.polling = true
      try {
        this.onChange({ mic: await poll(), playing: new Set() })
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
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const helper = this.helper
    // Cleared first, so the helper's exit isn't taken for a crash to recover from.
    this.helper = null
    helper?.kill()
    log('micwatch', 'stopped')
  }

  private startWindowsHelper(): void {
    const own = basename(process.execPath).replace(/\.exe$/i, '')
    const script = Buffer.from(micSessionsScript(process.pid), 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    this.helper = child
    const startedAt = Date.now()
    let reported = false
    createInterface({ input: child.stdout }).on('line', (line) => {
      reported = true
      this.onChange(parseHelperLine(line, own))
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-400)
    })
    child.on('error', (error) => {
      log('micwatch', 'audio session helper failed to start', error.message)
    })
    child.on('exit', (code) => {
      if (this.helper !== child) return
      this.helper = null
      log('micwatch', 'audio session helper exited', { code, reported, error: stderr.trim() })
      // Never got going (no PowerShell, or C# blocked by policy): fall back to the registry.
      if (!reported) {
        this.startPolling(pollWindows)
        return
      }
      // It worked and then died: the helpers only report changes, so without a restart the
      // watcher would stay silent until Lyra restarts.
      if (Date.now() - startedAt >= HELPER_STABLE_MS) this.restarts = 0
      const delay = helperRestartDelay(this.restarts)
      if (delay === null) {
        log('micwatch', 'audio session helper keeps exiting; using the registry', { restarts: this.restarts })
        this.startPolling(pollWindows)
        return
      }
      this.restarts++
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this.startWindowsHelper()
      }, delay)
    })
    log('micwatch', 'started', { platform: 'win32', source: 'audio sessions', restarts: this.restarts })
  }

  private startMacHelper(): void {
    const path = macHelperPath()
    if (!existsSync(path)) {
      log('micwatch', 'macOS helper missing; mic prompts unavailable', { path })
      return
    }
    const own = macOwnName()
    const child = spawn(path, [], { stdio: ['ignore', 'pipe', 'ignore'] })
    this.helper = child
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.onChange(parseHelperLine(line, own))
    })
    child.on('exit', (code) => {
      if (this.helper === child) this.helper = null
      log('micwatch', 'helper exited', { code, helper: basename(path) })
    })
    log('micwatch', 'started', { platform: 'darwin' })
  }
}
