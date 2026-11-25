import { app, powerMonitor } from 'electron'
import { statfs } from 'node:fs/promises'
import { cpus, freemem, loadavg, totalmem } from 'node:os'
import { log } from './log'
import { isRelabeling } from './meeting/relabel'
import { notesDir } from './pages'
import { pressure, summarizeProcesses } from './resourceUsage'
import { onSessionState } from './session'

/**
 * Resource use in the log, so a slow or failed session can be put down to the machine (no memory,
 * a full disk, a throttled CPU) or cleared of it, and so there's a record of what normal looks
 * like: every half minute while recording or settling speakers, every ten minutes otherwise, and
 * whenever a recording starts or stops. Numbers only.
 */
const BUSY_MS = 30_000
const IDLE_MS = 10 * 60_000

let recording = false
let lastAt = 0
let lastPressure = ''

function thermalState(): string | null {
  // macOS only; elsewhere Electron reports 'unknown'.
  const state = powerMonitor.getCurrentThermalState()
  return state === 'unknown' ? null : state
}

async function diskFreeGb(): Promise<number | null> {
  // The notes folder is where recordings go; before it exists, the profile's disk stands in.
  for (const dir of [notesDir(), app.getPath('userData')]) {
    try {
      const stats = await statfs(dir)
      return +((stats.bavail * stats.bsize) / 1024 ** 3).toFixed(1)
    } catch {
      // Try the next one.
    }
  }
  return null
}

async function sample(why: string): Promise<void> {
  lastAt = Date.now()
  const machine = {
    freeMb: Math.round(freemem() / 1024 ** 2),
    totalMb: Math.round(totalmem() / 1024 ** 2),
    load1: +(loadavg()[0] ?? 0).toFixed(2),
    cores: cpus().length,
    diskFreeGb: await diskFreeGb(),
    thermal: thermalState()
  }
  log('resources', why, {
    // CPU is since the previous sample: Electron measures between calls.
    processes: summarizeProcesses(app.getAppMetrics()),
    ...machine,
    onBattery: powerMonitor.isOnBatteryPower()
  })
  // macOS counts only untouched pages as free: a healthy Mac reads a few percent free while
  // most of its memory is reclaimable cache, so the number is logged but not judged there.
  const short = pressure({ ...machine, freeMb: process.platform === 'darwin' ? null : machine.freeMb })
  const key = short.join(',')
  // Once when it starts and once when it changes, not on every sample.
  if (key !== lastPressure) {
    lastPressure = key
    if (short.length) log('resources', 'the machine is short of resources', { short })
    else log('resources', 'resources recovered')
  }
}

function sampleQuietly(why: string): void {
  sample(why).catch((error: unknown) => {
    log('resources', 'could not sample', { error: String(error) })
  })
}

/** Starts the periodic samples; call once the app is ready. */
export function startResourceLog(): void {
  // The first call only starts Electron's CPU measurement; its numbers cover nothing yet.
  app.getAppMetrics()
  onSessionState((state) => {
    const now = state.phase !== 'idle'
    if (now === recording) return
    recording = now
    sampleQuietly(now ? 'recording started' : 'recording stopped')
  })
  powerMonitor.on('thermal-state-change', ({ state }) => {
    log('resources', 'thermal state changed', { state })
  })
  const timer = setInterval(() => {
    const busy = recording || isRelabeling()
    if (Date.now() - lastAt >= (busy ? BUSY_MS : IDLE_MS) - 1000) sampleQuietly(busy ? 'busy' : 'idle')
  }, BUSY_MS)
  // Never the reason the app stays alive.
  timer.unref()
  sampleQuietly('started')
}
